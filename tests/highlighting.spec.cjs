const { test, expect } = require('@playwright/test');
const { build } = require('esbuild');
const { readFileSync } = require('node:fs');
const path = require('node:path');
let client;
const source = readFileSync('test-vault/03-Highlighting.md', 'utf8');

test.beforeAll(async () => {
    const result = await build({
        stdin: {
            contents: `
            import {Compartment} from '@codemirror/state';
            import {EditorView} from '@codemirror/view';
            import {markdown} from '@codemirror/lang-markdown';
            import {yfmSourceHighlighting} from './src/highlighting';
            window.mountEditor = (doc) => {
                const compartment = new Compartment();
                window.testEditor = new EditorView({doc, extensions:[markdown(), compartment.of(yfmSourceHighlighting)], parent:document.getElementById('editor')});
                window.toggleHighlighting = enabled => window.testEditor.dispatch({effects:compartment.reconfigure(enabled ? yfmSourceHighlighting : [])});
            };
        `,
            resolveDir: process.cwd(),
        },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        write: false,
    });
    client = result.outputFiles[0].text;
});

async function mount(page, dark, { doc = source } = {}) {
    await page.setViewportSize({ width: 1000, height: 1400 });
    await page.setContent('<div id="editor"></div>');
    await page.addStyleTag({
        content: `
        :root {--text-normal:${dark ? '#ddd' : '#222'};--text-accent:${dark ? '#ac8fff' : '#7048c8'};--text-faint:${dark ? '#999' : '#666'};--color-blue:#448aff;--color-purple:#a26fff;--color-cyan:#00a8af;--color-green:#399455;--color-orange:#d17d11;--color-red:#df4545;}
        .cm-content {padding-inline:12px !important;}
        body {background:${dark ? '#202020' : 'white'};color:var(--text-normal);font:15px/1.6 monospace;}
        ${readFileSync('styles.css', 'utf8')}
    `,
    });
    await page.addScriptTag({ content: client });
    await page.evaluate((source) => window.mountEditor(source), doc);
}

for (const dark of [false, true]) {
    test(`highlights nested YFM blocks and excludes code examples in the ${dark ? 'dark' : 'light'} theme`, async ({
        page,
    }) => {
        // Arrange
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await mount(page, dark);
        const lines = page.locator('.cm-line');
        // Assert
        await expect(lines.filter({ hasText: 'У примечания есть фон' })).toHaveClass(
            /yfm-source-note-warning/,
        );
        await expect(lines.filter({ hasText: 'У вложенного блока свой фон' })).toHaveClass(
            /yfm-source-cut/,
        );
        await expect(lines.filter({ hasText: 'Текст вкладки.' })).toHaveClass(/yfm-source-list/);
        await expect(lines.filter({ hasText: 'Обычный текст вне блока.' })).not.toHaveClass(
            /yfm-source-block/,
        );
        await expect(
            lines.filter({ hasText: 'Inline:' }).locator('.yfm-source-keyword'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: 'Пример внутри fenced code' }).locator('.yfm-source-keyword'),
        ).toHaveCount(0);
        await expect(lines.filter({ hasText: 'Добавьте закрывающий тег' })).toHaveClass(
            /yfm-source-note-tip/,
        );
        await expect(
            page.locator('.yfm-source-keyword').filter({ hasText: 'endnote' }),
        ).toHaveCount(1);
        await expect(
            page.locator('.yfm-source-string').filter({ hasText: 'Внешнее примечание' }),
        ).toHaveCount(1);
        expect(
            await lines
                .filter({ hasText: 'У вложенного блока свой фон' })
                .evaluate((element) => getComputedStyle(element, '::before').backgroundColor),
        ).not.toBe('rgba(0, 0, 0, 0)');
        expect(errors).toEqual([]);
        await page.screenshot({
            path: path.resolve(`.test/highlighting-${dark ? 'dark' : 'light'}.png`),
            fullPage: true,
        });
        // Act: closing an unfinished block must remove the background from the following lines.
        await page.evaluate(() => {
            const editor = window.testEditor;
            editor.dispatch({
                changes: {
                    from: editor.state.doc.length,
                    insert: '\n{% endnote %}\n\nAfter close',
                },
            });
        });
        // Assert
        await expect(lines.filter({ hasText: 'After close' })).not.toHaveClass(/yfm-source-block/);
        // Act: disable and enable without changing source text.
        await page.evaluate(() => window.toggleHighlighting(false));
        await expect(page.locator('.yfm-source-block')).toHaveCount(0);
        const textPosition = () =>
            lines.filter({ hasText: 'У вложенного блока свой фон' }).evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                const { x, y } = range.getBoundingClientRect();
                return { x, y };
            });
        const before = await textPosition();
        await page.evaluate(() => window.toggleHighlighting(true));
        await expect(lines.filter({ hasText: 'У вложенного блока свой фон' })).toHaveClass(
            /yfm-source-cut/,
        );
        expect(await textPosition()).toEqual(before);
        expect(errors).toEqual([]);
    });
}

