const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalization } = require('../.test/localization.cjs');
const { MarkupCache } = require('../.test/cache.cjs');

test('selects Russian locale variants and falls back to English', () => {
    // Act & Assert
    for (const language of ['ru', 'ru-RU', 'RU_ru']) {
        assert.equal(createLocalization(language).language, 'ru');
    }
    for (const language of ['en', 'en-GB', 'de', 'fr', '', 'unknown']) {
        assert.equal(createLocalization(language).language, 'en');
        assert.equal(createLocalization(language).strings.refresh, 'Refresh');
    }
});

test('localizes generated YFM note titles with independent content-hash caches', () => {
    // Arrange
    const source = '{% note info %}\n\nContent\n\n{% endnote %}';
    // Act
    const en = new MarkupCache({ language: 'en' }).render('one.md', source);
    const ru = new MarkupCache({ language: 'ru' }).render('one.md', source);
    // Assert
    assert.equal(en.hash, ru.hash);
    assert.match(en.html, /Note/);
    assert.match(ru.html, /Примечание/);
});
