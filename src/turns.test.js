// `npm test`: which rows of Claude's history are prompts you sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrompt } from './turns.js'

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
