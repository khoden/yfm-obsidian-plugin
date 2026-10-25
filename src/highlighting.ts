import { syntaxTree } from '@codemirror/language';
import { analyzeYfm, blockClassNames, backgroundBlock } from './yfm-markup';
import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view';

function decorations(view: EditorView): DecorationSet {
    const { state } = view;
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
    const { ranges, blocks } = analyzeYfm(state.doc, excluded);
    const lineBlocks = blocks.map((block) => ({
        ...block,
        from: state.doc.lineAt(block.from).from,
        to: state.doc.lineAt(block.to).from,
    }));
    const decoratedLines = new Set<number>();
    for (const visible of view.visibleRanges) {
        for (let line = state.doc.lineAt(visible.from); line.from <= visible.to; ) {
            const active = backgroundBlock(
                lineBlocks.filter((block) => block.from <= line.from && line.from <= block.to),
            );
            if (active && !decoratedLines.has(line.from)) {
                ranges.push(
                    Decoration.line({
                        class: blockClassNames(active, {
                            start: active.from === line.from,
                            end: active.to === line.from,
                        }),
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
