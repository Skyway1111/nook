// Formulas in Claude's transcript. nook's mod saves each display formula Claude writes, $$ … $$ or \[ … \],
// as a .tex file and names it as a picture. `formula` reads it and writes it as MathML Core, which the webview
// lays out in the picture's box (pictures.js), in the theme's ink. A command it doesn't know shows in red, and
// a formula that doesn't parse shows as its source. Every node is built through the DOM, so no text from the
// formula is ever read as markup.
import { invoke } from './host.js'

const NS = 'http://www.w3.org/1998/Math/MathML'

/** The formula in the .tex file at `path`, as a <math> element. */
export async function formula(path) {
  return mathml(await invoke('read_text', { path }))
}

// TeX's symbols by kind: i a letter (italic alone), n upright, b binary, r relation, o opening, c closing,
// f a bar, d dots, u an operator spaced as the webview's dictionary has it, L a big operator with limits
// under and over, I one with them beside it.
const TABLE = {
  n: 'Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω infty ∞ nabla ∇ emptyset ∅ '
    + 'varnothing ∅ hbar ℏ hslash ℏ ell ℓ wp ℘ Re ℜ Im ℑ aleph ℵ beth ℶ gimel ℷ daleth ℸ forall ∀ exists ∃ '
    + 'nexists ∄ neg ¬ lnot ¬ top ⊤ bot ⊥ angle ∠ measuredangle ∡ sphericalangle ∢ triangle △ square □ Box □ '
    + 'blacksquare ■ Diamond ◊ lozenge ◊ blacklozenge ⧫ bigstar ★ clubsuit ♣ diamondsuit ♢ heartsuit ♡ spadesuit ♠ '
    + 'flat ♭ natural ♮ sharp ♯ backprime ‵ surd √ degree ° checkmark ✓ dag † ddag ‡ S § P ¶ copyright © pounds £ '
    + 'yen ¥ euro € imath ı jmath ȷ complement ∁ mho ℧ eth ð Finv Ⅎ Game ⅁ circledR ® circledS Ⓢ Bbbk 𝕜 # # $ $ '
    + '% % & & _ _',
  i: 'alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ '
    + 'varkappa ϰ lambda λ mu μ nu ν xi ξ omicron ο pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ '
    + 'upsilon υ phi ϕ varphi φ chi χ psi ψ omega ω digamma ϝ partial ∂ varGamma Γ varDelta Δ varTheta Θ '
    + 'varLambda Λ varXi Ξ varPi Π varSigma Σ varUpsilon Υ varPhi Φ varPsi Ψ varOmega Ω',
  b: 'pm ± mp ∓ times × div ÷ cdot ⋅ ast ∗ star ⋆ circ ∘ bullet ∙ oplus ⊕ ominus ⊖ otimes ⊗ oslash ⊘ odot ⊙ '
    + 'cup ∪ cap ∩ sqcup ⊔ sqcap ⊓ vee ∨ lor ∨ wedge ∧ land ∧ setminus ∖ smallsetminus ∖ wr ≀ uplus ⊎ amalg ⨿ '
    + 'diamond ⋄ bigtriangleup △ bigtriangledown ▽ triangleleft ◃ triangleright ▹ lhd ⊲ rhd ⊳ unlhd ⊴ unrhd ⊵ '
    + 'dagger † ddagger ‡ ltimes ⋉ rtimes ⋊ dotplus ∔ boxplus ⊞ boxminus ⊟ boxtimes ⊠ boxdot ⊡ circledast ⊛ '
    + 'circledcirc ⊚ circleddash ⊝ divideontimes ⋇ intercal ⊺ barwedge ⌅ veebar ⊻ curlywedge ⋏ curlyvee ⋎ '
    + 'centerdot ⋅ bigcirc ◯ Cap ⋒ Cup ⋓',
  r: 'leq ≤ le ≤ geq ≥ ge ≥ neq ≠ ne ≠ equiv ≡ approx ≈ sim ∼ simeq ≃ cong ≅ propto ∝ varpropto ∝ ll ≪ gg ≫ '
    + 'lll ⋘ ggg ⋙ subset ⊂ supset ⊃ subseteq ⊆ supseteq ⊇ subsetneq ⊊ supsetneq ⊋ nsubseteq ⊈ nsupseteq ⊉ '
    + 'sqsubset ⊏ sqsupset ⊐ sqsubseteq ⊑ sqsupseteq ⊒ Subset ⋐ Supset ⋑ in ∈ notin ∉ ni ∋ owns ∋ mid ∣ nmid ∤ '
    + 'parallel ∥ nparallel ∦ perp ⊥ vdash ⊢ dashv ⊣ models ⊨ vDash ⊨ Vdash ⊩ to → rightarrow → leftarrow ← '
    + 'gets ← Rightarrow ⇒ Leftarrow ⇐ leftrightarrow ↔ Leftrightarrow ⇔ mapsto ↦ '
    + 'longmapsto ⟼ longrightarrow ⟶ longleftarrow ⟵ longleftrightarrow ⟷ Longrightarrow ⟹ Longleftarrow ⟸ '
    + 'Longleftrightarrow ⟺ uparrow ↑ downarrow ↓ updownarrow ↕ Uparrow ⇑ Downarrow ⇓ Updownarrow ⇕ nearrow ↗ '
    + 'searrow ↘ swarrow ↙ nwarrow ↖ hookrightarrow ↪ hookleftarrow ↩ rightharpoonup ⇀ rightharpoondown ⇁ '
    + 'leftharpoonup ↼ leftharpoondown ↽ rightleftharpoons ⇌ leftrightharpoons ⇋ leadsto ⇝ rightsquigarrow ⇝ '
    + 'twoheadrightarrow ↠ twoheadleftarrow ↞ rightarrowtail ↣ leftarrowtail ↢ circlearrowleft ↺ '
    + 'circlearrowright ↻ curvearrowleft ↶ curvearrowright ↷ leftleftarrows ⇇ rightrightarrows ⇉ '
    + 'leftrightarrows ⇆ rightleftarrows ⇄ upuparrows ⇈ downdownarrows ⇊ Lleftarrow ⇚ Rrightarrow ⇛ '
    + 'upharpoonright ↾ restriction ↾ upharpoonleft ↿ downharpoonright ⇂ downharpoonleft ⇃ nleftarrow ↚ '
    + 'nrightarrow ↛ nLeftarrow ⇍ nRightarrow ⇏ nleftrightarrow ↮ nLeftrightarrow ⇎ multimap ⊸ leqslant ⩽ '
    + 'geqslant ⩾ leqq ≦ geqq ≧ lneq ⪇ gneq ⪈ lneqq ≨ gneqq ≩ lesssim ≲ gtrsim ≳ lessapprox ⪅ gtrapprox ⪆ '
    + 'lessgtr ≶ gtrless ≷ prec ≺ succ ≻ preceq ⪯ succeq ⪰ precsim ≾ succsim ≿ nless ≮ ngtr ≯ nleq ≰ ngeq ≱ '
    + 'nsim ≁ ncong ≇ nprec ⊀ nsucc ⊁ asymp ≍ doteq ≐ doteqdot ≑ triangleq ≜ coloneqq ≔ coloneq ≔ eqqcolon ≕ '
    + 'Coloneqq ⩴ approxeq ≊ backsim ∽ eqsim ≂ circeq ≗ bumpeq ≏ Bumpeq ≎ thicksim ∼ thickapprox ≈ bowtie ⋈ '
    + 'Join ⨝ smile ⌣ frown ⌢ therefore ∴ because ∵ vartriangleleft ⊲ vartriangleright ⊳ trianglelefteq ⊴ '
    + 'trianglerighteq ⊵ ntriangleleft ⋪ ntriangleright ⋫ pitchfork ⋔ shortmid ∣ shortparallel ∥ lessdot ⋖ '
    + 'gtrdot ⋗',
  o: 'langle ⟨ lbrace { lbrack [ lfloor ⌊ lceil ⌈ lgroup ⟮ lmoustache ⎰ ulcorner ⌜ llcorner ⌞ llbracket ⟦ '
    + 'lvert | lVert ‖ { {',
  c: 'rangle ⟩ rbrace } rbrack ] rfloor ⌋ rceil ⌉ rgroup ⟯ rmoustache ⎱ urcorner ⌝ lrcorner ⌟ rrbracket ⟧ '
    + 'rvert | rVert ‖ } }',
  f: 'vert | Vert ‖ | ‖ backslash \\',
  d: 'ldots … dots … cdots ⋯ vdots ⋮ ddots ⋱ dotsc … dotsb ⋯ dotsm ⋯ dotsi ⋯ dotso … iddots ⋰ prime ′',
  L: 'sum ∑ prod ∏ coprod ∐ bigcup ⋃ bigcap ⋂ bigvee ⋁ bigwedge ⋀ bigoplus ⨁ bigotimes ⨂ bigodot ⨀ biguplus ⨄ '
    + 'bigsqcup ⨆',
  I: 'int ∫ iint ∬ iiint ∭ iiiint ⨌ oint ∮ oiint ∯ oiiint ∰ intop ∫ smallint ∫',
}
const SYMBOLS = new Map() // name -> [char, kind]
const KIND = new Map() // char -> kind, for a symbol typed as itself
for (const [kind, list] of Object.entries(TABLE)) {
  const words = list.split(' ')
  for (let i = 0; i < words.length; i += 2) {
    SYMBOLS.set(words[i], [words[i + 1], kind])
    if (!KIND.has(words[i + 1])) KIND.set(words[i + 1], kind)
  }
}
for (const [kind, chars] of Object.entries({ b: '+−∗', r: '=<>:', p: ',;', c: '!?)]', o: '([', f: '|/.' })) {
  for (const c of chars) KIND.set(c, kind)
}

