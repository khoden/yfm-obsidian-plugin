import {
    getLanguage,
    ItemView,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
} from 'obsidian';
import type { Menu } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { yfmSourceHighlighting } from './highlighting';
import { MarkupCache } from './cache';
import { previewDocument } from './document';
import { localImageSource } from './images';
import { createLocalization } from './localization';

const VIEW_TYPE = 'yfm-preview';
interface YfmPreviewSettings {
    debounceMs: number;
    debugMode: boolean;
    highlightYfm: boolean;
}

const DEFAULT_SETTINGS: YfmPreviewSettings = {
    debounceMs: 500,
    debugMode: false,
    highlightYfm: true,
};

class YfmPreviewView extends ItemView {
    private file: TFile | null = null;
    private sourceLeaf: WorkspaceLeaf | null = null;
    private frame!: HTMLIFrameElement;
    private status!: HTMLElement;
    private diagnostics!: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private revision = 0;
    private debugStatus = false;
    private hash = '';
    private renderedFile: TFile | null = null;
    private scroll = { x: 0, y: 0 };
    private documentId = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: YfmPreviewPlugin,
    ) {
        super(leaf);
    }

    private get text() {
        return this.plugin.locale.strings;
    }

    getViewType(): string {
        return VIEW_TYPE;
    }
    getDisplayText(): string {
        return 'YFM Preview';
    }
    getIcon(): string {
        return 'file-code';
    }

    /** Adds manual refresh to the native tab and pane menus. */
    onPaneMenu(menu: Menu, source: string): void {
        super.onPaneMenu(menu, source);
        menu.addItem((item) =>
            item
                .setTitle(this.text.refresh)
                .setIcon('refresh-cw')
                .setSection('action')
                .onClick(() => {
                    if (this.file) this.plugin.cache.invalidate(this.file.path);
                    this.schedule({ immediate: true });
                }),
        );
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('yfm-preview-panel');
        this.status = this.contentEl.createDiv({
            cls: 'yfm-preview-status',
            text: this.text.openFile,
        });
        this.diagnostics = this.contentEl.createEl('pre', { cls: 'yfm-preview-diagnostics' });
        this.diagnostics.hidden = true;
        this.frame = this.contentEl.createEl('iframe', { cls: 'yfm-preview-frame' });
        this.frame.title = this.text.frameTitle;
        // Keep document scripts and styles isolated from Obsidian and its Node APIs.
        this.frame.setAttribute('sandbox', 'allow-scripts');
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file?.extension === 'md') this.follow(file);
            }),
        );
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file === this.file) this.schedule({ immediate: false });
            }),
        );
        this.registerEvent(
            this.app.vault.on('rename', (file) => {
                if (file === this.file) this.schedule({ immediate: true });
            }),
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file !== this.file) return;
                this.cancelPending();
                this.file = null;
                this.frame.srcdoc = '';
                this.renderedFile = null;
                this.scroll = { x: 0, y: 0 };
                ++this.documentId;
                this.setStatus(this.text.fileDeleted);
                this.diagnostics.hidden = true;
            }),
        );
        this.registerEvent(
            this.app.workspace.on('css-change', () => this.schedule({ immediate: true })),
        );
        this.registerDomEvent(window, 'message', (event: MessageEvent) => {
            if (event.source !== this.frame.contentWindow) return;
            if (event.data?.type === 'yfm-preview-scroll') {
                const { documentId, x, y } = event.data;
                // Old srcdoc documents share the same WindowProxy; ignore their delayed messages.
                if (documentId === this.documentId && Number.isFinite(x) && Number.isFinite(y)) {
                    this.scroll = { x: Math.max(0, x), y: Math.max(0, y) };
                }
                return;
            }
            if (event.data?.type !== 'yfm-preview-link') return;
            const href = event.data.href;
            if (typeof href !== 'string') return;
            if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
            else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && this.file) {
                void this.openSourceLink(href);
            }
        });
        const file = this.app.workspace.getActiveFile() ?? this.plugin.currentFile;
        if (file?.extension === 'md') this.follow(file);
    }

    private follow(file: TFile): void {
        this.file = file;
        const editor = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.sourceLeaf =
            editor?.file === file
                ? editor.leaf
                : (this.app.workspace
                      .getLeavesOfType('markdown')
                      .find(
                          (leaf) => leaf.view instanceof MarkdownView && leaf.view.file === file,
                      ) ?? this.sourceLeaf);
        this.schedule({ immediate: true });
    }

    private async openSourceLink(href: string): Promise<void> {
        if (!this.file) return;
        const sourcePath = this.file.path;
        const workspace = this.app.workspace;
        const editors = workspace.getLeavesOfType('markdown');
        const source =
            this.sourceLeaf && editors.includes(this.sourceLeaf)
                ? this.sourceLeaf
                : (editors.find(
                      (leaf) => leaf.view instanceof MarkdownView && leaf.view.file === this.file,
                  ) ??
                  editors[0] ??
                  workspace.getLeaf('split', 'vertical'));
        this.sourceLeaf = source;
        // openLinkText(false) reuses the active editor; activate it before native link resolution.
        workspace.setActiveLeaf(source, { focus: true });
        await workspace.openLinkText(href, sourcePath, false);
    }

    private cancelPending(): void {
        ++this.revision;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule({ immediate }: { immediate: boolean }): void {
        this.cancelPending();
        if (!this.file) return;
        const revision = this.revision;
        this.setStatus(
            `${this.file.path} · ${immediate ? this.text.rendering : this.text.waiting}`,
            {
                debugOnly: true,
            },
        );
        if (immediate) void this.renderFile(revision);
        else
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.renderFile(revision);
            }, this.plugin.settings.debounceMs);
    }

    private async renderFile(revision: number): Promise<void> {
        const file = this.file;
        if (!file) return;
        try {
            const source = await this.app.vault.read(file);
            // A new file selection or modification may have arrived during the read.
            if (revision !== this.revision) return;
            const result = this.plugin.cache.render(file.path, source);
            const container = document.createElement('div');
            container.innerHTML = result.html;
            // Resolve resources after the cache lookup: identical source can live in different folders.
            const imageDiagnostics: string[] = [];
            await Promise.all(
                Array.from(container.querySelectorAll('img[src]')).map(async (image) => {
                    const src = image.getAttribute('src')!;
                    try {
                        image.setAttribute('src', await localImageSource(this.app, src, file.path));
                    } catch (error) {
                        imageDiagnostics.push(this.text.imageError(src, String(error)));
                    }
                }),
            );
            if (revision !== this.revision) return;
            if (this.renderedFile !== file) this.scroll = { x: 0, y: 0 };
            this.renderedFile = file;
            this.frame.srcdoc = previewDocument(
                container.innerHTML,
                document.body.classList.contains('theme-dark'),
                {
                    scroll: this.scroll,
                    documentId: ++this.documentId,
                    language: this.plugin.locale.language,
                    typography: this.readTypography(),
                },
            );
            this.setStatus(
                `${file.path} · ${result.cacheHit ? this.text.cache : this.text.conversion} · SHA-256 ${result.hash.slice(0, 12)}`,
                { debugOnly: true, hash: result.hash },
            );
            const diagnostics = [...result.diagnostics, ...imageDiagnostics];
            this.diagnostics.setText(diagnostics.join('\n'));
            this.diagnostics.hidden = diagnostics.length === 0;
        } catch (error) {
            if (revision !== this.revision) return;
            this.frame.srcdoc = '';
            this.setStatus(`${file.path} · ${this.text.error}`);
            this.diagnostics.setText(String(error));
            this.diagnostics.hidden = false;
        }
    }

    private readTypography(): {
        fontFamily: string;
        fontSize: string;
        monospaceFontFamily: string;
    } {
        const container =
            this.sourceLeaf?.view instanceof MarkdownView
                ? (this.sourceLeaf.view.previewMode?.containerEl ?? this.contentEl)
                : this.contentEl;
        const probe = container.createDiv({ cls: 'markdown-preview-view markdown-rendered' });
        const code = probe.createEl('code');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        try {
            const style = probe.win.getComputedStyle(probe);
            return {
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                monospaceFontFamily: code.win.getComputedStyle(code).fontFamily,
            };
        } finally {
            probe.remove();
        }
    }

    private setStatus(
        text: string,
        { debugOnly = false, hash = '' }: { debugOnly?: boolean; hash?: string } = {},
    ): void {
        this.debugStatus = debugOnly;
        this.hash = hash;
        this.status.setText(text);
        this.updateStatusVisibility();
    }

    private updateStatusVisibility(): void {
        this.status.hidden = this.debugStatus && !this.plugin.settings.debugMode;
        this.status.title = this.plugin.settings.debugMode ? this.hash : '';
    }

    /** Applies settings without resetting the displayed document or interactive blocks. */
    applySettings(): void {
        this.updateStatusVisibility();
        if (this.timer !== undefined) this.schedule({ immediate: false });
    }

    async onClose(): Promise<void> {
        this.cancelPending();
        this.contentEl.empty();
    }
}

