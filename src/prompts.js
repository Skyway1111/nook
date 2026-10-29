// Quick prompts: Ctrl+Shift+P lists settings.json's prompts and the slash commands and skills Claude Code
// offers in the folder, and pastes the pick into Claude's prompt to edit or send. Text that matches none
// can go to Claude as it is, or be saved as a prompt. These helpers are pure, so `prompts.test.js` checks
// them under `npm test`.

/** `text` with `{file}` and `{folder}` filled in; a missing file reads as the folder. */
export function expand(text, { file, folder }) {
  return text.replaceAll('{file}', file || folder || '').replaceAll('{folder}', folder || '')
}

/** What the picker offers for `query`: `{ kind, name, text }` rows, prompts then commands, each whose name
 * or text holds every word typed; then, for text that names nothing, `send` and `save` rows. */
export function offer(prompts, commands, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const fits = s => words.every(w => s.toLowerCase().includes(w))
  const rows = [
    ...prompts.filter(p => fits(`${p.name} ${p.text}`)).map(p => ({ kind: 'prompt', name: p.name, text: p.text })),
    ...commands.filter(c => fits(`/${c.name} ${c.description}`)).map(c => ({ kind: 'command', name: `/${c.name}`, text: `/${c.name} `, description: c.description })),
  ]
  const q = query.trim()
  if (q && !rows.some(r => r.name.toLowerCase() === q.toLowerCase())) {
    const tail = [{ kind: 'send', name: q, text: q }, { kind: 'save', name: q, text: q }]
    return rows.length ? [...rows, ...tail] : tail
  }
  return rows
}

/** `prompts` with `text` saved as one, named by its first words. */
export function saved(prompts, text) {
  const name = text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text
  return [...prompts, { name, text }]
}
