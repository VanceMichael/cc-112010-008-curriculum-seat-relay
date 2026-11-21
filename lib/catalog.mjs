// 把两校页面合成一份「课程目录」：联开课、常课、调课后的实际场次。
//
// 关键约定：
// - 只有两校页面都明确写出同一个 data-joint 时，才把课程当作跨校联开、
//   席位才可能共用。课程名相同、节次相同都不足以合并。
// - 调课条目只覆盖它指出的日期、学校内部编号和原课节，不改动其他日期，
//   也不改动常课行本身；找不到该日期的常课时按补课处理。
// - 所有学周都已由 parse.mjs 换算成日期，冲突比较只看日期与节次。

import { occurrenceKey, compareOccurrence } from './calendar.mjs'

export const SCHOOLS = ['east', 'west']

export const SCHOOL_NAMES = { east: '东校', west: '西校' }

export function otherSchool(school) {
  return school === 'east' ? 'west' : 'east'
}

function schoolSlotKey(school, slot) {
  return `${school}:${slot}`
}

function ensureSchool(entry, school) {
  entry.schools[school] ??= { slot: null, label: null, sessions: [] }
  return entry.schools[school]
}

function newEntry(key, { id, joint }) {
  return {
    key,
    id,
    joint: joint ?? null,
    shared: false,
    label: null,
    schools: {},
    sessions: [],
  }
}

function addIndex(byId, id, key) {
  if (id === null || id === undefined || id === '') return
  byId.set(id, [...(byId.get(id) ?? []), key])
}