const FUNCTIONS = new Set('arccos arcsin arctan arg cos cosh cot coth csc deg dim exp hom ker lg ln log sec sin sinh tan tanh'.split(' '))
const LIMITED = new Map(Object.entries({ det: 'det', gcd: 'gcd', inf: 'inf', lim: 'lim', liminf: 'lim\u2009inf', limsup: 'lim\u2009sup',
  max: 'max', min: 'min', Pr: 'Pr', sup: 'sup', injlim: 'inj\u2009lim', projlim: 'proj\u2009lim' }))

// Alphabets for \mathbf and the rest: where A, a, 0 and Α sit among Unicode's mathematical alphanumerics, and
// the letters that live elsewhere, in pairs.
const ALPHABETS = new Map(Object.entries({
  bf: [0x1d400, 0x1d41a, 0x1d7ce, 0x1d6a8],
  it: [0x1d434, 0x1d44e, 0, 0x1d6e2, 'hℎ'],
  bi: [0x1d468, 0x1d482, 0x1d7ce, 0x1d71c],
  cal: [0x1d49c, 0x1d4b6, 0, 0, 'BℬEℰFℱHℋIℐLℒMℳRℛeℯgℊoℴ'],
  frak: [0x1d504, 0x1d51e, 0, 0, 'CℭHℌIℑRℜZℨ'],
  bb: [0x1d538, 0x1d552, 0x1d7d8, 0, 'CℂHℍNℕPℙQℚRℝZℤ'],
  sf: [0x1d5a0, 0x1d5ba, 0x1d7e2, 0],
  tt: [0x1d670, 0x1d68a, 0x1d7f6, 0],
}))
const FONTS = new Map(Object.entries({ mathrm: 'rm', mathup: 'rm', mathit: 'it', mathnormal: '', mathbf: 'bf', bold: 'bf',
  mathbb: 'bb', Bbb: 'bb', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak', mathsf: 'sf', mathtt: 'tt', boldsymbol: 'bi',
  bm: 'bi', pmb: 'bi', mathbfit: 'bi' }))
