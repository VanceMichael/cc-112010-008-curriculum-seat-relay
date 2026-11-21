// 席位核算。
//
// /seats 的 common[] 是每班的容量、分校配额与放位记录：
//   total          班级总席位
//   allocation     各校分到的配额（班级只对这些学校开放）
//   occupied       已落位学生及其学校
//   reservedOpenAt 未用预留的开放时刻
//   allowedChannel 可申领未用预留的申请渠道
//
// 规则：
// - 本校配额还有空位，可以直接用。
// - 本校配额用完、班级仍有空位时，空位属于其他学校或未分配的公共预留；
//   借用必须等 reservedOpenAt 已过，且申请渠道等于 allowedChannel。
//   没到时间 → 备选（候补）；渠道不符或没有放位记录 → 不能代办。
// - 同批互换要看两边释放后的配额，不能只看当前空位。

import { SCHOOL_NAMES } from './catalog.mjs'

export const SEAT_READY = new Set(['available', 'available-swap', 'available-reserved', 'unmanaged'])
export const SEAT_BACKUP = new Set(['reserved-closed'])
export const SEAT_BLOCKED = new Set([
  'full', 'quota-exhausted', 'not-open-to-school', 'channel-mismatch', 'contended',
])

export function seatIdFor(entry, school) {
  if (!entry) return null
  if (entry.joint) return entry.joint
  return entry.schools?.[school]?.slot ?? entry.id
}

export function indexSeats(seatsPayload) {
  const map = new Map()
  for (const seat of seatsPayload?.seats ?? []) map.set(seat.id, seat)
  return map
}

function countBySchool(rows) {
  const counts = {}
  for (const row of rows) {
    if (!row.school) continue
    counts[row.school] = (counts[row.school] ?? 0) + 1
  }
  return counts
}

function gateFor(seat, now, channel) {
  if (!seat.reservedOpenAt) {
    return {
      verdict: 'not-open-to-school',
      gate: 'no-release',
      reason: '该班没有放位记录，不能借用其他学校的配额',
    }
  }
  const moment = now instanceof Date ? now : new Date(now)
  if (!now || Number.isNaN(moment.getTime()) || moment.getTime() < new Date(seat.reservedOpenAt).getTime()) {
    return {
      verdict: 'reserved-closed',
      gate: 'not-yet-open',
      releaseAt: seat.reservedOpenAt,
      reason: `未用预留要到 ${new Date(seat.reservedOpenAt).toISOString()} 才开放，现在只能作为备选`,
    }
  }
  if (seat.allowedChannel && channel !== seat.allowedChannel) {
    return {
      verdict: 'channel-mismatch',
      gate: 'channel',
      reason: `未用预留只接受「${seat.allowedChannel}」渠道，本次申请渠道为${channel ? `「${channel}」` : '空'}`,
    }
  }
  return {
    verdict: 'available-reserved',
    gate: 'open',
    reason: '放位时间已到且渠道相符，可以借用其他学校或公共的未用预留',
  }
}