/** Adds a saved-file YFM HTML preview alongside Obsidian's Markdown editor. */
export default class YfmPreviewPlugin extends Plugin {
    readonly locale = createLocalization(getLanguage());
    readonly cache = new MarkupCache({ language: this.locale.language });
    settings: YfmPreviewSettings = { ...DEFAULT_SETTINGS };
    currentFile: TFile | null = null;
    private readonly editorExtensions: Extension[] = [];

    async onload(): Promise<void> {
        const saved = await this.loadData();
        this.settings = {
            debounceMs:
                Number.isInteger(saved?.debounceMs) &&
                saved.debounceMs >= 0 &&
                saved.debounceMs <= 60_000
                    ? saved.debounceMs
                    : DEFAULT_SETTINGS.debounceMs,
            highlightYfm:
                typeof saved?.highlightYfm === 'boolean'
                    ? saved.highlightYfm
                    : DEFAULT_SETTINGS.highlightYfm,
            debugMode:
                typeof saved?.debugMode === 'boolean'
                    ? saved.debugMode
                    : DEFAULT_SETTINGS.debugMode,
        };
        this.editorExtensions.length = 0;
        if (this.settings.highlightYfm) this.editorExtensions.push(yfmSourceHighlighting);
        this.registerEditorExtension(this.editorExtensions);
        this.addSettingTab(new YfmPreviewSettingTab(this));
        this.registerView(VIEW_TYPE, (leaf) => new YfmPreviewView(leaf, this));
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file?.extension === 'md') this.currentFile = file;
            }),
        );
        this.registerEvent(this.app.vault.on('modify', (file) => this.cache.invalidate(file.path)));
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                this.cache.invalidate(file.path);
                if (file === this.currentFile) this.currentFile = null;
            }),
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.cache.invalidate(oldPath);
                this.cache.invalidate(file.path);
            }),
        );
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
                if (
                    leaf?.view instanceof MarkdownView &&
                    leaf.view.file === file &&
                    leaf.view.file?.extension === 'md'
                ) {
                    this.addPreviewToggle(menu, { file: leaf.view.file, sourceLeaf: leaf });
                }
            }),
        );
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, _editor, info) => {
                if (info.file?.extension !== 'md') return;
                const sourceLeaf =
                    info instanceof MarkdownView
                        ? info.leaf
                        : this.app.workspace
                              .getLeavesOfType('markdown')
                              .find(
                                  (leaf) =>
                                      leaf.view instanceof MarkdownView &&
                                      leaf.view.file === info.file,
                              );
                this.addPreviewToggle(menu, { file: info.file, sourceLeaf });
            }),
        );
        this.addCommand({
            // Preserve the command ID so existing user hotkeys continue to work.
            id: 'open-preview',
            name: this.locale.strings.toggleCommand,
            callback: () => {
                void this.togglePreview();
            },
        });
        this.addRibbonIcon('file-code', this.locale.strings.toggleRibbon, () => {
            void this.togglePreview();
        });
        this.register(() => this.cache.clear());
    }

    /** Persists preferences and updates all open preview panels. */
    async updateSettings(changes: Partial<YfmPreviewSettings>): Promise<void> {
        const previousHighlighting = this.settings.highlightYfm;
        this.settings = { ...this.settings, ...changes };
        if (this.settings.highlightYfm !== previousHighlighting) {
            this.editorExtensions.length = 0;
            if (this.settings.highlightYfm) this.editorExtensions.push(yfmSourceHighlighting);
            this.app.workspace.updateOptions();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof YfmPreviewView) leaf.view.applySettings();
        }
        await this.saveData(this.settings);
    }

    private addPreviewToggle(
        menu: Menu,
        options: { file: TFile; sourceLeaf?: WorkspaceLeaf },
    ): void {
        const isOpen = this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0;
        menu.addItem((item) =>
            item
                .setTitle(
                    isOpen ? this.locale.strings.closePreview : this.locale.strings.openPreview,
                )
                .setIcon(isOpen ? 'x' : 'file-code')
                .setSection('action')
                .onClick(() => this.togglePreview(options)),
        );
    }

    private async togglePreview({
        file,
        sourceLeaf,
    }: {
        file?: TFile;
        sourceLeaf?: WorkspaceLeaf;
    } = {}): Promise<void> {
        const workspace = this.app.workspace;
        const previews = workspace.getLeavesOfType(VIEW_TYPE);
        if (previews.length > 0) {
            for (const leaf of previews) leaf.detach();
            return;
        }
        this.currentFile = file ?? workspace.getActiveFile() ?? this.currentFile;
        if (!this.currentFile || this.currentFile.extension !== 'md') {
            new Notice(this.locale.strings.openFileFirst);
            return;
        }
        const source =
            sourceLeaf ??
            workspace
                .getLeavesOfType('markdown')
                .find(
                    (leaf) =>
                        leaf.view instanceof MarkdownView && leaf.view.file === this.currentFile,
                );
        // Split the source pane even if its menu was opened while another pane was active.
        if (source) workspace.setActiveLeaf(source, { focus: false });
        const leaf = workspace.getLeaf('split', 'vertical');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        await workspace.revealLeaf(leaf);
    }
}