const SWITCHES = new Map(Object.entries({ '\\rm': 'rm', '\\bf': 'bf', '\\it': 'it', '\\sf': 'sf', '\\tt': 'tt', '\\cal': 'cal', '\\mit': '' }))
const STYLES = new Map(Object.entries({ '\\displaystyle': ['true', ''], '\\textstyle': ['false', ''], '\\scriptstyle': ['false', '1'],
  '\\scriptscriptstyle': ['false', '2'] }))

// name -> its mark, over the argument, or under it for under… and utilde. wide…, over… and under… stretch.
const ACCENTS = { hat: '\u0302', widehat: '\u0302', check: 'ˇ', widecheck: 'ˇ', tilde: '˜', widetilde: '˜', utilde: '˜',
  acute: '´', grave: '`', dot: '˙', ddot: '¨', dddot: '\u20db', ddddot: '\u20dc', breve: '˘', bar: '¯', vec: '\u20d7',
  mathring: '˚', overrightarrow: '→', overleftarrow: '←', overleftrightarrow: '↔', underrightarrow: '→',
  underleftarrow: '←', underleftrightarrow: '↔', overbrace: '⏞', underbrace: '⏟', overparen: '⏜', underparen: '⏝' }
const ARROWS = { xrightarrow: '→', xleftarrow: '←', xRightarrow: '⇒', xLeftarrow: '⇐', xleftrightarrow: '↔',
  xLeftrightarrow: '⇔', xmapsto: '↦', xhookrightarrow: '↪', xhookleftarrow: '↩', xrightharpoonup: '⇀',
  xrightharpoondown: '⇁', xleftharpoonup: '↼', xleftharpoondown: '↽', xrightleftharpoons: '⇌',
  xleftrightharpoons: '⇋', xtwoheadrightarrow: '↠', xtwoheadleftarrow: '↞', xlongequal: '=' }
const SPACES = { ',': 3, thinspace: 3, ':': 4, '>': 4, medspace: 4, ';': 5, thickspace: 5, '!': -3, negthinspace: -3,
  negmedspace: -4, negthickspace: -5, ' ': 4.5, enspace: 9, enskip: 9, quad: 18, qquad: 36 } // in mu, 1/18 em
const UNITS = { em: 1, ex: 0.43, pt: 0.1, pc: 1.2, mu: 1 / 18, cm: 2.845, mm: 0.2845, in: 7.227, px: 0.075, bp: 0.1004, dd: 0.107 }
const TEXT = { text: '', textrm: '', textnormal: '', textup: '', textmd: '', mbox: '', hbox: '', textbf: 'font-weight:bold',
  textit: 'font-style:italic', emph: 'font-style:italic', texttt: 'font-family:monospace', textsf: 'font-family:sans-serif' }
const IGNORED = 'nonumber notag nobreak allowbreak relax displaybreak strut limits nolimits hline hdashline tiny scriptsize '
  + 'footnotesize small normalsize large Large LARGE huge Huge'

// environment -> [layout, opening, closing, attributes]
const ENVIRONMENTS = new Map(Object.entries({
  matrix: ['matrix'], pmatrix: ['matrix', '(', ')'], bmatrix: ['matrix', '[', ']'], Bmatrix: ['matrix', '{', '}'],
  vmatrix: ['matrix', '|', '|'], Vmatrix: ['matrix', '‖', '‖'], smallmatrix: ['small', '', '', { scriptlevel: '1' }],
  cases: ['cases', '{'], dcases: ['cases', '{', '', { displaystyle: 'true' }], rcases: ['cases', '', '}'],
  array: ['array'], darray: ['array', '', '', { displaystyle: 'true' }], subarray: ['substack'],
  ...Object.fromEntries('aligned align split alignat alignedat flalign eqnarray'.split(' ').map(n => [n, ['align', '', '', { displaystyle: 'true' }]])),
  ...Object.fromEntries('gathered gather equation multline'.split(' ').map(n => [n, ['gather', '', '', { displaystyle: 'true' }]])),
}))

const CLOSE = new Set(['}', '&', '\\\\', '\\cr', '\\end', '\\right', '\\middle'])
const SIGNED = new Set(['start', 'bin', 'rel', 'open', 'punct', 'op']) // a + or − after these is a sign
const OPENING = new Set(['(', '[', '\\left', '\\{', '\\lbrace', '\\langle', '\\lbrack', '\\big', '\\Big', '\\bigg', '\\Bigg',
  '\\bigl', '\\Bigl', '\\biggl', '\\Biggl', null, ...CLOSE])
const BAR = { stretchy: 'false', lspace: '0', rspace: '0' }
const FENCE = { stretchy: 'true', symmetric: 'true', lspace: '0', rspace: '0' }
const ZERO = { lspace: '0', rspace: '0' }
const WIDE = { lspace: '.5556em', rspace: '.5556em' } // \implies and \iff: a relation's space and a \; more
const TOKEN = /\\(?:[A-Za-z]+|[^])|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^]/y
const DIGITS = /(?:\.?\d)*/y
const LETTERS = /[A-Za-z]*/y
const LENGTH = /[-+]?\s*\d*\.?\d+\s*[a-z]{2}/y