for (const dark of [false, true]) {
    test(`styles heading anchors and tab labels in the ${dark ? 'dark' : 'light'} theme`, async ({
        page,
    }) => {
        // Arrange
        await mount(page, dark, { doc: readFileSync('test-vault/04-Anchors-and-tabs.md', 'utf8') });
        await page.addStyleTag({
            content:
                ':root {--heading-formatting:rgb(123, 98, 150);} .cm-formatting-header {color:var(--heading-formatting);}',
        });
        const lines = page.locator('.cm-line');
        const anchor = page.locator('.yfm-source-meta').filter({ hasText: '{#header-id}' });
        const selected = page.locator('.yfm-source-meta').filter({ hasText: '{selected}' });
        // Assert
        await expect(anchor).toHaveCount(1);
        await expect(anchor).toHaveCSS('color', 'rgb(123, 98, 150)');
        await expect(selected).toHaveCount(2);
        for (const marker of await selected.all()) {
            await expect(marker).toHaveCSS('color', 'rgb(123, 98, 150)');
            await expect(marker).toHaveCSS('font-weight', '400');
        }
        const first = page.locator('.yfm-source-tab-title').filter({ hasText: 'Первая вкладка' });
        await expect(first).toHaveCSS('font-weight', '700');
        await expect(first).toHaveText('Первая вкладка');
        await expect(page.locator('.yfm-source-tab-title')).toHaveCount(3);
        await expect(
            lines
                .filter({ hasText: 'Обычная строка содержимого' })
                .locator('.yfm-source-tab-title'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: 'Вложенный пункт списка' }).locator('.yfm-source-tab-title'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: 'Обычный список вне' }).locator('.yfm-source-tab-title'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: '{#inline-code}' }).locator('.yfm-source-meta'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: '{#code-example}' }).locator('.yfm-source-meta'),
        ).toHaveCount(0);
        await expect(
            lines
                .filter({ hasText: 'Пример вкладки' })
                .locator('.yfm-source-tab-title, .yfm-source-meta'),
        ).toHaveCount(0);
    });
}

for (const dark of [false, true]) {
    test(`frames multiline tables and colors their markers in the ${dark ? 'dark' : 'light'} editor`, async ({
        page,
    }) => {
        // Arrange
        const doc = readFileSync('test-vault/06-Multiline-tables.md', 'utf8');
        await mount(page, dark, { doc });
        await page.addStyleTag({
            content:
                ':root {--code-background:rgb(50, 60, 70);--background-modifier-border:rgb(110, 120, 130);--heading-formatting:rgb(123, 98, 150);}',
        });
        const lines = page.locator('.cm-line');
        const table = lines.filter({ hasText: '|| Раздел | Описание' });
        // Assert
        await expect(table).toHaveClass(/yfm-source-table/);
        for (const marker of await page.locator('.yfm-source-table-marker').all()) {
            await expect(marker).toHaveCSS('color', 'rgb(123, 98, 150)');
        }
        await expect(page.locator('.yfm-source-table-marker').filter({ hasText: '^' })).toHaveCount(
            1,
        );
        await expect(page.locator('.yfm-source-table-marker').filter({ hasText: '>' })).toHaveCount(
            1,
        );
        await expect(lines.filter({ hasText: 'Обычный текст после' })).not.toHaveClass(
            /yfm-source-table/,
        );
        await expect(
            lines.filter({ hasText: '|| Это | Пример' }).locator('.yfm-source-table-marker'),
        ).toHaveCount(0);
        await expect(
            lines.filter({ hasText: '`#| || |# ^`' }).locator('.yfm-source-table-marker'),
        ).toHaveCount(0);
        const escaped = lines.filter({ hasText: 'Текст с \\|' });
        const escapedMarkers = await escaped.locator('.yfm-source-table-marker').allTextContents();
        expect(escapedMarkers).toEqual(['||', '|', '||']);
        const style = await table.evaluate((line) => {
            const s = getComputedStyle(line, '::before');
            return [
                s.backgroundColor,
                s.borderLeftWidth,
                s.borderRightWidth,
                s.borderTopWidth,
                s.borderRadius,
            ];
        });
        expect(style).toEqual(['rgb(50, 60, 70)', '1px', '1px', '0px', '0px']);
        const textPosition = () =>
            table.evaluate((line) => {
                const range = document.createRange();
                range.selectNodeContents(line);
                return range.getBoundingClientRect().x;
            });
        const before = await textPosition();
        // Act: toggling decorations must not move table text.
        await page.evaluate(() => window.toggleHighlighting(false));
        expect(await textPosition()).toBe(before);
        await page.evaluate(() => window.toggleHighlighting(true));
        await expect(table).toHaveClass(/yfm-source-table/);
        await page.screenshot({
            path: path.resolve(`.test/tables-editor-${dark ? 'dark' : 'light'}.png`),
            fullPage: true,
        });
    });
}
