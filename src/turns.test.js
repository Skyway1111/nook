// `npm test`: which rows of Claude's history are prompts you sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrompt, promptRows, transcriptEnd, moved } from './turns.js'

test('a prompt row starts with the pointer Claude draws, on either system', () => {
  assert.ok(isPrompt('❯ fix the resize flicker'))
  assert.ok(isPrompt('> fix the resize flicker'))
  assert.ok(isPrompt('❯ what changed?'))
})

test("Claude's own rows, quotes and blank prompts are not", () => {
  assert.equal(isPrompt('⏺ Update(src/main.js)'), false)
  assert.equal(isPrompt('  ❯ 1. Yes'), false) // a choice in a question, indented
  assert.equal(isPrompt('>> merged'), false)
  assert.equal(isPrompt('❯ '), false)
})

// Claude's fullscreen view as xterm reads it: the pinned prompt, the transcript, then its input box.
const rule = '─'.repeat(40)
const view = (...rows) => [...rows, '', rule, '❯ a draft', rule, '  ⏸ manual mode on']

test("on Claude's fullscreen view, prompts are found above its input box, below the pinned row", () => {
  const screen = view('❯ list rivers', '  Nile', '', '❯ list mountains', '', '● Everest')
  assert.deepEqual(promptRows(screen), [3])
  assert.equal(transcriptEnd(screen), 7)
  assert.deepEqual(promptRows(['❯ one', '  two']), []) // no input box: nothing past the pinned row
})

test('how far a page moved the transcript is read from rows that show in both views', () => {
  const before = view('❯ list mountains', '  K2', '  Lhotse', '  Makalu', '  Cho Oyu')
  const after = view('❯ list rivers', '  Don', '', '❯ list mountains', '  Nile', '  K2', '  Lhotse', '  Makalu')
  assert.equal(moved(before, after), 4) // K2 went from row 1 to row 5
  assert.equal(moved(after, before), -4)
  assert.equal(moved(before, before), 0)
  assert.equal(moved(before, view('❯ x', '  a', '  b', '  c')), null)
})
