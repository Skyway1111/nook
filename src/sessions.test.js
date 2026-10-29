import { test } from 'node:test'
import assert from 'node:assert/strict'
import { follow, wanting, ago, modelName, summary, answeredReport, notice, cannotSend, pickedAtFirst, asking, fill, money, limits, ANSWERS } from './sessions.js'

const run = (steps, view) => steps.map(([report, watched]) => (view = follow(view, report, watched)))

test('a session watched as it works and finishes leaves no mark and asks nothing', () => {
  const views = run([[{ status: 'idle', turns: 0 }, true], [{ status: 'working', turns: 0 }, true], [{ status: 'idle', turns: 1 }, true]])
  assert.deepEqual(views.map(v => v.mark), ['', 'working', ''])
  assert.ok(views.every(v => !v.attention))
})

test('a session that finishes while the user looks elsewhere is done, and asks once', () => {
  const views = run([
    [{ status: 'working', turns: 0 }, false],
    [{ status: 'idle', turns: 1 }, false],
    [{ status: 'idle', turns: 1 }, false],
    [{ status: 'idle', turns: 1 }, true],
  ])
  assert.deepEqual(views.map(v => v.mark), ['working', 'done', 'done', ''])
  assert.deepEqual(views.map(v => v.attention), [false, true, false, false])
})

test('a quick turn that started and ended between two polls still counts as done', () => {
  const [, view] = run([[{ status: 'idle', turns: 3 }, false], [{ status: 'idle', turns: 4 }, false]])
  assert.equal(view.mark, 'done')
  assert.ok(view.attention)
})

test('waiting on the user asks for attention only when they are not looking', () => {
  const away = run([[{ status: 'working' }, false], [{ status: 'waiting' }, false], [{ status: 'waiting' }, false], [{ status: 'working' }, false]])
  assert.deepEqual(away.map(v => v.mark), ['working', 'waiting', 'waiting', 'working'])
  assert.deepEqual(away.map(v => v.attention), [false, true, false, false])
  const here = run([[{ status: 'working' }, true], [{ status: 'waiting' }, true]])
  assert.equal(here[1].mark, 'waiting')
  assert.equal(here[1].attention, false)
})

test('a session with no report yet idles', () => {
  assert.deepEqual(follow(undefined, undefined, false), { mark: '', turns: 0, attention: false })
})

test('wanting counts sessions waiting or done', () => {
  assert.equal(wanting([{ mark: 'waiting' }, { mark: 'done' }, { mark: 'working' }, { mark: '' }]), 2)
})

test('ago reads a span the way the cards show it', () => {
  assert.equal(ago(0), '0s')
  assert.equal(ago(59_900), '59s')
  assert.equal(ago(125_000), '2m 05s')
  assert.equal(ago(3_725_000), '1h 02m')
  assert.equal(ago(-5), '0s')
})

test('modelName shortens a model id', () => {
  assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5')
  assert.equal(modelName('claude-haiku-5'), 'Haiku 5')
  assert.equal(modelName(undefined), '')
  assert.equal(modelName('gpt'), 'gpt')
})

test('summary counts sessions by what they do', () => {
  assert.equal(summary(['working', 'working', 'waiting', '']), '2 working · 1 waiting on you')
  assert.equal(summary(['', '']), '2 idle')
  assert.equal(summary(['done']), '1 done')
})

test('an answered prompt reads as working until the session reports again', () => {
  const waiting = { status: 'waiting', since: 5, activity: 'Bash · npm test' }
  assert.deepEqual(answeredReport(waiting, 5), { status: 'working', since: 5, activity: 'Bash · npm test' })
  assert.equal(answeredReport(waiting, undefined), waiting)
  assert.equal(answeredReport({ ...waiting, since: 9 }, 5).status, 'waiting') // asked again since
  assert.equal(answeredReport({ status: 'idle', since: 5 }, 5).status, 'idle')
  assert.ok(['Enter', 'NumpadEnter', 'Escape', 'Digit2', 'Numpad1'].every(k => ANSWERS.test(k)))
  assert.ok(!['ArrowDown', 'KeyY', 'Digit0', 'Tab'].some(k => ANSWERS.test(k)))
})

