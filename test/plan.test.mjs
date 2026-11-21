import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import { makeSource } from '../source.mjs'
import { snapshot, readEast, readWest } from '../lib/fetch.mjs'
import {
  prepare, refresh, submitGroup, splitIndependent, revalidate, revalidateFrom,
} from '../lib/transaction.mjs'
import { buildHandover } from '../lib/handover.mjs'

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

async function prepared(origin) {
  const { prepared } = await refresh(origin)
  return prepared
}

function groupOf(plan, students) {
  return plan.groups.find(group =>
    group.students.length === students.length
    && group.students.every((student, index) => student === students[index]))
}

test('第 0 次发布：未到放位时间的互换作为备选，独立申请可单独办理', async t => {
  const origin = await openSource(t)
  const { plan } = await prepared(origin)

  const swap = groupOf(plan, ['S1', 'S2'])
  assert.equal(swap.kind, 'swap')
  assert.equal(swap.atomic, true)
  assert.deepEqual(swap.submit, [])
  assert.deepEqual(swap.keepOriginal, ['S1', 'S2'])
  const s1 = swap.members.find(member => member.student === 'S1')
  assert.equal(s1.verdict, 'backup')
  assert.equal(new Date(s1.backup.releaseAt).toISOString(), '2026-11-22T03:00:00.000Z')
  assert.equal(s1.backup.allowedChannel, '跨校审批')
  // 西校在 J9 没有配额，不能借用东校未开放的预留。
  const s2 = swap.members.find(member => member.student === 'S2')
  assert.equal(s2.verdict, 'blocked')
  assert.equal(s2.seat.verdict, 'not-open-to-school')

  const single = groupOf(plan, ['S4'])
  assert.equal(single.status, 'ready')
  assert.deepEqual(single.submit, ['S4'])
  assert.deepEqual(plan.independent, ['S4'])
})

test('第 0 次发布：整组互换被门户以 409 拒绝时不重试、不占位', async t => {
  const origin = await openSource(t)
  const { plan, snapshot: current } = await prepared(origin)
  const result = await submitGroup(origin, ['S1', 'S2'], { plan, snapshot: current })
  assert.equal(result.state, 'rejected')
  assert.equal(result.status, 409)
  assert.deepEqual(result.retainedOriginal, ['S1', 'S2'])
  assert.equal(result.group, null)
  // 409 之后重新读取，确认组目录没有新增，席位版本也没变。
  const after = await snapshot(origin, null)
  assert.equal(after.seats.version, 4)
  assert.equal(after.confirmations.length, 0)
})

test('换课后与共同必修同场次：冲突定位到日期与节次，整组保留原课', async t => {
  const origin = await openSource(t)
  await at(origin, 1)
  const { plan } = await prepared(origin)
  const swap = groupOf(plan, ['S1', 'S2'])
  assert.equal(swap.status, 'blocked')
  assert.deepEqual(swap.submit, [])

  const s2 = swap.members.find(member => member.student === 'S2')
  const core = s2.conflicts.find(item => item.kind === 'core-overlap')
  assert.ok(core)
  assert.equal(core.severity, 'blocking')
  assert.equal(core.date, '2026-11-23')
  assert.equal(core.period, 1)
  assert.equal(core.core[0].slot, 'W04')

  const desync = s2.conflicts.find(item => item.kind === 'joint-desync')
  assert.ok(desync)
  assert.deepEqual(desync.periods, { east: [4], west: [1] })
  // 原班必修继续有效。
  assert.deepEqual(
    s2.retainedCore.map(row => `${row.date}#${row.period}:${row.slot}`),
    ['2026-11-23#1:W04'],
  )
})

test('第 1 次发布：门户确认回条先于席位目录同步时按确认组处理', async t => {
  const origin = await openSource(t)
  await at(origin, 1)
  const { plan } = await prepared(origin)
  const single = groupOf(plan, ['S4'])
  assert.equal(single.status, 'confirmed')
  assert.equal(single.members[0].receipt.group, 'G16')
  assert.equal(single.members[0].receipt.conclusion, '已生效并同步')
  assert.deepEqual(single.submit, [])
  assert.equal(single.members[0].action.canSubmit, false)
})

test('第 2 次发布：整组待生效时保留原位和可能已接收的位置', async t => {
  const origin = await openSource(t)
  await at(origin, 2)
  const { plan, snapshot: current } = await prepared(origin)

  const swap = groupOf(plan, ['S1', 'S2'])
  assert.equal(swap.status, 'pending-receipt')
  assert.equal(swap.atomic, true)
  assert.deepEqual(swap.submit, [])
  assert.deepEqual(swap.keepOriginal, ['S1', 'S2'])
  for (const member of swap.members) {
    assert.equal(member.receipt.group, 'G17')
    assert.equal(member.receipt.effective, false)
    assert.equal(member.receipt.conclusion, '未生效（等待门户确认）')
  }

  // 未查清前这组同时占住原位与目标位。
  const seats = plan.reservations.filter(row => ['S1', 'S2'].includes(row.student))
  const kinds = new Set(seats.map(row => row.kind))
  assert.deepEqual([...kinds].sort(), ['pending-original', 'pending-target'])
  assert.ok(seats.some(row => row.seatId === 'J7' && row.student === 'S1'))
  assert.ok(seats.some(row => row.seatId === 'J9' && row.student === 'S2'))

  // 门户接受提交但回条暂时读不到 → 未查清，必须继续占位。
  const result = await submitGroup(origin, ['S1', 'S2'], { plan, snapshot: current })
  assert.equal(result.state, 'unknown')
  assert.equal(result.status, 503)
  assert.deepEqual(result.reservedUnknown, ['S1', 'S2'])
})