class YfmPreviewSettingTab extends PluginSettingTab {
    constructor(private readonly plugin: YfmPreviewPlugin) {
        super(plugin.app, plugin);
    }

    display(): void {
        this.containerEl.empty();
        const strings = this.plugin.locale.strings;
        new Setting(this.containerEl)
            .setName(strings.highlightName)
            .setDesc(strings.highlightDescription)
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.highlightYfm)
                    .onChange(async (highlightYfm) => {
                        await this.plugin.updateSettings({ highlightYfm });
                    }),
            );
        new Setting(this.containerEl)
            .setName(strings.delayName)
            .setDesc(strings.delayDescription)
            .addText((text) => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
                text.inputEl.max = '60000';
                text.inputEl.step = '1';
                text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
                    const delay = Number(value);
                    const valid =
                        value.trim() !== '' &&
                        Number.isInteger(delay) &&
                        delay >= 0 &&
                        delay <= 60_000;
                    text.inputEl.setCustomValidity(valid ? '' : strings.delayValidation);
                    if (valid) await this.plugin.updateSettings({ debounceMs: delay });
                });
            });
        new Setting(this.containerEl)
            .setName(strings.debugName)
            .setDesc(strings.debugDescription)
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.debugMode).onChange(async (debugMode) => {
                    await this.plugin.updateSettings({ debugMode });
                }),
            );
    }
}
