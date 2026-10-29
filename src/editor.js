// CodeMirror for a file tab, and its highlighter for Markdown's code blocks. style.css colors both from theme.css.
import { EditorState, Compartment, StateField, StateEffect, RangeSet, RangeSetBuilder } from '@codemirror/state'
import {
  EditorView, keymap, gutters, gutter, GutterMarker, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, showPanel,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  syntaxHighlighting, indentOnInput, indentUnit, bracketMatching, LanguageDescription,
  codeFolding, foldGutter, foldKeymap, ensureSyntaxTree, syntaxTree,
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, completeAnyWord, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { el } from './ui.js'
import { DOC } from './files.js'
import { UNCOMMITTED, runs, ages, since } from './blame.js'
import { outline as outlineOf } from './symbols.js'
import { lineChanges } from './linediff.js'

// Blame: a gutter, off until asked for, of who last changed each line. Its marks follow edits until the next blame.
const blameGutter = new Compartment()
const blamed = new WeakSet() // editors showing the gutter
const setBlame = StateEffect.define()
const blameMarks = StateField.define({
  create: () => RangeSet.empty,
  update: (marks, tr) => tr.effects.find(e => e.is(setBlame))?.value ?? (tr.docChanged ? marks.map(tr.changes) : marks),
})
class BlameMark extends GutterMarker {
  constructor(oid, label, title, age) {
    super()
    Object.assign(this, { oid, label, title, age })
  }
  eq(o) { return o.oid === this.oid && o.label === this.label && o.age === this.age }
  toDOM() {
    const d = el('div', { className: this.label ? 'blame first' : 'blame', textContent: this.label, title: this.title })
    d.style.setProperty('--age', this.age)
    return d
  }
}

// Change bars: beside the line numbers, the lines that differ from git's copy of the file. Off outside a repository.
const changeGutter = new Compartment()
const barred = new WeakSet() // editors showing the bars
const setChanges = StateEffect.define()
const changeMarks = StateField.define({
  create: () => RangeSet.empty,
  update: (marks, tr) => tr.effects.find(e => e.is(setChanges))?.value ?? (tr.docChanged ? marks.map(tr.changes) : marks),
})
class ChangeMark extends GutterMarker {
  constructor(kind, title) {
    super()
    Object.assign(this, { kind, title })
  }
  eq(o) { return o.kind === this.kind }
  toDOM() { return el('div', { className: `gitbar ${this.kind}`, title: this.title }) }
}
const BARS = {
  add: new ChangeMark('add', 'Added since git\'s copy'),
  change: new ChangeMark('change', 'Changed since git\'s copy'),
  delete: new ChangeMark('delete', 'Lines taken out above'),
  below: new ChangeMark('delete below', 'Lines taken out below'),
}

/**
 * An editor holding `text`, in the language its file `name` implies. Calls `changed` after each edit. With
 * `status`, a line under the text shows the caret, the language, the indent, and `status.eol()`, the line ending.
 * Calls `picked` after each change to the selection.
 */
export function createEditor(name, text, changed, { status, picked } = {}) {
  const language = new Compartment()
  const wrapping = new Compartment()
  const indent = /^(\t)|^( {2,})(?=\S)/m.exec(text) // the first indented line's
  const unit = indent?.[1] ?? indent?.[2] ?? '    '
  const prose = DOC.test(name)
  // language-data matches extensions case-sensitively, and README.MD is Markdown too.
  const found = LanguageDescription.matchFilename(languages, name.replace(/\.[^.]*$/, ext => ext.toLowerCase()))
  const wrap = on => ({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) })
  const toggleWrap = view => { view.dispatch(wrap(!view.lineWrapping)); return true }
  const editor = new EditorView({
    doc: text,
    extensions: [
      gutters({ fixed: false }), // scrolls with the text, so no backdrop shows through behind it
      blameMarks, blameGutter.of([]), lineNumbers(), changeMarks, changeGutter.of([]), foldGutter({ markerDOM: fold }), highlightActiveLineGutter(), highlightActiveLine(), highlightSpecialChars(),
      history(), drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(), EditorState.allowMultipleSelections.of(true),
      indentOnInput(), indentUnit.of(unit), bracketMatching(), highlightSelectionMatches(), codeFolding({ placeholderDOM: folded }),
      // Code closes its brackets and offers the words already in the file, as well as what its language knows.
      prose ? [] : [closeBrackets(), autocompletion({ icons: false }), EditorState.languageData.of(() => [{ autocomplete: words }])],
      syntaxHighlighting(classHighlighter), EditorView.darkTheme.of(true),
      wrapping.of(prose ? EditorView.lineWrapping : []),
      keymap.of([
        ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
        { key: 'Alt-z', run: toggleWrap, preventDefault: true },
        indentWithTab,
      ]),
      language.of([]),
      status ? showPanel.of(view => statusLine(view, { language: found?.name ?? 'Plain text', unit, eol: status.eol, toggleWrap })) : [],
      EditorView.updateListener.of(u => {
        if (u.docChanged) changed()
        if (u.selectionSet) picked?.()
      }),
    ],
  })
  const support = found?.name === 'Markdown' // with its code blocks colored
    ? import('@codemirror/lang-markdown').then(m => m.markdown({ codeLanguages: languages }))
    : found?.load()
  support?.then(s => editor.dispatch({ effects: language.reconfigure(s) }))
  return editor
}

