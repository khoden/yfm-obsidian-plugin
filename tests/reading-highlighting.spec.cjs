const { test, expect } = require('@playwright/test');
const { build } = require('esbuild');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({ html: true });
let client;

test.beforeAll(async () => {
    const result = await build({
        stdin: {
            contents: `
        import {ReadingHighlighter} from './src/reading-highlighting';
        window.readingHighlighter = new ReadingHighlighter();
        window.highlightSections = (source, reverse) => {
            const sections = [...document.querySelectorAll('#reading > section')];
            if (reverse) sections.reverse();
            for (const element of sections) window.readingHighlighter.process(element, {
                lineStart:Number(element.dataset.start), lineEnd:Number(element.dataset.end)
            }, source);
        };
    `,
            resolveDir: process.cwd(),
        },
        bundle: true,
        platform: 'browser',
        alias: { 'markdown-it': require.resolve('markdown-it/dist/markdown-it.js') },
        format: 'iife',
        target: 'es2022',
        write: false,
    });
    client = result.outputFiles[0].text;
});

function sections(source) {
    const tokens = markdown.parse(source, {});
    const lines = source.split('\n');
    const output = [];
    for (let i = 0; i < tokens.length; ) {
        const start = i;
        const token = tokens[i++];
        if (!token.map) continue;
        if (token.nesting === 1) {
            let depth = 1;
            while (i < tokens.length && depth) depth += tokens[i++].nesting;
        }
        let lineEnd = token.map[1] - 1;
        // Native reading sections omit trailing blank lines, unlike markdown-it's list maps.
        while (lineEnd > token.map[0] && !lines[lineEnd].trim()) --lineEnd;
        output.push(
            `<section data-start="${token.map[0]}" data-end="${lineEnd}">${markdown.renderer.render(tokens.slice(start, i), markdown.options, {})}</section>`,
        );
    }
    return output.join('');
}

async function mount(page, source, dark) {
    await page.setViewportSize({ width: 1000, height: 1600 });
    await page.setContent(
        `<main id="reading" class="markdown-rendered">${sections(source)}</main>`,
    );
    await page.addStyleTag({
        content: `
        :root {--text-normal:${dark ? '#ddd' : '#222'};--background-primary:${dark ? '#202020' : 'white'};--text-accent:${dark ? '#ac8fff' : '#7048c8'};--text-faint:${dark ? '#999' : '#666'};--heading-formatting:var(--text-faint);--color-blue:#448aff;--color-purple:#a26fff;--color-cyan:#00a8af;--color-green:#399455;--color-orange:#d17d11;--color-red:#df4545;--p-spacing:16px;}
        body {background:var(--background-primary);color:var(--text-normal);font:16px/1.5 sans-serif;padding:20px;}
        p,ul,ol {margin:0 0 var(--p-spacing);} pre {background:#8882;}
        ${readFileSync('styles.css', 'utf8')}
    `,
    });
    await page.addScriptTag({ content: client });
}

