import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outline } from './symbols.js'
import { parser as js } from '@lezer/javascript'
import { parser as python } from '@lezer/python'
import { parser as rust } from '@lezer/rust'
import { parser as go } from '@lezer/go'
import { parser as java } from '@lezer/java'
import { parser as cpp } from '@lezer/cpp'
import { parser as css } from '@lezer/css'
import { parser as markdown } from '@lezer/markdown'
import { parser as yaml } from '@lezer/yaml'
import { parser as json } from '@lezer/json'

/** Each item as `kind name` indented by its depth, with its container after an `in`. */
function lines(parser, text) {
  const { items } = outline(parser.parse(text), (from, to) => text.slice(from, to))
  return items.map(i => `${'  '.repeat(i.depth)}${i.kind} ${i.name}${i.container ? ` in ${i.container}` : ''}`)
}

test('JavaScript and TypeScript', () => {
  const ts = js.configure({ dialect: 'ts' })
  assert.deepEqual(lines(ts, `
export class Foo extends Bar {
  x = 1
  handler = () => { function inner() {} }
  static make() {}
}
function bar(a) { const local = 1; const nested = () => 2; return { noise() {}, more: () => 1 } }
const baz = () => 1, q = 2
let mutable
export interface Shape { area(): number }
type Id = string
enum Color { Red }
const api = { get() {}, post: function () {} }
namespace NS { function inner() {} }
export default function () {}
`), [
    'class Foo',
    '  field x in Foo',
    '  method handler in Foo',
    '    function inner in handler',
    '  method make in Foo',
    'function bar',
    '  function nested in bar',
    'function baz',
    'constant q',
    'variable mutable',
    'interface Shape',
    'type Id',
    'enum Color',
    'constant api',
    '  method get in api',
    '  method post in api',
    'module NS',
    '  function inner in NS',
  ])
})

test('Python', () => {
  assert.deepEqual(lines(python, `
class Foo(Base):
    x = 1
    def method(self):
        def helper(): pass
    async def am(self): pass
def top(a): pass
@dec
def decorated(): pass
LIMIT = 3
name = 'x'
`), ['class Foo', '  method method in Foo', '    function helper in method', '  method am in Foo', 'function top', 'function decorated', 'constant LIMIT', 'variable name'])
})

test('Rust', () => {
  assert.deepEqual(lines(rust, `
mod m { fn inner() {} }
pub struct S { a: u8 }
enum E { A }
trait T { fn t(&self); }
impl T for S { fn t(&self) {} }
impl<'a> S { pub fn new() -> Self { S { a: 0 } } }
pub async fn top() {}
const C: u8 = 1;
type Alias = u8;
macro_rules! mac { () => {} }
`), ['module m', '  function inner in m', 'struct S', 'enum E', 'trait T', '  method t in T', 'impl T for S', '  method t in T for S',
    'impl S', '  method new in S', 'function top', 'constant C', 'type Alias', 'function mac'])
})

test('Go', () => {
  assert.deepEqual(lines(go, `package p
type S struct{ a int }
type I interface{ M() }
func (s *S) Method() {}
func Top() { var local = 1 }
var V = 1
const (
  K = 2
)
`), ['struct S', 'interface I', 'method Method in S', 'function Top', 'variable V', 'constant K'])
})

test('Java and C++', () => {
  assert.deepEqual(lines(java, 'class A { A() {} void m() {} interface I {} enum E { X } }'),
    ['class A', '  method A in A', '  method m in A', '  interface I in A', '  enum E in A'])
  assert.deepEqual(lines(cpp, `
namespace ns { class C { void m() {} int f; }; }
struct S { int a; };
struct S value;
void C::m() {}
int *top(int a) { return 0; }
#define MAX 1
#define SQ(x) x * x
#include <x>
`), ['module ns', '  class C in ns', '    method m in C', 'struct S', 'function C::m', 'function top', 'constant MAX', 'function SQ'])
})

test('Markdown headings nest by level', () => {
  assert.deepEqual(lines(markdown, '# Title\n\ntext\n\n## Sub *x* ##\n\n### Deep\n\nSetext\n===\n\n```sh\n# not a heading\n```\n'),
    ['heading Title', '  heading Sub *x* in Title', '    heading Deep in Sub *x*', 'heading Setext'])
})

test('CSS rules, and YAML and JSON keys two deep', () => {
  assert.deepEqual(lines(css, 'a { b: c }\n@media (max-width: 9px) {\n  .d,\n  e > f { g: h }\n}\n'),
    ['rule a', 'rule @media (max-width: 9px)', '  rule .d, e > f in @media (max-width: 9px)'])
  assert.deepEqual(lines(yaml, 'a:\n  b: 1\n  c:\n    d: 2\ne: [1]\n'), ['key a', '  key b in a', '  key c in a', 'key e'])
  assert.deepEqual(lines(json, '{"name": "x", "scripts": {"test": "t", "deep": {"no": 1}}}'),
    ['key name', 'key scripts', '  key test in scripts', '  key deep in scripts'])
})

test('stops at the limit, and a big file outlines fast', () => {
  const text = Array.from({ length: 20_000 }, (_, i) => `function f${i}(a) { return a + ${i} }\n`).join('')
  const tree = js.parse(text)
  const t = performance.now()
  const { items, partial } = outline(tree, (from, to) => text.slice(from, to))
  assert.equal(items.length, 5000)
  assert.ok(partial)
  assert.ok(performance.now() - t < 200, `${performance.now() - t} ms`)
})

test('code blocks in Markdown add nothing to its headings', async () => {
  const { markdown: md } = await import('@codemirror/lang-markdown')
  const { javascriptLanguage } = await import('@codemirror/lang-javascript')
  const parser = md({ codeLanguages: () => javascriptLanguage }).language.parser
  assert.deepEqual(lines(parser, '# Use\n\n```js\nfunction hidden() {}\n```\n\n## More\n'), ['heading Use', '  heading More in Use'])
})
