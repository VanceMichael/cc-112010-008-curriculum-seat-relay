import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSchoolPage, parseSeats } from '../lib/parse.mjs'
import { buildPlan } from '../lib/plan.mjs'
import { instant } from '../lib/calendar.mjs'

// 构造最小来源：两校各一周的课表、席位目录、转课申请与确认组。
function school(rows, { week = 1, date = '2026-11-23', moves = '' } = {}) {
  const table = rows.map(row => {
    const joint = row.joint ? ` data-joint="${row.joint}"` : ''
    const held = row.held ? ` data-held="${row.held}"` : ''
    return `<tr data-slot="${row.slot}" data-week="${week}" data-day="${row.day ?? 1}" `
      + `data-period="${row.period}"${joint}${held}><td>${row.label ?? row.slot}</td></tr>`
  }).join('')
  return parseSchoolPage(
    `<!doctype html><html><time data-week="${week}" datetime="${date}"></time>`
    + `<table>${table}</table>${moves}</html>`,
    rows[0]?.school ?? 'east',
  )
}

function page(html, name) {
  return parseSchoolPage(html, name)
}

function planFor({ east, west, seats, requests, confirmations = [], now = '2026-11-22T11:45+08:00' }) {
  return buildPlan({
    east,
    west,
    seats: parseSeats({ version: 1, common: seats }),
    changes: { now: instant(now), requests },
    confirmations,
  })
}

const EAST_WEEK = `<!doctype html><time data-week="1" datetime="2026-11-23"></time><table>
  <tr data-slot="A01" data-week="1" data-day="1" data-period="1" data-held="core"><td>语文</td></tr>
  <tr data-slot="E17" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
  <tr data-slot="E18" data-week="1" data-day="1" data-period="4" data-joint="J9"><td>环境实践</td></tr>
</table>`

const WEST_WEEK = `<!doctype html><time data-week="1" datetime="2026-11-23"></time><table>
  <tr data-slot="W04" data-week="1" data-day="1" data-period="1" data-held="core"><td>数学</td></tr>
  <tr data-slot="W21" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
  <tr data-slot="W22" data-week="1" data-day="1" data-period="4" data-joint="J9"><td>环境实践</td></tr>
</table>`

test('未生效确认组占住的位置，其他申请不能使用', () => {
  const plan = planFor({
    east: page(EAST_WEEK, 'east'),
    west: page(WEST_WEEK, 'west'),
    seats: [
      // J9 只有东校 1 个名额，已被 S1 占着；S3 要进 J9。
      { id: 'J9', total: 1, allocation: { east: 1 }, occupied: [{ student: 'S1', school: 'east' }] },
      // J7 有东校名额，供 S1 转出后待确认。
      { id: 'J7', total: 2, allocation: { east: 1, west: 1 }, occupied: [{ student: 'S9', school: 'west' }] },
    ],
    requests: [
      { student: 'S1', school: 'east', from: 'J9', to: 'J7', core: [] },
      { student: 'S3', school: 'east', from: 'E17', to: 'J9', core: [] },
    ],
    confirmations: [{
      group: 'G1',
      effective: false,
      pending: true,
      rows: [],
      request: [{ student: 'S1', from: 'J9', to: 'J7' }],
    }],
  })

  const s3 = plan.students.find(member => member.student === 'S3')
  // 门户已登记 S1 的转课但未生效：J9 仍算被 S1 占住（原位保留），S3 不能进。
  assert.equal(s3.verdict, 'blocked')
  assert.equal(s3.seat.verdict, 'full')

  const s1 = plan.students.find(member => member.student === 'S1')
  assert.equal(s1.verdict, 'pending-receipt')
  assert.ok(plan.reservations.some(row => row.seatId === 'J9' && row.kind === 'pending-original'))
  assert.ok(plan.reservations.some(row => row.seatId === 'J7' && row.kind === 'pending-target'))
})

