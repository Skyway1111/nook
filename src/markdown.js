// Markdown to HTML for file tabs, GitHub's flavor as marked 18 writes it: the same tags, attributes and quirks.
// viewer.js sanitizes what this returns. Blocks are read first, so a link defined below its use resolves; then each
// block's inline text is read in the order it was found, and the blocks are written out.

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HR = / {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/.source
const HEAD = / {0,3}#{1,6}(?:\s|$)/.source
const FENCE = / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/.source
const HTML6 = `<\\/?(?:${TAG})(?: +|\\n|\\/?>)|<(?:script|pre|style|textarea|!--)`
const DELIM = /((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)/.source
const re = (s, f = 'y') => new RegExp(s, f)

const B_FENCES = /( {0,3})(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\2[~`]* *(?=\n|$)|$)/y
const B_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y
const B_HR = re(HR)
const B_QUOTE = re(`(?: {0,3}> ?(?:[^\\n]+(?:\\n(?!${HR}|${HEAD}| {0,3}>|${FENCE}| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)|${HTML6}|[ \\t]+\\n)[^\\n]+)*|[^\\n]*)(?:\\n|$))+`)
const B_LIST = /( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/y
const B_HTML = re(` {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(${TAG})(?: +|\\n|\\/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *'[^'\\n]*'| *= *[^\\s"'=<>\`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<\\/(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))`, 'iy')
const B_DEF = / {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\])+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$)/y
const B_TABLE = re(` *([^\\n ].*)\\n {0,3}${DELIM}(?:\\n((?:(?! *\\n|${HR}|${HEAD}| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]|${FENCE}| {0,3}(?:[*+-]|1[.)])[ \\t]|${HTML6}).*(?:\\n|$))*)\\n*|$)`)
const LH_STOP = ` {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:\`{3,}|~{3,})| {0,3}>|${HEAD}`
const LH_STOP2 = ` {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[:\\- ]*\\n`
const B_LHEADING = re(`(?!${LH_STOP}|(?: {4}| {0,3}\\t)|${LH_STOP2})((?:.|\\n(?!\\s*?\\n|${LH_STOP}|${HR.replace('(', '(?:')}|${LH_STOP2}))+?)\\n {0,3}(=+|-+) *(?:\\n+|$)`)
const B_PARA = re(`[^\\n]+(?:\\n(?!${HR}|${HEAD}| {0,3}>|${FENCE}| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]|${HTML6}| *[^\\n ].*\\n {0,3}${DELIM}(?:\\n|$)|[ \\t]+\\n)[^\\n]+)*`)

const I_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/y
const I_TAG = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y
const LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^[\]\\`])*?/.source
const REF = /((?!\s*\])(?:\\[\s\S]|[^[\]\\])+)/.source
const I_LINK = re(`!?\\[(${LABEL})\\]\\(\\s*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\"?|[^"\\\\])*"|'(?:\\\\'?|[^'\\\\])*'|\\((?:\\\\\\)?|[^)\\\\])*\\)))?\\s*\\)`)
const I_REFLINK = re(`!?\\[(${LABEL})\\]\\[${REF}\\]`)
const I_NOLINK = re(`!?\\[${REF}\\](?:\\[\\])?`)
const REF_SEARCH = /!?\[((?:[^[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^[\]\\]){1,999})\](?:\[\])?(?!\()/g
const SKIP = /\[(?:[^[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu
const EM_L = /\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy
const EM_R_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu
const EM_R_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu
const DEL_L = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy
const DEL_R = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu
const PUNCT = /^(?![*_])[\s\p{P}\p{S}]/u
const ALNUM = /[\p{L}\p{N}]/u
const I_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y
const I_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y
const I_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y
const EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.source
const I_URL = re(`(?:mailto:${EMAIL}|xmpp:${EMAIL}(?:\\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])`)
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/
const TASK = /^\[[ xX]\] +/
const IS_TASK = /^\[[ xX]\] +\S/

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const ENC = /[&<>"']/g
const NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g
/** `s` safe in HTML text or an attribute. Without `all`, an `&` that starts a reference stays. */
function escape(s, all) {
  const r = all ? ENC : NOENC
  r.lastIndex = 0
  let m = r.exec(s)
  if (!m) return s
  let out = '', last = 0
  do {
    out += s.slice(last, m.index) + ESC[s[m.index]]
    last = m.index + 1
  } while ((m = r.exec(s)))
  return out + s.slice(last)
}

const NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g
const numref = (_, d, h) => {
  const c = d === undefined ? parseInt(h, 16) : parseInt(d, 10)
  return c === 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) ? '\ufffd' : String.fromCodePoint(c)
}
const decode = s => s.replace(NUMREF, numref)

function rtrim(s, c) {
  let n = s.length
  while (n > 0 && s[n - 1] === c) n--
  return s.slice(0, n)
}
const label = s => s.trim().toLowerCase().toUpperCase().toLowerCase()
const lineAt = (s, p) => {
  if (p >= s.length) return ''
  const e = s.indexOf('\n', p)
  return e < 0 ? s.slice(p) : s.slice(p, e)
}

/** `encodeURI`, keeping the `%` escapes already there, or null for a lone surrogate. */
function cleanUrl(href) {
  if (/^[\w;,/?:@&=+$\-.!~*'()#%]*$/.test(href)) return href
  try { return encodeURI(href).replace(/%25/g, '%') } catch { return null }
}

let links, queue, top, inLink, inRawBlock, linkEmitted

/** The HTML for Markdown `md`. */
export function toHtml(md) {
  links = Object.create(null)
  queue = []
  top = true
  inLink = inRawBlock = linkEmitted = false
  if (md.includes('\r')) md = md.replace(/\r\n|\r/g, '\n')
  const tokens = lex(md, [])
  for (let i = 0; i < queue.length; i++) queue[i].html = inline(queue[i].src, false)
  return render(tokens)
}

/** A block's inline text, read once every block is. */
function later(src) {
  const e = { src, html: '' }
  queue.push(e)
  return e
}

// ---- blocks

/** The end of the blank lines at `i`, or `i`. */
function blanks(s, i) {
  const n = s.length
  let end = i
  for (;;) {
    let j = end
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++
    if (j === n) return j
    if (s.charCodeAt(j) !== 10) return end
    end = j + 1
  }
}

/** The end of the indented code at `i`, with the blank lines after it. */
function codeEnd(s, i) {
  const n = s.length
  let p = i
  for (;;) {
    let k = p
    while (k < p + 4 && s.charCodeAt(k) === 32) k++
    if (k < p + 4) {
      if (s.charCodeAt(k) !== 9) return p
      k++
    }
    if (k >= n || s.charCodeAt(k) === 10) return p
    const e = s.indexOf('\n', k)
    if (e < 0) return n
    p = blanks(s, e + 1)
  }
}

/** `s` less its trailing blank lines, if there are two or more. */
function trimBlank(s) {
  const lines = s.split('\n')
  let end = lines.length - 1
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--
  return lines.length - end <= 2 ? s : lines.slice(0, end + 1).join('\n')
}

const isPara = t => t && (t.t === 'paragraph' || t.t === 'text')
function append(last, raw, text) {
  last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw
  last.text += '\n' + text
  queue[queue.length - 1].src = last.text
}

/** Whether the line after `i` could be a table's delimiter row. */
function delimNext(s, i) {
  const j = s.indexOf('\n', i) + 1
  if (j === 0) return false
  const c = s.charCodeAt(Math.min(spaces(s, j), j + 3))
  return c === 124 || c === 58 || c === 45
}

/**
 * -1 if a line of `=` or `-` follows `i` before the next blank line, as a setext heading needs; else where the search
 * stopped, before which none can start.
 */
function setextStop(s, i) {
  const n = s.length
  for (let p = s.indexOf('\n', i); p >= 0; p = s.indexOf('\n', p + 1)) {
    let j = spaces(s, p + 1), c = s.charCodeAt(j)
    if (j - p <= 4 && (c === 61 || c === 45)) {
      let k = j
      while (s.charCodeAt(k) === c) k++
      k = spaces(s, k)
      if (k >= n || s.charCodeAt(k) === 10) return -1
    }
    while (c === 32 || c === 9) c = s.charCodeAt(++j)
    if (c === 10 || j >= n) return p + 1
  }
  return n
}

/** Reads the blocks of `s` into `tokens`. A paragraph first after `clipped` continues the one before it. */
function lex(s, tokens, clipped = false) {
  const n = s.length
  let i = 0, m, noSetext = 0
  while (i < n) {
    const last = tokens[tokens.length - 1]
    const e = blanks(s, i)
    if (e > i) {
      if (e - i === 1 && last) last.raw += '\n'
      else tokens.push({ t: 'space', raw: s.slice(i, e) })
      i = e
      continue
    }
    let k = i
    while (s.charCodeAt(k) === 32) k++
    const c = s.charCodeAt(k)
    if (k - i > 3 || c === 9) {
      const raw = trimBlank(s.slice(i, codeEnd(s, i)))
      const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '')
      i += raw.length
      if (isPara(last)) append(last, raw, text)
      else tokens.push({ t: 'code', raw, text })
      continue
    }
    if (c === 96 || c === 126) {
      B_FENCES.lastIndex = i
      if ((m = B_FENCES.exec(s))) {
        const indent = m[1], text = m[4] || ''
        tokens.push({
          t: 'code', raw: m[0], lang: m[3] ? m[3].trim().replace(ANY_PUNCT, '$1') : m[3],
          text: indent && m[2][0] === '`' ? text.split('\n').map(l => {
            const w = /^\s+/.exec(l)
            return w ? l.slice(Math.min(w[0].length, indent.length)) : l
          }).join('\n') : text,
        })
        i += m[0].length
        continue
      }
    } else if (c === 35) {
      B_HEADING.lastIndex = i
      if ((m = B_HEADING.exec(s))) {
        let text = m[2].trim()
        if (text.endsWith('#')) {
          const t = rtrim(text, '#')
          if (!t || /[ \t]$/.test(t)) text = t.trim()
        }
        const raw = rtrim(m[0], '\n')
        tokens.push({ t: 'heading', raw, depth: m[1].length, e: later(text) })
        i += raw.length
        continue
      }
    }
    if (c === 45 || c === 95 || c === 42) {
      B_HR.lastIndex = i
      if ((m = B_HR.exec(s))) {
        const raw = rtrim(m[0], '\n')
        tokens.push({ t: 'hr', raw })
        i += raw.length
        continue
      }
    }
    if (c === 62) {
      const t = blockquote(s, i)
      if (t) {
        tokens.push(t)
        i += t.raw.length
        continue
      }
    }
    if (c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)) {
      const t = list(s, i)
      if (t) {
        tokens.push(t)
        i += t.raw.length
        continue
      }
    }
    if (c === 60) {
      B_HTML.lastIndex = i
      if ((m = B_HTML.exec(s))) {
        const raw = trimBlank(m[0])
        tokens.push({ t: 'html', raw })
        i += raw.length
        continue
      }
    }
    if (c === 91) {
      B_DEF.lastIndex = i
      if ((m = B_DEF.exec(s))) {
        const raw = rtrim(m[0], '\n')
        i += raw.length
        if (isPara(last)) append(last, raw, raw)
        else {
          const tag = label(m[1]).replace(/\s+/g, ' ')
          if (!links[tag]) {
            links[tag] = {
              href: m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT, '$1') : '',
              title: m[3] ? m[3].slice(1, -1).replace(ANY_PUNCT, '$1') : m[3],
            }
            tokens.push({ t: 'def', raw })
          }
        }
        continue
      }
    }
    const t = delimNext(s, i) && table(s, i)
    if (t) {
      tokens.push(t)
      i += t.raw.length
      continue
    }
    if (i >= noSetext && (noSetext = setextStop(s, i)) < 0 && (B_LHEADING.lastIndex = i, m = B_LHEADING.exec(s))) {
      const raw = rtrim(m[0], '\n')
      tokens.push({ t: 'heading', raw, depth: m[2][0] === '=' ? 1 : 2, e: later(m[1].trim()) })
      i += raw.length
      continue
    }
    if (top) {
      B_PARA.lastIndex = i
      const raw = B_PARA.exec(s)[0]
      i += raw.length
      if (clipped && last?.t === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw
        last.text += '\n' + raw
        queue[queue.length - 1].src = last.text
      } else tokens.push({ t: 'paragraph', raw, text: raw, e: later(raw) })
      clipped = false
      continue
    }
    const raw = lineAt(s, i)
    i += raw.length
    if (last?.t === 'text') {
      last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw
      last.text += '\n' + raw
      queue[queue.length - 1].src = last.text
    } else tokens.push({ t: 'text', raw, text: raw, e: later(raw) })
  }
  top = true
  return tokens
}

function blockquote(s, i) {
  B_QUOTE.lastIndex = i
  const cap = B_QUOTE.exec(s)
  if (!cap) return
  let lines = rtrim(cap[0], '\n').split('\n'), raw = '', text = ''
  const tokens = []
  while (lines.length > 0) {
    let inQuote = false, j
    const cur = []
    for (j = 0; j < lines.length; j++) {
      if (/^ {0,3}>/.test(lines[j])) {
        cur.push(lines[j])
        inQuote = true
      } else if (!inQuote) cur.push(lines[j])
      else break
    }
    lines = lines.slice(j)
    const curRaw = cur.join('\n')
    const curText = curRaw.replace(/\n {0,3}((?:=+|-+) *)(?=\n|$)/g, '\n    $1').replace(/^ {0,3}>[ \t]?/gm, '')
    raw = raw ? `${raw}\n${curRaw}` : curRaw
    text = text ? `${text}\n${curText}` : curText
    const was = top
    top = true
    lex(curText, tokens, true)
    top = was
    if (lines.length === 0) break
    const last = tokens[tokens.length - 1]
    if (last?.t === 'code') break
    if (last?.t === 'blockquote') {
      const next = last.raw + '\n' + lines.join('\n').replace(/^ {0,3}>[ \t]?/gm, '')
      const t = blockquote(next, 0)
      tokens[tokens.length - 1] = t
      const left = next.substring(t.raw.length).replace(/^\n/, '')
      const count = left ? left.split('\n').length : 0
      const used = count ? lines.slice(0, -count) : lines
      if (used.length > 0) raw = `${raw}\n${used.join('\n')}`
      text = text.substring(0, text.length - last.text.length) + t.text
      break
    }
    if (last?.t === 'list') {
      const next = last.raw + '\n' + lines.join('\n')
      const t = list(next, 0)
      tokens[tokens.length - 1] = t
      raw = raw.substring(0, raw.length - last.raw.length) + t.raw
      text = text.substring(0, text.length - last.raw.length) + t.raw
      lines = next.substring(t.raw.length).split('\n')
    }
  }
  return { t: 'blockquote', raw, tokens, text }
}

const expandTabs = (s, col) => {
  let out = ''
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4)
      out += ' '.repeat(n)
      col += n
    } else {
      out += ch
      col++
    }
  }
  return out
}

const spaces = (s, i) => {
  while (s.charCodeAt(i) === 32) i++
  return i
}
/** Whether `s` is only whitespace, as `trim` reads it. */
const isBlank = s => {
  const c = s.charCodeAt(spaces(s, 0))
  return !(c > 32 && c < 128) && !s.trim()
}
/** Whether `s` ends with a blank line, as /\n[ \t]*\n[ \t]*$/ reads it. */
function endsBlank(s) {
  let i = s.length - 1
  while (s[i] === ' ' || s[i] === '\t') i--
  if (s[i--] !== '\n') return false
  while (s[i] === ' ' || s[i] === '\t') i--
  return s[i] === '\n'
}

const ITEM = {}
const LINE_RES = []
/** The tests for a line that ends a list item, for one indented `k` spaces at most. */
function lineRes(k) {
  return LINE_RES[k] ??= [
    new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
    new RegExp(`^ {0,${k}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
    new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`),
    new RegExp(`^ {0,${k}}#`),
    new RegExp(`^ {0,${k}}(?:<\\/?(?:${TAG})(?: +|$|\\/?>)|<(?:script|pre|style|textarea|!--))`, 'i'),
  ]
}

function list(s, i) {
  B_LIST.lastIndex = i
  let cap = B_LIST.exec(s)
  if (!cap) return
  let bull = cap[1].trim()
  const ordered = bull.length > 1
  const token = { t: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] }
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`
  const item = ITEM[bull] ??= new RegExp(`( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`, 'y')
  const n = s.length
  let p = i, endsWithBlank = false
  while (p < n) {
    let early = false, contents = ''
    item.lastIndex = p
    if (!(cap = item.exec(s))) break
    B_HR.lastIndex = p
    if (B_HR.test(s)) break
    const from = p
    p += cap[0].length
    const bulletIndent = cap[1].length
    let line = cap[2].endsWith('\n') ? cap[2].slice(0, -1) : cap[2], sp = spaces(line, 0)
    if (line.charCodeAt(sp) === 9) line = line.replace(/^[ \t]+/, w => expandTabs(w, bulletIndent))
    let blank = isBlank(line), indent
    if (blank) indent = bulletIndent + 1
    else {
      indent = line.search(/[^ ]/)
      indent = indent > 4 ? 1 : indent
      contents = line.slice(indent)
      indent += bulletIndent
    }
    const next = blank ? lineAt(s, p) : ''
    if (blank && /^[ \t]*$/.test(next)) {
      p += next.length + 1
      early = true
    }
    if (!early) {
      const k = Math.max(0, Math.min(3, indent - 1))
      const [bullet, hr, fence, head, html] = lineRes(k)
      while (p < n) {
        const rawLine = lineAt(s, p)
        sp = spaces(rawLine, 0)
        const c = rawLine.charCodeAt(sp)
        // A line that would start a block of its own ends the item.
        if (sp <= k && (c === 35 || c === 62 || ((c === 96 || c === 126) && rawLine.startsWith(c === 96 ? '```' : '~~~', sp))
          || (c === 60 && html.test(rawLine)) || ((c === 42 || c === 43 || c === 45 || (c > 47 && c < 58)) && bullet.test(rawLine))
          || ((c === 42 || c === 45 || c === 95) && hr.test(rawLine)))) break
        const untabbed = c === 9 ? rawLine.replace(/^[ \t]+/, w => w.replace(/\t/g, '    ')) : rawLine
        const blankNow = isBlank(rawLine)
        if ((c === 9 ? untabbed.search(/[^ ]/) : sp < rawLine.length ? sp : -1) >= indent || blankNow) contents += '\n' + untabbed.slice(indent)
        else {
          if (blank || line.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fence.test(line) || head.test(line)
            || hr.test(line)) break
          contents += '\n' + rawLine
        }
        blank = blankNow
        p += rawLine.length + 1
        line = untabbed.slice(indent)
      }
    }
    // A line's newline, or one added after the last line.
    const raw = p > n ? s.slice(from, n) + '\n' : s.slice(from, p)
    if (!token.loose) {
      if (endsWithBlank) token.loose = true
      else if (endsBlank(raw)) endsWithBlank = true
    }
    token.items.push({ raw, task: IS_TASK.test(contents), text: contents, tokens: null })
  }
  token.raw = p > n ? s.slice(i, n) + '\n' : s.slice(i, p)
  const lastItem = token.items[token.items.length - 1]
  if (!lastItem) return
  lastItem.raw = lastItem.raw.trimEnd()
  lastItem.text = lastItem.text.trimEnd()
  token.raw = token.raw.trimEnd()
  for (const it of token.items) {
    top = false
    it.tokens = lex(it.text, [])
    if (!token.loose) token.loose = it.tokens.some(t => t.t === 'space' && /\n.*\n/.test(t.raw))
  }
  for (const it of token.items) {
    const first = it.tokens[0]
    if (it.task && isPara(first)) {
      for (let j = queue.length - 1; j >= 0; j--) {
        if (IS_TASK.test(queue[j].src)) {
          queue[j].src = queue[j].src.replace(TASK, '')
          break
        }
      }
      const box = /\[[ xX]\]/.exec(it.raw)
      if (box) {
        const checked = box[0] !== '[ ]'
        if (token.loose) first.check = checked
        else it.tokens.unshift({ t: 'checkbox', checked })
      }
    }
  }
  if (token.loose) for (const it of token.items) for (const t of it.tokens) if (t.t === 'text') t.t = 'paragraph'
  return token
}

