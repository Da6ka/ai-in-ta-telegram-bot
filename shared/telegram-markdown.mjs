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

export function mdToHtml(md) {
  const out = []
  for (const line of md.split('\n')) {
    const hm = /^#{1,6}\s+(.+)$/.exec(line)
    if (hm) {
      out.push(`<b>${escapeHtml(hm[1])}</b>`)
      continue
    }
    const parts = []
    let last = 0
    // Links and inline **bold** are the only Markdown the model reliably
    // produces inline -- match both in one pass so escaping stays ordered.
    // Only http(s) links are treated as real links -- anything else (e.g. a
    // malformed or non-http scheme slipping through from generated content)
    // falls through to the plain-text escaping below instead of becoming <a>.
    const tokenRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g
    let m
    while ((m = tokenRe.exec(line))) {
      parts.push(escapeHtml(line.slice(last, m.index)))
      if (m[1] !== undefined) {
        parts.push(`<a href="${escapeHtmlAttr(m[2])}">${escapeHtml(m[1])}</a>`)
      } else {
        parts.push(`<b>${escapeHtml(m[3])}</b>`)
      }
      last = m.index + m[0].length
    }
    parts.push(escapeHtml(line.slice(last)))
    out.push(parts.join(''))
  }
  return out.join('\n')
}

export function chunk(text, limit) {
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  parts.push(rest)
  return parts
}