test('单向依赖按先后顺序办理，不当作互换整组拦截', () => {
  const plan = planFor({
    east: page(EAST_WEEK, 'east'),
    west: page(WEST_WEEK, 'west'),
    seats: [
      { id: 'J9', total: 1, allocation: { east: 1 }, occupied: [{ student: 'S1', school: 'east' }] },
      { id: 'J7', total: 2, allocation: { east: 1, west: 1 }, occupied: [] },
    ],
    requests: [
      { student: 'S1', school: 'east', from: 'J9', to: 'J7', core: [] },
      { student: 'S3', school: 'east', from: 'J7', to: 'J9', core: [] },
    ],
  })
  const group = plan.groups[0]
  assert.equal(group.kind, 'sequence')
  assert.equal(group.atomic, false)
  assert.deepEqual(group.students, ['S1', 'S3'])
  // 先办释放 J9 的 S1；S3 等 S1 释放后再办。
  assert.deepEqual(group.submit, ['S1'])
  const s3 = group.members.find(member => member.student === 'S3')
  assert.deepEqual(s3.waitFor, ['S1'])
  assert.equal(s3.verdict, 'ready')
  // 等待方不能被单独提交；本批只提交释放方。
  assert.equal(s3.action.canSubmit, false)
  assert.deepEqual(plan.independent, ['S1'])
})

test('同一学生两门目标课撞在同一节次时不能同时转入', () => {
  const east = page(`<!doctype html><time data-week="1" datetime="2026-11-23"></time><table>
    <tr data-slot="A01" data-week="1" data-day="1" data-period="1" data-held="core"><td>语文</td></tr>
    <tr data-slot="E40" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
    <tr data-slot="E41" data-week="1" data-day="1" data-period="3" data-joint="J9"><td>环境实践</td></tr>
  </table>`, 'east')
  const west = page(`<!doctype html><time data-week="1" datetime="2026-11-23"></time><table>
    <tr data-slot="W40" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
    <tr data-slot="W41" data-week="1" data-day="1" data-period="3" data-joint="J9"><td>环境实践</td></tr>
  </table>`, 'west')
  const plan = planFor({
    east,
    west,
    seats: [
      { id: 'J7', total: 2, allocation: { east: 1, west: 1 }, occupied: [] },
      { id: 'J9', total: 2, allocation: { east: 1, west: 1 }, occupied: [] },
    ],
    // J7 与 J9 都在周一第 3 节（这里用两门不同课制造同场次）。
    requests: [
      { student: 'S8', school: 'east', from: 'A01', to: 'J7', core: [] },
      { student: 'S8', school: 'east', from: 'A01', to: 'J9', core: [] },
    ],
  })
  const conflicts = plan.students.flatMap(member => member.conflicts)
  assert.ok(conflicts.some(item => item.kind === 'same-student-overlap' && item.severity === 'blocking'))
})

test('原班必修即使申请里没写也保留，并参与冲突判断', () => {
  const east = page(`<!doctype html><time data-week="1" datetime="2026-11-23"></time><table>
    <tr data-slot="A01" data-week="1" data-day="1" data-period="1" data-held="core"><td>语文</td></tr>
    <tr data-slot="E30" data-week="1" data-day="1" data-period="1"><td>选修</td></tr>
  </table>`, 'east')
  const plan = planFor({
    east,
    west: page(WEST_WEEK, 'west'),
    seats: [],
    requests: [{ student: 'S6', school: 'east', from: 'E30', to: 'E30', core: [] }],
  })
  const member = plan.students[0]
  assert.deepEqual(member.retainedCore.map(row => row.slot), ['A01'])
})

test('席位目录缺项按普通课程处理，不擅自判定容量', () => {
  const plan = planFor({
    east: page(EAST_WEEK, 'east'),
    west: page(WEST_WEEK, 'west'),
    seats: [],
    requests: [{ student: 'S7', school: 'east', from: 'J9', to: 'J7', core: [] }],
  })
  const member = plan.students[0]
  assert.equal(member.seat.verdict, 'unmanaged')
  assert.equal(member.verdict, 'ready')
  assert.ok(member.issues.some(issue => issue.kind === 'seat-unmanaged'))
})
