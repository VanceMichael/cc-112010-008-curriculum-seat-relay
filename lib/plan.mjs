// 转课计划。
//
// 输入是某一发布时刻的两校页面、席位目录、调课表与门户确认组；
// 输出是教务员可以直接照办的清单：
//   - 哪些申请现在能办，
//   - 哪些必须整组一起办（互换/联动），
//   - 哪些只能作为候补（放位时间未到），
//   - 哪些保留原课，
//   - 每处冲突落在哪个日期、哪个课节、哪个展示号。
//
// 判断只依据页面事实，不做推断：
//   * 学周先换算成日期，再比较节次；
//   * 只有两校页面明确给出同一个 data-joint 才按共用席位处理；
//   * 调课条目只覆盖所指日期与节次；
//   * 席位按分校配额核算，借用别校未用预留必须等放位时间且渠道相符。

import {
  buildCatalog, resolveClass, sessionsFor, classSides, SCHOOL_NAMES,
} from './catalog.mjs'
import {
  evaluateSeat, seatIdFor, indexSeats, seatBasis, SEAT_READY, SEAT_BACKUP,
} from './seats.mjs'
import { compareOccurrence, occurrenceKey } from './calendar.mjs'
import { hasCycle, makeUnionFind } from './graph.mjs'

// ---------------------------------------------------------------------------
// 小工具

function uniqBy(list, key) {
  const seen = new Set()
  const result = []
  for (const item of list) {
    const value = key(item)
    if (seen.has(value)) continue
    seen.add(value)
    result.push(item)
  }
  return result
}

function conflict(kind, severity, message, extra = {}) {
  return { kind, severity, message, ...extra }
}

export function changeSignature(row) {
  return `${row.student}\u0000${row.from}\u0000${row.to}`
}

export function sessionView(session) {
  return {
    date: session.date,
    period: session.period,
    slot: session.slot,
    school: session.school,
    label: session.label,
    moved: Boolean(session.moved),
    makeup: Boolean(session.makeup),
    originalPeriod: session.originalPeriod,
    held: session.held ?? null,
  }
}

export function classView(entry) {
  if (!entry) return null
  return {
    id: entry.id,
    joint: entry.joint,
    shared: entry.shared,
    label: entry.label,
    sides: Object.fromEntries(Object.entries(entry.schools).map(([school, side]) => [
      school,
      {
        slot: side.slot,
        label: side.label,
        sessions: side.sessions.map(sessionView),
      },
    ])),
  }
}

// ---------------------------------------------------------------------------
// 原班必修与目标课程

// 学生继续有效的原班课节：申请列出的 core + 页面上 held=core 的课程。
// 这些课节无论转课是否成立都不动，也不能作为转出课程。
export function coreSessions(catalog, request) {
  const ids = new Set(request.core ?? [])
  const entries = new Map()
  const missing = []

  for (const id of ids) {
    const entry = resolveClass(catalog, id, request.school)
    if (entry) entries.set(entry.key, entry)
    else missing.push(id)
  }
  for (const entry of catalog.classes.values()) {
    if (entry.schools?.[request.school]?.sessions.some(session => session.held === 'core')) {
      entries.set(entry.key, entry)
    }
  }

  const sessions = []
  for (const entry of entries.values()) {
    const side = entry.schools[request.school]
    for (const session of side.sessions) {
      const listed = ids.has(entry.id) || ids.has(side.slot ?? '')
      if (session.held !== 'core' && !listed) continue
      sessions.push({ entry, session })
    }
  }
  return {
    sessions: sessions.sort((left, right) => compareOccurrence(left.session, right.session)),
    entries: [...entries.values()],
    missing,
  }
}

