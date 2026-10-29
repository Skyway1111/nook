import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, separator, numeric, compareFields } from './delimited.js'

test('plain rows and fields', () => {
  assert.deepEqual(parse('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']])
  assert.deepEqual(parse('a,b\r\n1,2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parse('a,,c\n,\n'), [['a', '', 'c'], ['', '']])
})

test('quoted fields hold separators, line breaks, and doubled quotes', () => {
  assert.deepEqual(parse('"a,b","line\nbreak","say ""hi"""\n'), [['a,b', 'line\nbreak', 'say "hi"']])
  assert.deepEqual(parse('"unterminated'), [['unterminated']])
})

test('a BOM is not part of the first field', () => {
  assert.deepEqual(parse('﻿name,age\nx,1'), [['name', 'age'], ['x', '1']])
})

test('tabs for .tsv, and the most used of , ; tab on a .csv first line', () => {
  assert.equal(separator('a.tsv', 'x,y'), '\t')
  assert.equal(separator('a.csv', 'x;y;z\n1;2;3'), ';')
  assert.equal(separator('a.csv', 'x,y\n'), ',')
  assert.equal(separator('a.csv', 'single'), ',')
})

test('numeric columns', () => {
  const rows = parse('n,name,pct\n1,a,5%\n2.5,b,\n-3e2,c,10%\n"1,234",d,1%')
  assert.equal(numeric(rows, 0), true)
  assert.equal(numeric(rows, 1), false)
  assert.equal(numeric(rows, 2), true)
})

test('fields order as numbers when both are, and empty ones last', () => {
  assert.ok(compareFields('9', '10') < 0)
  assert.ok(compareFields('b', 'a') > 0)
  assert.ok(compareFields('', 'a') > 0)
  assert.ok(compareFields('file2', 'file10') < 0)
})

test('parses a 4 MB file quickly', () => {
  const text = Array.from({ length: 60_000 }, (_, i) => `${i},"name ${i}",${i * 1.5},note`).join('\n')
  const t = performance.now()
  assert.equal(parse(text).length, 60_000)
  assert.ok(performance.now() - t < 1500)
})
