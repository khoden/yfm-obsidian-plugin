import type { Text, Range } from '@codemirror/state';
import { Decoration } from '@codemirror/view';

type BlockKind = 'note' | 'cut' | 'list';
export interface YfmBlock {
    from: number;
    to: number;
    kind: BlockKind;
    variant: string;
    depth: number;
    bodyFrom: number;
    bodyTo: number;
}

/** Shared source ranges and styling for editor and reading-view adapters. */
export function analyzeYfm(doc: Text, excluded: { from: number; to: number }[]) {
    const source = doc.toString();
    const ranges: Range<Decoration>[] = [];
    const stack: YfmBlock[] = [];
    const blocks: YfmBlock[] = [];
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
                top.bodyTo = from;
                blocks.push(stack.pop()!);
            }
        } else {
            const variant =
                kind === 'note'
                    ? (/^(info|tip|warning|alert)\b/.exec(match[2].trim())?.[1] ?? 'info')
                    : '';
            stack.push({
                from,
                to: source.length,
                kind,
                variant,
                depth: stack.length,
                bodyFrom: to,
                bodyTo: source.length,
            });
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
    const isExcluded = (from: number, to: number) =>
        excluded.some((range) => range.from < to && from < range.to);
    const metadata = (from: number, to: number) => {
        if (!isExcluded(from, to))
            ranges.push(
                Decoration.mark({
                    class: 'cm-formatting cm-formatting-header yfm-source-meta',
                }).range(from, to),
            );
    };
    for (const heading of source.matchAll(/^ {0,3}#{1,6}[ \t]+.*$/gm)) {
        for (const anchor of heading[0].matchAll(/\{#[^{}\s]+\}/g)) {
            const from = heading.index + anchor.index;
            if (source[from - 1] !== '\\') metadata(from, from + anchor[0].length);
        }
    }
    for (const block of blocks.filter((block) => block.kind === 'list')) {
        const titles: { from: number; text: string; indent: number }[] = [];
        for (let line = doc.lineAt(block.bodyFrom); line.from < block.bodyTo; ) {
            const title = /^([ \t]*)[-+*][ \t]+(.+)$/.exec(line.text);
            if (
                title &&
                !isExcluded(line.from, line.to) &&
                !blocks.some(
                    (child) =>
                        child.depth > block.depth &&
                        child.from <= line.from &&
                        line.from < child.to,
                )
            ) {
                titles.push({
                    from: line.to - title[2].length,
                    text: title[2],
                    indent: title[1].replace(/\t/g, '    ').length,
                });
            }
            if (line.number === doc.lines) break;
            line = doc.line(line.number + 1);
        }
        const indent = Math.min(...titles.map((title) => title.indent));
        for (const title of titles.filter((title) => title.indent === indent)) {
            const attributes = /(?:\s*\{[^{}]+\})+\s*$/.exec(title.text);
            const end = attributes?.index ?? title.text.trimEnd().length;
            if (end > 0)
                ranges.push(
                    Decoration.mark({ class: 'yfm-source-tab-title' }).range(
                        title.from,
                        title.from + end,
                    ),
                );
            if (attributes) {
                for (const attribute of attributes[0].matchAll(/\{[^{}]+\}/g)) {
                    const from = title.from + attributes.index + attribute.index;
                    metadata(from, from + attribute[0].length);
                }
            }
        }
    }
    return { ranges, blocks };
}

/** Returns the same block classes for both rendering modes. */
export function blockClassNames(
    block: YfmBlock,
    { start = false, end = false }: { start?: boolean; end?: boolean } = {},
): string {
    return `yfm-source-block yfm-source-${block.kind}${block.variant ? ` yfm-source-note-${block.variant}` : ''}${start ? ' yfm-source-block-start' : ''}${end ? ' yfm-source-block-end' : ''}`;
}