// 目标课程的可执行场次。联开课用学生本校的展示号；本校页面没有时，
// 不能直接当成共用课执行。
export function targetSessions(catalog, request) {
  const entry = resolveClass(catalog, request.to, request.school)
  if (!entry) {
    return {
      entry: null, sessions: [], side: null, missing: true, foreign: false,
      conflicts: [conflict('target-not-listed', 'blocking',
        `目标课程 ${request.to} 在两校课表页都不存在`, { classId: request.to })],
    }
  }

  const result = sessionsFor(entry, request.school)
  const conflicts = []

  if (result.missing) {
    conflicts.push(conflict('class-not-on-page', 'blocking',
      `转课目标「${entry.label ?? entry.id}」在${SCHOOL_NAMES[request.school]}课表页没有可执行场次`, {
        classId: entry.id,
        presentSchools: classSides(entry),
      }))
  } else if (result.foreign && entry.joint) {
    conflicts.push(conflict('joint-not-confirmed', 'blocking',
      `联开组 ${entry.joint} 只有${SCHOOL_NAMES[result.side]}页面，两校没有明确给出的对应关系，不能按共用席位办理`, {
        classId: entry.id,
        presentSchools: classSides(entry),
      }))
  } else if (result.foreign) {
    conflicts.push(conflict('class-other-school', 'warning',
      `课程「${entry.label ?? entry.id}」只在${SCHOOL_NAMES[result.side]}页面列出，需人工确认学生实际到课地点`, {
        classId: entry.id,
        listedSchool: result.side,
      }))
  }

  if (entry.joint) {
    for (const issue of catalog.issues) {
      if (issue.kind === 'joint-missing-side' && issue.joint === entry.joint) {
        if (result.foreign) continue
        conflicts.push(conflict('joint-missing-side', 'blocking',
          `联开组 ${entry.joint} 缺少${issue.missing.map(school => SCHOOL_NAMES[school]).join('、')}页面，共用席位无依据`, {
            classId: entry.id,
            presentSchools: issue.present,
            missingSchools: issue.missing,
          }))
      }
      if (issue.kind !== 'joint-desync' || issue.joint !== entry.joint) continue
      if (!result.sessions.some(session => session.date === issue.date)) continue
      conflicts.push(conflict('joint-desync', 'warning',
        `联开组 ${entry.joint} 在 ${issue.date} 两校节次不同：${
          Object.entries(issue.periods)
            .map(([school, periods]) => `${SCHOOL_NAMES[school]}第 ${periods.join('/')} 节`)
            .join('，')
        }；学生按${SCHOOL_NAMES[request.school]}第 ${(issue.periods[request.school] ?? []).join('/')} 节执行`, {
          classId: entry.id,
          date: issue.date,
          periods: issue.periods,
        }))
    }
    for (const issue of catalog.issues) {
      if (issue.kind !== 'joint-date-desync' || issue.joint !== entry.joint) continue
      if (!issue.missing?.includes(request.school)) continue
      conflicts.push(conflict('joint-date-missing', 'blocking',
        `联开组 ${entry.joint} 在 ${issue.date} 只有${SCHOOL_NAMES[issue.present]}页面有课，${SCHOOL_NAMES[request.school]}没有对应课节`, {
          classId: entry.id,
          date: issue.date,
        }))
    }
  }

  return { entry, ...result, conflicts }
}

// 目标课节与保留课节落在同一日期同一节次即冲突；冲突带上具体场次。
export function scheduleConflicts(request, core, target, siblingTargets = []) {
  const conflicts = []
  const byOccurrence = new Map()
  for (const session of target.sessions) {
    const key = occurrenceKey(session)
    byOccurrence.set(key, [...(byOccurrence.get(key) ?? []), session])
  }

  for (const [key, list] of byOccurrence) {
    const [date, periodPart] = key.split('#P')
    const period = Number(periodPart)

    if (list.length > 1) {
      conflicts.push(conflict('duplicate-target-session', 'warning',
        `目标课程 ${request.to} 在 ${date} 第 ${period} 节重复出现`, {
          date, period, sessions: list.map(sessionView),
        }))
    }

    for (const { entry, session } of core.sessions) {
      if (occurrenceKey(session) !== key) continue
      conflicts.push(conflict('core-overlap', 'blocking',
        `转课后 ${date} 第 ${period} 节与原班必修「${entry.label ?? entry.id}」冲突`, {
          date,
          period,
          target: list.map(item => ({
            classId: request.to,
            slot: item.slot,
            label: item.label,
            moved: Boolean(item.moved),
            makeup: Boolean(item.makeup),
            originalPeriod: item.originalPeriod,
          })),
          core: [{
            classId: entry.id,
            slot: session.slot,
            label: entry.label,
            held: 'core',
          }],
        }))
    }

    for (const sibling of siblingTargets) {
      if (sibling.request === request) continue
      const hit = sibling.sessions.find(session => occurrenceKey(session) === key)
      if (!hit) continue
      conflicts.push(conflict('same-student-overlap', 'blocking',
        `同一学生在 ${date} 第 ${period} 节同时转入 ${request.to} 与 ${sibling.request.to}`, {
          date,
          period,
          classes: [request.to, sibling.request.to],
        }))
    }
  }
  return conflicts
}