test('第 3 次发布：确认已生效但只在一校显示时标为未同步', async t => {
  const origin = await openSource(t)
  await at(origin, 3)
  const { plan, handover } = await prepared(origin)

  const s2 = plan.students.find(member => member.student === 'S2')
  assert.equal(s2.verdict, 'confirmed-unsynced')
  assert.equal(s2.confirmationGroup, 'G17')
  assert.deepEqual(s2.receipt.unsyncedSchools, ['east'])
  assert.equal(s2.receipt.sides.west.state, '已同步')
  assert.equal(s2.receipt.sides.east.state, '未同步')
  assert.equal(s2.receipt.sides.east.effective, true)

  const handoverS2 = handover.students.find(student => student.student === 'S2')
  assert.match(handoverS2.status, /部分课表未同步/)
  const group = handoverS2.confirmation.find(row => row.group === 'G17')
  assert.equal(group.conclusion, '已生效，部分课表未同步')
  assert.deepEqual(group.unsyncedSchools, ['east'])

  // 确认组里但不在本次申请中的学生也要交给班主任。
  const s5 = handover.students.find(student => student.student === 'S5')
  assert.ok(s5)
  assert.equal(s5.confirmation[0].group, 'G-11')
})

test('交给班主任的课表保留必修、共用课订位依据与未交接选修', async t => {
  const origin = await openSource(t)
  await at(origin, 3)
  const { plan, handover, snapshot: current } = await prepared(origin)

  const s1 = handover.students.find(student => student.student === 'S1')
  assert.deepEqual(
    s1.timetable.map(row => `${row.date}#${row.period}:${row.kind}`),
    ['2026-11-23#1:retained-core', '2026-11-23#3:target'],
  )
  assert.equal(s1.sharedSeats[0].seatId, 'J7')
  assert.deepEqual(s1.sharedSeats[0].displaySlots, { east: 'E17', west: 'W21' })
  assert.equal(s1.sharedSeats[0].basis.total, 1)

  // 未生效的申请：原课保留，选修课单列，不排成已上课节。
  await at(origin, 2)
  const pendingState = await prepared(origin)
  const pendingS1 = pendingState.handover.students.find(student => student.student === 'S1')
  assert.equal(pendingS1.status, '门户回条待确认，保留原课')
  assert.ok(pendingS1.timetable.some(row => row.kind === 'retained-core' && row.slot === 'A01'))
  assert.ok(pendingS1.timetable.some(row => row.kind === 'original' && row.slot === 'E18'))
  assert.equal(pendingS1.timetable.filter(row => row.kind === 'target').length, 0)
  assert.equal(pendingS1.pendingElectives[0].from, 'J9')
  assert.equal(pendingS1.pendingElectives[0].to, 'J7')
})

test('填报前后重新核对：新调课或新占位会让可办理申请变成保留原课', async t => {
  const origin = await openSource(t)
  const { plan, snapshot: current } = await prepared(origin)
  assert.deepEqual(plan.independent, ['S4'])

  await at(origin, 1)
  const rechecked = await revalidateFrom(origin, plan)
  // 第 1 次发布里 S1/S2 已出现新调课与共同必修冲突。
  assert.ok(rechecked.changes.some(change => change.group === 'GRP-S1-S2'))
  assert.deepEqual(rechecked.plan.independent, [])
})

test('只拆出仍可独立办理的申请，联动项保留原课', async t => {
  const origin = await openSource(t)
  const { plan } = await prepared(origin)
  const split = splitIndependent(plan, ['S1', 'S2', 'S4'])
  assert.deepEqual(split.independent.map(row => row.student), ['S4'])
  const kept = split.kept.map(row => row.students.join(',')).sort()
  assert.deepEqual(kept, ['S1,S2'])
})

test('同一份资料只读一次也能产出计划与课表', async t => {
  const origin = await openSource(t)
  const raw = await snapshot(origin)
  const { plan, handover } = prepare(raw)
  assert.equal(plan.summary.students.length, 3)
  assert.ok(handover.students.length >= 3)
  // 两校锚点都是同一周一，周号不同不影响判断。
  const east = await readEast(origin)
  const west = await readWest(origin)
  assert.notEqual(east.anchorWeek, west.anchorWeek)
  assert.equal(east.anchorDate, west.anchorDate)
})
