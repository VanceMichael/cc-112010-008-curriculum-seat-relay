import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import { makeSource } from '../source.mjs'
import { connect } from '../lib/session.mjs'

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

async function at(origin, step) {
  const response = await fetch(new URL('/replay', origin), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
  })
  assert.equal(response.status, 200)
}

test('会话在同一批资料上产出计划与课表', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  assert.equal(session.plan.summary.students.length, 3)
  assert.ok(session.handover.students.length >= 3)
  // 重新取计划不重新读来源，结果一致。
  const again = await session.planFor()
  assert.deepEqual(again.summary, session.plan.summary)
})

test('提交未查清时记下这组，其他申请不能让出位置', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  const result = await session.submit(['S4'])
  assert.equal(result.state, 'unknown')
  assert.deepEqual(session.unknownGroups().map(entry => entry.students).flat(), ['S4'])

  // 同一次发布里重新取计划，未查清的组同时保留原位与目标位。
  await session.refresh()
  const unknownRows = session.plan.reservations.filter(row => row.student === 'S4')
  assert.ok(unknownRows.some(row => row.kind === 'unknown-original'))
  assert.ok(unknownRows.some(row => row.kind === 'unknown-target'))
  const s4 = session.plan.students.find(member => member.student === 'S4')
  assert.equal(s4.verdict, 'pending-receipt')
})

test('门户已有生效记录时，未查清的组以门户为准', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  await session.submit(['S4'])
  await at(origin, 1)
  await session.refresh()
  const s4 = session.plan.students.find(member => member.student === 'S4')
  assert.equal(s4.verdict, 'confirmed')
  assert.equal(s4.receipt.group, 'G16')
  // 已生效即不再按未查清保留双份位置。
  assert.equal(session.plan.reservations.filter(row => row.student === 'S4').length, 1)
  assert.equal(session.plan.reservations.find(row => row.student === 'S4').kind, 'confirmed-target')
})

test('门户后来确认整组生效后，可以从待核对名单移除', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  // 第 0 次发布里 S4 还没有任何确认组：提交后门户没有这项表单，属于未查清。
  const pending = await session.submit(['S4'])
  assert.equal(pending.state, 'unknown')
  assert.equal(session.unknownGroups().length, 1)

  await at(origin, 3)
  const rechecked = await session.recheckSubmission(['S4'])
  assert.equal(rechecked.state, 'confirmed')
  assert.equal(session.unknownGroups().length, 0)
  const receipt = rechecked.receipts[0]
  assert.equal(receipt.group, 'G16')
  assert.equal(receipt.effective, true)
  assert.deepEqual(receipt.unsyncedSchools, [])
})

test('整组仍不成立时不会单独提交任何一条', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  const result = await session.submit(['S1', 'S2'])
  assert.equal(result.state, 'kept')
  assert.deepEqual(result.split.independent, [])
  assert.equal(result.split.kept.length, 1)
})

test('可以只提交真正独立的那一条', async t => {
  const origin = await openSource(t)
  const session = await connect(origin).refresh()
  const result = await session.submit(['S1', 'S2', 'S4'])
  // 互换组被保留，S4 单独发出（来源没有对应表单，因此结果未查清）。
  assert.equal(result.split.kept.length, 1)
  assert.deepEqual(result.split.independent.map(row => row.student), ['S4'])
  assert.equal(result.state, 'unknown')
  assert.equal(result.request.changes.length, 1)
  assert.equal(result.request.changes[0].student, 'S4')
})

test('门户已有确认组时不重复提交，先核对实际记录', async t => {
  const origin = await openSource(t)
  await at(origin, 2)
  const session = await connect(origin).refresh()
  const result = await session.submit(['S1', 'S2'])
  assert.equal(result.state, 'recorded')
  assert.equal(result.receipts[0].group, 'G17')
  assert.equal(result.receipts[0].effective, false)
})
