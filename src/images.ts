import type { App } from 'obsidian';

const IMAGE_MIME_TYPES: Record<string, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    apng: 'image/apng',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
};

/** Embeds a vault image so the sandboxed preview does not depend on app:// access. */
export async function localImageSource(app: App, src: string, sourcePath: string): Promise<string> {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) return src;
    const [path] = src.split(/[?#]/);
    const target = app.metadataCache.getFirstLinkpathDest(decodeURIComponent(path), sourcePath);
    if (!target) return src;
    const mime = IMAGE_MIME_TYPES[target.extension.toLowerCase()];
    if (!mime) return src;
    const bytes = await app.vault.readBinary(target);
    const fragment = src.includes('#') ? src.slice(src.indexOf('#')) : '';
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}${fragment}`;
}
