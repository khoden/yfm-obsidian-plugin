const {test, expect} = require('@playwright/test');
const {readFileSync} = require('node:fs');
const {build} = require('esbuild');
const {pathToFileURL} = require('node:url');
let previewDocument;
const {MarkupCache} = require('../.test/cache.cjs');

test.beforeAll(async () => {
    const {options} = await import(pathToFileURL(require('node:path').resolve('scripts/build.mjs')).href);
    await build({...options, entryPoints:['src/document.ts'], outfile:'.test/document.cjs'});
    previewDocument = require('../.test/document.cjs').previewDocument;
});

test('sandboxed preview renders YFM and interactive controls', async ({page}) => {
    // Arrange
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = readFileSync('test-vault/01-YFM.md', 'utf8');
    const {html} = new MarkupCache().render('01-YFM.md', source);
    await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:900px"></iframe>');
    // Act
    await page.locator('iframe').evaluate((frame, document) => { frame.srcdoc = document; }, previewDocument(html, false));
    const frame = page.frameLocator('iframe');
    // Assert
    await expect(frame.locator('.yfm-note').first()).toBeVisible();
    await expect(frame.locator('table')).toHaveCount(2);
    await expect(frame.locator('[colspan="2"]')).toHaveCount(1);
    await expect(frame.getByText('Текст внутри ката.', {exact:true})).not.toBeVisible();
    await frame.getByText('Раскрыть вложенное примечание', {exact:true}).click();
    await expect(frame.getByText('Текст внутри ката.', {exact:true})).toBeVisible();
    await expect(frame.getByText('Содержимое второй вкладки.', {exact:true})).not.toBeVisible();
    await frame.getByText('Вторая', {exact:true}).click();
    await expect(frame.getByText('Содержимое второй вкладки.', {exact:true})).toBeVisible();
    await frame.getByText('термином', {exact:true}).click();
    await expect(frame.getByText('HTML после конвертации текущего сохранённого файла.', {exact:true}).first()).toBeVisible();
    expect(errors).toEqual([]);
    // A fresh srcdoc must initialize its controls again after an edit.
    await page.locator('iframe').evaluate((frame, document) => { frame.srcdoc = document; }, previewDocument(html, true));
    await frame.getByText('Вторая', {exact:true}).click();
    await expect(frame.getByText('Содержимое второй вкладки.', {exact:true})).toBeVisible();
    expect(errors).toEqual([]);
});


test('loads the local SVG inside the sandbox without the app protocol', async ({page}) => {
    // Arrange
    const {localImageSource} = require('../.test/images.cjs');
    const bytes = readFileSync('test-vault/assets/preview.svg');
    const app = {
        metadataCache:{getFirstLinkpathDest:(path, source) => {
            expect(path).toBe('assets/preview.svg');
            expect(source).toBe('01-YFM.md');
            return {extension:'svg'};
        }},
        vault:{readBinary:async () => Uint8Array.from(bytes).buffer},
    };
    const src = await localImageSource(app, 'assets/preview.svg', '01-YFM.md');
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(src.split(',')[1], 'base64')).toEqual(bytes);
    await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
    // Act
    await page.locator('iframe').evaluate((frame, document) => {frame.srcdoc = document;},
        previewDocument(`<img src="${src}" alt="Локальная картинка" width="240">`, false));
    const image = page.frameLocator('iframe').getByAltText('Локальная картинка');
    // Assert
    await expect(image).toHaveAttribute('width', '240');
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBe(240);
    for (const url of ['https://example.com/a.png', 'data:image/png;base64,AA==']) {
        expect(await localImageSource({}, url, 'one.md')).toBe(url);
    }
});

test('anchor links scroll inside srcdoc without navigating away from the preview', async ({page}) => {
    // Arrange
    await page.route('https://obsidian-preview.test/**', route => route.fulfill({
        contentType: 'text/html', body: '<iframe sandbox="allow-scripts" style="width:600px;height:200px"></iframe>',
    }));
    await page.goto('https://obsidian-preview.test/');
    const {html} = new MarkupCache().render('01-YFM.md', readFileSync('test-vault/01-YFM.md', 'utf8'));
    await page.locator('iframe').evaluate((frame, document) => {frame.srcdoc = document;}, previewDocument(html, false));
    const frame = page.frameLocator('iframe');
    // Act
    await frame.getByText('Перейти к якорю', {exact:true}).click();
    // Assert
    await expect(frame.locator('main.yfm')).toHaveCount(1, {timeout:2000});
    await expect(frame.locator('#explicit-anchor')).toBeInViewport();
    expect(page.frames()[1].url()).toBe('about:srcdoc');
});