test('a notice names what Claude asks about, or the prompt it finished, and only when it wants the user', () => {
  const report = { activity: 'Bash · npm publish', prompt: 'Ship it' }
  assert.deepEqual(notice({ mark: 'waiting', attention: true }, report, 'nook'), {
    title: 'Claude needs you in nook',
    body: 'Asks about Bash · npm publish\n“Ship it”',
  })
  assert.deepEqual(notice({ mark: 'done', attention: true }, report, 'nook'), { title: 'Claude finished in nook', body: '“Ship it”' })
  assert.deepEqual(notice({ mark: 'done', attention: true }, { ...report, answer: 'Published 1.4.0' }, 'nook'), { title: 'Claude finished in nook', body: 'Published 1.4.0' })
  assert.deepEqual(notice({ mark: 'waiting', attention: true }, {}), { title: 'Claude needs you', body: 'Waiting on you' })
  assert.equal(notice({ mark: 'working', attention: false }, report, 'nook'), null)
})

test('a prompt goes to several sessions only where Enter sends it, and starts on the ones between turns', () => {
  const idle = { status: 'idle' }, working = { status: 'working' }, waiting = { status: 'waiting' }
  assert.equal(cannotSend({ mark: '' }, idle), null)
  assert.equal(cannotSend({ mark: 'done' }, idle), null)
  assert.equal(cannotSend({ mark: 'working' }, working), null) // Claude queues it for after this turn
  assert.equal(cannotSend({ mark: 'waiting' }, waiting), 'Answer its question first')
  assert.equal(cannotSend(undefined, {}), 'Still starting')
  assert.deepEqual([idle, working, waiting, {}].map(r => pickedAtFirst({ mark: '' }, r)), [true, false, false, false])
})

test('a card reads the context fill once Claude has replied, and the cost from half a cent', () => {
  assert.equal(fill({}), null)
  assert.equal(fill({ context: { window: 200000 } }), null) // a new or cleared session
  assert.equal(fill({ context: { window: 200000, tokens: 124000, percent: 62 } }), 62)
  assert.deepEqual([0, 0.004, 0.42, 3.456, 12.6].map(money), ['', '', '$0.42', '$3.46', '$13'])
})

test('the account\'s limits: the newest unreset reading of each window, the fullest first', () => {
  const now = Date.parse('2026-10-29T16:00:00Z')
  const reports = [
    { limits: [{ kind: 'five_hour', used: 61, resetsAt: '2026-10-29T15:00:00Z' }] }, // reset an hour ago
    { limits: [{ kind: 'five_hour', used: 12, resetsAt: '2026-10-29T20:00:00Z' }, { kind: 'seven_day', used: 30, resetsAt: '2026-11-02T00:00:00Z' }] },
    { limits: [{ kind: 'five_hour', used: 14.5, resetsAt: '2026-10-29T20:00:00Z' }] }, // the same window, read later
    {},
  ]
  assert.deepEqual(limits(reports, now), [
    { name: 'weekly', used: 30, resetsAt: Date.parse('2026-11-02T00:00:00Z') },
    { name: '5-hour', used: 14.5, resetsAt: Date.parse('2026-10-29T20:00:00Z') },
  ])
  assert.deepEqual(limits([{}, { limits: [] }], now), [])
})

test('a card offers to answer a permission prompt only while its session waits on it', () => {
  const asks = { tool: 'Bash', what: 'Bash · git push' }
  assert.deepEqual(asking({ mark: 'waiting' }, { status: 'waiting', asks }), asks)
  assert.equal(asking({ mark: 'waiting' }, { status: 'waiting', asks: null }), null) // Claude asks a question
  assert.equal(asking({ mark: 'working' }, answeredReport({ status: 'waiting', since: 5, asks }, 5)), null) // answered in the tab
  assert.equal(asking({ mark: 'working' }, { status: 'working', asks: null }), null)
  assert.equal(asking(undefined, {}), null)
})
