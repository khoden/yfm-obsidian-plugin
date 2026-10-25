const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

class Events {
    handlers = new Map();
    on(name, callback) {
        const callbacks = this.handlers.get(name) ?? [];
        callbacks.push(callback);
        this.handlers.set(name, callbacks);
        return { off: () => callbacks.splice(callbacks.indexOf(callback), 1) };
    }
    emit(name, ...args) {
        for (const callback of this.handlers.get(name) ?? []) callback(...args);
    }
}
class Element {
    children = [];
    text = '';
    innerHTML = '';
    srcdoc = '';
    style = {};
    win = { getComputedStyle: () => ({ fontFamily: 'Arial', fontSize: '16px' }) };
    remove() {}
    classList = { contains: () => false };
    createEl(tag, options) {
        const element = new Element();
        element.tag = tag;
        element.text = options?.text ?? '';
        this.children.push(element);
        return element;
    }
    createDiv(options) {
        return this.createEl('div', options);
    }
    createSpan(options) {
        return this.createEl('span', options);
    }
    empty() {
        this.children = [];
    }
    addClass() {}
    setAttribute() {}
    setText(text) {
        this.text = text;
    }
    querySelectorAll() {
        return [];
    }
}
class Component {
    disposers = [];
    registerEvent(ref) {
        this.disposers.push(() => ref.off());
    }
    register(dispose) {
        this.disposers.push(dispose);
    }
    domEvents = [];
    registerDomEvent(target, type, callback) {
        this.domEvents.push({ target, type, callback });
    }
}
class ItemView extends Component {
    constructor(leaf) {
        super();
        this.app = leaf.app;
        this.contentEl = new Element();
    }
}
class MarkdownView {}
class Plugin extends Component {
    registerView(type, create) {
        this.createView = create;
    }
    addCommand(command) {
        this.command = command;
    }
    registerEditorExtension(extension) {
        this.editorExtensions = extension;
    }
    addRibbonIcon(_icon, title, callback) {
        this.ribbon = { title, callback };
    }
    async loadData() {
        return this.savedData;
    }
    async saveData(data) {
        this.savedData = { ...data };
    }
    addSettingTab(tab) {
        this.settingsTab = tab;
    }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function harness(savedData, { language = 'en' } = {}) {
    const timers = new Map();
    let timerId = 0;
    const module = { exports: {} };
    vm.runInNewContext(readFileSync('main.js', 'utf8'), {
        module,
        exports: module.exports,
        require: (name) =>
            name === 'obsidian'
                ? {
                      getLanguage: () => language,
                      ItemView,
                      MarkdownView,
                      Plugin,
                      PluginSettingTab: class {
                          constructor() {
                              this.containerEl = new Element();
                          }
                      },
                      Setting: class {},
                      Notice: class {},
                      TFile: class {},
                  }
                : require(name),
        process,
        console,
        Buffer,
        URL,
        URLSearchParams,
        TextDecoder,
        TextEncoder,
        ReadableStream,
        WritableStream,
        TransformStream,
        Blob,
        File,
        FormData,
        AbortController,
        AbortSignal,
        MessagePort,
        DOMException,
        performance,
        structuredClone,
        Event,
        EventTarget,
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        document: { createElement: () => new Element(), body: new Element() },
        window: {},
    });
    const vault = new Events();
    const workspace = new Events();
    const first = { path: 'one.md', extension: 'md' };
    const second = { path: 'two.md', extension: 'md' };
    const contents = new Map([
        [first, '# First'],
        [second, '# Second'],
    ]);
    workspace.getActiveFile = () => first;
    let read = (file) => Promise.resolve(contents.get(file));
    vault.read = (file) => read(file);
    const app = { vault, workspace };
    const plugin = new module.exports.default();
    plugin.app = app;
    plugin.savedData = savedData;
    workspace.getActiveViewOfType = () => null;
    workspace.getLeavesOfType = () => [];
    await plugin.onload();
    const view = plugin.createView({ app });
    workspace.getLeavesOfType = (type) => (type === 'yfm-preview' ? [{ view }] : []);
    await view.onOpen();
    await flush();
    const frame = view.contentEl.children.find((element) => element.tag === 'iframe');
    return {
        plugin,
        view,
        frame,
        vault,
        workspace,
        first,
        second,
        contents,
        timers,
        setRead: (fn) => {
            read = fn;
        },
    };
}

test('saved changes invalidate immediately and render only after a 500 ms debounce', async () => {
    // Arrange
    const h = await harness();
    assert.match(h.frame.srcdoc, />First</);
    // Act
    h.contents.set(h.first, '# Changed');
    h.vault.emit('modify', h.first);
    h.vault.emit('modify', h.first);
    // Assert
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 500);
    assert.doesNotMatch(h.frame.srcdoc, />Changed</);
    assert.equal(h.plugin.cache.render(h.first.path, '# First').cacheHit, false);
    // Act
    [...h.timers.values()][0].callback();
    await flush();
    // Assert
    assert.match(h.frame.srcdoc, />Changed</);
    await h.view.onClose();
});

