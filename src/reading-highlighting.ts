import { Text } from '@codemirror/state';
import MarkdownIt from 'markdown-it';
import { analyzeYfm, blockClassNames, backgroundBlock } from './yfm-markup';

interface Section {
    lineStart: number;
    lineEnd: number;
}
const markdown = new MarkdownIt({ html: true });

function parse(source: string) {
    const doc = Text.of(source.split('\n'));
    const tokens = markdown.parse(source, {});
    const offset = (line: number) => (line >= doc.lines ? doc.length : doc.line(line + 1).from);
    const excluded: { from: number; to: number }[] = [];
    const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
        source,
    );
    if (frontmatter) excluded.push({ from: 0, to: frontmatter[0].length });
    for (const token of tokens) {
        if (!token.map) continue;
        const from = offset(token.map[0]);
        const to = offset(token.map[1]);
        if (['fence', 'code_block', 'html_block'].includes(token.type)) excluded.push({ from, to });
        if (
            token.type !== 'inline' ||
            !token.children?.some((child) => child.type === 'code_inline')
        )
            continue;
        const raw = source.slice(from, to);
        const ticks = Array.from(raw.matchAll(/`+/g));
        for (let i = 0; i < ticks.length; ++i) {
            let escapes = 0;
            for (let p = ticks[i].index - 1; p >= 0 && raw[p] === '\\'; --p) ++escapes;
            if (escapes % 2) continue;
            const end = ticks.findIndex(
                (run, index) => index > i && run[0].length === ticks[i][0].length,
            );
            if (end < 0) continue;
            excluded.push({
                from: from + ticks[i].index,
                to: from + ticks[end].index + ticks[end][0].length,
            });
            i = end;
        }
    }
    excluded.sort((a, b) => a.from - b.from);
    return { doc, tokens, offset, ...analyzeYfm(doc, excluded) };
}

type Parsed = ReturnType<typeof parse>;

function clear(element: HTMLElement): void {
    for (const span of element.querySelectorAll('.yfm-reading-mark'))
        span.replaceWith(...span.childNodes);
    for (const block of [
        element,
        ...element.querySelectorAll<HTMLElement>('[data-yfm-reading-block]'),
    ]) {
        if (!block.hasAttribute('data-yfm-reading-block')) continue;
        for (const name of [...block.classList]) {
            if (name === 'yfm-reading-block' || name.startsWith('yfm-source-'))
                block.classList.remove(name);
        }
        block.removeAttribute('data-yfm-reading-block');
        block.style.removeProperty('--yfm-reading-left');
        block.style.removeProperty('--yfm-reading-right');
        block.style.removeProperty('--yfm-reading-top');
        block.style.removeProperty('--yfm-reading-bottom');
    }
}

function highlight(element: HTMLElement, section: Section, source: string, parsed: Parsed): void {
    const from = parsed.offset(section.lineStart);
    const to = parsed.offset(section.lineEnd + 1);
    const nodes: { node: globalThis.Text; from: number; to: number }[] = [];
    const document = element.ownerDocument;
    const walker = document.createTreeWalker(element, 4);
    let text = '';
    while (walker.nextNode()) {
        const node = walker.currentNode as globalThis.Text;
        if (
            node.parentElement?.closest(
                'pre, code, script, style, .frontmatter, .metadata-container, .list-bullet, .collapse-indicator',
            )
        )
            continue;
        nodes.push({ node, from: text.length, to: text.length + node.length });
        text += node.data;
    }
    const spans: { node: globalThis.Text; from: number; to: number; className: string }[] = [];
    let cursor = 0;
    let sourceCursor = from;
    const marks = parsed.ranges
        .filter((mark) => from <= mark.from && mark.to <= to)
        .sort((a, b) => a.from - b.from);
    for (const mark of marks) {
        const raw = source.slice(mark.from, mark.to);
        const temporary = document.createElement('div');
        // Render inline formatting to match the visible native text; never execute source HTML.
        temporary.innerHTML = markdown.renderInline(raw.replace(/</g, '&lt;'));
        const needle = temporary.textContent ?? '';
        if (!needle) continue;
        if (mark.value.spec.class.includes('yfm-source-table-marker')) {
            // Escaped separators remain visible but have no decoration in the source model.
            // Skip their visible occurrences before searching for the next real marker.
            temporary.innerHTML = markdown.render(
                source.slice(sourceCursor, mark.from).replace(/</g, '&lt;'),
            );
            for (const code of temporary.querySelectorAll('pre, code')) code.remove();
            const skipped = (temporary.textContent ?? '').split(needle).length - 1;
            for (let i = 0; i < skipped; ++i) {
                const position = text.indexOf(needle, cursor);
                if (position < 0) break;
                cursor = position + needle.length;
            }
        }
        const start = text.indexOf(needle, cursor);
        if (start < 0) continue;
        const end = start + needle.length;
        for (const entry of nodes) {
            if (entry.to <= start || entry.from >= end) continue;
            spans.push({
                node: entry.node,
                from: Math.max(start, entry.from) - entry.from,
                to: Math.min(end, entry.to) - entry.from,
                className: mark.value.spec.class,
            });
        }
        cursor = end;
        sourceCursor = mark.to;
    }
    for (const span of spans.reverse()) {
        const selected = span.node.splitText(span.from);
        selected.splitText(span.to - span.from);
        const wrapper = document.createElement('span');
        wrapper.className = `yfm-reading-mark ${span.className}`;
        selected.replaceWith(wrapper);
        wrapper.append(selected);
    }
    const elements = Array.from(element.querySelectorAll<HTMLElement>('*'));
    if (element.matches('p, ul, ol, li, blockquote, table, pre, h1, h2, h3, h4, h5, h6'))
        elements.unshift(element);
    let index = 0;
    for (const token of parsed.tokens) {
        // List maps may include trailing blank lines omitted by Obsidian's section bounds.
        if (!token.map || token.map[0] < section.lineStart || token.map[0] > section.lineEnd)
            continue;
        if (token.nesting < 0 || token.type === 'inline' || token.hidden) continue;
        const tag = ['fence', 'code_block'].includes(token.type) ? 'pre' : token.tag;
        if (!tag) continue;
        const found = elements.findIndex(
            (node, position) => position >= index && node.tagName.toLowerCase() === tag,
        );
        if (found < 0) continue;
        const node = elements[found];
        index = found + 1;
        const start = parsed.offset(token.map[0]);
        const active = backgroundBlock(
            parsed.blocks.filter(
                (block) => parsed.doc.lineAt(block.from).from <= start && start < block.to,
            ),
        );
        if (!active) continue;
        if (
            node.parentElement
                ?.closest('[data-yfm-reading-block]')
                ?.getAttribute('data-yfm-reading-block') === String(active.from)
        )
            continue;
        node.classList.add(
            'yfm-reading-block',
            ...blockClassNames(active, {
                start: parsed.doc.lineAt(active.from).number - 1 === token.map[0],
                end: parsed.doc.lineAt(active.to).number - 1 < token.map[1],
            }).split(' '),
        );
        node.setAttribute('data-yfm-reading-block', String(active.from));
    }
}

/** Styles native reading sections using the shared YFM model and preserves their Markdown DOM. */
export class ReadingHighlighter {
    private readonly sections = new Map<
        HTMLElement,
        { section: Section; source: string; backgrounds: HTMLElement[] }
    >();
    private observer: ResizeObserver | null = null;
    private readonly cache = new Map<string, Parsed>();
    private enabled = true;

    /** Records a section so settings can be applied without reloading the plugin. */
    process(element: HTMLElement, section: Section, source: string): void {
        const previous = this.sections.get(element);
        if (previous)
            for (const node of [element, ...previous.backgrounds]) this.observer?.unobserve(node);
        clear(element);
        const record = { section, source, backgrounds: [] as HTMLElement[] };
        this.sections.set(element, record);
        if (!this.enabled) return;
        let parsed = this.cache.get(source);
        if (!parsed) {
            parsed = parse(source);
            this.cache.set(source, parsed);
            if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
        }
        highlight(element, section, source, parsed);
        record.backgrounds = [
            element,
            ...element.querySelectorAll<HTMLElement>('[data-yfm-reading-block]'),
        ].filter((node) => node.hasAttribute('data-yfm-reading-block'));
        const Observer = element.ownerDocument.defaultView?.ResizeObserver;
        if (!this.observer && Observer) this.observer = new Observer(() => this.alignBackgrounds());
        if (record.backgrounds.length) {
            for (const node of [element, ...record.backgrounds]) this.observer?.observe(node);
        }
        this.alignBackgrounds();
    }

    private alignBackgrounds(): void {
        interface Background {
            node: HTMLElement;
            rect: DOMRect;
            source: string;
            id: string | null;
            left: number;
            right: number;
            top: number;
            bottom: number;
        }
        const groups = new Map<HTMLElement, Background[]>();
        for (const [element, record] of this.sections) {
            if (!element.isConnected) continue;
            let reference = element;
            while (reference.matches('ul, ol, li') && reference.parentElement)
                reference = reference.parentElement;
            const column = reference.getBoundingClientRect();
            for (const node of record.backgrounds) {
                if (!node.getClientRects().length) continue;
                const rect = node.getBoundingClientRect();
                const parent =
                    node.parentElement?.closest<HTMLElement>('[data-yfm-reading-block]') ??
                    element.closest<HTMLElement>('.markdown-rendered') ??
                    reference;
                const entries = groups.get(parent) ?? [];
                entries.push({
                    node,
                    rect,
                    source: record.source,
                    id: node.getAttribute('data-yfm-reading-block'),
                    left: column.left - rect.left - 4,
                    right: rect.right - column.right - 4,
                    top: node.classList.contains('yfm-source-block-start') ? -4 : 0,
                    bottom: node.classList.contains('yfm-source-block-end') ? -4 : 0,
                });
                groups.set(parent, entries);
            }
        }
        for (const entries of groups.values()) {
            entries.sort((a, b) => (a.node.compareDocumentPosition(b.node) & 4 ? -1 : 1));
            for (let i = 1; i < entries.length; ++i) {
                const previous = entries[i - 1];
                const current = entries[i];
                const gap = current.rect.top - previous.rect.bottom;
                // Join only adjacent pieces of the same block in this native rendering context.
                if (previous.source === current.source && previous.id === current.id && gap >= 0) {
                    previous.bottom = -gap / 2;
                    current.top = -gap / 2;
                }
            }
            for (const entry of entries) {
                entry.node.style.setProperty('--yfm-reading-left', `${entry.left}px`);
                entry.node.style.setProperty('--yfm-reading-right', `${entry.right}px`);
                entry.node.style.setProperty('--yfm-reading-top', `${entry.top}px`);
                entry.node.style.setProperty('--yfm-reading-bottom', `${entry.bottom}px`);
            }
        }
    }

    /** Reports whether a section already has a registered rendering lifecycle. */
    has(element: HTMLElement): boolean {
        return this.sections.has(element);
    }

    /** Releases removed reading sections and their decorations. */
    forget(element: HTMLElement): void {
        const record = this.sections.get(element);
        if (record)
            for (const node of [element, ...record.backgrounds]) this.observer?.unobserve(node);
        clear(element);
        this.sections.delete(element);
        this.alignBackgrounds();
    }

    /** Updates all tracked sections when highlighting is toggled. */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        for (const [element, record] of this.sections)
            this.process(element, record.section, record.source);
    }

    /** Restores native reading markup and releases caches on plugin unload. */
    dispose(): void {
        this.observer?.disconnect();
        this.observer = null;
        for (const element of this.sections.keys()) clear(element);
        this.sections.clear();
        this.cache.clear();
    }
}