function splitCells(row, count) {
  const cells = row.replace(/\|/g, (_, at, str) => {
    let escaped = false
    while (--at >= 0 && str[at] === '\\') escaped = !escaped
    return escaped ? '|' : ' |'
  }).split(/ \|/)
  if (!cells[0].trim()) cells.shift()
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop()
  if (count) {
    if (cells.length > count) cells.splice(count)
    else while (cells.length < count) cells.push('')
  }
  return cells.map(c => c.trim().replace(/\\\|/g, '|'))
}

function table(s, i) {
  B_TABLE.lastIndex = i
  const cap = B_TABLE.exec(s)
  if (!cap || !/[:|]/.test(cap[2])) return
  const head = splitCells(cap[1])
  const aligns = cap[2].replace(/^\||\| *$/g, '').split('|')
  if (head.length !== aligns.length) return
  const rows = cap[3]?.trim() ? cap[3].replace(/\n[ \t]*$/, '').split('\n') : []
  const align = aligns.map(a => /^ *-+: *$/.test(a) ? 'right' : /^ *:-+: *$/.test(a) ? 'center' : /^ *:-+ *$/.test(a) ? 'left' : '')
  return {
    t: 'table', raw: rtrim(cap[0], '\n'), align,
    head: head.map(later),
    rows: rows.map(r => splitCells(r, head.length).map(later)),
  }
}

