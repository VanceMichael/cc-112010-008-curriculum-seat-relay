// 现场核对与提交。
//
// 教务员填报前后都要从门户重新验证：日历、配额、确认组可能已经变化。
// 正式确认之前如果遇到新调课、席位被现场录入，就要把整组拆成「仍可以
// 独立办理」的申请；必须联动的申请保留原课，冲突定位到具体场次。
//
// 提交结果有三种可能：
//   * 门户返回 409：整组没有写入任何席位，可以按原样调整后重试；
//   * 门户返回 200：拿到该组回条，但回条可能先于学校课表同步；
//   * 门户不可读 / 暂时看不到回条：先核对实际接收记录，查清前为这组
//     同时保留原位和可能已经接收的位置。

import { snapshot, postEnroll } from './fetch.mjs'
import { buildCatalog, resolveClass as resolveClassFrom } from './catalog.mjs'
import { indexSeats } from './seats.mjs'
import { buildPlan } from './plan.mjs'
import { buildHandover } from './handover.mjs'
import { changeSignature } from './plan.mjs'


// 把一份原始 snapshot 固定成「计划/课表都能复用」的结构。
export function sealSnapshot(raw, options = {}) {
  const catalog = options.catalog ?? buildCatalog(raw)
  const seatIndex = options.seatIndex ?? indexSeats(raw.seats)
  return { ...raw, catalog, seatIndex }
}

export function prepare(raw, options = {}) {
  const sealed = raw.catalog && raw.seatIndex ? raw : sealSnapshot(raw)
  const plan = buildPlan(sealed, options.plan ?? { students: options.students })
  const handover = buildHandover(sealed, plan, sealed.catalog, sealed.seatIndex)
  return { snapshot: sealed, plan, handover }
}

// 与上一次核对相比，整组是否仍能按原样提交。返回新增的阻碍，供逐项复查。
export function revalidate(sealed, plan, options = {}) {
  const students = options.students ?? plan.summary.students
  const next = buildPlan(sealed, { ...(options.plan ?? {}), students })
  const changes = []
  for (const group of plan.groups) {
    if (!group.students.every(student => students.includes(student))) continue
    const updated = next.groups.find(candidate =>
      candidate.students.length === group.students.length
      && candidate.students.every((student, index) => student === group.students[index]))
    if (!updated) {
      changes.push({
        group: group.key,
        kind: 'group-disappeared',
        message: '核对后这组申请在来源中已不存在，需要重新填报',
      })
      continue
    }
    if (updated.status !== group.status) {
      changes.push({
        group: group.key,
        from: group.status,
        to: updated.status,
        message: `核对后状态由「${group.status}」变为「${updated.status}」`,
      })
    }
  }
  return { plan: next, changes, canSubmit: next.groups
    .filter(group => group.status === 'ready')
    .map(group => group.students) }
}

// 重新读来源后再核对；只读一次，计划和课表共用同一份。
export async function revalidateFrom(base, plan, options = {}) {
  const refreshed = await refresh(base, options.previous ?? null, options)
  const result = revalidate(refreshed.prepared.snapshot, plan, options)
  return { ...refreshed.prepared, ...result }
}

// 提交前的最后一道：把整组拆成仍可独立办理的申请，联动项保留原课。
export function splitIndependent(plan, students) {
  const chosen = new Set(students)
  const independent = []
  const kept = []
  for (const group of plan.groups) {
    if (!group.students.some(student => chosen.has(student))) continue
    const members = group.members.filter(member => chosen.has(member.student))
    if (group.atomic) {
      kept.push({
        group: group.key,
        students: members.map(member => member.student),
        reason: group.note ?? '这组必须联动提交，任一项不成立时整组保留原课',
        conflicts: group.blockingConflicts,
      })
      continue
    }
    for (const member of members) {
      if (member.verdict === 'ready') {
        independent.push({ group: group.key, student: member.student, from: member.from, to: member.to })
      } else {
        kept.push({
          group: group.key,
          students: [member.student],
          reason: member.action.reason,
          conflicts: member.blockingConflict ? [member.blockingConflict] : [],
        })
      }
    }
  }
  return { independent, kept }
}

export function payloadFor(students, plan, version) {
  const changes = students
    .map(student => plan.students.find(member => member.student === student))
    .filter(Boolean)
    .map(member => ({ student: member.student, from: member.from, to: member.to }))
    .sort((left, right) => left.student.localeCompare(right.student))
  return { version, changes }
}

// 开提交前先刷新来源；缺哪一项都要在结果里说清楚，不能悄悄用旧数据。
export async function refresh(base, previous, options = {}) {
  const next = await snapshot(base, previous, options.fetch)
  const sealed = sealSnapshot(next)
  return { snapshot: sealed, prepared: prepare(sealed, options.prepare) }
}

