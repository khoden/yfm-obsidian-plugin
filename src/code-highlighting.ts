interface PrismHighlighter {
    highlightElement(element: HTMLElement): void;
}

const TOKEN_STYLES = [
    'color',
    'background-color',
    'font-weight',
    'font-style',
    'text-decoration-line',
    'opacity',
] as const;

/** Highlights code with Obsidian's Prism and captures the current reading-view theme. */
export function highlightPreviewCode(
    content: HTMLElement,
    { prism, themeContainer }: { prism: PrismHighlighter; themeContainer: HTMLElement },
): void {
    const probe = content.ownerDocument.createElement('div');
    probe.className = 'markdown-preview-view markdown-rendered';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    themeContainer.appendChild(probe);
    try {
        for (const original of content.querySelectorAll<HTMLElement>('pre > code')) {
            const pre = probe.ownerDocument.createElement('pre');
            const code = original.cloneNode(true) as HTMLElement;
            pre.appendChild(code);
            probe.appendChild(pre);
            // The same API is used by Obsidian's native code-block postprocessor.
            prism.highlightElement(code);
            const win = probe.ownerDocument.defaultView!;
            for (const token of code.querySelectorAll<HTMLElement>('.token')) {
                const style = win.getComputedStyle(token);
                for (const property of TOKEN_STYLES) {
                    token.style.setProperty(property, style.getPropertyValue(property));
                }
            }
            original.innerHTML = code.innerHTML;
            original.className = code.className;
            original.style.color = win.getComputedStyle(code).color;
            original.style.backgroundColor = win.getComputedStyle(pre).backgroundColor;
            original.parentElement!.style.backgroundColor = original.style.backgroundColor;
            pre.remove();
        }
    } finally {
        probe.remove();
    }
}
