// `npm test`: spotting sixel and iTerm2 pictures in output, so the terminal's picture module loads only for them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageStart, FOUND, NONE, clipboardText } from './sequences.js'

test('sixel and iTerm2 pictures are found', () => {
  assert.equal(imageStart('hi \x1bP0;1;0q"1;1;10;10#0~-\x1b\\'), FOUND)
  assert.equal(imageStart('\x1bPq#0~\x1b\\'), FOUND)
  assert.equal(imageStart('\x1b]1337;File=inline=1:AAAA\x07'), FOUND)
})

test('other sequences are not pictures', () => {
  assert.equal(imageStart('\x1b[2J\x1b[?25h plain text'), NONE)
  assert.equal(imageStart('\x1bP$qm\x1b\\'), NONE) // DECRQSS
  assert.equal(imageStart('\x1bP+q544e\x1b\\'), NONE) // XTGETTCAP
  assert.equal(imageStart('\x1b]0;title\x07\x1b]8;;https://x\x07'), NONE)
  assert.equal(imageStart('\x1b]1337;MultipartFile=inline=1\x07'), NONE) // not drawn
  assert.equal(imageStart(''), NONE)
})

test('a chunk that ends partway into a possible picture says where', () => {
  assert.equal(imageStart('abc\x1b'), 3)
  assert.equal(imageStart('abc\x1bP0;1'), 3)
  assert.equal(imageStart('ab\x1b]133'), 2)
  assert.equal(imageStart('ab\x1b]0;tit'), NONE)
})

const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

test('OSC 52 puts its text on the clipboard', () => {
  assert.equal(clipboardText(`c;${b64('hello')}`), 'hello')
  assert.equal(clipboardText(`;${b64('no selection named')}`), 'no selection named')
  assert.equal(clipboardText(`pc;${b64('naïve — 日本 🐟')}`), 'naïve — 日本 🐟')
  assert.equal(clipboardText(`c;${b64('two\nlines')}`), 'two\nlines')
  assert.equal(clipboardText('c;'), '')
})

test('OSC 52 reads and broken payloads put nothing', () => {
  assert.equal(clipboardText('c;?'), null)
  assert.equal(clipboardText('no separator'), null)
  assert.equal(clipboardText('c;not base64!'), null)
  assert.equal(clipboardText('c;/w=='), null) // 0xff is not UTF-8
  assert.equal(clipboardText('c;' + 'A'.repeat((8 << 20) + 4)), null)
})
