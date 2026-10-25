const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { build } = require('esbuild');
const { pathToFileURL } = require('node:url');
let previewDocument;
const { MarkupCache } = require('../.test/cache.cjs');

test.beforeAll(async () => {
    const { options } = await import(
        pathToFileURL(require('node:path').resolve('scripts/build.mjs')).href
    );
    await build({ ...options, entryPoints: ['src/document.ts'], outfile: '.test/document.cjs' });
    previewDocument = require('../.test/document.cjs').previewDocument;
});

test('sandboxed preview renders YFM and interactive controls', async ({ page }) => {
    // Arrange
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const source = readFileSync('test-vault/01-YFM.md', 'utf8');
    const { html } = new MarkupCache().render('01-YFM.md', source);
    await page.setContent(
        '<iframe sandbox="allow-scripts" style="width:100%;height:900px"></iframe>',
    );
    // Act
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(html, false),
    );
    const frame = page.frameLocator('iframe');
    // Assert
    await expect(frame.locator('.yfm-note').first()).toBeVisible();
    await expect(frame.locator('table')).toHaveCount(2);
    await expect(frame.locator('[colspan="2"]')).toHaveCount(1);
    await expect(frame.getByText('Текст внутри ката.', { exact: true })).not.toBeVisible();
    await frame.getByText('Раскрыть вложенное примечание', { exact: true }).click();
    await expect(frame.getByText('Текст внутри ката.', { exact: true })).toBeVisible();
    await expect(frame.getByText('Содержимое второй вкладки.', { exact: true })).not.toBeVisible();
    await frame.getByText('Вторая', { exact: true }).click();
    await expect(frame.getByText('Содержимое второй вкладки.', { exact: true })).toBeVisible();
    await frame.getByText('термином', { exact: true }).click();
    await expect(
        frame
            .getByText('HTML после конвертации текущего сохранённого файла.', { exact: true })
            .first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
    // A fresh srcdoc must initialize its controls again after an edit.
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(html, true),
    );
    await frame.getByText('Вторая', { exact: true }).click();
    await expect(frame.getByText('Содержимое второй вкладки.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test('loads the local SVG inside the sandbox without the app protocol', async ({ page }) => {
    // Arrange
    const { localImageSource } = require('../.test/images.cjs');
    const bytes = readFileSync('test-vault/assets/preview.svg');
    const app = {
        metadataCache: {
            getFirstLinkpathDest: (path, source) => {
                expect(path).toBe('assets/preview.svg');
                expect(source).toBe('01-YFM.md');
                return { extension: 'svg' };
            },
        },
        vault: { readBinary: async () => Uint8Array.from(bytes).buffer },
    };
    const src = await localImageSource(app, 'assets/preview.svg', '01-YFM.md');
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(src.split(',')[1], 'base64')).toEqual(bytes);
    await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
    // Act
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(`<img src="${src}" alt="Локальная картинка" width="240">`, false),
    );
    const image = page.frameLocator('iframe').getByAltText('Локальная картинка');
    // Assert
    await expect(image).toHaveAttribute('width', '240');
    await expect
        .poll(() => image.evaluate((element) => element.complete && element.naturalWidth))
        .toBe(240);
    for (const url of ['https://example.com/a.png', 'data:image/png;base64,AA==']) {
        expect(await localImageSource({}, url, 'one.md')).toBe(url);
    }
});

test('anchor links scroll inside srcdoc without navigating away from the preview', async ({
    page,
}) => {
    // Arrange
    await page.route('https://obsidian-preview.test/**', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<iframe sandbox="allow-scripts" style="width:600px;height:200px"></iframe>',
        }),
    );
    await page.goto('https://obsidian-preview.test/');
    const { html } = new MarkupCache().render(
        '01-YFM.md',
        readFileSync('test-vault/01-YFM.md', 'utf8'),
    );
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(html, false),
    );
    const frame = page.frameLocator('iframe');
    // Act
    await frame.getByText('Перейти к якорю', { exact: true }).click();
    // Assert
    await expect(frame.locator('main.yfm')).toHaveCount(1, { timeout: 2000 });
    await expect(frame.locator('#explicit-anchor')).toBeInViewport();
    expect(page.frames()[1].url()).toBe('about:srcdoc');
});

