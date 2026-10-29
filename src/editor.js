// CodeMirror for a file tab, and its highlighter for Markdown's code blocks. style.css colors both from theme.css.
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView, keymap, gutters, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, indentOnInput, indentUnit, bracketMatching, LanguageDescription } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { el } from './ui.js'
import { DOC } from './files.js'

/** An editor holding `text`, in the language its file `name` implies. Calls `changed` after each edit. */
export function createEditor(name, text, changed) {
  const language = new Compartment()
  const indent = /^(\t)|^( {2,})(?=\S)/m.exec(text) // the first indented line's
  const editor = new EditorView({
    doc: text,
    extensions: [
      gutters({ fixed: false }), // scrolls with the text, so no backdrop shows through behind it
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), highlightSpecialChars(),
      history(), drawSelection(), dropCursor(), rectangularSelection(), EditorState.allowMultipleSelections.of(true),
      indentOnInput(), indentUnit.of(indent?.[1] ?? indent?.[2] ?? '    '), bracketMatching(), highlightSelectionMatches(),
      syntaxHighlighting(classHighlighter), EditorView.darkTheme.of(true),
      DOC.test(name) ? EditorView.lineWrapping : [],
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      language.of([]),
      EditorView.updateListener.of(u => u.docChanged && changed()),
    ],
  })
  // language-data matches extensions case-sensitively, and README.MD is Markdown too.
  const found = LanguageDescription.matchFilename(languages, name.replace(/\.[^.]*$/, ext => ext.toLowerCase()))
  const support = found?.name === 'Markdown' // with its code blocks colored
    ? import('@codemirror/lang-markdown').then(m => m.markdown({ codeLanguages: languages }))
    : found?.load()
  support?.then(s => editor.dispatch({ effects: language.reconfigure(s) }))
  return editor
}

/** Puts the caret at 1-based `line` and `col` and scrolls that line to the middle. */
export function goto(editor, line, col = 1) {
  const doc = editor.state.doc
  const at = doc.line(Math.max(1, Math.min(line, doc.lines)))
  const pos = Math.min(at.to, at.from + Math.max(0, col - 1))
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