let src = '' // the TeX being read, its macros expanded in place
let at = 0 // where reading is in it
let font = '' // the alphabet letters take: '', 'rm', or one of ALPHABETS
let tag = null // the \tag on the line being read
let budget = 0 // macro expansions left, so a macro that calls itself ends
const macros = new Map() // \newcommand's, kept from formula to formula

/** `source`, TeX, as a <math> element. */
export function mathml(source) {
  const math = m('math')
  math.setAttribute('display', 'block')
  math.setAttribute('class', 'tex')
  src = source
  at = 0
  font = ''
  tag = null
  budget = 1000
  try {
    let nodes = row()
    if (peek() !== null) {
      if (!['&', '\\\\', '\\cr'].includes(peek())) throw new Error('unbalanced')
      at = 0 // lines or & at the top: the formula is one table
      nodes = [table(null, null, null)]
    }
    math.append(...nodes)
    if (tag) math.append(tag)
  } catch {
    math.replaceChildren(klass(m('mtext', source.trim().replace(/\s+/g, ' ')), 'source'))
  }
  return math
}

function m(name, ...kids) {
  const e = document.createElementNS(NS, name)
  e.append(...kids)
  return e
}

function mo(text, attrs) {
  const e = m('mo', text)
  for (const k in attrs) e.setAttribute(k, attrs[k])
  return e
}

function klass(e, name) {
  e.setAttribute('class', name)
  return e
}

const wrap = nodes => (nodes.length === 1 ? nodes[0] : m('mrow', ...nodes))

/** Moves past spaces and % comments. */
function skip() {
  for (let c = src.charCodeAt(at); ; c = src.charCodeAt(at)) {
    if (c === 32 || c === 10 || c === 9 || c === 13) at++
    else if (c === 37) at = src.indexOf('\n', at) + 1 || src.length
    else return
  }
}

/** The next token as written: a command, or one character. */
function raw() {
  skip()
  if (at >= src.length) return null
  TOKEN.lastIndex = at
  const t = TOKEN.exec(src)[0]
  at += t.length
  return t
}

/** The next token, a macro's replaced by its body. */
function next() {
  for (;;) {
    const t = raw()
    const macro = t && macros.get(t)
    if (!macro) return t
    if (--budget < 0 || src.length > 100000) throw new Error('macro loop')
    const start = at - t.length
    const args = macro.opt === undefined ? [] : [optional() ?? macro.opt]
    while (args.length < macro.n) args.push(braced())
    const body = macro.body.replace(/#([1-9])/g, (_, k) => args[k - 1] ?? '')
    src = src.slice(0, start) + body + (/\\[A-Za-z]+$/.test(body) ? ' ' : '') + src.slice(at)
    at = start
  }
}

function peek() {
  const a = at
  const t = next()
  at = a
  return t
}

/** A braced argument's source, or one token's. */
function braced() {
  skip()
  if (src[at] !== '{') {
    const t = raw()
    if (t === null) throw new Error('argument')
    return t
  }
  for (let i = at + 1, depth = 1; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      const s = src.slice(at + 1, i)
      at = i + 1
      return s
    }
  }
  throw new Error('unclosed {')
}

/** An [optional] argument's source, or null. */
function optional() {
  skip()
  if (src[at] !== '[') return null
  for (let i = at + 1, depth = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === ']' && !depth) {
      const s = src.slice(at + 1, i)
      at = i + 1
      return s
    }
  }
  throw new Error('unclosed [')
}

/** A `*` right after a command, taken. */
const star = () => src[at] === '*' && ++at > 0

/** `text` read as math on its own, as one node. */
function inner(text) {
  const [s, a] = [src, at]
  src = text
  at = 0
  const nodes = row()
  if (peek() !== null) throw new Error('unbalanced')
  src = s
  at = a
  return wrap(nodes)
}

/** Atoms up to the next closing token, which stays unread. `prev` is the class of what comes before. */
function row(prev = 'start') {
  const out = []
  for (;;) {
    const a = at
    const t = next()
    if (t === null || CLOSE.has(t)) {
      at = a
      return out
    }
    if (t === '\\color') {
      const c = color()
      out.push(paint(m('mrow', ...row(prev)), c))
    } else if (STYLES.has(t)) {
      const [display, level] = STYLES.get(t)
      const e = m('mrow', ...row(prev))
      e.setAttribute('displaystyle', display)
      if (level) e.setAttribute('scriptlevel', level)
      out.push(e)
    } else if (SWITCHES.has(t)) {
      const old = font
      font = SWITCHES.get(t)
      out.push(...row(prev))
      font = old
    } else if (t === '\\over' || t === '\\atop' || t === '\\choose') {
      const f = m('mfrac', wrap(out.splice(0)), wrap(row()))
      if (t !== '\\over') f.setAttribute('linethickness', '0')
      out.push(t === '\\choose' ? fenced('(', f, ')').node : f)
    } else prev = atom(out, prev, t) ?? prev
  }
}

