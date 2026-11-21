// 读取两校页面、席位目录、调课表与录取门户确认组。
// 这些资料在每次发布中可能只出现一部分，未出现的地址沿用它上一轮的
// 内容——读取方不能把一次 404 当作「业务上撤回」。

import { load } from 'cheerio'
import { occurrenceDate, instant } from './calendar.mjs'

function integer(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label}不是正整数：${value}`)
  return number
}

// 解析一校的课表页：校历锚点、常课行、调课条目。
export function parseSchoolPage(html, school) {
  const $ = load(html)
  const anchor = $('time[data-week]').first()
  const anchorWeek = integer(anchor.attr('data-week'), '校历学周')
  const anchorDate = anchor.attr('datetime')
  if (!anchorDate) throw new TypeError('校历缺少周一日期')

  const rows = []
  $('table tr[data-slot]').each((_, element) => {
    const row = $(element)
    const week = integer(row.attr('data-week'), '课程学周')
    const day = integer(row.attr('data-day'), '课程星期')
    const period = integer(row.attr('data-period'), '课程节次')
    rows.push({
      school,
      slot: row.attr('data-slot'),
      label: row.find('td').first().text().trim() || row.attr('data-slot'),
      joint: row.attr('data-joint') ?? null,
      held: row.attr('data-held') ?? null,
      week,
      day,
      period,
      date: occurrenceDate(anchorDate, anchorWeek, week, day),
    })
  })

  // 调课条目只覆盖所指日期、原课节与课程展示号；不动常课行本身。
  // 调课节点的 data-slot 是学校内部编号，与常课行同一编号体系对应。
  const moves = []
  $('[data-slot][data-date][data-new-period]').each((_, element) => {
    const node = $(element)
    const slot = node.attr('data-slot')
    const date = node.attr('data-date')
    const newPeriod = integer(node.attr('data-new-period'), '调课后节次')
    const original = rows.find(row => row.slot === slot && row.date === date) ?? null
    moves.push({
      school,
      slot,
      date,
      fromPeriod: original?.period ?? null,
      newPeriod,
      joint: original?.joint ?? null,
      label: node.text().trim() || original?.label || slot,
      note: node.attr('data-note') ?? null,
    })
  })

  return { school, anchorWeek, anchorDate, rows, moves }
}

// 席位目录：common 是联开/共用班，occupied 是已落位学生。
// reservedOpenAt 未到之前，未用预留不能借给任何渠道。
export function parseSeats(payload) {
  const version = payload?.version
  const seats = (payload?.common ?? []).map(seat => ({
    id: seat.id,
    total: seat.total,
    allocation: { ...(seat.allocation ?? {}) },
    occupied: (seat.occupied ?? []).map(row => ({ student: row.student, school: row.school })),
    reservedOpenAt: instant(seat.reservedOpenAt),
    allowedChannel: seat.allowedChannel ?? null,
  }))
  return { version, seats }
}

export function parseChanges(payload) {
  return {
    now: instant(payload?.now),
    requests: (payload?.requests ?? []).map(request => ({
      student: request.student,
      school: request.school,
      from: request.from,
      to: request.to,
      core: [...(request.core ?? [])],
      channel: request.channel ?? null,
    })),
  }
}

// 确认组：rows 为空且 pending 表示门户还没写出任何席位。
// 生效与否看 effective；view 只说明已经同步到哪些界面。
export function parseConfirmations(payload) {
  return (Array.isArray(payload) ? payload : []).map(group => ({
    group: group.group,
    effective: group.effective === true,
    pending: group.pending === true,
    rows: (group.rows ?? []).map(row => ({
      student: row.student,
      from: row.from,
      to: row.to,
      view: [...(row.view ?? [])],
    })),
    request: group.request === undefined ? null
      : (group.request ?? []).map(row => ({ student: row.student, from: row.from, to: row.to })),
  }))
}