// 提交一组并立刻核对回条。
// 返回 state:
//   'confirmed' 门户接受且确认组已生效
//   'pending'   门户已登记但未生效
//   'unknown'   门户不可读或暂时看不到回条，必须按「未查清」处理
//   'rejected'  门户拒绝整组，未写入任何席位
export async function submitGroup(base, group, options = {}) {
  const { plan, snapshot: current, fetchOptions = {} } = options
  const payload = payloadFor(group, plan, current.seats?.version)
  const response = await postEnroll(base, payload, fetchOptions)
  const body = response.body ?? {}
  const result = {
    request: payload,
    status: response.status,
    reception: body.state ?? null,
    group: body.group ?? null,
    version: body.version ?? null,
    receivedChanges: payload.changes,
  }

  if (response.status === 409) {
    return {
      ...result,
      state: 'rejected',
      message: body.state ?? '门户拒绝整组，没有写入任何席位',
      retainedOriginal: payload.changes.map(change => change.student),
      note: '整组未成立，原课继续；可按冲突说明调整后重新填报。',
    }
  }

  // 404 表示门户没有这项表单组合：这次提交很可能根本没有被接收，
  // 但在核对确认组之前仍按「未查清」保留位置，避免和别的申请抢同一格。
  if (response.status === 404) {
    const receipt = await lookupReceipt(base, payload.changes, {
      fetchOptions,
      previous: current,
      plan,
    })
    if (receipt.found) {
      const confirmed = receipt.group.effective
      return {
        ...result,
        state: confirmed ? 'confirmed' : 'pending',
        group: receipt.group.group,
        rows: receipt.group.rows,
        receipt: receipt.group,
        sync: receipt.sync,
        unsyncedSchools: receipt.unsyncedSchools,
        message: '门户虽未接受这次表单，但确认组里已有这组记录',
        note: confirmed
          ? '按门户实际记录处理；未同步的课表要单独标出。'
          : '门户登记尚未生效，保留原课并继续查询确认组。',
      }
    }
    return {
      ...result,
      state: 'unknown',
      message: body.原因 ?? '门户没有这项表单组合，提交结果未查清',
      retainedOriginal: payload.changes.map(change => change.student),
      reservedUnknown: payload.changes.map(change => change.student),
      note: '门户很可能没有接收这次提交；核对确认组之前，这组仍占住原位与目标位。',
      lookup: receipt,
    }
  }

  if (response.status !== 200) {
    return {
      ...result,
      state: 'unknown',
      message: body.state ?? `门户返回 ${response.status}，提交结果未查清`,
      retainedOriginal: payload.changes.map(change => change.student),
      reservedUnknown: payload.changes.map(change => change.student),
      note: '不得据此重试或让其他申请占用这组的位置；先查询门户实际接收记录。',
    }
  }

  const receipt = await lookupReceipt(base, payload.changes, {
    group: body.group ?? null,
    fetchOptions,
    previous: current,
    plan,
  })
  if (!receipt.found) {
    return {
      ...result,
      state: 'unknown',
      message: '门户接受了提交，但暂时读不到回条',
      retainedOriginal: payload.changes.map(change => change.student),
      reservedUnknown: payload.changes.map(change => change.student),
      note: '查清前同时保留原位和可能已经接收的位置。',
      lookup: receipt,
    }
  }

  const confirmed = receipt.group.effective
  return {
    ...result,
    state: confirmed ? 'confirmed' : 'pending',
    group: receipt.group.group,
    rows: receipt.group.rows,
    receipt: receipt.group,
    sync: receipt.sync,
    unsyncedSchools: receipt.unsyncedSchools,
    message: confirmed ? '门户确认组已生效' : '门户已登记，尚未生效',
    note: confirmed
      ? '按确认的课节交给班主任；未同步的课表要单独标出。'
      : '回条仍是 pending，保留原转课组，尚无生效席位。',
  }
}

// 查询门户实际接收记录：按「学生 + from + to」核对，不按提交顺序猜。
// previous 用于在上一次资料仍可沿用；单次读不到 404 不代表回条被撤回。
export async function lookupReceipt(base, changes, options = {}) {
  const raw = await snapshot(base, options.previous ?? null, options.fetchOptions)
  const confirmations = raw.confirmations ?? []
  const wanted = new Set(changes.map(changeSignature))
  const candidates = confirmations.filter(group => {
    const rows = group.rows?.length ? group.rows : (group.request ?? [])
    if (!rows.length) return false
    const actual = new Set(rows.map(changeSignature))
    if (actual.size !== wanted.size) return false
    for (const signature of wanted) if (!actual.has(signature)) return false
    return true
  })
  if (!candidates.length) {
    return {
      found: false,
      group: null,
      confirmations,
      message: '门户目录里还没有这组回条，不能按已接收处理',
    }
  }
  const group = candidates.find(candidate => candidate.effective)
    ?? candidates.find(candidate => candidate.pending)
    ?? candidates[0]
  const sync = group.effective ? syncPerStudent(group, options.plan, raw) : {}
  return {
    found: true,
    group,
    candidates,
    sync,
    unsyncedSchools: [...new Set(Object.values(sync).flatMap(row => row.unsyncedSchools))],
  }
}

// 每个学生逐校区：已同步 / 未同步。只列出课表上真实会出现这门课的学校。
function syncPerStudent(group, plan, raw) {
  const catalog = buildCatalog(raw)
  const result = {}
  for (const row of group.rows ?? []) {
    const member = plan?.students.find(item => item.student === row.student)
    const toEntry = resolveClassFrom(catalog, row.to, member?.school)
    const school = member?.school
    const sides = new Set()
    if (school && toEntry?.schools?.[school]) sides.add(school)
    if (toEntry?.joint && toEntry.shared) {
      for (const side of Object.keys(toEntry.schools)) sides.add(side)
    }
    const view = new Set(row.view ?? [])
    const unsyncedSchools = [...sides].filter(side => !view.has(side))
    result[row.student] = {
      group: group.group,
      sides: Object.fromEntries([...sides].map(side => [side, {
        state: view.has(side) ? '已同步' : '未同步',
        effective: true,
        synced: view.has(side),
      }])),
      unsyncedSchools,
    }
  }
  return result
}

export { changeSignature }
