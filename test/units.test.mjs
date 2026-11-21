import assert from 'node:assert/strict'
import { test } from 'node:test'

import { occurrenceDate, mondayOf, addDays, instant, occurrenceKey } from '../lib/calendar.mjs'
import { parseSchoolPage } from '../lib/parse.mjs'
import { buildCatalog, resolveClass, sessionsFor } from '../lib/catalog.mjs'
import { evaluateSeat } from '../lib/seats.mjs'

test('学周按各校锚点换算成日期', () => {
  // 东校第 12 周与西校第 11 周都从 2026-11-23（周一）起。
  assert.equal(occurrenceDate('2026-11-23', 12, 12, 1), '2026-11-23')
  assert.equal(occurrenceDate('2026-11-23', 11, 11, 1), '2026-11-23')
  assert.equal(occurrenceDate('2026-11-23', 12, 13, 2), '2026-12-01')
  assert.equal(addDays('2026-11-23', -7), '2026-11-16')
})

test('周一锚点不因传入日期是周三而偏移', () => {
  assert.equal(mondayOf('2026-11-25'), '2026-11-23')
  assert.equal(occurrenceDate('2026-11-23', 12, 12, 3), '2026-11-25')
})

test('调课只覆盖所指日期与原课节', () => {
  const html = `<!doctype html><html><time data-week="11" datetime="2026-11-23">第十一周</time>
    <table>
      <tr data-slot="W21" data-week="11" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
      <tr data-slot="W21" data-week="12" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr>
    </table>
    <article data-slot="W21" data-date="2026-11-23" data-new-period="1">改上第一节</article>`
  const page = parseSchoolPage(html, 'west')
  const catalog = buildCatalog({ west: page })
  const entry = catalog.classes.get('joint:J7')
  const sessions = entry.schools.west.sessions
  const moved = sessions.find(session => session.date === '2026-11-23')
  const untouched = sessions.find(session => session.date === '2026-11-30')
  assert.equal(moved.period, 1)
  assert.equal(moved.originalPeriod, 3)
  assert.equal(untouched.period, 3)
  assert.ok(catalog.moves.some(move => move.date === '2026-11-23' && move.toPeriod === 1))
})

test('补课可以只给某个日期增加一节', () => {
  const html = `<!doctype html><html><time data-week="11" datetime="2026-11-23">第十一周</time>
    <table><tr data-slot="W29" data-week="11" data-day="1" data-period="5"><td>陶艺</td></tr></table>
    <article data-slot="W29" data-date="2026-11-24" data-new-period="2">补课</article></html>`
  const catalog = buildCatalog({ west: parseSchoolPage(html, 'west') })
  const sessions = catalog.classes.get('west:W29').sessions
  assert.equal(sessions.length, 2)
  const makeup = sessions.find(session => session.date === '2026-11-24')
  assert.equal(makeup.period, 2)
  assert.equal(makeup.makeup, true)
  assert.equal(sessions.find(session => session.date === '2026-11-23').period, 5)
})

test('同名课程没有 data-joint 时不合并', () => {
  const east = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="E1" data-week="1" data-day="1" data-period="1"><td>工业图学</td></tr></table>`, 'east')
  const west = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="W1" data-week="1" data-day="1" data-period="1"><td>工业图学</td></tr></table>`, 'west')
  const catalog = buildCatalog({ east, west })
  assert.equal(catalog.classes.size, 2)
  assert.equal(resolveClass(catalog, 'E1', 'east').shared, false)
})

test('只有一校写 data-joint 时不能当共用班', () => {
  const east = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="E17" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr></table>`, 'east')
  const west = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="W21" data-week="1" data-day="1" data-period="3"><td>工业图学</td></tr></table>`, 'west')
  const catalog = buildCatalog({ east, west })
  const joint = catalog.classes.get('joint:J7')
  assert.equal(joint.shared, false)
  assert.ok(catalog.issues.some(issue => issue.kind === 'joint-missing-side'))
})

