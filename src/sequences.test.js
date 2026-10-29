// `npm test`: spotting sixel and iTerm2 pictures in output, so xterm's image addon loads only for them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageStart, FOUND, NONE } from './sequences.js'

const b = s => new TextEncoder().encode(s)

test('sixel and iTerm2 pictures are found', () => {
  assert.equal(imageStart(b('hi \x1bP0;1;0q"1;1;10;10#0~-\x1b\\')), FOUND)
  assert.equal(imageStart(b('\x1bPq#0~\x1b\\')), FOUND)
  assert.equal(imageStart(b('\x1b]1337;File=inline=1:AAAA\x07')), FOUND)
  assert.equal(imageStart(b('\x1b]1337;MultipartFile=inline=1\x07')), FOUND)
})

test('other sequences are not pictures', () => {
  assert.equal(imageStart(b('\x1b[2J\x1b[?25h plain text')), NONE)
  assert.equal(imageStart(b('\x1bP$qm\x1b\\')), NONE) // DECRQSS
  assert.equal(imageStart(b('\x1bP+q544e\x1b\\')), NONE) // XTGETTCAP
  assert.equal(imageStart(b('\x1b]0;title\x07\x1b]8;;https://x\x07')), NONE)
  assert.equal(imageStart(b('')), NONE)
})

test('a chunk that ends partway into a possible picture says where', () => {
  assert.equal(imageStart(b('abc\x1b')), 3)
  assert.equal(imageStart(b('abc\x1bP0;1')), 3)
  assert.equal(imageStart(b('ab\x1b]133')), 2)
  assert.equal(imageStart(b('ab\x1b]0;tit')), NONE)
})
