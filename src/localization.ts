const en = {
    refresh: 'Refresh',
    highlightName: 'Highlight YFM blocks',
    highlightDescription:
        'Color note, cut and list tags, parameters, multiline table markers and block backgrounds in Source mode, Live Preview and Reading view.',
    openFile: 'Open a Markdown file.',
    fileDeleted: 'File deleted. Open another Markdown file.',
    frameTitle: 'YFM HTML preview',
    rendering: 'rendering',
    waiting: 'waiting for update…',
    cache: 'cache',
    conversion: 'conversion',
    error: 'error',
    imageError: (src: string, error: string) => `Could not load image ${src}: ${error}`,
    toggleCommand: 'Toggle preview',
    toggleRibbon: 'Toggle YFM Preview',
    closePreview: 'Close YFM Preview',
    openPreview: 'Open YFM Preview to the right',
    openFileFirst: 'Open a Markdown file first.',
    delayName: 'Update delay (ms)',
    delayDescription: 'Debounce after saving a file: 0–60000 ms. Default: 500 ms.',
    delayValidation: 'Enter an integer from 0 to 60000.',
    debugName: 'Debug mode',
    debugDescription: 'Show file path, cache status, and SHA-256 in the preview.',
};

const ru: typeof en = {
    refresh: 'Обновить',
    highlightName: 'Подсветка YFM-блоков',
    highlightDescription:
        'Выделять теги note, cut и list, их параметры, маркеры многострочных таблиц и фон блоков в режиме исходника, Live Preview и Reading view.',
    openFile: 'Откройте Markdown-файл.',
    fileDeleted: 'Файл удалён. Откройте другой Markdown-файл.',
    frameTitle: 'HTML-предпросмотр YFM',
    rendering: 'рендеринг',
    waiting: 'ожидание обновления…',
    cache: 'кеш',
    conversion: 'конвертация',
    error: 'ошибка',
    imageError: (src: string, error: string) => `Не удалось загрузить изображение ${src}: ${error}`,
    toggleCommand: 'Переключить предпросмотр',
    toggleRibbon: 'Переключить YFM Preview',
    closePreview: 'Закрыть YFM Preview',
    openPreview: 'Открыть YFM Preview справа',
    openFileFirst: 'Сначала откройте Markdown-файл.',
    delayName: 'Задержка обновления (мс)',
    delayDescription: 'Debounce после сохранения файла: от 0 до 60000 мс. По умолчанию — 500 мс.',
    delayValidation: 'Введите целое число от 0 до 60000.',
    debugName: 'Режим отладки',
    debugDescription: 'Показывать в предпросмотре путь файла, состояние кеша и SHA-256.',
};

/** Selects Russian for ru locales and English for every other Obsidian language. */
export function createLocalization(language: string): {
    language: 'en' | 'ru';
    strings: typeof en;
} {
    const selected = language.toLowerCase().split(/[-_]/)[0] === 'ru' ? 'ru' : 'en';
    return { language: selected, strings: selected === 'ru' ? ru : en };
}