const box = checked => `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `
const cell = (tag, align) => (e, i) => `<${tag}${align[i] ? ` align="${align[i]}"` : ''}>${e.html}</${tag}>\n`

function render(tokens) {
  let out = ''
  for (const t of tokens) {
    switch (t.t) {
      case 'hr': out += '<hr>\n'; break
      case 'heading': out += `<h${t.depth}>${t.e.html}</h${t.depth}>\n`; break
      case 'code': {
        const lang = (t.lang || '').match(/^\S*/)[0]
        const code = t.text ? t.text.replace(/\n$/, '') + '\n' : ''
        out += (lang ? `<pre><code class="language-${escape(lang)}">` : '<pre><code>') + escape(code, true) + '</code></pre>\n'
        break
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n' + t.head.map(cell('th', t.align)).join('') + '</tr>\n</thead>\n'
        if (t.rows.length) out += '<tbody>' + t.rows.map(r => '<tr>\n' + r.map(cell('td', t.align)).join('') + '</tr>\n').join('') + '</tbody>'
        out += '</table>\n'
        break
      }
      case 'blockquote': out += `<blockquote>\n${render(t.tokens)}</blockquote>\n`; break
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul'
        out += `<${tag}${t.ordered && t.start !== 1 ? ` start="${t.start}"` : ''}>\n`
        for (const it of t.items) out += `<li>${render(it.tokens)}</li>\n`
        out += `</${tag}>\n`
        break
      }
      case 'checkbox': out += box(t.checked); break
      case 'html': out += t.raw; break
      case 'paragraph': out += `<p>${t.check === undefined ? '' : box(t.check)}${t.e.html}</p>\n`; break
      case 'text': out += t.e.html; break
    }
  }
  return out
}