// 调课造成的同场次碰撞，挂到目标课节上。
function movedSessionConflicts(catalog, request, target) {
  const conflicts = []
  const ownIds = new Set([
    target.entry?.id,
    target.entry?.schools?.[request.school]?.slot,
  ].filter(Boolean))

  for (const issue of catalog.issues) {
    if (issue.kind !== 'moved-session-overlap' || issue.school !== request.school) continue
    if (!target.sessions.some(session => session.date === issue.date && session.period === issue.period)) continue
    if (!issue.classes.some(item => ownIds.has(item.id) || ownIds.has(item.slot))) continue
    conflicts.push(conflict('moved-session-overlap', 'warning',
      `调课后 ${issue.date} 第 ${issue.period} 节与「${
        issue.classes
          .filter(item => !ownIds.has(item.id) && !ownIds.has(item.slot))
          .map(item => item.label)
          .join('、') || '其他课程'
      }」同场次`, {
        date: issue.date,
        period: issue.period,
        classes: issue.classes,
      }))
  }
  return conflicts
}

function mergeConflicts(list) {
  return uniqBy(list, item => [
    item.kind, item.date ?? '', item.period ?? '', item.message,
  ].join('\u0000'))
}

// ---------------------------------------------------------------------------
// 门户确认组

// 确认组以「学生 + from + to」对应申请。组内 rows 为空表示门户尚未写出席位，
// 此时用 request 判断这组原本要办什么。
export function matchReceipts(requests, confirmations) {
  const bySignature = new Map(requests.map(request => [changeSignature(request), request]))
  const result = new Map()

  for (const group of confirmations ?? []) {
    const rows = group.rows?.length ? group.rows : (group.request ?? [])
    if (!rows.length) continue
    const matched = rows.map(row => bySignature.get(changeSignature(row))).filter(Boolean)
    if (matched.length !== rows.length) continue
    for (const request of matched) {
      result.set(request.student, {
        group,
        row: group.rows?.find(row => row.student === request.student) ?? null,
        requests: matched,
      })
    }
  }
  return result
}

// 逐校区的同步状态：未生效 vs 未同步，二者不能混为一谈。
export function receiptState(member) {
  if (!member.receipt) return null
  const { group, row } = member.receipt
  const sides = new Set([member.school])
  for (const school of classSides(member.toEntry)) sides.add(school)
  const view = new Set(row?.view ?? [])
  const sideStates = {}

  for (const school of sides) {
    if (!group.effective) {
      sideStates[school] = {
        state: '未生效',
        effective: false,
        synced: false,
        reason: '门户确认组尚未生效，这个课节还没有写入席位',
      }
    } else if (view.has(school)) {
      sideStates[school] = {
        state: '已同步',
        effective: true,
        synced: true,
        reason: `门户确认组已同步到${SCHOOL_NAMES[school]}课表`,
      }
    } else {
      sideStates[school] = {
        state: '未同步',
        effective: true,
        synced: false,
        reason: `门户确认组已记录该生转课，但${SCHOOL_NAMES[school]}课表尚未显示这门共用课`,
      }
    }
  }

  const unsyncedSchools = Object.entries(sideStates)
    .filter(([, value]) => !value.synced)
    .map(([school]) => school)
  const conclusion = !group.effective
    ? (group.pending ? '未生效（等待门户确认）' : '未生效')
    : unsyncedSchools.length === 0 ? '已生效并同步' : '已生效，部分课表未同步'

  return {
    group: group.group,
    effective: Boolean(group.effective),
    pending: Boolean(group.pending),
    view: [...view],
    sides: sideStates,
    unsyncedSchools,
    conclusion,
  }
}

// ---------------------------------------------------------------------------
// 席位预留：未生效/未查清的确认组会同时占住原位和可能已经接收的位置。
// 其他申请只能看到被占住的状态，不能借用。

export function receiptReservations(confirmations, requestsByStudent, catalog) {
  const rows = []
  for (const group of confirmations ?? []) {
    if (group.effective) {
      // 已生效但课表/席位目录还没同步时，目标位置也已经被这组占用。
      for (const row of group.rows ?? []) {
        const request = requestsByStudent.get(row.student)
        if (!request) continue
        const entry = resolveClass(catalog, row.to, request.school)
        const seatId = entry ? seatIdFor(entry, request.school) : row.to
        if (!seatId) continue
        rows.push({
          seatId,
          student: row.student,
          school: request.school,
          reason: '门户确认组已接收，目标席位已被占用',
          group: group.group,
          kind: 'confirmed-target',
        })
      }
      continue
    }
    const entries = group.rows?.length
      ? group.rows
      : (group.request ?? []).map(row => ({ ...row, view: [] }))
    for (const row of entries) {
      const request = requestsByStudent.get(row.student)
      if (!request) continue
      const fromEntry = resolveClass(catalog, row.from, request.school)
      const toEntry = resolveClass(catalog, row.to, request.school)
      const fromSeatId = fromEntry ? seatIdFor(fromEntry, request.school) : row.from
      const toSeatId = toEntry ? seatIdFor(toEntry, request.school) : row.to
      if (fromSeatId) {
        rows.push({
          seatId: fromSeatId,
          student: row.student,
          school: request.school,
          reason: '确认组未生效，原位保留',
          group: group.group,
          kind: 'pending-original',
        })
      }
      if (toSeatId) {
        rows.push({
          seatId: toSeatId,
          student: row.student,
          school: request.school,
          reason: '确认组未生效，可能已经接收的位置保留',
          group: group.group,
          kind: 'pending-target',
        })
      }
    }
  }
  return rows
}

