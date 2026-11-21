// 交给班主任的可执行课表。
//
// 每个学生一张表：
//   * 已确认的转课 → 按确认的课节列出（用学生本校的展示号）；
//   * 未生效、待确认、被拦下的申请 → 保留原课，并把尚未交接的选修课单列；
//   * 原班必修无论何种状态都继续有效；
//   * 跨校共用课附上订位依据（席位编号、分校配额、已落位学生、放位记录）；
//   * 确认组只在一边课表显示时，标出「未同步」，并给出可查回的确认组号，
//     与「未生效」明确区分。

import { resolveClass, sessionsFor, classSides, SCHOOL_NAMES } from './catalog.mjs'
import { seatIdFor, seatBasis } from './seats.mjs'
import { compareOccurrence } from './calendar.mjs'

// 联开编号本身不是校内展示号：学生本校页面若没有这个编号，
// 就不能凭 span 里的东/西校字段断定它已经同步到本校课表。
function displaySlot(catalog, id, school) {
  const entry = resolveClass(catalog, id, school)
  if (!entry) return null
  if (entry.joint) {
    const side = entry.schools?.[school]
    return side?.slot ?? null
  }
  return entry.id
}

function sortSessions(sessions) {
  return sessions.slice().sort(compareOccurrence)
}

function sessionRow(session, kind, extra = {}) {
  return {
    date: session.date,
    period: session.period,
    slot: session.slot,
    school: session.school,
    label: session.label,
    kind,
    moved: Boolean(session.moved),
    makeup: Boolean(session.makeup),
    originalPeriod: session.originalPeriod,
    held: session.held ?? null,
    ...extra,
  }
}

function targetRows(entry, school) {
  const result = sessionsFor(entry, school)
  return {
    rows: result.sessions.map(session => sessionRow(session, 'target')),
    side: result.side,
    foreign: result.foreign,
    missing: result.missing,
  }
}

function classSessions(entry, school) {
  return entry?.schools?.[school]?.sessions ?? []
}

// 共用课的订位依据：席位目录里的容量、分校配额、已落位学生与放位记录。
function sharedSeatEvidence(entry, school, seatIndex) {
  if (!entry?.joint) return []
  const seatId = seatIdFor(entry, school)
  const seat = seatIndex.get(seatId)
  const displaySlots = Object.fromEntries(Object.entries(entry.schools)
    .map(([side, value]) => [side, value.slot]))
  if (!seat) {
    return [{
      seatId,
      joint: entry.joint,
      present: false,
      displaySlots,
      note: '席位目录没有这个联开班，订位依据需人工补录',
    }]
  }
  return [{
    seatId,
    joint: entry.joint,
    present: true,
    basis: seatBasis(seat),
    displaySlots,
    note: '两校页面明确给出同一 data-joint，才按共用席位处理',
  }]
}

// 逐校区说明：未生效 / 已同步 / 未同步。返回该生所有相关确认组。
// sides 只包含「课表上真实会出现这门课」的学校：目标课在学生本校有展示号时，
// 本校一定要出现在 sides 里；另一校只有在联开关系成立时才出现。
export function confirmationStates(snapshot, student, school, toEntry, catalog) {
  const sides = new Set()
  const ownDisplay = toEntry ? (catalog ? displaySlot(catalog, toEntry.id, school) : toEntry.schools?.[school]?.slot) : null
  if (ownDisplay || toEntry?.schools?.[school]) sides.add(school)
  if (toEntry?.joint && toEntry.shared) for (const side of classSides(toEntry)) sides.add(side)
  if (!sides.size) sides.add(school)

  const results = []
  for (const group of snapshot.confirmations ?? []) {
    const row = (group.rows ?? []).find(candidate => candidate.student === student)
    if (!row) continue
    const view = new Set(row.view ?? [])
    const sideStates = {}
    for (const side of sides) {
      if (!group.effective) {
        sideStates[side] = {
          state: '未生效',
          effective: false,
          synced: false,
          reason: group.pending
            ? '门户已登记这一组，但尚未生效，还不能排进课表'
            : '门户确认组未生效',
        }
      } else if (view.has(side)) {
        sideStates[side] = {
          state: '已同步',
          effective: true,
          synced: true,
          reason: `${SCHOOL_NAMES[side] ?? side}课表已显示这门共用课`,
        }
      } else {
        sideStates[side] = {
          state: '未同步',
          effective: true,
          synced: false,
          reason: `${SCHOOL_NAMES[side] ?? side}课表尚未显示这门共用课，需要继续跟进同步`,
        }
      }
    }
    const unsyncedSchools = Object.entries(sideStates)
      .filter(([, value]) => !value.synced)
      .map(([side]) => side)
    results.push({
      group: group.group,
      effective: Boolean(group.effective),
      pending: Boolean(group.pending),
      view: [...view],
      sides: sideStates,
      unsyncedSchools,
      conclusion: !group.effective
        ? (group.pending ? '未生效（等待门户确认）' : '未生效')
        : unsyncedSchools.length === 0 ? '已生效并同步' : '已生效，部分课表未同步',
    })
  }
  return results.sort((left, right) => String(left.group).localeCompare(String(right.group)))
}

function pendingReason(member) {
  if (member.verdict === 'backup') {
    return `座位未放位：${member.seat?.reason ?? '需等待放位时间'}`
  }
  if (member.verdict === 'pending-receipt') {
    return '门户回条未查清，暂不交接'
  }
  return member.blockingConflict?.message ?? '申请未成立'
}