/** The file's own words as completions. Untyped, so a word the language offers too shows once. */
function words(context) {
  const found = completeAnyWord(context)
  return found && { ...found, options: found.options.map(({ label }) => ({ label })) }
}

/** The fold gutter's marker: a chevron that shows on hover, or always while its block is folded. */
function fold(open) {
  return el('i', { className: `icon fold${open ? '' : ' shut'}`, textContent: open ? '\uE70D' : '\uE76C', title: open ? 'Fold' : 'Unfold' })
}

/** What stands in for a folded block; a click unfolds it. */
function folded(view, onclick) {
  return el('span', { className: 'cm-foldPlaceholder', textContent: '\u2026', title: 'Unfold', onclick })
}

/** The line under a file tab's text: where the caret is, how many selections, the language, the indent, the
 * line ending, and whether long lines wrap. It writes to the DOM only what changed. */
function statusLine(view, { language, unit, eol, toggleWrap }) {
  const dom = el('div', { className: 'cm-status' })
  const caret = el('span')
  const wrapButton = el('button', { title: 'Wrap long lines (Alt+Z)', onmousedown: e => e.preventDefault(), onclick: () => toggleWrap(view) })
  const ending = el('span')
  dom.append(caret, el('span', { className: 'fill' }), el('span', { textContent: language }),
    el('span', { textContent: unit === '\t' ? 'Tabs' : `Spaces: ${unit.length}` }), ending, wrapButton)
  const set = (node, text) => node.textContent !== text && (node.textContent = text)
  const paint = () => {
    const { main, ranges } = view.state.selection
    const line = view.state.doc.lineAt(main.head)
    const picked = ranges.reduce((n, r) => n + r.to - r.from, 0)
    const next = `Ln ${line.number}, Col ${main.head - line.from + 1}` +
      (ranges.length > 1 ? ` · ${ranges.length} cursors` : '') + (picked ? ` · ${picked.toLocaleString()} selected` : '')
    set(caret, next)
    set(ending, eol() === '\r\n' ? 'CRLF' : 'LF')
    set(wrapButton, view.lineWrapping ? 'Wrap' : 'No wrap')
  }
  paint()
  return { dom, update: paint }
}

/**
 * Shows `blame`, from blame.js's parseBlame, in a gutter beside the line numbers, or takes the gutter away
 * when it's null. A click on a commit's lines calls `pick(oid)`.
 */
