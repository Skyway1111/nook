import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expand, offer, saved } from './prompts.js'

const prompts = [{ name: 'Write tests', text: 'Write tests for {file}' }, { name: 'Review my changes', text: 'Review them' }]
const commands = [{ name: 'review-pr', description: 'Review a pull request' }, { name: 'ship', description: 'Deploy' }]

test('fills in the file, or the folder without one', () => {
  assert.equal(expand('Write tests for {file} in {folder}', { file: '/a/b.js', folder: '/a' }), 'Write tests for /a/b.js in /a')
  assert.equal(expand('Explain {file}', { folder: '/a' }), 'Explain /a')
})

test('offers prompts then commands that hold every word typed', () => {
  assert.deepEqual(offer(prompts, commands, '').map(r => r.name), ['Write tests', 'Review my changes', '/review-pr', '/ship'])
  assert.deepEqual(offer(prompts, commands, 'review').map(r => [r.kind, r.name]), [
    ['prompt', 'Review my changes'], ['command', '/review-pr'], ['send', 'review'], ['save', 'review'],
  ])
  assert.equal(offer(prompts, commands, '/ship')[0].text, '/ship ')
})

test('text that names nothing goes to Claude first, or saves', () => {
  assert.deepEqual(offer(prompts, commands, 'why is resize slow').map(r => r.kind), ['send', 'save'])
  assert.deepEqual(offer(prompts, commands, 'write tests').map(r => r.kind), ['prompt'])
})

test('a saved prompt is named by its first words', () => {
  assert.deepEqual(saved([], 'Short'), [{ name: 'Short', text: 'Short' }])
  assert.equal(saved([], 'x'.repeat(60))[0].name, `${'x'.repeat(39)}…`)
})