// snapshot.east / snapshot.west 来自 parse.mjs 的 parseSchoolPage。
export function buildCatalog(snapshot) {
  const classes = new Map()
  const issues = []
  const moves = []

  const pages = SCHOOLS.map(school => [school, snapshot[school]]).filter(([, page]) => page)

  // 1. 联开课与本校独立课程。
  for (const [school, page] of pages) {
    for (const row of page.rows) {
      let entry
      if (row.joint) {
        const key = `joint:${row.joint}`
        entry = classes.get(key)
        if (!entry) {
          entry = newEntry(key, { id: row.joint, joint: row.joint })
          classes.set(key, entry)
        }
      } else {
        const key = schoolSlotKey(school, row.slot)
        entry = classes.get(key)
        if (!entry) {
          entry = newEntry(key, { id: row.slot, joint: null })
          classes.set(key, entry)
        }
      }
      const side = ensureSchool(entry, school)
      if (side.slot && side.slot !== row.slot) {
        issues.push({
          kind: 'joint-slot-conflict',
          joint: entry.joint,
          school,
          slots: [side.slot, row.slot],
          message: `联开组 ${row.joint} 在${SCHOOL_NAMES[school]}出现两个校内编号：${side.slot} / ${row.slot}`,
        })
      }
      side.slot ??= row.slot
      side.label ??= row.label
      entry.label ??= row.label
      side.sessions.push({
        school,
        slot: row.slot,
        joint: entry.joint,
        label: row.label,
        date: row.date,
        period: row.period,
        originalPeriod: row.period,
        moved: null,
        makeup: false,
        held: row.held,
      })
    }
  }

  // 2. 应用调课/补课。按 学校 + 校内编号 + 日期 覆盖原课节。
  for (const [school, page] of pages) {
    for (const move of page.moves) {
      const entry = [...classes.values()].find(item => item.schools[school]?.slot === move.slot)
      if (!entry) {
        issues.push({
          kind: 'move-without-class',
          school,
          slot: move.slot,
          date: move.date,
          message: `${SCHOOL_NAMES[school]}调课 ${move.slot} 找不到对应课程`,
        })
        continue
      }
      const side = entry.schools[school]
      let session = side.sessions.find(item => item.date === move.date)
      if (!session) {
        // 补课：所指日期原本没有这门课，只在该日期增加一节，不影响其他日期。
        session = {
          school,
          slot: move.slot,
          joint: entry.joint,
          label: entry.label,
          date: move.date,
          period: move.newPeriod,
          originalPeriod: null,
          moved: null,
          makeup: true,
          held: null,
        }
        side.sessions.push(session)
        issues.push({
          kind: 'session-makeup',
          school,
          slot: move.slot,
          date: move.date,
          toPeriod: move.newPeriod,
          joint: entry.joint,
          label: entry.label,
          message: `${entry.label ?? move.slot} 在 ${move.date} 增加第 ${move.newPeriod} 节补课`,
        })
      }
      if (session.moved) {
        issues.push({
          kind: 'duplicate-move',
          school,
          slot: move.slot,
          date: move.date,
          message: `${SCHOOL_NAMES[school]} ${move.slot} 在 ${move.date} 有多个调课条目`,
        })
      }
      const before = session.period
      session.originalPeriod ??= before
      session.period = move.newPeriod
      session.moved = { ...move, fromPeriod: before }
      if (before !== move.newPeriod) {
        issues.push({
          kind: 'session-moved',
          school,
          slot: move.slot,
          date: move.date,
          fromPeriod: before,
          toPeriod: move.newPeriod,
          joint: entry.joint,
          label: entry.label,
          message: `${entry.label ?? move.slot} ${move.date} 由第 ${before} 节调至第 ${move.newPeriod} 节`,
        })
      }
      moves.push({
        school,
        slot: move.slot,
        date: move.date,
        fromPeriod: before,
        toPeriod: move.newPeriod,
        joint: entry.joint,
        label: entry.label,
      })
    }
  }

  // 3. 联开课是否真的两校都有页面依据。
  for (const entry of classes.values()) {
    const sides = Object.keys(entry.schools)
    if (entry.joint) {
      entry.shared = sides.length >= 2
      if (sides.length < 2) {
        issues.push({
          kind: 'joint-missing-side',
          joint: entry.joint,
          present: sides,
          missing: SCHOOLS.filter(school => !sides.includes(school)),
          message: `联开组 ${entry.joint} 只有${sides.map(side => SCHOOL_NAMES[side]).join('、')}页面，`
            + `${SCHOOLS.filter(school => !sides.includes(school)).map(side => SCHOOL_NAMES[side]).join('、')}未给出对应关系，不能按共用席位处理`,
        })
      }
    }
  }

  // 4. 同校同场次碰撞：涉及调课/补课，且另一方是原班必修或另一门课时提示。
  for (const [school, page] of pages) {
    const byOccurrence = new Map()
    for (const entry of classes.values()) {
      for (const session of entry.schools[school]?.sessions ?? []) {
        const key = occurrenceKey({ date: session.date, period: session.period })
        byOccurrence.set(key, [...(byOccurrence.get(key) ?? []), { entry, session }])
      }
    }
    for (const [key, list] of byOccurrence) {
      if (list.length < 2) continue
      const moved = list.filter(item => item.session.moved || item.session.makeup)
      if (!moved.length) continue
      const [date, periodPart] = key.split('#P')
      issues.push({
        kind: 'moved-session-overlap',
        school,
        date,
        period: Number(periodPart),
        classes: list.map(item => ({
          id: item.entry.id,
          slot: item.session.slot,
          label: item.entry.label,
          moved: Boolean(item.session.moved || item.session.makeup),
          held: item.session.held ?? null,
        })),
        message: `${SCHOOL_NAMES[school]} ${date} 第 ${periodPart} 节在调课后出现同场次课程`,
      })
    }
  }

  // 5. 联开课两校场次不同步：日期集合不同，或同一日期节次不同。
  for (const entry of classes.values()) {
    if (!entry.joint || !entry.shared) continue
    const sides = Object.entries(entry.schools).filter(([, side]) => side.sessions.length)
    if (sides.length < 2) continue
    const dates = new Set(sides.flatMap(([, side]) => side.sessions.map(session => session.date)))
    for (const date of [...dates].sort()) {
      const onDate = sides
        .map(([school, side]) => [school, side.sessions.filter(session => session.date === date)])
        .filter(([, sessions]) => sessions.length)
      if (onDate.length === 1) {
        const [school] = onDate[0]
        issues.push({
          kind: 'joint-date-desync',
          joint: entry.joint,
          label: entry.label,
          date,
          present: school,
          missing: SCHOOLS.filter(side => !onDate.some(([present]) => present === side)),
          message: `联开组 ${entry.joint} 在 ${date} 只在${SCHOOL_NAMES[school]}页面有课`,
        })
        continue
      }
      const periods = new Map(onDate.map(([school, sessions]) => [
        school, sessions.map(session => session.period).sort((a, b) => a - b),
      ]))
      const distinct = new Set([...periods.values()].map(value => value.join(',')))
      if (distinct.size > 1) {
        issues.push({
          kind: 'joint-desync',
          joint: entry.joint,
          label: entry.label,
          date,
          periods: Object.fromEntries(periods),
          message: `联开组 ${entry.joint} 在 ${date} 两校节次不同：${
            onDate.map(([school, sessions]) => `${SCHOOL_NAMES[school]}第 ${sessions.map(s => s.period).join('/')} 节`).join('，')
          }`,
        })
      }
    }
  }

  // 6. 索引：联开编号、校内编号、学校限定编号。
  const byId = new Map()
  for (const entry of classes.values()) {
    if (entry.joint) addIndex(byId, entry.joint, entry.key)
    for (const [school, side] of Object.entries(entry.schools)) {
      addIndex(byId, schoolSlotKey(school, side.slot ?? entry.id), entry.key)
      addIndex(byId, side.slot ?? entry.id, entry.key)
    }
    if (!entry.joint) addIndex(byId, entry.id, entry.key)
  }

  const ambiguous = []
  for (const [id, keys] of byId) {
    const unique = [...new Set(keys)]
    if (unique.length > 1) {
      ambiguous.push({
        kind: 'ambiguous-id',
        id,
        candidates: unique,
        message: `课程编号 ${id} 同时出现在多门课程中，需要按学生所在学校区分`,
      })
    }
    byId.set(id, unique)
  }
  issues.push(...ambiguous)

  // 7. 为保证输出稳定，场次排序。
  for (const entry of classes.values()) {
    for (const side of Object.values(entry.schools)) {
      side.sessions.sort(compareOccurrence)
    }
    entry.sessions = Object.values(entry.schools).flatMap(side => side.sessions).sort(compareOccurrence)
  }

  return { classes, byId, ambiguous, issues, moves, schools: SCHOOLS }
}