/** Reads an atom that starts with `t` and its scripts into `out`, and returns its class. */
function atom(out, prev, t) {
  const p = primary(t, false)
  if (!p) return null
  let { node, cls, limits } = p
  if (cls === 'bin') {
    const sign = SIGNED.has(prev)
    node.setAttribute('form', sign ? 'prefix' : 'infix')
    if (sign) cls = 'ord'
  } else if (cls === 'rel' && prev === 'rel' && node.localName === 'mo' && out.at(-1)?.localName === 'mo') {
    out.at(-1).setAttribute('rspace', '0') // := and the like sit together
    node.setAttribute('lspace', '0')
  }
  if (p.fn && (prev === 'ord' || prev === 'close' || prev === 'inner')) out.push(space(1 / 6))
  let sub = null
  let sup = null
  let primes = ''
  for (;;) {
    const a = at
    const s = next()
    if (s === "'") primes += '′'
    else if (s === '\\limits' || s === '\\nolimits') limits = s === '\\limits'
    else if (s === '_') sub = sub ? m('mrow', sub, arg()) : arg()
    else if (s === '^') {
      const x = arg()
      if (/^[′″‴]+$/.test(x.textContent)) primes += x.textContent // ^\prime: a prime, not a raised one
      else sup = sup ? m('mrow', sup, x) : x
    } else {
      at = a
      break
    }
  }
  if (primes) node = m('mrow', node, mo(primes.replace(/′{2,3}/g, s => (s.length === 2 ? '″' : '‴')), ZERO))
  if (sub && sup) node = m(limits ? 'munderover' : 'msubsup', node, sub, sup)
  else if (sub) node = m(limits ? 'munder' : 'msub', node, sub)
  else if (sup) node = m(limits ? 'mover' : 'msup', node, sup)
  out.push(node)
  if (p.fn) out.push(mo('\u2061', { lspace: '0', rspace: OPENING.has(peek()) ? '0' : '.1667em' }))
  return cls
}

/** A required argument: a group in braces, or one token. */
function arg() {
  const t = next()
  if (t === null || CLOSE.has(t)) throw new Error('argument')
  return primary(t, true)?.node ?? m('mrow')
}

/** The atom `t` starts, without scripts: { node, cls, limits, fn }, or null for what draws nothing. `one`
 * reads one character of a number, as an argument does. */
function primary(t, one) {
  if (t === '{') {
    const nodes = row()
    if (next() !== '}') throw new Error('unclosed {')
    return { node: wrap(nodes), cls: 'ord' }
  }
  if (t.length > 1 && t[0] === '\\') return command(t.slice(1))
  if (t === '^' || t === '_') {
    at-- // a script with nothing under it
    return { node: m('mrow'), cls: 'ord' }
  }
  if (t === "'") return { node: mo('′', ZERO), cls: 'ord' }
  if (t === '~') return { node: space(1 / 3) }
  if (t === '$') return null
  const c = t.charCodeAt(0)
  if ((c >= 48 && c <= 57) || (t === '.' && /\d/.test(src[at]))) {
    let s = t
    if (!one) {
      DIGITS.lastIndex = at
      s += DIGITS.exec(src)[0]
      at = DIGITS.lastIndex
    }
    return { node: m('mn', style(s)), cls: 'ord' }
  }
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
    if (!font) return { node: m('mi', t), cls: 'ord' }
    let s = t
    if (!one) {
      LETTERS.lastIndex = at
      s += LETTERS.exec(src)[0]
      at = LETTERS.lastIndex
    }
    const e = m('mi', style(s))
    if (font === 'rm') e.setAttribute('mathvariant', 'normal')
    return { node: e, cls: 'ord' }
  }
  const ch = t === '-' ? '−' : t === '*' ? '∗' : t
  return symbol(ch, KIND.get(ch) ?? (/\p{L}/u.test(ch) ? 'i' : /\p{N}/u.test(ch) ? 'N' : 'u'))
}

function symbol(ch, kind) {
  switch (kind) {
    case 'i': case 'n': {
      const s = style(ch)
      const e = m('mi', s)
      if ((kind === 'n' || font === 'rm') && s === ch) e.setAttribute('mathvariant', 'normal')
      return { node: e, cls: 'ord' }
    }
    case 'N': return { node: m('mn', ch), cls: 'ord' }
    case 'b': return { node: m('mo', ch), cls: 'bin' }
    case 'r': return { node: ch === ':' ? mo(':', { lspace: '.2778em', rspace: '.2778em' }) : m('mo', ch), cls: 'rel' }
    case 'p': return { node: m('mo', ch), cls: 'punct' }
    case 'o': return { node: mo(ch, BAR), cls: 'open' }
    case 'c': return { node: mo(ch, BAR), cls: 'close' }
    case 'f': return { node: mo(ch, BAR), cls: 'ord' }
    case 'd': return { node: mo(ch, ZERO), cls: 'ord' }
    case 'L': case 'I': return { node: m('mo', ch), cls: 'op', limits: kind === 'L' }
    default: return { node: m('mo', ch), cls: 'ord' }
  }
}

/** `s` in the current alphabet. */
function style(s) {
  const a = ALPHABETS.get(font)
  if (!a) return s
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    const hole = a[4]?.indexOf(ch) ?? -1
    const g = a[3] ? greek(c) : -1
    out += hole >= 0 && hole % 2 === 0 ? a[4][hole + 1]
      : c >= 65 && c <= 90 ? String.fromCodePoint(a[0] + c - 65)
        : c >= 97 && c <= 122 ? String.fromCodePoint(a[1] + c - 97)
          : c >= 48 && c <= 57 && a[2] ? String.fromCodePoint(a[2] + c - 48)
            : g >= 0 ? String.fromCodePoint((font === 'bi' && g < 26 ? 0x1d6a8 : a[3]) + g) // bold capitals stay upright
              : ch
  }
  return out
}

/** Where a Greek letter sits in a mathematical Greek alphabet, or -1. */
function greek(c) {
  if (c >= 0x391 && c <= 0x3a9) return c - 0x391
  if (c >= 0x3b1 && c <= 0x3c9) return c - 0x3b1 + 26
  if (c === 0x2207) return 25
  const i = '∂ϵϑϰϕϱϖ'.indexOf(String.fromCharCode(c))
  return i < 0 ? -1 : 51 + i
}

function command(name) {
  const s = SYMBOLS.get(name)
  if (s) return symbol(s[0], s[1])
  const f = COMMANDS.get(name)
  if (f) return f(name)
  if (FUNCTIONS.has(name)) return { node: m('mi', name), cls: 'op', fn: true }
  if (LIMITED.has(name)) return { node: mo(LIMITED.get(name), { movablelimits: 'true', ...ZERO }), cls: 'op', fn: true, limits: true }
  return unknown('\\' + name)
}

