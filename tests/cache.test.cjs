const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { MarkupCache } = require('../.test/cache.cjs');

test('caches identical UTF-8 contents by SHA-256 across paths', () => {
    // Arrange
    const cache = new MarkupCache();
    const source = '# Привет';
    // Act
    const first = cache.render('one.md', source);
    const second = cache.render('nested/two.md', source);
    // Assert
    assert.equal(first.hash, createHash('sha256').update(source).digest('hex'));
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.html, second.html);
});

test('invalidates previous markup after modification even when contents are restored', () => {
    // Arrange
    const cache = new MarkupCache();
    cache.render('one.md', '# Before');
    // Act & Assert
    cache.invalidate('one.md');
    assert.equal(cache.render('one.md', '# Before').cacheHit, false);
    assert.match(cache.render('one.md', '# After').html, /After/);
    assert.equal(cache.render('one.md', '# Before').cacheHit, false);
});

test('bounds the cache and evicts the least recently used entry', () => {
    // Arrange
    const cache = new MarkupCache({ limit: 2 });
    cache.render('one.md', '# One');
    cache.render('two.md', '# Two');
    cache.render('one.md', '# One');
    // Act
    cache.render('three.md', '# Three');
    // Assert
    assert.equal(cache.render('one.md', '# One').cacheHit, true);
    assert.equal(cache.render('two.md', '# Two').cacheHit, false);
});

test('renders YFM while leaving Liquid untouched and escaping raw HTML', () => {
    // Arrange
    const cache = new MarkupCache();
    // Act
    const result = cache.render(
        'one.md',
        '{% note info %}\n\n{{ missing }}\n\n{% endnote %}\n\n<script>alert(1)</script>',
    );
    // Assert
    assert.match(result.html, /yfm-note/);
    assert.match(result.html, /\{\{ missing \}\}/);
    assert.doesNotMatch(result.html, /<script>/);
});

test('highlights fenced code using its language and escapes unsupported code', () => {
    const cache = new MarkupCache();
    for (const [language, code, token] of [
        ['typescript', 'const answer: number = 42;', 'keyword'],
        ['json', '{"answer": 42}', 'attr'],
        ['bash', 'echo "hello"', 'string'],
        ['python', 'def hello():\n    return "hello"', 'keyword'],
        ['diff', '+added\n-removed', 'addition'],
    ]) {
        const { html } = cache.render('code.md', '```' + language + '\n' + code + '\n```');
        assert.match(html, new RegExp('class="hljs-' + token));
    }
    for (const language of ['', 'unknown-language']) {
        const { html } = cache.render(
            'code.md',
            '```' + language + '\n<script>alert("x")</script>\n```',
        );
        assert.match(html, /&lt;script&gt;/);
        assert.doesNotMatch(html, /<script>|hljs-keyword/);
    }
});
