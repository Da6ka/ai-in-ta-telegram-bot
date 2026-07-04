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

// #26 regression: a source URL with a literal paren -- a common shape for
// Wikipedia-style links (`.../wiki/Foo_(bar)`) -- used to stop the URL match
// at the first `)`, truncating the href and leaving `(bar)` as stray text
// outside the closed anchor.
test('a URL containing one level of nested parens is not truncated (#26)', () => {
  assert.equal(
    mdToHtml('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))'),
    '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>',
  )
  assert.equal(
    mdToHtml('see [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) for details'),
    'see <a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a> for details',
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

test('inline italic converts', () => {
  assert.equal(mdToHtml('*hi*'), '<i>hi</i>')
})

// Regression, caught live in Telegram on 2026-07-04: a real generation
// italicized a case name inside a bold sentence --
// "**...the claims in *Mobley v. Workday* proceed**, advancing..." -- and
// the old bold regex ([^*]+) couldn't match across the nested asterisks, so
// the whole bold span (and the closing **) fell through as literal,
// unconverted Markdown all the way to the user.
test('a nested *italic* span inside **bold** converts instead of falling through as literal Markdown (2026-07-04 regression)', () => {
  const out = mdToHtml('**the claims in *Mobley v. Workday* proceed**, advancing')
  assert.equal(out, '<b>the claims in <i>Mobley v. Workday</i> proceed</b>, advancing')
  assert.ok(!out.includes('*'), 'no literal asterisk should survive conversion')
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

// AUD-2 regression: the L6 fix protected <a>…</a> pairs but not <b>…</b>. A
// single line longer than the limit whose cut point landed inside a bold span
// (bold text contains spaces, so the space-preferring cut can land there)
// produced two chunks each with an unbalanced <b> — Telegram rejects both.
test('chunk keeps <b> pairs intact when the boundary lands inside a bold span (AUD-2)', () => {
  const md = 'x'.repeat(3480) + ' **a bold phrase with spaces inside** tail ' + 'y'.repeat(200)
  const html = mdToHtml(md)
  const parts = chunk(html, 3500)
  assert.ok(parts.length >= 2, 'long line actually chunked')
  for (const p of parts) {
    assert.ok(p.length <= 3500, 'chunk within limit')
    assert.equal(
      (p.match(/<b>/g) ?? []).length,
      (p.match(/<\/b>/g) ?? []).length,
      `unbalanced <b> in chunk: …${p.slice(-40)}`,
    )
  }
  assert.equal(parts.join(''), html, 'no content lost')
})

// Nested <i> inside <b> (the 2026-07-04 regression fix) must stay balanced
// across a chunk boundary the same way plain <b> does above.
test('chunk keeps nested <b><i>…</i></b> pairs intact across a boundary', () => {
  const md = 'x'.repeat(3470) + ' **a bold phrase with an *italic title* inside** tail ' + 'y'.repeat(200)
  const html = mdToHtml(md)
  const parts = chunk(html, 3500)
  assert.ok(parts.length >= 2, 'long line actually chunked')
  for (const p of parts) {
    assert.ok(p.length <= 3500, 'chunk within limit')
    for (const tag of ['b', 'i']) {
      assert.equal(
        (p.match(new RegExp(`<${tag}>`, 'g')) ?? []).length,
        (p.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
        `unbalanced <${tag}> in chunk: …${p.slice(-40)}`,
      )
    }
  }
  assert.equal(parts.join(''), html, 'no content lost')
})

// #27 regression: the "back up before the outermost open tag" fix only
// applied when that tag started partway through the slice (stack[0].index >
// 0). If a single tag's content alone exceeds the chunk limit -- so the
// outermost open tag starts at index 0 -- there was no earlier point to back
// up to, and the naive whitespace-based cut could land mid-tag. Extending
// forward past the full close keeps the chunk valid even though it then
// exceeds `limit` (still comfortably under Telegram's real 4096 ceiling for
// any realistic single span).
test('chunk extends past the limit rather than truncate a single oversized tag (#27)', () => {
  const html = `<b>${'z'.repeat(4200)}</b> tail`
  const parts = chunk(html, 4000)
  assert.ok(parts.length >= 2, 'oversized content actually chunked')
  for (const p of parts) {
    assert.equal((p.match(/<b>/g) ?? []).length, (p.match(/<\/b>/g) ?? []).length, `unbalanced <b> in chunk: …${p.slice(-40)}`)
  }
  assert.equal(parts.join(''), html, 'no content lost')
})

// #37 regression: the naive whitespace-preferring cut can land inside a
// tag's own opening syntax (before its `>`) if that syntax happens to
// contain the only whitespace before the limit -- e.g. the space in
// `<a href=`, when the anchor text/URL that follows has none. Backing up
// only worked when the dangling `<` was partway through the slice; if it
// sat at index 0 there was nothing earlier to back up to, and previously
// nothing corrected the cut at all -- risking a near-zero-progress cut that
// could hang the chunking loop.
test('chunk completes a tag whose opening syntax has the only whitespace before the limit (#37)', () => {
  const longUrl = 'https://example.com/' + 'x'.repeat(50)
  const longText = 'y'.repeat(4200)
  const html = `<a href="${longUrl}">${longText}</a> tail text after`
  const parts = chunk(html, 4000)
  assert.ok(parts.length >= 2, 'oversized content actually chunked')
  assert.ok(parts.every((p) => p.length > 10), 'no near-zero-progress chunk')
  for (const p of parts) {
    assert.equal((p.match(/<a\b/g) ?? []).length, (p.match(/<\/a>/g) ?? []).length, `unbalanced <a> in chunk: …${p.slice(-40)}`)
  }
  assert.equal(parts.join(''), html, 'no content lost')
})

// The generalized balance check must not regress the anchor case (L6).
test('chunk still keeps <a> pairs intact across cuts', () => {
  const links = Array.from({ length: 60 }, (_, i) =>
    `[a much longer link label number ${i} with spaces](https://example.com/${i})`).join(' ')
  const html = mdToHtml(links)
  for (const p of chunk(html, 3500)) {
    assert.equal(
      (p.match(/<a\b/g) ?? []).length,
      (p.match(/<\/a>/g) ?? []).length,
      'unbalanced <a> in chunk',
    )
  }
})