// 同一名学生不能重复占位：同一容量里可能有原始 occupied 与预留叠加。
function dedupeOccupied(rows) {
  const seen = new Set()
  return rows.filter(row => {
    const key = `${row.student}\u0000${row.school}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function schoolFreeMap(seat, { releases = [], claims = [] } = {}) {
  const occupied = countBySchool(dedupeOccupied(seat.occupied ?? []))
  const released = countBySchool(releases)
  const claimed = countBySchool(claims)
  const schools = new Set([
    ...Object.keys(seat.allocation ?? {}),
    ...Object.keys(occupied),
    ...Object.keys(released),
    ...Object.keys(claimed),
  ])
  return Object.fromEntries([...schools].map(school => [school,
    (seat.allocation?.[school] ?? 0) - (occupied[school] ?? 0)
    + (released[school] ?? 0) - (claimed[school] ?? 0)]))
}

// releases: 同批中离开本班的其他申请；claims: 同批中同时申请本班的其他申请。
export function evaluateSeat(seat, { school, now, channel = null, releases = [], claims = [] } = {}) {
  if (!seat) {
    return {
      verdict: 'unmanaged',
      seatId: null,
      reason: '席位目录没有这个班，需人工核对是否受容量限制',
    }
  }

  const shownOccupied = dedupeOccupied(seat.occupied ?? [])
  const freeBySchool = schoolFreeMap({ ...seat, occupied: shownOccupied }, { releases, claims })
  const baselineFreeBySchool = schoolFreeMap({ ...seat, occupied: shownOccupied })
  const rawOwnFree = Math.max(0, freeBySchool[school] ?? 0)
  const baselineOwnFree = Math.max(0, baselineFreeBySchool[school] ?? 0)
  const freeTotal = seat.total - shownOccupied.length + releases.length - claims.length
  const allocatedTotal = Object.values(seat.allocation ?? {}).reduce((sum, value) => sum + (value ?? 0), 0)
  const commonReserve = Math.max(0, seat.total - allocatedTotal)
  // 总席位是硬约束：本校配额与别校余量都不能超过实际空位。
  const ownFree = Math.max(0, Math.min(rawOwnFree, freeTotal))
  const rawOtherFree = Object.entries(freeBySchool)
    .filter(([other]) => other !== school)
    .reduce((sum, [, value]) => sum + Math.max(0, value), 0) + commonReserve
  const otherFree = Math.max(0, Math.min(rawOtherFree, freeTotal - ownFree))
  const otherReserved = Math.max(0, Math.min(
    Object.entries(baselineFreeBySchool)
      .filter(([other]) => other !== school)
      .reduce((sum, [, value]) => sum + Math.max(0, value), 0) + commonReserve,
    freeTotal,
  ))
  const ownQuota = seat.allocation?.[school] ?? 0
  const hasAllocation = ownQuota > 0

  const detail = {
    seatId: seat.id,
    total: seat.total,
    occupied: shownOccupied.length,
    allocation: { ...(seat.allocation ?? {}) },
    freeTotal,
    freeSchool: ownFree,
    freeBySchool,
    ownAllocated: hasAllocation,
    commonReserve,
    otherFree,
    otherReserved,
    reservedOpenAt: seat.reservedOpenAt,
    allowedChannel: seat.allowedChannel,
    channel,
    releases: releases.length,
    claims: claims.length,
    releaseStudents: releases.map(row => row.student).filter(Boolean),
    claimStudents: claims.map(row => row.student).filter(Boolean),
  }

  if (ownFree > 0) {
    return {
      ...detail,
      verdict: releases.length && baselineOwnFree <= 0 ? 'available-swap' : 'available',
      basis: releases.length && baselineOwnFree <= 0 ? '同批释放的本校配额' : '本校配额',
      bySwap: baselineOwnFree <= 0,
      reason: baselineOwnFree > 0
        ? '本校仍有空配额'
        : '同批另一人先释放了本校配额，腾出位置',
    }
  }

  if (freeTotal > 0 && ownQuota <= 0) {
    return {
      ...detail,
      verdict: 'not-open-to-school',
      basis: '无本校配额',
      reason: `该班只向协作学校开放，${SCHOOL_NAMES[school] ?? school}没有配额`,
    }
  }

  if (freeTotal > 0 && (otherFree > 0 || commonReserve > 0)) {
    const gate = gateFor(seat, now, channel)
    return {
      ...detail,
      ...gate,
      basis: otherFree > 0 ? '其他学校未用配额' : '未分配的公共预留',
      usesOtherQuota: otherFree > 0,
      usesCommonReserve: otherFree <= 0 && commonReserve > 0,
      bySwap: baselineOwnFree <= 0 && releases.length > 0,
      schoolLabel: SCHOOL_NAMES[school] ?? school,
    }
  }

  if (freeTotal > 0) {
    return {
      ...detail,
      verdict: 'quota-exhausted',
      basis: '本校配额',
      bySwap: false,
      reason: '本校配额已满，总席位虽有空余但都记在其他学校名下，且没有可借的放位记录',
    }
  }

  if (claims.length > 0 && releases.length > 0) {
    return { ...detail, verdict: 'contended', reason: '同批释放出的席位已被另一个申请占用' }
  }

  return {
    ...detail,
    verdict: hasAllocation ? 'full' : 'not-open-to-school',
    reason: hasAllocation
      ? '班级没有空席位；同批释放后仍不足'
      : `该班只向协作学校开放，${SCHOOL_NAMES[school] ?? school}没有配额`,
  }
}

export function seatCategory(verdict) {
  if (SEAT_READY.has(verdict)) return 'ready'
  if (SEAT_BACKUP.has(verdict)) return 'backup'
  if (SEAT_BLOCKED.has(verdict)) return 'blocked'
  return 'unknown'
}

// 交给班主任的订位依据：只写事实，不写推断。
// 入参既可以是原始席位，也可以是 evaluateSeat 的结果。
export function seatBasis(seat) {
  if (!seat) return null
  const basis = {
    seatId: seat.id ?? seat.seatId ?? null,
    total: seat.total,
    allocation: { ...(seat.allocation ?? {}) },
    reservedOpenAt: seat.reservedOpenAt ?? null,
    allowedChannel: seat.allowedChannel ?? null,
    verdict: seat.verdict ?? null,
  }
  if (Array.isArray(seat.occupied)) {
    basis.occupied = seat.occupied.map(row => ({ ...row }))
    basis.occupiedCount = seat.occupied.length
  } else {
    basis.occupiedCount = seat.occupied ?? null
  }
  if (seat.freeBySchool) basis.freeBySchool = { ...seat.freeBySchool }
  if (seat.releaseStudents?.length) {
    basis.releasedBy = [...seat.releaseStudents]
  }
  return basis
}