function unknown(text) {
  return { node: klass(m('mtext', text), 'unknown'), cls: 'ord' }
}

/** A space `em` wide, or a step back for a negative one. */
function space(em) {
  const e = m('mspace')
  if (em >= 0) e.setAttribute('width', `${+em.toFixed(4)}em`)
  else e.style.marginLeft = `${+em.toFixed(4)}em`
  return e
}

/** A length in TeX's units, in ems. */
function length(s) {
  const r = /^\s*([-+]?)\s*(\d*\.?\d+)\s*([a-z]{2})/.exec(s ?? '')
  return r ? (r[1] === '-' ? -1 : 1) * r[2] * (UNITS[r[3]] ?? 0) : 0
}

/** A length after \kern, \hskip and the like, in braces or not. */
function measure() {
  skip()
  if (src[at] === '{') return length(braced())
  LENGTH.lastIndex = at
  const r = LENGTH.exec(src)
  if (!r) return 0
  at = LENGTH.lastIndex
  return length(r[0])
}

/** `node` between delimiters, which stretch to its height when `stretch`. */
function fenced(open, node, close, stretch = true) {
  const a = stretch ? FENCE : BAR
  return { node: m('mrow', ...(open ? [mo(open, a)] : []), node, ...(close ? [mo(close, a)] : [])), cls: 'inner' }
}

/** The delimiter after \left, \right, \big and the like: its character, or '' for `.`. */
function delimiter() {
  const t = next()
  if (t === null) throw new Error('delimiter')
  if (t === '.') return ''
  if (t === '<' || t === '>') return t === '<' ? '⟨' : '⟩'
  if (t[0] !== '\\' || t.length === 1) return t
  const s = SYMBOLS.get(t.slice(1))
  if (s && 'ocfr'.includes(s[1])) return s[0]
  throw new Error('delimiter')
}

/** A color's CSS form. Whatever it comes to only ever lands in `style.color` or `style.backgroundColor`, which
 * take nothing but a color. */
function color() {
  const model = optional()
  const spec = braced().trim()
  const rgb = scale => `rgb(${spec.split(',').map(v => v * scale).join()})`
  return model === 'HTML' ? `#${spec}` : model === 'rgb' ? rgb(255) : model === 'RGB' ? rgb(1)
    : model === 'gray' ? `rgb(${[spec, spec, spec].map(v => v * 255).join()})` : spec
}

function paint(e, c) {
  e.style.color = c
  return e
}

/** Text in `css`, with any $…$ in it as math. */
function text(s, css = '') {
  const kids = []
  let run = ''
  const flush = () => {
    if (!run) return
    const e = m('mtext', run.replace(/\s+/g, '\u00a0'))
    if (css) e.style.cssText = css
    kids.push(e)
    run = ''
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '$' && s.indexOf('$', i + 1) > i) {
      const end = s.indexOf('$', i + 1)
      flush()
      kids.push(inner(s.slice(i + 1, end)))
      i = end
    } else if (c === '\\') {
      const w = /^(?:[A-Za-z]+|[^])/.exec(s.slice(i + 1))?.[0] ?? ''
      i += w.length
      if (/^[A-Za-z]/.test(w)) while (s[i + 1] === ' ') i++
      if (w === ',' || w === ' ' || w === '\\') run += w === ',' ? '\u2009' : ' '
      else if (w.length === 1 && !/[A-Za-z]/.test(w)) run += w
      else if (SYMBOLS.has(w)) run += SYMBOLS.get(w)[0]
      else if (!(w in TEXT)) {
        flush()
        kids.push(unknown('\\' + w).node)
      }
    } else if (c === '~') run += '\u00a0'
    else if (c !== '{' && c !== '}') run += c
  }
  flush()
  return wrap(kids)
}

/** An environment's rows of cells, up to `close`: its name, } for \substack, or null for the formula's end.
 * `layout` names its CSS (null picks align or gather by whether it has &), `cols` an array's column styles. */
function table(close, layout, cols) {
  const rows = []
  const paired = layout === 'align' || close === null
  for (;;) {
    const line = hlines()
    const cells = []
    tag = null
    let t
    do {
      cells.push(row(paired && cells.length % 2 ? 'ord' : 'start'))
      t = next()
    } while (t === '&')
    rows.push({ cells, line, tag })
    tag = null
    if (t === '\\\\' || t === '\\cr') {
      const gap = src[at] === '[' ? length(optional()) : 0 // \\[4pt]
      if (gap > 0) cells[0].push(depth(gap))
      continue
    }
    if (t === '\\end' ? braced().trim() === close : t === '}' ? close === '}' : t === null && close === null) break
    throw new Error('unclosed table')
  }
  const last = rows.at(-1)
  if (rows.length > 1 && last.cells.length === 1 && !last.cells[0].length && !last.tag) {
    rows.pop() // what a last \\ leaves
    if (last.line) rows.at(-1).under = true
  }
  const t = klass(m('mtable'), layout ?? (rows.some(r => r.cells.length > 1) ? 'align' : 'gather'))
  if (close === null) t.setAttribute('displaystyle', 'true')
  for (const r of rows) {
    const tr = m('mtr')
    if (r.line || r.under) tr.setAttribute('class', `${r.line ? 'line' : ''} ${r.under ? 'under' : ''}`)
    if (layout !== 'substack' && layout !== 'small') r.cells[0].unshift(strut())
    r.cells.forEach((nodes, i) => {
      const td = m('mtd', ...nodes)
      if (cols?.[i]) td.style.cssText = cols[i]
      tr.append(td)
    })
    if (r.tag) tr.append(m('mtd', r.tag))
    t.append(tr)
  }
  return t
}