// 提交后暂时看不到回条的组：在查清前同样保留两个位置。
// 只给 student/group 时从转课申请里补出 from/to。
export function unknownReservations(unknowns, requestsByStudent, catalog) {
  return unknowns.flatMap(entry => {
    const request = requestsByStudent.get(entry.student) ?? entry
    if (!request.school) return []
    const fromId = entry.from ?? request.from ?? null
    const toId = entry.to ?? request.to ?? null
    const fromEntry = fromId ? resolveClass(catalog, fromId, request.school) : null
    const toEntry = toId ? resolveClass(catalog, toId, request.school) : null
    const fromSeatId = fromEntry ? seatIdFor(fromEntry, request.school) : fromId
    const toSeatId = toEntry ? seatIdFor(toEntry, request.school) : toId
    const rows = []
    if (fromSeatId) {
      rows.push({
        seatId: fromSeatId,
        student: entry.student,
        school: request.school,
        reason: '提交结果未查清，原位保留',
        group: entry.group ?? null,
        kind: 'unknown-original',
      })
    }
    if (toSeatId) {
      rows.push({
        seatId: toSeatId,
        student: entry.student,
        school: request.school,
        reason: '提交结果未查清，可能已经接收的位置保留',
        group: entry.group ?? null,
        kind: 'unknown-target',
      })
    }
    return rows
  })
}

function seatOverlay(seat, reservations) {
  if (!seat) return seat
  const occupied = [...(seat.occupied ?? [])]
  for (const reservation of reservations) {
    if (reservation.seatId !== seat.id) continue
    if (occupied.some(row => row.student === reservation.student && row.school === reservation.school)) continue
    occupied.push({
      student: reservation.student,
      school: reservation.school,
      reserved: true,
      reason: reservation.reason,
      group: reservation.group ?? null,
    })
  }
  return { ...seat, occupied }
}

// ---------------------------------------------------------------------------
// 单个申请

function analyzeRequest(request, context) {
  const {
    catalog, seatIndex, reservations, now, receipt, siblings = [],
  } = context
  const fromEntry = resolveClass(catalog, request.from, request.school)
  const toEntry = resolveClass(catalog, request.to, request.school)
  const fromSeatId = fromEntry ? seatIdFor(fromEntry, request.school) : request.from ?? null
  const toSeatId = toEntry ? seatIdFor(toEntry, request.school) : request.to ?? null
  const core = coreSessions(catalog, request)
  const target = targetSessions(catalog, request)

  const conflicts = mergeConflicts([
    ...target.conflicts,
    ...scheduleConflicts(request, core, target, siblings),
    ...movedSessionConflicts(catalog, request, target),
  ])
  const issues = []

  if (!fromEntry) {
    issues.push(conflict('from-class-not-listed', 'warning',
      `原课程 ${request.from} 没有出现在本校课表页，释放的席位无法核实`, {
        classId: request.from,
      }))
  }
  if (fromEntry?.schools?.[request.school]?.sessions.some(session => session.held === 'core')) {
    conflicts.push(conflict('core-not-transferable', 'blocking',
      `原课程「${fromEntry.label ?? fromEntry.id}」是原班必修，不能通过转课停止`, {
        classId: fromEntry.id,
      }))
  }
  if (core.missing.length) {
    issues.push(conflict('core-not-listed', 'warning',
      `申请列出的原班课 ${core.missing.join('、')} 在课表页找不到`, {
        missing: core.missing,
      }))
  }
  if (request.from === request.to) {
    issues.push(conflict('no-op', 'warning', '原课程与目标课程相同，不产生变更'))
  }

  const ownReservations = reservations.filter(row => row.student === request.student)
  const foreignReservations = reservations.filter(row => row.student !== request.student)
  const baseSeat = seatIndex.get(toSeatId) ?? null

  const baselineSeat = baseSeat
    ? evaluateSeat(seatOverlay(baseSeat, foreignReservations), {
      school: request.school,
      now,
      channel: request.channel,
    })
    : {
      verdict: 'unmanaged',
      seatId: toSeatId,
      reason: '席位目录没有这个班，按普通课程处理',
    }

  if (baselineSeat.verdict === 'unmanaged' && toEntry) {
    issues.push(conflict('seat-unmanaged', 'warning',
      `目标班 ${toSeatId} 不在席位目录中，如需配额限制请人工核对`, {
        seatId: toSeatId,
      }))
  }

  return {
    student: request.student,
    school: request.school,
    from: request.from,
    to: request.to,
    channel: request.channel,
    fromEntry,
    toEntry,
    fromSeatId,
    toSeatId,
    core: core.sessions,
    coreEntries: core.entries,
    coreMissing: core.missing,
    target,
    conflicts: mergeConflicts(conflicts),
    issues,
    baselineSeat,
    seat: baselineSeat,
    ownReservations,
    receipt: receipt ?? null,
    receiptState: null,
    unknown: null,
    siblings,
  }
}