for (const dark of [false, true]) {
    test(`highlights native reading sections independently in the ${dark ? 'dark' : 'light'} theme`, async ({
        page,
    }) => {
        // Arrange
        const source = readFileSync('test-vault/03-Highlighting.md', 'utf8');
        await mount(page, source, dark);
        const before = await page.locator('#reading').textContent();
        const codeBefore = await page.locator('pre').innerHTML();
        // Act: section rendering can arrive in any order.
        await page.evaluate((source) => window.highlightSections(source, true), source);
        // Assert
        expect(await page.locator('#reading').textContent()).toBe(before);
        expect(await page.locator('pre').innerHTML()).toBe(codeBefore);
        await expect(page.locator('p').filter({ hasText: 'У примечания есть фон' })).toHaveClass(
            /yfm-source-note-warning/,
        );
        await expect(
            page.locator('p').filter({ hasText: 'У вложенного блока свой фон' }),
        ).toHaveClass(/yfm-source-cut/);
        await expect(
            page.locator('.yfm-source-keyword').filter({ hasText: 'endnote' }),
        ).toHaveCount(1);
        await expect(page.locator('pre .yfm-reading-mark,code .yfm-reading-mark')).toHaveCount(0);
        await expect(
            page.locator('p').filter({ hasText: 'Обычный текст вне блока' }),
        ).not.toHaveClass(/yfm-source-block/);
        await page.screenshot({
            path: path.resolve(`.test/reading-${dark ? 'dark' : 'light'}.png`),
            fullPage: true,
        });
        const gap = await page.evaluate(() => {
            const opening = document.querySelector(
                'p.yfm-source-note-warning.yfm-source-block-start',
            );
            const content = [...document.querySelectorAll('p.yfm-source-note-warning')].find(
                (node) => node.textContent.includes('У примечания есть фон'),
            );
            const bottom =
                opening.getBoundingClientRect().bottom -
                parseFloat(getComputedStyle(opening, '::before').bottom);
            const top =
                content.getBoundingClientRect().top +
                parseFloat(getComputedStyle(content, '::before').top);
            return top - bottom;
        });
        expect(Math.abs(gap)).toBeLessThan(1);
        const count = await page.locator('.yfm-reading-mark').count();
        // Act: refresh must not nest duplicate spans.
        await page.evaluate((source) => window.highlightSections(source, false), source);
        await expect(page.locator('.yfm-reading-mark')).toHaveCount(count);
        // The shared setting removes and reapplies decorations to existing sections.
        await page.evaluate(() => window.readingHighlighter.setEnabled(false));
        await expect(page.locator('.yfm-reading-mark,.yfm-reading-block')).toHaveCount(0);
        expect(await page.locator('#reading').textContent()).toBe(before);
        await page.evaluate(() => window.readingHighlighter.setEnabled(true));
        await expect(page.locator('.yfm-reading-mark')).toHaveCount(count);
    });
}

test('keeps anchors, tab titles, native inline markup and links intact', async ({ page }) => {
    // Arrange
    const source =
        readFileSync('test-vault/04-Anchors-and-tabs.md', 'utf8') +
        '\n\n{% list tabs %}\n\n- **Bold title** {selected}\n\n  [Native link](second.md).\n\n{% endlist %}\n';
    await mount(page, source, false);
    const before = await page.locator('#reading').textContent();
    // Act
    await page.evaluate((source) => window.highlightSections(source, false), source);
    // Assert
    await expect(page.locator('.yfm-source-meta').filter({ hasText: '{#header-id}' })).toHaveCount(
        1,
    );
    await expect(page.locator('.yfm-source-tab-title')).toHaveCount(4);
    await expect(
        page.locator('.yfm-source-tab-title').filter({ hasText: 'Первая вкладка' }),
    ).toHaveCSS('text-decoration-line', 'underline');
    await expect(page.locator('.yfm-source-meta').filter({ hasText: '{selected}' })).toHaveCount(3);
    await expect(page.locator('strong .yfm-source-tab-title')).toHaveText('Bold title');
    await expect(page.getByRole('link', { name: 'Native link' })).toHaveAttribute(
        'href',
        'second.md',
    );
    expect(await page.locator('#reading').textContent()).toBe(before);
});

