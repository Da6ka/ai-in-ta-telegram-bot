// Unit tests for the shared Markdown -> Telegram-HTML converter.
// Run with: node --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, mdToHtml, chunk } from './telegram-markdown.mjs'

test('escapeHtml escapes the three HTML-significant characters', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
  // & must be escaped first so an already-escaped entity is not double-mangled
  assert.equal(escapeHtml('<>&'), '&lt;&gt;&amp;')
})

test('headings become bold', () => {
  assert.equal(mdToHtml('# Title'), '<b>Title</b>')
  assert.equal(mdToHtml('###### Deep'), '<b>Deep</b>')
})

test('inline bold and links convert', () => {
  assert.equal(mdToHtml('**hi**'), '<b>hi</b>')
  assert.equal(
    mdToHtml('see [docs](https://example.com/x)'),
    'see <a href="https://example.com/x">docs</a>',
  )
})

test('a double-quote in a URL is escaped so it cannot break out of the href attribute', () => {
  // This is the regression this module was written to prevent: an unescaped
  // `"` in a scraped/LLM-composed link would close the attribute and make
  // Telegram reject the whole message.
  const out = mdToHtml('[x](https://e.com/a"b)')
  assert.ok(!/href="[^"]*"[^>]*"/.test(out), 'no stray quote should break the attribute')
  assert.match(out, /href="https:\/\/e\.com\/a&quot;b"/)
})

test('link text is HTML-escaped', () => {
  assert.equal(
    mdToHtml('[a<b>](https://e.com)'),
    '<a href="https://e.com">a&lt;b&gt;</a>',
  )
})

test('non-http(s) schemes are not turned into links', () => {
  // javascript: and other schemes fall through to plain escaped text.
  const out = mdToHtml('[click](javascript:alert(1))')
  assert.ok(!out.includes('<a '), 'must not emit an anchor for a non-http scheme')
})

test('plain text around tokens is escaped and ordering is preserved', () => {
  assert.equal(
    mdToHtml('1 < 2 and **bold** & [l](https://e.com)'),
    '1 &lt; 2 and <b>bold</b> &amp; <a href="https://e.com">l</a>',
  )
})

test('chunk never exceeds the limit and prefers newline boundaries', () => {
  const text = 'line one\nline two\nline three'
  for (const part of chunk(text, 12)) {
    assert.ok(part.length <= 12, `chunk "${part}" exceeds limit`)
  }
  // reassembling the pieces reproduces the original text
  assert.equal(chunk(text, 12).join(''), text)
})

test('chunk returns the whole string when it fits', () => {
  assert.deepEqual(chunk('short', 100), ['short'])
})