// ---------------------------------------------------------------------------
// 联动关系

// 只有「目标班现在一个空位都没有，而同批中有人要从这个班转出」才形成
// 释放依赖。放位时间是否已到不影响是否联动，只影响整组是「可办」还是「备选」。
function seatDependencies(items) {
  const edges = new Map(items.map(item => [item.student, []]))
  for (const item of items) {
    const baseline = item.baselineSeat
    if (!baseline || baseline.verdict === 'unmanaged') continue
    if ((baseline.freeTotal ?? 0) > 0) continue
    const providers = items.filter(other => other.student !== item.student
      && other.fromSeatId && other.fromSeatId === item.toSeatId)
    if (!providers.length) continue
    edges.set(item.student, providers.map(provider => provider.student))
  }
  return edges
}

// 组内席位核算。
//
// 一方向依赖的组（sequence）可以让后一项看到前一项释放出来的位置，
// 但两项不能在未确认前互相抵消；只有互换（swap）或同一确认组（receipt）
// 才把两边的释放与占用同时放进同一批。
//
// 已经因为「未生效/未查清」被预留占住的名额不重复计算：那一名学生
// 既不能视为空出来，也不能再被同组另一个人占一次。
function buildGroupMembers(root, group, seatIndex, reservations, now) {
  const seat = seatIndex.get(root.toSeatId)
  const others = group.members.filter(other => other.student !== root.student)
  const reservedOnSeat = new Set(reservations
    .filter(row => row.seatId === root.toSeatId && row.student !== root.student)
    .map(row => row.student))
  const releases = others
    .filter(other => other.fromSeatId && other.fromSeatId === root.toSeatId)
    .filter(other => !reservedOnSeat.has(other.student))
    .map(other => ({ school: other.school, student: other.student }))
  const claims = others
    .filter(other => other.toSeatId === root.toSeatId)
    .filter(other => !reservedOnSeat.has(other.student))
    .map(other => ({ school: other.school, student: other.student }))
  const overlayReservations = reservations.filter(row => row.student !== root.student)

  if (!seat) {
    root.seat = root.baselineSeat
    return
  }
  const applyReleases = group.atomic || group.kind === 'sequence'
  const applyClaims = group.atomic
  const evaluated = evaluateSeat(seatOverlay(seat, overlayReservations), {
    school: root.school,
    now,
    channel: root.channel,
    releases: applyReleases ? releases : [],
    claims: applyClaims ? claims : [],
  })
  evaluated.releasesInGroup = releases.map(row => row.student)
  evaluated.claimsInGroup = claims.map(row => row.student)
  root.seat = evaluated
}

// ---------------------------------------------------------------------------
// 汇总

function verdictFor(member) {
  if (member.receipt?.group?.effective) {
    return member.receiptState?.unsyncedSchools.length ? 'confirmed-unsynced' : 'confirmed'
  }
  if (member.receipt?.group?.pending || member.unknown) return 'pending-receipt'
  if (member.conflicts.some(item => item.severity === 'blocking')) return 'blocked'
  if (SEAT_READY.has(member.seat.verdict)) return 'ready'
  if (SEAT_BACKUP.has(member.seat.verdict)) return 'backup'
  return 'blocked'
}