test('两校联开节次不同步会被定位到日期与节次', () => {
  const east = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="E18" data-week="1" data-day="1" data-period="4" data-joint="J9"><td>环境实践</td></tr></table>`, 'east')
  const west = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="W22" data-week="1" data-day="1" data-period="4" data-joint="J9"><td>环境实践</td></tr></table>
    <article data-slot="W22" data-date="2026-11-23" data-new-period="1">改上第一节</article>`, 'west')
  const catalog = buildCatalog({ east, west })
  const issue = catalog.issues.find(item => item.kind === 'joint-desync')
  assert.ok(issue)
  assert.equal(issue.date, '2026-11-23')
  assert.deepEqual(issue.periods, { west: [1], east: [4] })
})

test('本校页面没有联开课时退回另一校并标注', () => {
  const east = parseSchoolPage(`<!doctype html><time data-week="1" datetime="2026-11-23"></time>
    <table><tr data-slot="E17" data-week="1" data-day="1" data-period="3" data-joint="J7"><td>工业图学</td></tr></table>`, 'east')
  const catalog = buildCatalog({ east })
  const entry = resolveClass(catalog, 'J7', 'west')
  const result = sessionsFor(entry, 'west')
  assert.equal(result.foreign, true)
  assert.equal(entry.shared, false)
  assert.equal(result.sessions.length, 1)
})

test('席位按分校配额、放位时间与渠道核算', () => {
  const seat = {
    id: 'J7',
    total: 2,
    allocation: { east: 1, west: 1 },
    occupied: [{ student: 'S3', school: 'east' }, { student: 'S2', school: 'west' }],
    reservedOpenAt: instant('2026-11-22T11:00+08:00'),
    allowedChannel: '跨校审批',
  }
  // 当前两校配额都已占满；西校学生转出后腾出的名额属于西校配额，
  // 东校要借它必须等放位时间开放，且渠道相符。
  const closed = evaluateSeat(seat, {
    school: 'east',
    now: instant('2026-11-22T09:30+08:00'),
    channel: '跨校审批',
    releases: [{ student: 'S2', school: 'west' }],
  })
  assert.equal(closed.verdict, 'reserved-closed')
  assert.equal(new Date(closed.releaseAt).toISOString(), '2026-11-22T03:00:00.000Z')

  const full = evaluateSeat(seat, { school: 'east', now: instant('2026-11-22T09:30+08:00') })
  assert.equal(full.verdict, 'full')

  const wrongChannel = evaluateSeat(seat, {
    school: 'east',
    now: instant('2026-11-22T11:45+08:00'),
    channel: '现场录入',
    releases: [{ student: 'S2', school: 'west' }],
  })
  assert.equal(wrongChannel.verdict, 'channel-mismatch')

  const opened = evaluateSeat(seat, {
    school: 'east',
    now: instant('2026-11-22T11:45+08:00'),
    channel: '跨校审批',
    releases: [{ student: 'S2', school: 'west' }],
  })
  assert.equal(opened.verdict, 'available-reserved')
  assert.equal(opened.usesOtherQuota, true)
})

test('同批互换只有对方释放后才有位置', () => {
  const seat = {
    id: 'J9',
    total: 1,
    allocation: { east: 1, west: 0 },
    occupied: [{ student: 'S1', school: 'east' }],
    reservedOpenAt: null,
    allowedChannel: null,
  }
  const before = evaluateSeat(seat, { school: 'east', now: instant('2026-11-22T11:45+08:00') })
  assert.equal(before.verdict, 'full')
  assert.equal(before.freeTotal, 0)

  const after = evaluateSeat(seat, {
    school: 'east',
    now: instant('2026-11-22T11:45+08:00'),
    releases: [{ student: 'S2', school: 'east' }],
  })
  assert.equal(after.verdict, 'available-swap')
  assert.equal(after.freeTotal, 1)
  assert.deepEqual(after.releaseStudents, ['S2'])
})

test('没有本校配额也不能借别校空位', () => {
  const seat = {
    id: 'J9', total: 2, allocation: { east: 2, west: 0 }, occupied: [], reservedOpenAt: null,
  }
  const result = evaluateSeat(seat, { school: 'west', now: instant('2026-11-22T11:45+08:00') })
  assert.equal(result.verdict, 'not-open-to-school')
})

test('课节身份按日期与节次，不按展示号', () => {
  assert.equal(occurrenceKey({ date: '2026-11-23', period: 3 }), occurrenceKey({ date: '2026-11-23', period: 3 }))
  assert.notEqual(occurrenceKey({ date: '2026-11-23', period: 3 }), occurrenceKey({ date: '2026-11-23', period: 4 }))
})
