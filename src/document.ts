import yfmCss from '@diplodoc/transform/dist/css/yfm.css';
import yfmRuntime from '@diplodoc/transform/dist/js/yfm.js';

/** Builds a self-contained document; the caller must use a sandboxed iframe. */
export function previewDocument(html: string, dark: boolean): string {
    const theme = dark ? `color-scheme:dark;--yfm-color-text:#ddd;--yfm-color-base:#202020;--yfm-color-link:#8ab4f8;--yfm-color-table:#ddd;--yfm-color-table-background:#202020;--yfm-color-table-head-background:#303030;--yfm-color-table-border:#555;--yfm-color-code-background:#303030;--yfm-color-inline-code-background:#303030;` : 'color-scheme:light;';
    const bridge = `document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href) return;
        event.preventDefault();
        // A srcdoc document inherits its parent's base URL; native hash navigation leaves the preview.
        if (href.startsWith('#')) {
            let id = href.slice(1);
            try { id = decodeURIComponent(id); } catch {}
            if (!id) window.scrollTo(0, 0);
            else document.getElementById(id)?.scrollIntoView({block:'start'});
            return;
        }
        parent.postMessage({type:'yfm-preview-link', href}, '*');
    });`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${yfmCss}</style>
    <style>:root{${theme}}html,body{margin:0;background:var(--yfm-color-base,#fff);color:var(--yfm-color-text,#222)}body{padding:24px}.yfm{max-width:100%;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>
    </head><body><main class="yfm">${html}</main><script>${bridge}</script><script>${yfmRuntime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