export function showBlame(editor, blame, pick) {
  if (!blame) {
    if (blamed.delete(editor)) editor.dispatch({ effects: blameGutter.reconfigure([]) })
    return
  }
  const { lines, commits } = blame
  const age = ages(commits)
  const doc = editor.state.doc
  const marks = new RangeSetBuilder()
  for (const run of runs(lines)) {
    const c = commits.get(run.oid)
    const mine = run.oid === UNCOMMITTED
    const title = mine ? 'Not committed yet' : `${c.summary}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}\n${c.oid.slice(0, 10)}`
    for (let n = run.from; n <= Math.min(run.to, doc.lines); n++) {
      const label = n === run.from ? (mine ? 'Not committed' : `${since(c.time)}  ${c.author}`) : ''
      marks.add(doc.line(n).from, doc.line(n).from, new BlameMark(run.oid, label, title, age.get(run.oid)))
    }
  }
  const on = blamed.has(editor)
  blamed.add(editor)
  editor.dispatch({
    effects: [
      setBlame.of(marks.finish()),
      ...(on ? [] : [blameGutter.reconfigure(gutter({
        class: 'cm-blame',
        markers: view => view.state.field(blameMarks),
        initialSpacer: () => new BlameMark('', 'Not committed', '', 0),
        domEventHandlers: {
          mousedown(view, line) {
            let oid = null
            view.state.field(blameMarks).between(line.from, line.from, (from, to, mark) => { oid = mark.oid })
            if (oid && oid !== UNCOMMITTED) pick(oid)
            return !!oid
          },
        },
      }))]),
    ],
  })
}

/**
 * Marks the editor's lines that differ from `base`, git's copy of the file as an array of lines, or takes the bars
 * away when it's null.
 */
export function showChanges(editor, base) {
  if (!base) {
    if (barred.delete(editor)) editor.dispatch({ effects: [setChanges.of(RangeSet.empty), changeGutter.reconfigure([])] })
    return
  }
  const doc = editor.state.doc
  const marks = new RangeSetBuilder()
  for (const c of lineChanges(base, doc.toJSON())) {
    if (c.kind === 'delete') {
      const below = c.at > doc.lines
      const line = doc.line(below ? doc.lines : c.at)
      marks.add(line.from, line.from, below ? BARS.below : BARS.delete)
    } else {
      for (let n = c.from; n <= c.to; n++) marks.add(doc.line(n).from, doc.line(n).from, BARS[c.kind])
    }
  }
  const on = barred.has(editor)
  barred.add(editor)
  editor.dispatch({
    effects: [
      setChanges.of(marks.finish()),
      ...(on ? [] : [changeGutter.reconfigure(gutter({ class: 'cm-changes', markers: view => view.state.field(changeMarks) }))]),
    ],
  })
}

/** Puts the caret at 1-based `line` and `col` and scrolls that line to the middle. */
export function goto(editor, line, col = 1) {
  const doc = editor.state.doc
  const at = doc.line(Math.max(1, Math.min(line, doc.lines)))
  const pos = Math.min(at.to, at.from + Math.max(0, col - 1))
  editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

/**
 * The editor's outline for quick open's `@`, from symbols.js: `{ items, partial }`, each item with its 1-based
 * `line`. It parses the rest of the file first, for a fifth of a second at most; past that it outlines what parsed.
 */
export function outline(editor) {
  const { state } = editor
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state)
  const { items, partial } = outlineOf(tree, (from, to) => doc.sliceString(from, to))
  for (const item of items) item.line = doc.lineAt(item.from).number
  return { items, partial: partial || tree.length < doc.length }
}

/** Shows the line holding `pos` in the middle of the editor, with the caret there, without focusing it. */
export function show(editor, pos) {
  editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

/** `code` colored as the fence language `lang`, or null if language-data doesn't know it. */
export async function highlight(code, lang) {
  const found = LanguageDescription.matchLanguageName(languages, lang, false) // python, js, powershell
    ?? LanguageDescription.matchFilename(languages, `.${lang.toLowerCase()}`) // py, rs, ps1
  if (!found) return null
  const { language } = await found.load()
  const out = document.createDocumentFragment()
  const put = (text, className) => out.append(className ? el('span', { className, textContent: text }) : text)
  highlightCode(code, language.parser.parse(code), classHighlighter, put, () => out.append('\n'))
  return out
}

/** `code`'s syntax tokens, line by line, in the language its file `name` implies: for each line a list of
 * `[from, to, className]`. Null when language-data doesn't know the language. */
export async function tokenize(code, name) {
  const found = LanguageDescription.matchFilename(languages, name.replace(/\.[^.]*$/, ext => ext.toLowerCase()))
  if (!found) return null
  const { language } = await found.load()
  const lines = [[]]
  let at = 0
  highlightCode(code, language.parser.parse(code), classHighlighter,
    (text, className) => { if (className) lines.at(-1).push([at, at + text.length, className]); at += text.length },
    () => { lines.push([]); at = 0 })
  return lines
}