function buildStudent(member, snapshot, catalog, seatIndex) {
  const school = member.school
  const confirmed = member.verdict === 'confirmed' || member.verdict === 'confirmed-unsynced'
  const toEntry = resolveClass(catalog, member.to, school)
  const fromEntry = resolveClass(catalog, member.from, school)
  const rows = []

  for (const core of member.retainedCore ?? []) {
    rows.push({
      date: core.date,
      period: core.period,
      slot: core.slot,
      school,
      label: core.label,
      kind: 'retained-core',
      held: 'core',
      note: '与原班同学一起上，继续有效',
    })
  }

  if (confirmed) {
    for (const row of targetRows(toEntry, school).rows) {
      rows.push({ ...row, note: '门户确认组已生效' })
    }
  } else {
    for (const session of classSessions(fromEntry, school)) {
      rows.push(sessionRow(session, 'original', { note: '申请未成立，原课继续' }))
    }
  }

  // 未生效时目标课的席位只是「可能被接收」，不能写成订位依据；
  // 这里只保留原课与待办选修。
  const sharedSeats = confirmed ? sharedSeatEvidence(toEntry, school, seatIndex) : []

  const confirmation = confirmed
    ? confirmationStates(snapshot, member.student, school, toEntry, catalog)
    : null

  return {
    student: member.student,
    school,
    status: confirmed
      ? (member.verdict === 'confirmed' ? '已生效并同步' : '已生效，部分课表未同步')
      : member.verdict === 'pending-receipt'
        ? '门户回条待确认，保留原课'
        : member.verdict === 'backup'
          ? '候补中，保留原课'
          : '未成立，保留原课',
    transfer: { from: member.from, to: member.to },
    timetable: sortSessions(rows),
    sharedSeats,
    pendingElectives: confirmed ? [] : [{
      from: member.from,
      to: member.to,
      reason: pendingReason(member),
      releaseAt: member.seat?.reservedOpenAt ?? null,
      allowedChannel: member.seat?.allowedChannel ?? null,
    }],
    confirmation,
    reservedSeats: member.reservations ?? [],
    conflicts: member.conflicts ?? [],
    note: confirmed
      ? '按确认课节交接；未同步的校区需继续跟进'
      : '原班课节与必修照常执行，选修课待办',
  }
}

// 只出现在确认组里的学生（不在本次转课申请中），也要能交给班主任。
function buildConfirmationOnly(snapshot, catalog, seatIndex, handled) {
  const results = []
  for (const group of snapshot.confirmations ?? []) {
    for (const row of group.rows ?? []) {
      if (handled.has(row.student)) continue
      handled.add(row.student)
      const school = guessSchool(catalog, row)
      const toEntry = resolveClass(catalog, row.to, school)
      const confirmation = confirmationStates(snapshot, row.student, school, toEntry, catalog)
      results.push({
        student: row.student,
        school,
        status: group.effective
          ? (confirmation[0]?.unsyncedSchools.length ? '已生效，部分课表未同步' : '已生效并同步')
          : '未生效',
        transfer: { from: row.from, to: row.to },
        timetable: group.effective
          ? targetRows(toEntry, school).rows.map(item => ({ ...item, note: `门户确认组 ${group.group}` }))
          : [],
        sharedSeats: sharedSeatEvidence(toEntry, school, seatIndex),
        pendingElectives: group.effective ? [] : [{
          from: row.from,
          to: row.to,
          reason: group.pending ? '门户登记待生效' : '门户确认组未生效',
          group: group.group,
        }],
        confirmation,
        reservedSeats: [],
        conflicts: [],
        note: group.effective ? '确认组已生效，按确认课节排课' : '确认组未生效，暂不排课',
      })
    }
  }
  return results
}

// 确认组记录没有学校字段时，按校内展示号判断学生属于哪一校。
function guessSchool(catalog, row) {
  for (const school of ['east', 'west']) {
    const entry = resolveClass(catalog, row.to, school)
    if (entry?.schools?.[school]) return school
  }
  for (const school of ['east', 'west']) {
    const entry = resolveClass(catalog, row.from, school)
    if (entry?.schools?.[school]) return school
  }
  return 'east'
}

export function buildHandover(snapshot, plan, catalog, seatIndex) {
  const handled = new Set()
  const fromPlan = plan.students.map(member => {
    handled.add(member.student)
    return buildStudent(member, snapshot, catalog, seatIndex)
  })
  const students = [
    ...fromPlan,
    ...buildConfirmationOnly(snapshot, catalog, seatIndex, handled),
  ].sort((left, right) => left.student.localeCompare(right.student))

  return {
    generatedAt: plan.now,
    seatsVersion: plan.source.seatsVersion,
    stale: plan.source.stale,
    students,
    summary: {
      students: students.length,
      effective: students.filter(student => student.status.startsWith('已生效')).length,
      unsynced: students.filter(student => student.status.includes('部分课表未同步')).length,
      pending: students.filter(student => student.status.includes('待确认')
        || student.status === '未生效').length,
      retained: students.filter(student => student.status.includes('保留原课')).length,
    },
    notes: [
      '原班必修课节保留，学生仍与原班同学一起上。',
      '跨校共用课只列出两校页面明确给出同一 data-joint 的班级。',
      '确认组已记录但某校课表未显示时，标为「未同步」，与「未生效」分开处理。',
      '尚未交接的选修课单列，不作为已排课节。',
    ],
  }
}

export { targetRows, sharedSeatEvidence, buildStudent }