test('switching files rejects stale asynchronous reads and deletion clears the panel', async () => {
    // Arrange
    const h = await harness();
    let finishOldRead;
    h.setRead((file) =>
        file === h.first
            ? new Promise((resolve) => {
                  finishOldRead = resolve;
              })
            : Promise.resolve('# Second'),
    );
    // Act
    h.vault.emit('modify', h.first);
    [...h.timers.values()][0].callback();
    h.workspace.emit('file-open', h.second);
    await flush();
    finishOldRead('# Stale first file');
    await flush();
    // Assert
    assert.match(h.frame.srcdoc, />Second</);
    assert.doesNotMatch(h.frame.srcdoc, /Stale first file/);
    // Act & Assert
    h.vault.emit('delete', h.second);
    assert.equal(h.frame.srcdoc, '');
    await h.view.onClose();
});

test('persists custom delay and applies it to pending and future updates', async () => {
    // Arrange
    const h = await harness({ debounceMs: 1200, debugMode: false });
    // Act & Assert
    h.vault.emit('modify', h.first);
    assert.equal([...h.timers.values()][0].delay, 1200);
    await h.plugin.updateSettings({ debounceMs: 250 });
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 250);
    assert.equal(h.plugin.savedData.debounceMs, 250);
    await h.plugin.updateSettings({ debounceMs: 0 });
    h.vault.emit('modify', h.first);
    assert.equal([...h.timers.values()][0].delay, 0);
    await h.view.onClose();
});

test('debug mode toggles technical status without resetting the preview', async () => {
    // Arrange
    const h = await harness();
    const status = h.view.contentEl.children[0];
    const document = h.frame.srcdoc;
    // Act & Assert
    assert.equal(status.hidden, true);
    assert.equal(status.title, '');
    await h.plugin.updateSettings({ debugMode: true });
    assert.equal(status.hidden, false);
    assert.match(status.text, /SHA-256/);
    assert.match(status.title, /^[a-f0-9]{64}$/);
    assert.equal(h.plugin.savedData.debugMode, true);
    await h.plugin.updateSettings({ debugMode: false });
    assert.equal(status.hidden, true);
    assert.equal(status.title, '');
    assert.equal(h.frame.srcdoc, document);
    // Errors must stay visible with debug mode off.
    h.setRead(() => Promise.reject(new Error('Read failed')));
    h.workspace.emit('file-open', h.second);
    await flush();
    assert.equal(status.hidden, false);
    assert.match(status.text, /error/);
    await h.view.onClose();
});

test('invalid saved preferences fall back to defaults', async () => {
    // Arrange & Act
    const h = await harness({ debounceMs: -10, debugMode: 'false' });
    // Assert
    assert.equal(h.plugin.settings.debounceMs, 500);
    assert.equal(h.plugin.settings.debugMode, false);
    await h.view.onClose();
});

test('preview links replace the source editor instead of creating a tab over the preview', async () => {
    // Arrange
    const h = await harness();
    const source = { view: Object.assign(new MarkdownView(), { file: h.first }) };
    source.view.leaf = source;
    const other = { view: Object.assign(new MarkdownView(), { file: h.second }) };
    other.view.leaf = other;
    const preview = { view: h.view };
    h.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [other, source] : [preview]);
    h.workspace.getActiveViewOfType = () => source.view;
    h.workspace.emit('file-open', h.first);
    await flush();
    let active = preview;
    const calls = [];
    h.workspace.setActiveLeaf = (leaf) => {
        active = leaf;
    };
    h.workspace.openLinkText = async (href, sourcePath, newLeaf) => {
        calls.push({ href, sourcePath, newLeaf, leaf: active });
        active.view.file = h.second;
        h.workspace.getActiveViewOfType = () => active.view;
        h.workspace.emit('file-open', h.second);
    };
    h.workspace.getLeaf = () => {
        throw new Error('Must reuse an existing source leaf');
    };
    const handler = h.view.domEvents.find((event) => event.type === 'message').callback;
    // Act
    handler({ source: h.frame.contentWindow, data: { type: 'yfm-preview-link', href: 'two.md' } });
    await flush();
    // Assert
    assert.equal(calls.length, 1);
    assert.equal(calls[0].leaf, source);
    assert.equal(calls[0].newLeaf, false);
    assert.equal(calls[0].sourcePath, 'one.md');
    assert.equal(calls[0].href, 'two.md');
    assert.match(h.frame.srcdoc, />Second</);
    await h.view.onClose();
});