// 解析 from/to：先按联开编号，再按学生所在学校的校内编号。
export function resolveClass(catalog, id, school) {
  if (id === null || id === undefined) return null
  const keys = catalog.byId.get(id)
  if (!keys?.length) return null
  if (keys.length === 1) return catalog.classes.get(keys[0])
  const own = keys.find(key => {
    const entry = catalog.classes.get(key)
    return entry?.schools?.[school]?.slot === id || key === `joint:${id}`
  })
  return catalog.classes.get(own ?? keys[0]) ?? null
}

export function classSides(entry) {
  return Object.keys(entry?.schools ?? {})
}

// 学生实际要上的场次取本校展示；本校页面没有该课时，如果是真正的联开
// 共用课，退回另一校展示并标注。
export function sessionsFor(entry, school) {
  const side = entry?.schools?.[school]
  if (side) {
    return { sessions: side.sessions, side: school, missing: false, foreign: false }
  }
  const sides = classSides(entry)
  if (sides.length === 1) {
    return { sessions: entry.schools[sides[0]].sessions, side: sides[0], missing: false, foreign: true }
  }
  return { sessions: [], side: null, missing: true, foreign: true }
}

export function jointIssuesFor(catalog, entry) {
  if (!entry?.joint) return []
  return catalog.issues.filter(issue =>
    ['joint-desync', 'joint-date-desync', 'joint-missing-side'].includes(issue.kind)
    && issue.joint === entry.joint)
}
