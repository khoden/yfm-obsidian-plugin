import {ItemView, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf} from 'obsidian';
import type {Menu} from 'obsidian';
import {MarkupCache} from './cache';
import {previewDocument} from './document';
import {localImageSource} from './images';

const VIEW_TYPE = 'yfm-preview';
interface YfmPreviewSettings {
    debounceMs: number;
    debugMode: boolean;
}

const DEFAULT_SETTINGS: YfmPreviewSettings = {debounceMs: 500, debugMode: false};

class YfmPreviewView extends ItemView {
    private file: TFile | null = null;
    private sourceLeaf: WorkspaceLeaf | null = null;
    private frame!: HTMLIFrameElement;
    private status!: HTMLElement;
    private diagnostics!: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private revision = 0;
    private debugStatus = false;
    private hash = "";

    constructor(leaf: WorkspaceLeaf, private readonly plugin: YfmPreviewPlugin) {
        super(leaf);
    }

    getViewType(): string { return VIEW_TYPE; }
    getDisplayText(): string { return 'YFM Preview'; }
    getIcon(): string { return 'file-code'; }

    /** Adds manual refresh to the native tab and pane menus. */
    onPaneMenu(menu: Menu, source: string): void {
        super.onPaneMenu(menu, source);
        menu.addItem((item) => item
            .setTitle('Обновить')
            .setIcon('refresh-cw')
            .setSection('action')
            .onClick(() => {
                if (this.file) this.plugin.cache.invalidate(this.file.path);
                this.schedule({immediate: true});
            }));
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('yfm-preview-panel');
        this.status = this.contentEl.createDiv({cls: 'yfm-preview-status', text: 'Откройте Markdown-файл.'});
        this.diagnostics = this.contentEl.createEl('pre', {cls: 'yfm-preview-diagnostics'});
        this.diagnostics.hidden = true;
        this.frame = this.contentEl.createEl('iframe', {cls: 'yfm-preview-frame'});
        this.frame.title = 'YFM HTML preview';
        // Keep document scripts and styles isolated from Obsidian and its Node APIs.
        this.frame.setAttribute('sandbox', 'allow-scripts');
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file?.extension === 'md') this.follow(file);
        }));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file === this.file) this.schedule({immediate: false});
        }));
        this.registerEvent(this.app.vault.on('rename', (file) => {
            if (file === this.file) this.schedule({immediate: true});
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file !== this.file) return;
            this.cancelPending();
            this.file = null;
            this.frame.srcdoc = '';
            this.setStatus('Файл удалён. Откройте другой Markdown-файл.');
            this.diagnostics.hidden = true;
        }));
        this.registerEvent(this.app.workspace.on('css-change', () => this.schedule({immediate: true})));
        this.registerDomEvent(window, 'message', (event: MessageEvent) => {
            if (event.source !== this.frame.contentWindow || event.data?.type !== 'yfm-preview-link') return;
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
        this.sourceLeaf = editor?.file === file ? editor.leaf
            : this.app.workspace.getLeavesOfType('markdown').find((leaf) =>
                leaf.view instanceof MarkdownView && leaf.view.file === file) ?? this.sourceLeaf;
        this.schedule({immediate: true});
    }

    private async openSourceLink(href: string): Promise<void> {
        if (!this.file) return;
        const sourcePath = this.file.path;
        const workspace = this.app.workspace;
        const editors = workspace.getLeavesOfType('markdown');
        const source = this.sourceLeaf && editors.includes(this.sourceLeaf) ? this.sourceLeaf
            : editors.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file === this.file)
                ?? editors[0] ?? workspace.getLeaf('split', 'vertical');
        this.sourceLeaf = source;
        // openLinkText(false) reuses the active editor; activate it before native link resolution.
        workspace.setActiveLeaf(source, {focus: true});
        await workspace.openLinkText(href, sourcePath, false);
    }

    private cancelPending(): void {
        ++this.revision;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule({immediate}: {immediate: boolean}): void {
        this.cancelPending();
        if (!this.file) return;
        const revision = this.revision;
        this.setStatus(`${this.file.path} · ${immediate ? 'рендеринг' : 'ожидание обновления…'}`, {debugOnly: true});
        if (immediate) void this.renderFile(revision);
        else this.timer = setTimeout(() => {
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
            await Promise.all(Array.from(container.querySelectorAll('img[src]')).map(async (image) => {
                const src = image.getAttribute('src')!;
                try {
                    image.setAttribute('src', await localImageSource(this.app, src, file.path));
                } catch (error) {
                    imageDiagnostics.push(`Не удалось загрузить изображение ${src}: ${String(error)}`);
                }
            }));
            if (revision !== this.revision) return;
            this.frame.srcdoc = previewDocument(container.innerHTML, document.body.classList.contains('theme-dark'));
            this.setStatus(`${file.path} · ${result.cacheHit ? 'кеш' : 'конвертация'} · SHA-256 ${result.hash.slice(0, 12)}`, {debugOnly: true, hash: result.hash});
            const diagnostics = [...result.diagnostics, ...imageDiagnostics];
            this.diagnostics.setText(diagnostics.join('\n'));
            this.diagnostics.hidden = diagnostics.length === 0;
        } catch (error) {
            if (revision !== this.revision) return;
            this.frame.srcdoc = '';
            this.setStatus(`${file.path} · ошибка`);
            this.diagnostics.setText(String(error));
            this.diagnostics.hidden = false;
        }
    }

    private setStatus(text: string, {debugOnly = false, hash = ''}: {debugOnly?: boolean; hash?: string} = {}): void {
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
        if (this.timer !== undefined) this.schedule({immediate: false});
    }

    async onClose(): Promise<void> {
        this.cancelPending();
        this.contentEl.empty();
    }
}

/** Adds a saved-file YFM HTML preview alongside Obsidian's Markdown editor. */
export default class YfmPreviewPlugin extends Plugin {
    readonly cache = new MarkupCache();
    settings: YfmPreviewSettings = {...DEFAULT_SETTINGS};
    currentFile: TFile | null = null;

    async onload(): Promise<void> {
        const saved = await this.loadData();
        this.settings = {
            debounceMs: Number.isInteger(saved?.debounceMs) && saved.debounceMs >= 0 && saved.debounceMs <= 60_000
                ? saved.debounceMs : DEFAULT_SETTINGS.debounceMs,
            debugMode: typeof saved?.debugMode === 'boolean' ? saved.debugMode : DEFAULT_SETTINGS.debugMode,
        };
        this.addSettingTab(new YfmPreviewSettingTab(this));
        this.registerView(VIEW_TYPE, (leaf) => new YfmPreviewView(leaf, this));
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file?.extension === 'md') this.currentFile = file;
        }));
        this.registerEvent(this.app.vault.on('modify', (file) => this.cache.invalidate(file.path)));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            this.cache.invalidate(file.path);
            if (file === this.currentFile) this.currentFile = null;
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            this.cache.invalidate(oldPath);
            this.cache.invalidate(file.path);
        }));
        this.addCommand({id: 'open-preview', name: 'Open preview', callback: () => { void this.openPreview(); }});
        this.addRibbonIcon('file-code', 'Open YFM Preview', () => { void this.openPreview(); });
        this.register(() => this.cache.clear());
    }

    /** Persists preferences and updates all open preview panels. */
    async updateSettings(changes: Partial<YfmPreviewSettings>): Promise<void> {
        this.settings = {...this.settings, ...changes};
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof YfmPreviewView) leaf.view.applySettings();
        }
        await this.saveData(this.settings);
    }

    private async openPreview(): Promise<void> {
        this.currentFile = this.app.workspace.getActiveFile() ?? this.currentFile;
        if (!this.currentFile || this.currentFile.extension !== 'md') {
            new Notice('Сначала откройте Markdown-файл.');
            return;
        }
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeaf('split', 'vertical');
            await leaf.setViewState({type: VIEW_TYPE, active: true});
        }
        await this.app.workspace.revealLeaf(leaf);
    }
}

class YfmPreviewSettingTab extends PluginSettingTab {
    constructor(private readonly plugin: YfmPreviewPlugin) {
        super(plugin.app, plugin);
    }

    display(): void {
        this.containerEl.empty();
        new Setting(this.containerEl)
            .setName('Задержка обновления (мс)')
            .setDesc('Debounce после сохранения файла: от 0 до 60000 мс. По умолчанию — 500 мс.')
            .addText((text) => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
                text.inputEl.max = '60000';
                text.inputEl.step = '1';
                text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
                    const delay = Number(value);
                    const valid = value.trim() !== '' && Number.isInteger(delay) && delay >= 0 && delay <= 60_000;
                    text.inputEl.setCustomValidity(valid ? '' : 'Введите целое число от 0 до 60000.');
                    if (valid) await this.plugin.updateSettings({debounceMs: delay});
                });
            });
        new Setting(this.containerEl)
            .setName('Debug-mode')
            .setDesc('Показывать в предпросмотре техническую строку: путь файла, состояние кеша и SHA-256.')
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.debugMode).onChange(async (debugMode) => {
                await this.plugin.updateSettings({debugMode});
            }));
    }
}