function menuItems() {
    const items = [];
    return {
        items,
        addItem(callback) {
            const item = {
                setTitle(title) {
                    this.title = title;
                    return this;
                },
                setIcon() {
                    return this;
                },
                setSection() {
                    return this;
                },
                onClick(click) {
                    this.click = click;
                    return this;
                },
            };
            callback(item);
            items.push(item);
        },
    };
}

test('editor and tab menus toggle the preview beside the context source pane', async () => {
    // Arrange
    const h = await harness();
    const source = { view: Object.assign(new MarkdownView(), { file: h.second }) };
    source.view.leaf = source;
    let previews = [];
    let active;
    h.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [source] : previews);
    h.workspace.setActiveLeaf = (leaf) => {
        active = leaf;
    };
    const preview = {
        async setViewState(state) {
            assert.equal(state.type, 'yfm-preview');
            previews.push(this);
        },
        detach() {
            previews = previews.filter((leaf) => leaf !== this);
        },
    };
    h.workspace.getLeaf = (mode, direction) => {
        assert.equal(active, source);
        assert.equal(mode, 'split');
        assert.equal(direction, 'vertical');
        return preview;
    };
    h.workspace.revealLeaf = async (leaf) => {
        assert.equal(leaf, preview);
    };
    const editorMenu = menuItems();
    // Act
    h.workspace.emit('editor-menu', editorMenu, {}, source.view);
    await editorMenu.items[0].click();
    // Assert
    assert.equal(editorMenu.items[0].title, 'Open YFM Preview to the right');
    assert.equal(h.plugin.currentFile, h.second);
    assert.equal(previews.length, 1);
    // Act
    const tabMenu = menuItems();
    h.workspace.emit('file-menu', tabMenu, h.second, 'more-options', source);
    await tabMenu.items[0].click();
    // Assert
    assert.equal(tabMenu.items[0].title, 'Close YFM Preview');
    assert.equal(previews.length, 0);
    await h.view.onClose();
});

test('command and ribbon close existing previews even without an active Markdown file', async () => {
    // Arrange
    const h = await harness();
    let closed = 0;
    h.workspace.getLeavesOfType = () => [
        {
            detach() {
                ++closed;
            },
        },
    ];
    h.workspace.getActiveFile = () => {
        throw new Error('Closing must not require a source file');
    };
    // Act
    h.plugin.command.callback();
    h.plugin.ribbon.callback();
    await flush();
    // Assert
    assert.equal(closed, 2);
    assert.equal(h.plugin.command.id, 'open-preview');
    assert.equal(h.plugin.command.name, 'Toggle preview');
    await h.view.onClose();
});

for (const [language, command, open, close, error] of [
    [
        'ru',
        'Переключить предпросмотр',
        'Открыть YFM Preview справа',
        'Закрыть YFM Preview',
        'ошибка',
    ],
    ['fr', 'Toggle preview', 'Open YFM Preview to the right', 'Close YFM Preview', 'error'],
]) {
    test(`uses Obsidian language ${language} for commands, menus and errors`, async () => {
        // Arrange
        const h = await harness(undefined, { language });
        const source = { view: Object.assign(new MarkdownView(), { file: h.first }) };
        source.view.leaf = source;
        let previews = [];
        h.workspace.getLeavesOfType = (type) => (type === 'markdown' ? [source] : previews);
        // Act & Assert
        assert.equal(h.plugin.command.name, command);
        let menu = menuItems();
        h.workspace.emit('editor-menu', menu, {}, source.view);
        assert.equal(menu.items[0].title, open);
        previews = [{ view: h.view }];
        menu = menuItems();
        h.workspace.emit('file-menu', menu, h.first, 'more-options', source);
        assert.equal(menu.items[0].title, close);
        h.setRead(() => Promise.reject(new Error('Read failed')));
        h.workspace.emit('file-open', h.second);
        await flush();
        assert.match(h.view.contentEl.children[0].text, new RegExp(error));
        await h.view.onClose();
    });
}

test('highlighting setting reconfigures editors and persists without reloading the plugin', async () => {
    // Arrange
    const h = await harness();
    const extension = h.plugin.editorExtensions;
    let updates = 0;
    h.workspace.updateOptions = () => {
        ++updates;
    };
    // Act & Assert
    assert.equal(extension.length, 1);
    await h.plugin.updateSettings({ highlightYfm: false });
    assert.equal(extension.length, 0);
    assert.equal(h.plugin.savedData.highlightYfm, false);
    await h.plugin.updateSettings({ highlightYfm: true });
    assert.equal(extension.length, 1);
    assert.equal(updates, 2);
    await h.view.onClose();
});
