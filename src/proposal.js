// An edit Claude proposes and waits on a yes for, shown as its editor extensions show one: what would change in
// the file, with Accept and Reject. Claude's own prompt still takes the answer too; whichever comes first counts.
import { invoke } from './host.js'
import { el, sheet } from './ui.js'
import { diffRows, nearChanges } from './linediff.js'

await sheet(new URL('./diff.css', import.meta.url))

/** Fills `view` with the change from the file at `path` to `contents`. `answer(outcome, text)` hears Accept or
 * Reject, as Claude's `FILE_SAVED` with the contents, or `DIFF_REJECTED`. */
export function startProposal(view, { path, name, contents, answer }) {
  view.tabIndex = -1
  view.classList.add('diff', 'proposal')
  const sum = el('span', { className: 'sum', textContent: `Claude wants to change ${name}` })
  const bar = el('header', { className: 'diff-bar' })
  bar.append(
    sum,
    el('button', { textContent: 'Reject', onclick: () => answer('DIFF_REJECTED') }),
    el('button', { className: 'pill', textContent: 'Accept', onclick: () => answer('FILE_SAVED', contents) }),
  )
  const file = el('section', { className: 'file' })
  view.replaceChildren(bar, file)

  invoke('read_text', { path }).catch(() => '').then(old => {
    const split = text => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/))
    const list = diffRows(split(old), split(contents))
    const added = list.filter(r => r.t === '+').length
    const removed = list.filter(r => r.t === '-').length
    sum.replaceChildren(`Claude wants to ${old === '' ? 'create' : 'change'} ${name} `, el('b', { className: 'add', textContent: `+${added}` }), ' ', el('b', { className: 'del', textContent: `−${removed}` }))
    for (const run of nearChanges(list)) {
      const hunk = el('div', { className: 'hunk' })
      const head = el('div', { className: 'hunk-head' })
      head.append(el('span', { className: 'title', textContent: `Line ${run.find(r => r.b)?.b ?? run[0].a}` }))
      hunk.append(head)
      for (const r of run) {
        const cell = el('div', { className: `cell ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}` })
        cell.append(el('i', { textContent: r.a }), el('i', { textContent: r.b }), el('span', { className: 'src', textContent: r.text }))
        const ln = el('div', { className: 'ln' })
        ln.append(cell)
        hunk.append(ln)
      }
      file.append(hunk)
    }
  })

  return { refresh() {}, focus: () => view.focus() }
}
