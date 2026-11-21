// 校历换算：学周 × 星期 → 具体日期。
//
// 两校各自编学周（东校第 12 周与西校第 11 周可能指同一批日期），
// 只要页面 <time data-week datetime="周一日期"> 指向同一天，就是同一周。
// 所有课节冲突都必须先落到「日期 + 节次」上再比较。

const DAY_MS = 24 * 60 * 60 * 1000

export function parseDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new TypeError(`无法识别的日期：${isoDate}`)
  return date
}

export function formatDay(date) {
  return date.toISOString().slice(0, 10)
}

export function mondayOf(isoDate) {
  const date = parseDay(isoDate)
  const offset = (date.getUTCDay() + 6) % 7
  return formatDay(new Date(date.getTime() - offset * DAY_MS))
}

export function addDays(isoDate, days) {
  return formatDay(new Date(parseDay(isoDate).getTime() + days * DAY_MS))
}

// anchorWeek 是页面标出的学周；anchorDate 是该周的周一。data-day 从 1 起。
export function occurrenceDate(anchorDate, anchorWeek, week, day) {
  if (!Number.isInteger(week) || !Number.isInteger(day) || day < 1 || day > 7) {
    throw new TypeError(`学周或星期不合法：${week}/${day}`)
  }
  return addDays(anchorDate, (week - anchorWeek) * 7 + (day - 1))
}

export function compareOccurrence(left, right) {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1
  return (left.period ?? 0) - (right.period ?? 0)
}

export function occurrenceKey({ date, period }) {
  return `${date}#P${period}`
}

// 页面时间是带时区的绝对时刻（+08:00），不能依赖服务器本地时区。
export function instant(isoString) {
  if (isoString === null || isoString === undefined || isoString === '') return null
  const date = new Date(isoString)
  return Number.isNaN(date.getTime()) ? null : date
}
