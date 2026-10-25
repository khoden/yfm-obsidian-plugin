import { createHash } from 'node:crypto';
import transform = require('@diplodoc/transform');

export interface RenderedMarkup {
    hash: string;
    html: string;
    diagnostics: string[];
}

/** Caches path-independent transformed markup by the SHA-256 of UTF-8 file contents. */
export class MarkupCache {
    private readonly entries = new Map<string, RenderedMarkup>();
    private readonly fileHashes = new Map<string, string>();

    constructor(private readonly limit = 32) {}

    /** Converts contents, or reuses identical contents already held in memory. */
    render(path: string, source: string): RenderedMarkup & { cacheHit: boolean } {
        const hash = createHash('sha256').update(source, 'utf8').digest('hex');
        const previous = this.fileHashes.get(path);
        if (previous && previous !== hash) this.entries.delete(previous);
        this.fileHashes.set(path, hash);
        const cached = this.entries.get(hash);
        if (cached) {
            this.entries.delete(hash);
            this.entries.set(hash, cached);
            return { ...cached, cacheHit: true };
        }
        const output = transform(source, {
            disableLiquid: true,
            allowHTML: false,
            needToSanitizeHtml: true,
            // No filesystem callbacks: includes and build-time preprocessing are unsupported.
            log: { info: () => {}, warn: () => {}, error: () => {} },
        });
        const entry = {
            hash,
            html: output.result.html,
            diagnostics: [...output.logs.error, ...output.logs.warn].map(String),
        };
        this.entries.set(hash, entry);
        if (this.entries.size > this.limit) {
            this.entries.delete(this.entries.keys().next().value!);
        }
        return { ...entry, cacheHit: false };
    }

    /** Removes the previous content entry for a modified, renamed, or deleted file. */
    invalidate(path: string): void {
        const hash = this.fileHashes.get(path);
        if (hash) this.entries.delete(hash);
        this.fileHashes.delete(path);
    }

    /** Releases all cached markup when the plugin unloads. */
    clear(): void {
        this.entries.clear();
        this.fileHashes.clear();
    }
}