test('reports and restores preview scroll after a document refresh', async ({ page }) => {
    // Arrange
    await page.setContent(
        '<iframe sandbox="allow-scripts" style="width:600px;height:200px"></iframe>',
    );
    await page.evaluate(() => {
        window.lastScroll = null;
        window.addEventListener('message', (event) => {
            if (
                event.source === document.querySelector('iframe').contentWindow &&
                event.data?.type === 'yfm-preview-scroll'
            ) {
                window.lastScroll = event.data;
            }
        });
    });
    const html = '<p>Before</p><div style="height:3000px"></div><p>End</p>';
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(html, false, { documentId: 1 }),
    );
    await expect.poll(() => page.evaluate(() => window.lastScroll?.documentId)).toBe(1);
    await page
        .frameLocator('iframe')
        .locator('main')
        .evaluate(() => window.scrollTo(0, 900));
    await expect.poll(() => page.evaluate(() => window.lastScroll?.y)).toBe(900);
    const scroll = await page.evaluate(() => ({ x: window.lastScroll.x, y: window.lastScroll.y }));
    // Act
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(html.replace('Before', 'After'), false, { documentId: 2, scroll }),
    );
    // Assert
    await expect.poll(() => page.evaluate(() => window.lastScroll?.documentId)).toBe(2);
    await expect
        .poll(() =>
            page
                .frameLocator('iframe')
                .locator('main')
                .evaluate(() => window.scrollY),
        )
        .toBe(900);
    await expect(page.frameLocator('iframe').getByText('After', { exact: true })).toHaveCount(1);
    // Shortened content must clamp the old position to the new scroll range.
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument('<p>Short</p>', false, { documentId: 3, scroll }),
    );
    await expect.poll(() => page.evaluate(() => window.lastScroll?.documentId)).toBe(3);
    expect(await page.evaluate(() => window.lastScroll.y)).toBe(0);
});

test('uses the native reading-view font family and base font size', async ({ page }) => {
    // Arrange
    await page.setContent(
        '<style>.markdown-preview-view.markdown-rendered {font-family:Georgia, serif;font-size:21px;}.markdown-rendered code {font-family:"Courier New",monospace;}</style><div class="markdown-preview-view markdown-rendered">Native<code>Native code</code></div><iframe sandbox="allow-scripts"></iframe>',
    );
    const typography = await page.locator('.markdown-rendered').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            monospaceFontFamily: getComputedStyle(element.querySelector('code')).fontFamily,
        };
    });
    // Act
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument(
            '<p>Preview</p><p><code>Inline code</code></p><pre><code>Block code</code></pre>',
            false,
            { typography },
        ),
    );
    // Assert
    const paragraph = page.frameLocator('iframe').getByText('Preview', { exact: true });
    await expect(paragraph).toHaveCSS('font-family', typography.fontFamily);
    await expect(paragraph).toHaveCSS('font-size', typography.fontSize);
    for (const code of await page.frameLocator('iframe').locator('code').all()) {
        await expect(code).toHaveCSS('font-family', typography.monospaceFontFamily);
    }
    // A subsequent update picks up new appearance settings too.
    await page.locator('iframe').evaluate(
        (frame, document) => {
            frame.srcdoc = document;
        },
        previewDocument('<p>Preview</p>', true, {
            typography: { fontFamily: 'monospace', fontSize: '18px' },
        }),
    );
    await expect(paragraph).toHaveCSS('font-family', 'monospace');
    await expect(paragraph).toHaveCSS('font-size', '18px');
});

for (const dark of [false, true]) {
    test(`code highlighting stays readable in the ${dark ? 'dark' : 'light'} preview`, async ({
        page,
    }) => {
        const source = '```typescript\n// Comment\nconst message: string = "hello";\n```';
        const { html } = new MarkupCache().render('code.md', source);
        await page.setContent(
            '<iframe sandbox="allow-scripts" style="width:600px;height:300px"></iframe>',
        );
        await page.locator('iframe').evaluate(
            (frame, document) => {
                frame.srcdoc = document;
            },
            previewDocument(html, dark, {
                typography: {
                    fontFamily: 'serif',
                    fontSize: '18px',
                    monospaceFontFamily: 'monospace',
                },
            }),
        );
        const frame = page.frameLocator('iframe');
        await expect(frame.locator('.hljs-keyword')).toHaveText('const');
        await expect(frame.locator('.hljs-keyword')).toHaveCSS('font-weight', '700');
        await expect(frame.locator('code')).toHaveCSS('font-family', 'monospace');
        const colors = await frame.locator('code').evaluate((code) => {
            const style = getComputedStyle(code);
            // Diplodoc layers translucent code backgrounds over the document surface.
            const ancestors = [];
            for (let element = code; element; element = element.parentElement)
                ancestors.unshift(element);
            let background = [255, 255, 255];
            for (const element of ancestors) {
                const [r, g, b, alpha = 1] = getComputedStyle(element)
                    .backgroundColor.match(/[\d.]+/g)
                    .map(Number);
                background = [r, g, b].map(
                    (channel, i) => channel * alpha + background[i] * (1 - alpha),
                );
            }
            return {
                base: style.color,
                background: `rgb(${background.map(Math.round).join(', ')})`,
                string: getComputedStyle(code.querySelector('.hljs-string')).color,
                comment: getComputedStyle(code.querySelector('.hljs-comment')).color,
            };
        });
        expect(colors.string).not.toBe(colors.base);
        expect(colors.comment).not.toBe(colors.base);
        const luminance = (color) => {
            const channels = color
                .match(/\d+/g)
                .slice(0, 3)
                .map(Number)
                .map((value) => {
                    const s = value / 255;
                    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        for (const foreground of [colors.base, colors.string, colors.comment]) {
            const a = luminance(foreground);
            const b = luminance(colors.background);
            expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
        }
    });
}