function actionFor(member, verdict) {
  const seat = member.seat ?? {}
  if (verdict === 'confirmed' || verdict === 'confirmed-unsynced') {
    return { canSubmit: false, reason: '门户已确认，按确认课节交给班主任' }
  }
  if (verdict === 'pending-receipt') {
    return {
      canSubmit: false,
      reason: member.unknown
        ? '提交结果未查清，先核对门户接收记录；未查清前保留原位和可能已接收的位置'
        : '门户回条待生效，保留原课并继续查询确认组',
    }
  }
  if (verdict === 'blocked') {
    return {
      canSubmit: false,
      reason: member.conflicts.find(item => item.severity === 'blocking')?.message ?? seat.reason,
      remedy: seat.verdict === 'channel-mismatch' && seat.allowedChannel
        ? `改用「${seat.allowedChannel}」渠道`
        : null,
    }
  }
  if (verdict === 'backup') {
    return {
      canSubmit: false,
      reason: seat.reason,
      releaseAt: seat.reservedOpenAt ?? null,
      allowedChannel: seat.allowedChannel ?? null,
    }
  }
  return { canSubmit: true, reason: '可以办理' }
}

function memberView(member) {
  const verdict = verdictFor(member)
  const waitFor = (member.baselineSeat && !SEAT_READY.has(member.baselineSeat.verdict)
    && (member.seat?.releasesInGroup?.length || member.seat?.claimsInGroup?.length))
    ? [...new Set(member.seat.releasesInGroup ?? [])]
    : []
  return {
    student: member.student,
    school: member.school,
    from: member.from,
    to: member.to,
    channel: member.channel,
    fromSeatId: member.fromSeatId,
    toSeatId: member.toSeatId,
    verdict,
    classes: {
      from: classView(member.fromEntry),
      to: classView(member.toEntry),
    },
    retainedCore: member.core.map(({ entry, session }) => ({
      classId: entry.id,
      label: entry.label,
      slot: session.slot,
      date: session.date,
      period: session.period,
      held: 'core',
      basis: '原班必修继续有效，不参与转出',
    })),
    targetSessions: member.target.sessions.map(sessionView),
    seat: member.seat,
    seatBasis: seatBasis(member.seat),
    baselineSeat: member.baselineSeat,
    conflicts: member.conflicts,
    issues: member.issues,
    blockingConflict: member.conflicts.find(item => item.severity === 'blocking') ?? null,
    reservations: member.ownReservations,
    receipt: member.receiptState,
    confirmationGroup: member.receipt?.group?.group ?? null,
    action: actionFor(member, verdict),
    waitFor,
    backup: SEAT_BACKUP.has(member.seat?.verdict) ? {
      releaseAt: member.seat.reservedOpenAt ?? null,
      allowedChannel: member.seat.allowedChannel ?? null,
      requestedChannel: member.channel,
      reason: member.seat.reason,
    } : null,
  }
}

function groupStatus(members, atomic) {
  const verdicts = members.map(member => member.verdict)
  const unique = new Set(verdicts)
  if (unique.has('pending-receipt')) return 'pending-receipt'
  if (unique.has('blocked')) {
    return verdicts.some(verdict => verdict === 'ready' || verdict === 'backup')
      ? 'partly-blocked'
      : 'blocked'
  }
  if (unique.has('confirmed') || unique.has('confirmed-unsynced')) {
    return verdicts.every(verdict => verdict === 'confirmed') ? 'confirmed' : 'confirmed-unsynced'
  }
  if (unique.has('backup')) {
    return verdicts.some(verdict => verdict === 'ready') ? 'partly-ready' : 'backup'
  }
  if (atomic) return verdicts.every(verdict => verdict === 'ready') ? 'ready' : 'blocked'
  return 'ready'
}

function groupKind(members, edges, receiptGroups) {
  if (receiptGroups.length) return 'receipt'
  if (members.length < 2) return 'single'
  return hasCycle(members.map(member => member.student), edges) ? 'swap' : 'sequence'
}

function submitList(group, members) {
  if (group.kind === 'receipt') return []
  const ready = members.filter(member => member.verdict === 'ready').map(member => member.student)
  if (!ready.length) return []
  if (group.atomic) return ready.length === members.length ? [...group.students] : []
  if (group.kind === 'sequence') {
    return members
      .filter(member => member.verdict === 'ready' && (member.waitFor ?? []).length === 0)
      .map(member => member.student)
  }
  return ready
}