test('aligns list backgrounds with note and tabs boundaries without moving list text', async ({
    page,
}) => {
    // Arrange: reproduce the reading theme's list indentation using the reported fixture.
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const source = readFileSync('test-vault/01-YFM.md', 'utf8');
    await mount(page, source, true);
    await page.addStyleTag({
        content:
            '.markdown-rendered ul,.markdown-rendered ol {margin-inline-start:32px;padding-inline-start:8px;}',
    });
    const textPositions = () =>
        page.locator('ul > li').evaluateAll((nodes) =>
            nodes.map((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return range.getBoundingClientRect().x;
            }),
        );
    const before = await textPositions();
    // Act
    await page.evaluate((source) => window.highlightSections(source, false), source);
    // Assert
    for (const [openingText, listClass] of [
        ['Проверка note', 'yfm-source-note-info'],
        ['{% list tabs %}', 'yfm-source-list'],
    ]) {
        const opening = page.locator('p.yfm-source-block-start').filter({ hasText: openingText });
        const list = page.locator(`ul.yfm-reading-block.${listClass}`).first();
        const edges = async (locator) =>
            locator.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element, '::before');
                return {
                    left: rect.left + parseFloat(style.left),
                    right: rect.right - parseFloat(style.right),
                };
            });
        const expected = await edges(opening);
        await expect
            .poll(async () => Math.abs((await edges(list)).left - expected.left))
            .toBeLessThan(1);
        expect(Math.abs((await edges(list)).right - expected.right)).toBeLessThan(1);
    }
    expect(await textPositions()).toEqual(before);
    // The border must remain aligned after the theme changes the native indentation.
    await page.addStyleTag({
        content: '.markdown-rendered ul,.markdown-rendered ol {margin-inline-start:48px;}',
    });
    await expect
        .poll(() =>
            page
                .locator('ul.yfm-reading-block.yfm-source-note-info')
                .first()
                .evaluate((element) => {
                    const opening = [...document.querySelectorAll('p.yfm-source-block-start')].find(
                        (node) => node.textContent.includes('Проверка note'),
                    );
                    const left =
                        element.getBoundingClientRect().left +
                        parseFloat(getComputedStyle(element, '::before').left);
                    const expected =
                        opening.getBoundingClientRect().left +
                        parseFloat(getComputedStyle(opening, '::before').left);
                    return Math.abs(left - expected);
                }),
        )
        .toBeLessThan(1);
    expect(errors).toEqual([]);
});

async function addNativeListBullets(page) {
    await page.addStyleTag({
        content: `
        .markdown-rendered ul {margin-inline-start:32px;padding-inline-start:8px;}
        .markdown-rendered li {position:relative;list-style:none;margin-bottom:24px;}
        .list-bullet {position:absolute;left:-16px;top:0.5em;width:5px;height:5px;border-radius:50%;background:currentColor;}
    `,
    });
    await page.locator('ul > li').evaluateAll((items) => {
        for (const item of items) {
            const bullet = document.createElement('span');
            bullet.className = 'list-bullet';
            item.prepend(bullet);
        }
    });
}

const paintedBox = (locator) =>
    locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element, '::before');
        return {
            top: rect.top + parseFloat(style.top),
            bottom: rect.bottom - parseFloat(style.bottom),
        };
    });

test('preserves native list bullets and joins the backgrounds of separately rendered list items', async ({
    page,
}) => {
    // Arrange: native rendering can process individual list items, with absolute marker spans.
    const source = readFileSync('test-vault/01-YFM.md', 'utf8');
    await mount(page, source, true);
    await addNativeListBullets(page);
    const maps = markdown
        .parse(source, {})
        .filter((token) => token.type === 'list_item_open')
        .map((token) => token.map);
    // Act
    await page.evaluate(
        ({ source, maps }) => {
            for (const section of document.querySelectorAll('#reading > section')) {
                if (section.querySelector(':scope > ul')) continue;
                window.readingHighlighter.process(
                    section,
                    { lineStart: +section.dataset.start, lineEnd: +section.dataset.end },
                    source,
                );
            }
            [...document.querySelectorAll('#reading ul > li')].forEach((item, index) => {
                window.readingHighlighter.process(
                    item,
                    { lineStart: maps[index][0], lineEnd: maps[index][1] - 1 },
                    source,
                );
            });
        },
        { source, maps },
    );
    // Assert: the second tab retains its native marker geometry.
    const secondTab = page
        .locator('li.yfm-reading-block')
        .filter({ hasText: 'Содержимое второй вкладки.' })
        .first();
    await expect(secondTab.locator(':scope > .list-bullet')).toHaveCSS('position', 'absolute');
    expect((await secondTab.locator(':scope > .list-bullet').boundingBox()).width).toBe(5);
    const items = page.locator('li.yfm-source-note-info');
    await expect(items).toHaveCount(2);
    await expect
        .poll(async () =>
            Math.abs(
                (await paintedBox(items.nth(1))).top - (await paintedBox(items.nth(0))).bottom,
            ),
        )
        .toBeLessThan(1);
});