/** The \hline's before a row. */
function hlines() {
  for (let n = 0; ; n++) {
    const a = at
    const t = next()
    if (t !== '\\hline' && t !== '\\hdashline') {
      at = a
      return n
    }
  }
}

/** A row's least height and depth, as TeX's arrays have. */
function strut() {
  const e = m('mspace')
  e.setAttribute('height', '.84em')
  e.setAttribute('depth', '.36em')
  return e
}

/** Room `em` deep under a row. */
function depth(em) {
  const e = m('mspace')
  e.setAttribute('depth', `${+em.toFixed(4)}em`)
  return e
}

/** An array's column spec, {c|cc} or {rl}, as each column's CSS. */
function columns(spec) {
  const cols = []
  let rule = false
  spec = spec.replace(/\*\{(\d+)\}\{([^{}]*)\}/g, (_, n, x) => x.repeat(Math.min(n, 50)))
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]
    if (c === '|') {
      if (cols.length) cols[cols.length - 1] += ';border-right:.06em solid'
      else rule = true
    } else if ('lcrpmbX'.includes(c)) {
      cols.push(`text-align:-webkit-${c === 'r' ? 'right' : c === 'c' ? 'center' : 'left'}${rule ? ';border-left:.06em solid' : ''}`)
      rule = false
    }
    if ('pmb@!<>'.includes(c) && spec[i + 1] === '{') {
      for (let depth = 0, j = i + 1; j < spec.length; j++) {
        if (spec[j] === '{') depth++
        else if (spec[j] === '}' && !--depth) {
          i = j
          break
        }
      }
    }
  }
  return cols
}

/** A command that takes `font`'s letters for its argument. */
const inFont = (f, then) => () => {
  const old = font
  font = f
  const node = arg()
  font = old
  return then ? then(node) : { node, cls: 'ord' }
}

const frac = display => () => {
  const f = m('mfrac', arg(), arg())
  if (display) f.setAttribute('displaystyle', display)
  return { node: f, cls: 'ord' }
}

const binom = display => () => {
  const f = m('mfrac', arg(), arg())
  f.setAttribute('linethickness', '0')
  if (display) f.setAttribute('displaystyle', display)
  return fenced('(', f, ')')
}

/** \overset{a}{b} and the like: a relation still, when b is one. */
const stacked = name => () => {
  const script = arg()
  const base = arg()
  return { node: m(name, base, script), cls: base.localName === 'mo' ? 'rel' : 'ord' }
}

function phantom(attrs) {
  return () => {
    const e = m('mpadded', m('mphantom', arg()))
    for (const k in attrs) e.setAttribute(k, attrs[k])
    return { node: e, cls: 'ord' }
  }
}

const COMMANDS = new Map(Object.entries({
  frac: frac(''), dfrac: frac('true'), tfrac: frac('false'),
  cfrac: () => (optional(), frac('true')()),
  binom: binom(''), dbinom: binom('true'), tbinom: binom('false'),
  sqrt: () => {
    const index = optional()
    const x = arg()
    return { node: index === null ? m('msqrt', x) : m('mroot', x, inner(index)), cls: 'ord' }
  },
  left: () => {
    const kids = []
    let d = delimiter()
    if (d) kids.push(mo(d, FENCE))
    for (;;) {
      kids.push(...row('open'))
      const t = next()
      if (t !== '\\middle' && t !== '\\right') throw new Error('\\right')
      d = delimiter()
      if (d) kids.push(mo(d, t === '\\right' ? FENCE : { ...FENCE, lspace: '.1667em', rspace: '.1667em' }))
      if (t === '\\right') return { node: m('mrow', ...kids), cls: 'inner' }
    }
  },
  operatorname: () => {
    const limits = star()
    return inFont('rm', node => ({ node, cls: 'op', fn: true, limits }))()
  },
  overset: stacked('mover'), stackrel: stacked('mover'), underset: stacked('munder'),
  not: () => {
    const t = next()
    if (t === null || CLOSE.has(t)) throw new Error('\\not')
    const ch = t[0] === '\\' ? SYMBOLS.get(t.slice(1))?.[0] : t
    if (!ch) return unknown(`\\not${t}`)
    return { node: m('mo', `${ch}\u0338`.normalize('NFC')), cls: 'rel' } // ≠, ∉, ⊄ where Unicode has one
  },
  textcolor: () => {
    const c = color()
    return { node: paint(m('mrow', arg()), c), cls: 'ord' }
  },
  colorbox: () => {
    const c = color()
    const e = klass(m('mrow', text(braced())), 'colorbox')
    e.style.backgroundColor = c
    return { node: e, cls: 'ord' }
  },
  fbox: () => ({ node: klass(m('mrow', text(braced())), 'boxed'), cls: 'ord' }),
  phantom: () => ({ node: m('mphantom', arg()), cls: 'ord' }),
  hphantom: phantom({ height: '0', depth: '0' }),
  vphantom: phantom({ width: '0' }),
  smash: () => {
    optional()
    const e = m('mpadded', arg())
    e.setAttribute('height', '0')
    e.setAttribute('depth', '0')
    return { node: e, cls: 'ord' }
  },
  mathstrut: () => {
    const e = m('mpadded', m('mphantom', mo('(', BAR)))
    e.setAttribute('width', '0')
    return { node: e }
  },
  hspace: () => (star(), { node: space(length(braced())) }),
  mspace: () => ({ node: space(length(braced())) }),
  tag: () => {
    const bare = star()
    const s = braced()
    tag = m('mrow', space(2), text(bare ? s : `(${s})`))
    return null
  },
  label: () => (braced(), null),
  newcommand: define, renewcommand: define, providecommand: define,
  def: () => {
    const name = raw()
    let n = 0
    for (skip(); src[at] === '#'; skip()) at += 2, n++
    macros.set(name, { n, body: braced() })
    return null
  },
  DeclareMathOperator: () => {
    const limits = star()
    const name = braced().trim()
    macros.set(name, { n: 0, body: `\\operatorname${limits ? '*' : ''}{${braced()}}` })
    return null
  },
  bmod: () => ({ node: mo('mod', { lspace: '.2222em', rspace: '.2222em' }), cls: 'bin' }),
  pmod: () => ({ node: m('mrow', space(1), mo('(', BAR), m('mi', 'mod'), space(1 / 3), arg(), mo(')', BAR)), cls: 'ord' }),
  mod: () => ({ node: m('mrow', space(1), m('mi', 'mod'), space(1 / 3), arg()), cls: 'ord' }),
  pod: () => ({ node: m('mrow', space(1), mo('(', BAR), arg(), mo(')', BAR)), cls: 'ord' }),
  colon: () => ({ node: mo(':', { lspace: '0', rspace: '.2778em' }), cls: 'punct' }),
  implies: () => ({ node: mo('⟹', WIDE), cls: 'rel' }),
  impliedby: () => ({ node: mo('⟸', WIDE), cls: 'rel' }),
  iff: () => ({ node: mo('⟺', WIDE), cls: 'rel' }),
  bra: () => fenced('⟨', arg(), '|', false),
  ket: () => fenced('|', arg(), '⟩', false),
  braket: () => braket(false),
  Bra: () => fenced('⟨', arg(), '|'),
  Ket: () => fenced('|', arg(), '⟩'),
  Braket: () => braket(true),
  abs: () => fenced('|', arg(), '|'),
  norm: () => fenced('‖', arg(), '‖'),
  substack: () => {
    if (next() !== '{') throw new Error('\\substack')
    return { node: table('}', 'substack', null), cls: 'ord' }
  },
  begin: () => {
    const name = braced().trim()
    const base = name.replace(/\*$/, '')
    const e = ENVIRONMENTS.get(base)
    if (!e) throw new Error(name)
    if (/^align(?:ed)?at$/.test(base)) braced()
    if (base.endsWith('array')) optional()
    const t = table(name, e[0], base.endsWith('array') ? columns(braced()) : null)
    for (const k in e[3]) t.setAttribute(k, e[3][k])
    return e[1] || e[2] ? fenced(e[1], t, e[2]) : { node: t, cls: 'ord' }
  },
}))