export function buildPlan(snapshot, options = {}) {
  const catalog = options.catalog ?? buildCatalog(snapshot)
  const confirmations = snapshot.confirmations ?? []
  const allRequests = snapshot.changes?.requests ?? []
  const wanted = options.students ? new Set(options.students) : null
  const requests = allRequests.filter(request => !wanted || wanted.has(request.student))
  const requestsByStudent = new Map(allRequests.map(request => [request.student, request]))
  const now = options.now ?? snapshot.changes?.now ?? null
  const seatIndex = options.seatIndex ?? indexSeats(snapshot.seats)

  // 确认组可能在本批之前就已存在；匹配时用全部申请，避免只看子集时丢失回条。
  const receiptMatches = matchReceipts(allRequests, confirmations)

  const unknowns = (options.unknownSubmissions ?? [])
    .filter(entry => !wanted || wanted.has(entry.student))
    .filter(entry => {
      // 已经有确认组记录的，以确认组为准，不再算「未查清」。
      const request = requestsByStudent.get(entry.student) ?? entry
      if (!request?.from) return true
      return !receiptMatches.has(entry.student)
    })
  const unknownByStudent = new Map(unknowns.map(entry => [entry.student, entry]))

  const reservations = uniqBy([
    ...receiptReservations(confirmations, requestsByStudent, catalog),
    ...unknownReservations(unknowns, requestsByStudent, catalog),
    ...(options.reservations ?? []),
  ], row => [row.seatId, row.student, row.kind].join('\u0000'))

  const requestsByStudentForSiblings = new Map()
  for (const request of requests) {
    requestsByStudentForSiblings.set(request.student,
      [...(requestsByStudentForSiblings.get(request.student) ?? []), request])
  }

  const items = requests.map(request => {
    const siblings = requestsByStudentForSiblings.get(request.student)
      .filter(other => other !== request)
      .map(other => ({ request: other, sessions: targetSessions(catalog, other).sessions }))
    const item = analyzeRequest(request, {
      catalog,
      seatIndex,
      reservations,
      now,
      receipt: receiptMatches.get(request.student) ?? null,
      siblings,
    })
    item.receiptState = receiptState(item)
    if (unknownByStudent.has(request.student) && !item.receipt) {
      item.unknown = unknownByStudent.get(request.student)
    }
    return item
  })

  const edges = seatDependencies(items)
  const disjoint = makeUnionFind(items.map(item => item.student))
  const { find, union } = disjoint
  for (const [student, next] of edges) for (const other of next) union(student, other)

  // 同一个门户确认组内的学生必须整组核对，不能拆开。
  const receiptGroupsByKey = new Map()
  for (const item of items) {
    const group = item.receipt?.group
    if (!group) continue
    receiptGroupsByKey.set(group.group,
      [...(receiptGroupsByKey.get(group.group) ?? []), item.student])
  }
  for (const students of receiptGroupsByKey.values()) {
    for (let index = 1; index < students.length; index++) union(students[0], students[index])
  }
  // 同一组的未查清提交也整组保留。
  const unknownGroups = new Map()
  for (const item of items) {
    if (!item.unknown) continue
    const key = item.unknown.group ?? `UNKNOWN-${item.student}`
    unknownGroups.set(key, [...(unknownGroups.get(key) ?? []), item.student])
  }
  for (const students of unknownGroups.values()) {
    for (let index = 1; index < students.length; index++) union(students[0], students[index])
  }

  // 同一学生的多条申请必须一起核对，否则同名学生会出现在两组里，
  // 提交时互相踩位置。与席位依赖共用同一个并查集。
  const identity = makeUnionFind(items.map(item => item.student))
  for (const item of items) for (const sibling of item.siblings) {
    identity.union(item.student, sibling.request.student)
  }
  const components = new Map()
  for (const item of items) {
    const key = find(item.student)
    components.set(key, [...(components.get(key) ?? []), item])
  }

  const groups = [...components.values()].map(rawMembers => {
    const members = rawMembers.slice().sort((a, b) => a.student.localeCompare(b.student))
    const students = [...new Set(members.map(member => member.student))]
    const receiptGroups = uniqBy(members
      .map(member => member.receipt?.group)
      .filter(Boolean), group => group.group)
    // 同一学生的多条申请在门户里也是一个确认组，不能拆开提交。
    const sameStudent = new Set(members.map(member => member.student)).size < members.length
    const kind = sameStudent && members.length > 1
      ? 'linked'
      : groupKind(members, edges, receiptGroups)
    const cyclic = kind === 'swap'
    const group = {
      key: `GRP-${students.join('-')}`,
      students,
      members,
      kind,
      atomic: cyclic || sameStudent || receiptGroups.length > 0
        || members.some(member => member.unknown),
      dependencies: Object.fromEntries(members
        .map(member => [member.student,
          (edges.get(member.student) ?? []).filter(next => !students.includes(next))])
        .filter(([, next]) => next.length)),
    }
    for (const member of members) buildGroupMembers(member, group, seatIndex, reservations, now)
    return group
  }).sort((left, right) => left.students[0].localeCompare(right.students[0]))

  const groupViews = groups.map(group => {
    const members = group.members.map(member => ({
      ...memberView(member),
      group: group.key,
    }))
    const status = groupStatus(members, group.atomic)
    const submit = submitList(group, members)
    // 整组/先后关系会让本来「个人可办」的申请暂缓：以组级提交清单为准，
    // 避免把等待对方释放的申请单独提交出去。
    for (const member of members) {
      if (submit.includes(member.student)) continue
      if (!member.action.canSubmit) continue
      member.action = {
        ...member.action,
        canSubmit: false,
        reason: group.atomic
          ? '整组条件未同时成立，不能单独提交这一条'
          : group.kind === 'sequence'
            ? '需等前一项释放席位后再办'
            : member.action.reason,
      }
    }
    const actionable = members.filter(member => member.action.canSubmit)
    const independent = group.atomic ? [] : actionable.map(member => member.student)
    const keepOriginal = group.atomic && status !== 'ready' && status !== 'confirmed'
      && status !== 'confirmed-unsynced'
      ? [...group.students]
      : members
        .filter(member => member.verdict !== 'ready' && !member.verdict.startsWith('confirmed'))
        .map(member => member.student)
    const receiptGroups = uniqBy(members.map(member => member.receipt).filter(Boolean),
      receipt => receipt.group)

    return {
      key: group.key,
      students: group.students,
      kind: group.kind,
      atomic: group.atomic,
      status,
      members,
      dependencies: group.dependencies,
      conflicts: mergeConflicts(members.flatMap(member => member.conflicts)),
      issues: mergeConflicts(members.flatMap(member => member.issues)),
      blockingConflicts: members
        .map(member => member.blockingConflict)
        .filter(Boolean),
      actionable: actionable.map(member => member.student),
      independent,
      submit,
      keepOriginal: [...new Set(keepOriginal)],
      blocked: members.filter(member => member.verdict === 'blocked').map(member => member.student),
      backup: members.filter(member => member.verdict === 'backup').map(member => member.student),
      pending: members.filter(member => member.verdict === 'pending-receipt').map(member => member.student),
      receipts: receiptGroups.map(receipt => ({
        group: receipt.group,
        effective: receipt.effective,
        pending: receipt.pending,
        conclusion: receipt.conclusion,
        sides: receipt.sides,
        unsyncedSchools: receipt.unsyncedSchools,
      })),
      note: group.kind === 'linked'
        ? '同一学生的多条申请互相关联，必须一起核对，不能只提交其中一条。'
        : group.kind === 'receipt'
        ? '这组由门户确认组关联，必须整组核对；未查清前保留原位和可能已经接收的位置。'
        : group.kind === 'swap'
          ? '同批互换：只有两边都释放或都可借用时整组才成立；任一不成立时整组保留原课。'
          : group.kind === 'sequence'
            ? '后一项依赖前一项释放的席位，应按先后顺序办理。'
            : null,
    }
  })

  const students = groupViews.flatMap(group => group.members)
  const summary = {
    students: [...new Set(requests.map(request => request.student))],
    requests: requests.length,
    groups: groupViews.length,
    atomicGroups: groupViews.filter(group => group.atomic).length,
    ready: students.filter(member => member.verdict === 'ready').length,
    backup: students.filter(member => member.verdict === 'backup').length,
    blocked: students.filter(member => member.verdict === 'blocked').length,
    pending: students.filter(member => member.verdict === 'pending-receipt').length,
    confirmed: students.filter(member => member.verdict === 'confirmed').length,
    confirmedUnsynced: students.filter(member => member.verdict === 'confirmed-unsynced').length,
  }

  return {
    now,
    source: {
      seatsVersion: snapshot.seats?.version ?? null,
      stale: snapshot.stale ?? {},
      confirmations: confirmations.length,
      anchorDates: {
        east: snapshot.east?.anchorDate ?? null,
        west: snapshot.west?.anchorDate ?? null,
      },
    },
    summary,
    groups: groupViews,
    students,
    independent: groupViews
      .filter(group => !group.atomic)
      .flatMap(group => group.submit)
      .filter(student => students.find(member => member.student === student)?.verdict === 'ready'),
    backups: students.filter(member => member.verdict === 'backup'),
    blocked: students.filter(member => member.verdict === 'blocked'),
    pending: students.filter(member => member.verdict === 'pending-receipt'),
    confirmed: students.filter(member => member.verdict.startsWith('confirmed')),
    reservations,
    catalog: {
      classes: [...catalog.classes.values()].map(classView),
      moves: catalog.moves,
      issues: catalog.issues,
      ambiguous: catalog.ambiguous,
    },
  }
}

export {
  seatOverlay,
  SEAT_READY,
  SEAT_BACKUP,
  groupStatus,
  groupKind,
  submitList,
}
