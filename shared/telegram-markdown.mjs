// Shared Markdown -> Telegram-HTML conversion, used by both the Worker
// (worker/src/index.js) and the GitHub Actions delivery scripts
// (scripts/send-briefing.mjs, scripts/send-to-chat.mjs). Previously each
// file had its own copy, and none of them escaped the URL before placing
// it in an href attribute -- a stray `"` in a link (plausible from
// scraped/LLM-composed content) breaks out of the attribute and can make
// Telegram reject the whole message. Only escaping (not re-encoding) the
// URL preserves any existing percent-encoding while closing that hole.

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

// Links, **bold**, and *italic* are the only Markdown the model reliably
// produces inline. Bold is matched non-greedily up to the next `**` (rather
// than excluding `*` from its content) so a case/book title italicized
// *inside* a bold sentence -- e.g. "**...the claims in *Mobley v. Workday*
// proceed**", which real generations do produce -- doesn't make the whole
// bold match fail and fall through as literal asterisks (caught live,
// 2026-07-04: exactly that bullet reached Telegram unconverted). A fresh
// RegExp is built per call rather than sharing one module-level `g` regex,
// because bold recurses into this function for its own contents and a
// shared regex's mutable lastIndex would corrupt the outer scan.
//
// The URL is matched as alternating runs of "no space/parens" and balanced
// `(...)` groups, rather than a single `[^\s)]+` -- a source URL containing a
// paren (common for Wikipedia-style links, e.g. `.../Foo_(bar)`) would
// otherwise stop at the first `)`, truncating the href and leaving `(bar)`
// as stray literal text after the closed anchor (#26). This only handles one
// level of nesting, which covers every real URL shape seen so far.
function inlineRe() {
  return /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))+)\)|\*\*(.+?)\*\*|\*([^*\n]+)\*/g
}

function inlineToHtml(text) {
  const parts = []
  let last = 0
  let m
  const re = inlineRe()
  while ((m = re.exec(text))) {
    parts.push(escapeHtml(text.slice(last, m.index)))
    if (m[1] !== undefined) {
      parts.push(`<a href="${escapeHtmlAttr(m[2])}">${escapeHtml(m[1])}</a>`)
    } else if (m[3] !== undefined) {
      parts.push(`<b>${inlineToHtml(m[3])}</b>`)
    } else {
      parts.push(`<i>${escapeHtml(m[4])}</i>`)
    }
    last = m.index + m[0].length
  }
  parts.push(escapeHtml(text.slice(last)))
  return parts.join('')
}

export function mdToHtml(md) {
  const out = []
  for (const line of md.split('\n')) {
    const hm = /^#{1,6}\s+(.+)$/.exec(line)
    out.push(hm ? `<b>${escapeHtml(hm[1])}</b>` : inlineToHtml(line))
  }
  return out.join('\n')
}

export function chunk(text, limit) {
  const parts = []
  let rest = text
  while (rest.length > limit) {
    // Prefer a newline; then a space (so a single long line doesn't get cut
    // mid-word); only hard-cut at the limit if there's no whitespace at all.
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit
    // Never split inside an HTML tag or across an open/close pair — Telegram
    // rejects a chunk with an unbalanced entity (L6, AUD-2).
    //
    // Phase 1: don't stop mid tag-opening-syntax (inside `<...` before its
    // own `>`). Back up before it when possible; if the dangling `<` is
    // itself at index 0 there's nothing earlier to back up to (and backing
    // up to 0 would re-slice the same content forever, hanging the loop --
    // #37), so extend forward to just past this tag's own `>` instead.
    let slice = rest.slice(0, cut)
    let lastOpen = slice.lastIndexOf('<')
    let lastClose = slice.lastIndexOf('>')
    if (lastOpen > lastClose) {
      if (lastOpen > 0) {
        cut = lastOpen
      } else {
        const closeIdx = rest.indexOf('>', cut)
        cut = closeIdx === -1 ? rest.length : closeIdx + 1
      }
      slice = rest.slice(0, cut)
    }
    // Phase 2: don't stop with any opened-but-unclosed element (<a>, <b>,
    // ...). mdToHtml can nest <i> inside <b> (an italicized title inside a
    // bold sentence), but a plain LIFO stack scan still finds the right cut
    // point: if an inner tag is left unclosed, its enclosing tag opened
    // earlier and is unclosed too, so stack[0] (the outermost) is always
    // the correct place to back up to.
    const tagRe = /<(\/?)([a-z]+)\b[^>]*>/g
    const stack = []
    let tm
    while ((tm = tagRe.exec(slice))) {
      if (tm[1]) {
        if (stack.length && stack[stack.length - 1].name === tm[2]) stack.pop()
      } else {
        stack.push({ name: tm[2], index: tm.index })
      }
    }
    if (stack.length) {
      if (stack[0].index > 0) {
        cut = stack[0].index
      } else {
        // #27: the outermost open tag starts at index 0 of this slice, so
        // there's no earlier point to back up to. Extend forward instead,
        // past wherever the whole nest of open tags actually closes -- even
        // if that pushes this one chunk past `limit`. `limit` is a buffer
        // under Telegram's real 4096-char ceiling, so a somewhat-oversized
        // but valid chunk is always preferable to a malformed one.
        let depth = stack.length
        const fwdRe = /<(\/?)([a-z]+)\b[^>]*>/g
        fwdRe.lastIndex = cut
        let fm
        let end = rest.length
        while ((fm = fwdRe.exec(rest))) {
          depth += fm[1] ? -1 : 1
          if (depth === 0) { end = fwdRe.lastIndex; break }
        }
        cut = end
      }
    }
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  parts.push(rest)
  return parts
}
