import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view';

type BlockKind = 'note' | 'cut' | 'list';
interface Block {
    from: number;
    to: number;
    kind: BlockKind;
    variant: string;
    depth: number;
}

function decorations(view: EditorView): DecorationSet {
    const { state } = view;
    const source = state.doc.toString();
    const excluded: { from: number; to: number }[] = [];
    syntaxTree(state).iterate({
        enter(node) {
            // Support standard Markdown nodes and Obsidian's stream-parser token names.
            if (/code|frontmatter|comment|^htmlblock$/i.test(node.name)) {
                excluded.push({ from: node.from, to: node.to });
                return false;
            }
        },
    });
    const ranges: Range<Decoration>[] = [];
    const stack: Block[] = [];
    const blocks: Block[] = [];
    const tags =
        /\{%\s*(endnote|endcut|endlist|note|cut|list)\b((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'%]|%(?!}))*?)%}/g;
    let excludedIndex = 0;
    for (const match of source.matchAll(tags)) {
        const from = match.index;
        const to = from + match[0].length;
        while (excludedIndex < excluded.length && excluded[excludedIndex].to <= from)
            ++excludedIndex;
        if (excluded[excludedIndex]?.from < to) continue;
        let escapes = 0;
        for (let i = from - 1; i >= 0 && source[i] === '\\'; --i) ++escapes;
        if (escapes % 2) continue;
        const name = match[1];
        const closing = name.startsWith('end');
        const kind = (closing ? name.slice(3) : name) as BlockKind;
        if (!closing && kind === 'list' && !/^tabs\b/.test(match[2].trim())) continue;
        if (closing) {
            const top = stack.at(-1);
            if (top?.kind === kind) {
                top.to = to;
                blocks.push(stack.pop()!);
            }
        } else {
            const variant =
                kind === 'note'
                    ? (/^(info|tip|warning|alert)\b/.exec(match[2].trim())?.[1] ?? 'info')
                    : '';
            stack.push({ from, to: source.length, kind, variant, depth: stack.length });
        }
        const tokens = /\{%|%\}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s%{}]+|[%{}]/g;
        let keyword = true;
        for (const token of match[0].matchAll(tokens)) {
            let role: string;
            if (token[0] === '{%' || token[0] === '%}') role = 'delimiter';
            else if (keyword) {
                role = 'keyword';
                keyword = false;
            } else role = /^['"]/.test(token[0]) ? 'string' : 'parameter';
            ranges.push(
                Decoration.mark({ class: `yfm-source-${role}` }).range(
                    from + token.index,
                    from + token.index + token[0].length,
                ),
            );
        }
    }
    blocks.push(...stack);
    const lineBlocks = blocks.map((block) => ({
        ...block,
        from: state.doc.lineAt(block.from).from,
        to: state.doc.lineAt(block.to).from,
    }));
    const decoratedLines = new Set<number>();
    for (const visible of view.visibleRanges) {
        for (let line = state.doc.lineAt(visible.from); line.from <= visible.to; ) {
            const active = lineBlocks
                .filter((block) => block.from <= line.from && line.from <= block.to)
                .reduce<Block | null>(
                    (deepest, block) => (!deepest || block.depth > deepest.depth ? block : deepest),
                    null,
                );
            if (active && !decoratedLines.has(line.from)) {
                const variant = active.variant ? ` yfm-source-note-${active.variant}` : '';
                const start = active.from === line.from ? ' yfm-source-block-start' : '';
                const end = active.to === line.from ? ' yfm-source-block-end' : '';
                ranges.push(
                    Decoration.line({
                        class: `yfm-source-block yfm-source-${active.kind}${variant}${start}${end}`,
                    }).range(line.from),
                );
                decoratedLines.add(line.from);
            }
            if (line.number === state.doc.lines) break;
            line = state.doc.line(line.number + 1);
        }
    }
    return Decoration.set(ranges, true);
}

/** Adds YFM token colors and nested block backgrounds without replacing the Markdown editor. */
export const yfmSourceHighlighting = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = decorations(view);
        }

        update(update: ViewUpdate): void {
            if (
                update.docChanged ||
                update.viewportChanged ||
                syntaxTree(update.startState) !== syntaxTree(update.state)
            ) {
                this.decorations = decorations(update.view);
            }
        }
    },
    { decorations: (plugin) => plugin.decorations },
);