// ---- inline

function findClosingBracket(s) {
  if (!s.includes(')')) return -1
  let level = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '(') level++
    else if (s[i] === ')' && --level < 0) return i
  }
  return level > 0 ? -2 : -1
}

/** Whether the label at `start` in `src` ends inside an HTML tag or autolink that starts in it. */
function labelEndsInside(src, start, text) {
  if (!text.includes('<')) return false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') {
      I_CODE.lastIndex = i
      const m = I_CODE.exec(text)
      if (m) {
        i += m[0].length - 1
        continue
      }
    }
    if (ch !== '<') continue
    I_TAG.lastIndex = I_AUTOLINK.lastIndex = start + i
    const m = I_TAG.exec(src) || I_AUTOLINK.exec(src)
    if (!m) continue
    if (m[0].length > text.length - i) return true
    i += m[0].length - 1
  }
  return false
}

/** Whether link text `s` holds a link already. An image doesn't count. */
function linkInText(s) {
  if (!s.includes('[')) return false
  for (const m of s.matchAll(SKIP)) {
    I_LINK.lastIndex = 0
    if (I_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true
  }
  for (const m of s.matchAll(REF_SEARCH)) {
    const m0 = m[0], at = m0.lastIndexOf('[')
    if (m0[0] === '!' || !(label(m0.slice(at + 1, -1)) in links)) continue
    if (at > 1 && linkInText(m0.slice(1, at - 1))) continue
    return true
  }
  return false
}

function maskRef(m0) {
  const at = m0.lastIndexOf('[')
  if (!(label(m0.slice(at + 1, -1)) in links)) return m0
  if (at > 1 && m0[0] !== '!') {
    const text = m0.slice(1, at - 1)
    if (linkInText(text)) return '[' + text.replace(REF_SEARCH, maskRef) + '][' + 'a'.repeat(m0.length - at - 2) + ']'
  }
  return '[' + 'a'.repeat(m0.length - 2) + ']'
}

/** `src` with links, code, tags and escapes hidden from emphasis, at the same length. */
function mask(src) {
  let m = src.includes('[') ? src.replace(REF_SEARCH, maskRef) : src
  if (src.includes('\\')) m = m.replace(ANY_PUNCT, x => '+'.repeat(x.length))
  return /[[`<]/.test(src) ? m.replace(SKIP, x => '[' + 'a'.repeat(x.length - 2) + ']') : m
}

/** A link or image to `href`, or undefined when its text holds a link. */
function outputLink(text, raw, href, title, alt) {
  text = text.replace(/\\([[\]])/g, '$1')
  const image = raw[0] === '!'
  inLink = true
  const outerEmitted = linkEmitted, outerRaw = inRawBlock
  linkEmitted = false
  const inner = inline(text, alt || image)
  const has = linkEmitted
  linkEmitted = outerEmitted
  inLink = false
  if (!image) {
    if (has) {
      inRawBlock = outerRaw
      return
    }
    linkEmitted = true
  }
  if (alt) return text
  const url = cleanUrl(href)
  if (image) {
    if (url === null) return escape(inner)
    return `<img src="${escape(url)}" alt="${escape(inner)}"${title ? ` title="${escape(title)}"` : ''}>`
  }
  if (url === null) return inner
  return `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}>${inner}</a>`
}

function link(src, p, alt) {
  I_LINK.lastIndex = p
  const cap = I_LINK.exec(src)
  if (!cap || labelEndsInside(src, p + (cap[0][0] === '!' ? 2 : 1), cap[1])) return
  let raw = cap[0], href = cap[2], title = cap[3]
  const trimmed = href.trim()
  if (trimmed[0] === '<') {
    if (!trimmed.endsWith('>') || (trimmed.length - rtrim(trimmed.slice(0, -1), '\\').length) % 2 === 0) return
  } else {
    const close = findClosingBracket(href)
    if (close === -2) return
    if (close > -1) {
      raw = raw.substring(0, (raw[0] === '!' ? 5 : 4) + cap[1].length + close).trim()
      href = href.substring(0, close)
      title = ''
    }
  }
  title = title ? title.slice(1, -1) : ''
  href = href.trim()
  if (href[0] === '<') href = href.slice(1, -1)
  const html = outputLink(cap[1], raw, href && href.replace(ANY_PUNCT, '$1'), (title && title.replace(ANY_PUNCT, '$1')) || null, alt)
  return html === undefined ? undefined : [p + raw.length, html]
}

function reflink(src, p, alt) {
  I_REFLINK.lastIndex = p
  let cap = I_REFLINK.exec(src)
  if (!cap) {
    I_NOLINK.lastIndex = p
    cap = I_NOLINK.exec(src)
  }
  if (!cap || labelEndsInside(src, p + (cap[0][0] === '!' ? 2 : 1), cap[1])) return
  const l = links[label((cap[2] || cap[1]).replace(/\s+/g, ' '))]
  if (!l) return [p + 1, null]
  const html = outputLink(cap[1], cap[0], l.href, l.title || null, alt)
  return html === undefined ? undefined : [p + cap[0].length, html]
}

/** Emphasis or strikethrough at `p`, as marked pairs its delimiters. */
function delimited(src, p, prev, k, alt, tilde) {
  const L = tilde ? DEL_L : EM_L
  L.lastIndex = p
  const m = L.exec(src)
  if (!m) return
  if (!tilde) {
    if (!m[1] && !m[2] && !m[3] && !m[4]) return
    if (m[4] && ALNUM.test(prev)) return
  }
  const next = m[1] || m[3] || ''
  if (next && prev && !PUNCT.test(prev)) return
  const delim = src[p]
  let lLength = 1
  while (src[p + lLength] === delim) lLength++
  let total = lLength, mid = 0, r
  const midRun = prev === delim
  const R = tilde ? DEL_R : delim === '*' ? EM_R_AST : EM_R_UND
  R.lastIndex = 0
  const ms = (k.masked ??= mask(src)).slice(p + lLength)
  while ((r = R.exec(ms)) !== null) {
    const d = r[1] || r[2] || r[3] || r[4] || r[5] || r[6]
    if (!d) continue
    let rLength = d.length
    if (tilde && rLength !== lLength) continue
    if (r[3] || r[4]) {
      total += rLength
      continue
    }
    if (!tilde && (r[5] || r[6])) {
      if (lLength % 3 && !((lLength + rLength) % 3)) {
        mid += rLength
        continue
      }
      if (midRun) break
    }
    total -= rLength
    if (total > 0) continue
    rLength = Math.min(rLength, rLength + total + mid)
    const end = p + lLength + r.index + (r[0].codePointAt(0) > 0xffff ? 2 : 1) + rLength
    const raw = src.slice(p, end)
    const cut = tilde ? lLength : Math.min(lLength, rLength) % 2 ? 1 : 2
    const text = raw.slice(cut, -cut)
    const inner = inline(text, alt)
    const tag = tilde ? 'del' : cut === 1 ? 'em' : 'strong'
    return [end, alt ? text : `<${tag}>${inner}</${tag}>`]
  }
}

// ASCII classes for plain text: 1 starts something else, 2 can be in an email's name, 4 is a letter or digit.
const CH = new Uint8Array(128)
for (const ch of '\\<![`*~_') CH[ch.charCodeAt(0)] |= 1
for (const ch of ".!#$%&'*+/=?_`{|}~-") CH[ch.charCodeAt(0)] |= 2
for (let c = 48; c < 123; c++) if (c < 58 || (c > 64 && c < 91) || c > 96) CH[c] |= 6
const cls = c => c < 128 ? CH[c] : 0
const mailtoAt = (s, i) => s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)
const STOP = /[\\<![`*~_]|[hH][tT][tT][pP]|[fF][tT][pP]:\/\/|www\./g

const find = (s, ch, from) => {
  const i = s.indexOf(ch, from)
  return i < 0 ? s.length : i
}

/**
 * Where the plain text at `p` ends: before anything that could start a link, emphasis, code, a tag, a break, or a
 * bare URL or email. Each kind's next place is found by a single-character search and kept in `k` until passed.
 */
function textEnd(s, p, k) {
  const n = s.length
  let c = s.charCodeAt(p)
  if (!(cls(c) & 4) && mailtoAt(s, p + 1)) return p + 1
  let q = p + 1
  if (c === 96 || c === 126) while (s.charCodeAt(q) === c) q++
  if (k.stop < q) {
    STOP.lastIndex = q
    k.stop = STOP.exec(s)?.index ?? n
  }
  let end = k.stop
  // An email's name, then its `@`.
  if (k.at <= q) {
    let a = q
    for (;;) {
      a = find(s, '@', a)
      let u = a
      while (u > 0 && cls(s.charCodeAt(u - 1)) & 2) u--
      if (a === n || (u < a && a > q)) {
        k.at = a
        k.name = u
        break
      }
      a++
    }
  }
  if (k.at < n) end = Math.min(end, Math.max(k.name, q))
  // Two spaces before a line break. Spaces can't run past `end`, which isn't one.
  if (k.nl < q) k.nl = find(s, '\n', q)
  while (k.nl < end) {
    const nl = k.nl
    if (nl - 2 >= q && s.charCodeAt(nl - 1) === 32 && s.charCodeAt(nl - 2) === 32) {
      let t = nl - 2
      while (t > q && s.charCodeAt(t - 1) === 32) t--
      end = t
      break
    }
    k.nl = find(s, '\n', nl + 1)
  }
  // `mailto:` or `xmpp:` after a character that isn't a letter or digit.
  if (k.colon < q + 5) k.colon = find(s, ':', q + 5)
  while (k.colon < n && k.colon < end + 6) {
    const cl = k.colon
    const t = s.startsWith('mailto', cl - 6) ? cl - 6 : s.startsWith('xmpp', cl - 4) ? cl - 4 : -1
    if (t > q && !(cls(s.charCodeAt(t - 1)) & 4)) {
      if (t < end) end = t
      break
    }
    k.colon = find(s, ':', cl + 1)
  }
  return end
}

/** The HTML for inline Markdown `src`, or its plain text for an image's alt when `alt`. */
function inline(src, alt) {
  const n = src.length
  let out = '', text = '', textRaw = false, inText = false
  let prev = '', keep = false
  const k = { stop: -1, at: -1, name: 0, nl: -1, colon: -1, refs: src.includes('&#'), masked: null }
  let p = 0, m, r
  while (p < n) {
    if (!keep) prev = ''
    keep = false
    const c = src.charCodeAt(p)
    r = undefined
    if (c === 92) {
      I_ESCAPE.lastIndex = p
      if ((m = I_ESCAPE.exec(src))) r = [p + 2, alt ? m[1] : escape(m[1])]
    } else if (c === 60) {
      I_TAG.lastIndex = p
      if ((m = I_TAG.exec(src))) {
        const tag = m[0]
        if (!inLink && /^<a /i.test(tag)) inLink = true
        else if (inLink && /^<\/a>/i.test(tag)) inLink = false
        if (!inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) inRawBlock = true
        else if (inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) inRawBlock = false
        r = [p + tag.length, tag]
      }
    } else if (c === 33 || c === 91) {
      r = link(src, p, alt)
      if (!r) {
        r = reflink(src, p, alt)
        if (r && r[1] === null) {
          const ch = src[p]
          if (inText) text += ch
          else {
            inText = true
            text = ch
            textRaw = false
          }
          p = r[0]
          continue
        }
      }
    }
    if (!r && (c === 42 || c === 95)) r = delimited(src, p, prev, k, alt, false)
    if (!r) {
      if (c === 96) {
        I_CODE.lastIndex = p
        if ((m = I_CODE.exec(src))) {
          let code = m[2].includes('\n') ? m[2].replace(/\n/g, ' ') : m[2]
          if (/[^ ]/.test(code) && code[0] === ' ' && code[code.length - 1] === ' ') code = code.slice(1, -1)
          r = [p + m[0].length, alt ? code : `<code>${escape(code, true)}</code>`]
        }
      } else if (c === 32 || c === 92) {
        I_BR.lastIndex = p
        if ((m = I_BR.exec(src))) r = [p + m[0].length, alt ? '' : '<br>']
      } else if (c === 126) r = delimited(src, p, prev, k, alt, true)
    }
    if (!r && c === 60) {
      I_AUTOLINK.lastIndex = p
      if ((m = I_AUTOLINK.exec(src))) {
        const t = m[1], href = m[2] === '@' ? 'mailto:' + t : t
        r = [p + m[0].length, alt ? t : autolink(href, t)]
      }
    }
    if (!r && !inLink && ((c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122) || c === 46 || c === 95 || c === 43 || c === 45)) {
      I_URL.lastIndex = p
      if ((m = I_URL.exec(src))) {
        let t = m[0], href
        if (m[2] === '@') href = 'mailto:' + t
        else {
          let before
          do {
            before = t
            t = BACKPEDAL.exec(t)?.[0] ?? ''
          } while (before !== t)
          href = m[1] === 'www.' ? 'http://' + t : t
        }
        r = [p + t.length, alt ? t : autolink(href, t)]
      }
    }
    if (r) {
      if (inText) {
        out += alt || textRaw ? text : escape(text)
        inText = false
      }
      out += r[1]
      p = r[0]
      continue
    }
    const end = textEnd(src, p, k)
    const raw = src.slice(p, end)
    p = end
    const last = raw[raw.length - 1]
    if (last !== '_') prev = last
    keep = true
    const t = inRawBlock || !k.refs ? raw : decode(raw)
    if (inText) text += t
    else {
      inText = true
      text = t
      textRaw = inRawBlock
    }
  }
  if (inText) out += alt || textRaw ? text : escape(text)
  return out
}

function autolink(href, text) {
  const url = cleanUrl(href)
  text = escape(text, true)
  return url === null ? text : `<a href="${escape(url, true)}">${text}</a>`
}