test('joins the tabs list background to endlist across native list margins', async ({ page }) => {
    // Arrange
    const source = readFileSync('test-vault/01-YFM.md', 'utf8');
    await mount(page, source, false);
    await page.addStyleTag({ content: '.markdown-rendered ul {margin-bottom:32px;}' });
    // Act
    await page.evaluate((source) => window.highlightSections(source, false), source);
    // Assert
    const list = page.locator('ul.yfm-source-list');
    const closing = page.locator('p.yfm-source-block-end').filter({ hasText: '{% endlist %}' });
    await expect
        .poll(async () =>
            Math.abs((await paintedBox(closing)).top - (await paintedBox(list)).bottom),
        )
        .toBeLessThan(1);
});

async function addPseudoListBullets(page) {
    // Obsidian's marker is a zero-width float; the visible dot is painted by ::after.
    await page.addStyleTag({
        content: `
        :root {--list-marker-color:#999;--list-bullet-size:0.3em;--list-bullet-radius:50%;}
        .markdown-rendered ul {padding-inline-start:0;margin-block:16px;}
        .markdown-rendered ul>li {position:relative;margin-inline-start:3ch;padding-block:0.075em;}
        .markdown-rendered ul li p:first-of-type {margin-block-start:0;}
        .markdown-rendered ul li p:last-of-type {margin-block-end:0;}
        .markdown-rendered .list-bullet {float:left;margin-inline-start:-0.8em;}
        .markdown-rendered ul.has-list-bullet>li::marker {color:transparent;}
        .list-bullet {color:transparent;position:relative;display:inline-flex;justify-content:center;align-items:center;}
        .list-bullet::before {content:'\\200B';}
        .list-bullet::after {position:absolute;content:'\\200B';pointer-events:none;color:var(--list-marker-color);border-radius:var(--list-bullet-radius);width:var(--list-bullet-size);height:var(--list-bullet-size);background-color:var(--list-marker-color);}
    `,
    });
    await page.locator('ul>li').evaluateAll((items) => {
        for (const item of items) {
            item.parentElement.classList.add('has-list-bullet');
            const marker = document.createElement('span');
            marker.className = 'list-bullet';
            item.prepend(marker);
        }
    });
}

test('keeps the painted pseudo-bullet visible for all three tabs, including the last', async ({
    page,
}) => {
    // Arrange
    const { PNG } = require('pngjs');
    const source =
        '{% list tabs %}\n\n- Первая {selected}\n\n  Содержимое первой вкладки.\n\n- Вторая\n\n  Содержимое второй вкладки.\n\n- Третья\n\n  Содержимое третьей вкладки.\n\n{% endlist %}';
    await mount(page, source, true);
    await addPseudoListBullets(page);
    // Act
    await page.evaluate((source) => window.highlightSections(source, false), source);
    // Assert the actual pixels of ::after, not the intentionally zero-width parent span.
    for (const [index, marker] of (await page.locator('.list-bullet').all()).entries()) {
        const rect = await marker.boundingBox();
        const buffer = await page.screenshot({
            clip: { x: rect.x - 4, y: rect.y + rect.height / 2 - 4, width: 8, height: 8 },
        });
        const png = PNG.sync.read(buffer);
        let visible = 0;
        for (let i = 0; i < png.data.length; i += 4) {
            if ([0, 1, 2].every((channel) => Math.abs(png.data[i + channel] - 153) < 5)) ++visible;
        }
        expect(visible, `Visible pixels in tab marker ${index + 1}`).toBeGreaterThan(0);
    }
});