/** ⟨a|b⟩, written \braket{a|b} or \braket{a}{b}. */
function braket(stretch) {
  const a = arg()
  skip()
  return fenced('⟨', src[at] === '{' ? m('mrow', a, mo('|', BAR), arg()) : a, '⟩', stretch)
}

/** \newcommand{\name}[n][default]{body}. */
function define() {
  star()
  const name = braced().trim()
  const n = optional()
  const opt = optional()
  macros.set(name, { n: Math.min(9, +n || 0), opt: opt ?? undefined, body: braced() })
  return null
}

for (const [name, f] of FONTS) COMMANDS.set(name, inFont(f))
for (const [name, css] of Object.entries(TEXT)) COMMANDS.set(name, () => ({ node: text(braced(), css), cls: 'ord' }))
for (const [name, mu] of Object.entries(SPACES)) COMMANDS.set(name, () => ({ node: space(mu / 18) }))
for (const name of ['kern', 'mkern', 'hskip', 'mskip']) COMMANDS.set(name, () => ({ node: space(measure()) }))
for (const name of IGNORED.split(' ')) COMMANDS.set(name, () => null)
for (const cls of ['op', 'bin', 'rel', 'ord', 'open', 'close', 'punct', 'inner']) {
  COMMANDS.set(`math${cls}`, () => ({ node: arg(), cls, limits: cls === 'op' }))
}
for (const name of ['overline', 'underline', 'boxed', 'cancel', 'bcancel', 'xcancel', 'sout']) {
  COMMANDS.set(name, () => ({ node: klass(m('mrow', arg()), name), cls: 'ord' }))
}
for (const [name, ch] of Object.entries(ACCENTS)) {
  const under = name.startsWith('under') || name === 'utilde'
  const brace = /(?:brace|paren)$/.test(name)
  COMMANDS.set(name, () => {
    const e = m(under ? 'munder' : 'mover', arg(), mo(ch, { stretchy: /^(?:wide|over|under)/.test(name) ? 'true' : 'false' }))
    if (!brace) e.setAttribute(under ? 'accentunder' : 'accent', 'true')
    return { node: e, cls: 'ord', limits: brace }
  })
}
for (const [name, ch] of Object.entries(ARROWS)) {
  COMMANDS.set(name, () => {
    const below = optional()
    const label = node => klass(m('mrow', node), 'xarrow')
    const arrow = mo(ch, { stretchy: 'true' })
    const over = label(arg())
    return { node: below === null ? m('mover', arrow, over) : m('munderover', arrow, label(inner(below)), over), cls: 'rel' }
  })
}
for (const [name, em] of [['big', 1.2], ['Big', 1.623], ['bigg', 2.047], ['Bigg', 2.47]]) {
  for (const [suffix, cls] of [['', 'ord'], ['l', 'open'], ['r', 'close'], ['m', 'rel']]) {
    COMMANDS.set(name + suffix, () => {
      const d = delimiter()
      const gap = cls === 'rel' ? '.2778em' : '0'
      return { node: d ? mo(d, { ...FENCE, minsize: `${em}em`, maxsize: `${em}em`, lspace: gap, rspace: gap }) : m('mrow'), cls }
    })
  }
}
