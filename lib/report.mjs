// 文本报告：给教务员和班主任看的清单，不代替 JSON。
// 数字与措辞都来自 plan/handover 已核实的事实。

const VERDICT_LABELS = {
  ready: '可以办理',
  backup: '备选（未到放位时间）',
  blocked: '保留原课',
  'pending-receipt': '回条待核对',
  confirmed: '已生效并同步',
  'confirmed-unsynced': '已生效，课表未同步',
}

const KIND_LABELS = {
  single: '单独申请',
  swap: '同批互换',
  sequence: '先后依赖',
  receipt: '门户确认组',
  linked: '同一学生多条申请',
}

const STATUS_LABELS = {
  ready: '可以办理',
  'partly-ready': '部分可办',
  'partly-blocked': '部分可办，其余保留原课',
  blocked: '整组保留原课',
  backup: '整组备选',
  'pending-receipt': '等待门户回条',
  confirmed: '已生效',
  'confirmed-unsynced': '已生效，部分课表未同步',
}

function period(periods) {
  return periods.map(value => `第 ${value} 节`).join('、')
}

function seatLine(seat) {
  if (!seat) return '（无席位资料）'
  const parts = [`${seat.seatId ?? '未编号'}`]
  if (seat.total !== undefined) parts[0] += ` 总 ${seat.total}`
  if (seat.allocation && Object.keys(seat.allocation).length) {
    parts.push(`配额 ${Object.entries(seat.allocation).map(([school, value]) => `${school} ${value}`).join(' / ')}`)
  }
  if (seat.occupied !== undefined) parts.push(`已落位 ${seat.occupied}`)
  if (seat.freeSchool !== undefined) parts.push(`本校可用 ${seat.freeSchool}`)
  parts.push(`结论：${VERDICT_LABELS[seat.verdict] ?? seat.verdict}`)
  if (seat.reason) parts.push(seat.reason)
  return parts.join('；')
}

function conflictLine(conflict) {
  const where = [conflict.date, conflict.period ? `第 ${conflict.period} 节` : null]
    .filter(Boolean)
    .join(' ')
  const severity = conflict.severity === 'blocking' ? '阻碍' : '提示'
  return `- [${severity}]${where ? ` ${where}` : ''} ${conflict.message}`
}

export function renderPlan(plan) {
  const lines = []
  lines.push(`转课计划  ${plan.now ? new Date(plan.now).toISOString() : '（来源未给时间）'}`)
  lines.push(`来源：席位版本 ${plan.source.seatsVersion ?? '未提供'}；确认组 ${plan.source.confirmations} 个`)
  for (const [key, value] of Object.entries(plan.source.stale ?? {})) {
    lines.push(`注意：${key} 读取失败（${value.status ?? '?'} ${value.message}），沿用上一份资料`)
  }
  lines.push('')
  lines.push(`合计 ${plan.summary.students.length} 名学生、${plan.summary.requests ?? plan.students.length} 条申请、`
    + `${plan.summary.groups} 组：可办 ${plan.summary.ready}，备选 ${plan.summary.backup}，`
    + `保留原课 ${plan.summary.blocked}，待核对 ${plan.summary.pending}，`
    + `已生效 ${plan.summary.confirmed + plan.summary.confirmedUnsynced}`
    + '（逐条计数）')

  for (const group of plan.groups) {
    lines.push('')
    lines.push(`## ${group.key}（${group.students.join('、')}）`)
    lines.push(`类型：${KIND_LABELS[group.kind] ?? group.kind}；状态：${STATUS_LABELS[group.status] ?? group.status}`
      + (group.atomic ? '；必须整组办理' : ''))
    if (group.submit.length) lines.push(`本次可提交：${group.submit.join('、')}`)
    else if (group.atomic) lines.push('本次不提交：整组条件未同时成立')
    else if (group.kind === 'sequence') lines.push('本次只提交先前步骤，后一项等席位释放后再办')
    else lines.push('本次不提交：没有可独立办理的申请')
    if (group.keepOriginal.length) lines.push(`保留原课：${group.keepOriginal.join('、')}`)
    if (group.note) lines.push(group.note)

    for (const member of group.members) {
      lines.push('')
      lines.push(`### ${member.student}（${member.school}）${member.from} → ${member.to}`)
      lines.push(`结论：${VERDICT_LABELS[member.verdict] ?? member.verdict}；${member.action.reason}`)
      if (member.classes.to?.shared) {
        const slots = Object.entries(member.classes.to.sides ?? {})
          .map(([school, side]) => `${school}:${side.slot}`)
          .join(' / ')
        lines.push(`联开课：${member.classes.to.joint}（展示号 ${slots}）`)
      }
      lines.push(`席位：${seatLine(member.seat)}`)
      if (member.waitFor.length) lines.push(`需等待：${member.waitFor.join('、')} 先释放席位`)
      if (member.backup) {
        lines.push(`放位时间：${member.backup.releaseAt
          ? new Date(member.backup.releaseAt).toISOString() : '未提供'}`
          + `；可申领渠道：${member.backup.allowedChannel ?? '未提供'}`
          + `；本次渠道：${member.backup.requestedChannel ?? '未提供'}`)
      }
      if (member.retainedCore.length) {
        lines.push('保留的原班课节：')
        for (const core of member.retainedCore) {
          lines.push(`- ${core.date} 第 ${core.period} 节 ${core.label}（${core.slot}）`)
        }
      }
      if (member.conflicts.length) {
        lines.push('冲突：')
        for (const item of member.conflicts) lines.push(conflictLine(item))
      }
      if (member.issues.length) {
        lines.push('需核对：')
        for (const item of member.issues) lines.push(`- ${item.message}`)
      }
      if (member.receipt) {
        lines.push(`门户确认组 ${member.receipt.group}：${member.receipt.conclusion}`)
        for (const [school, state] of Object.entries(member.receipt.sides)) {
          lines.push(`- ${school}：${state.state}（${state.reason}）`)
        }
      }
    }
  }

  const catalogIssues = plan.catalog.issues.filter(issue =>
    ['joint-desync', 'joint-date-desync', 'joint-missing-side', 'moved-session-overlap'].includes(issue.kind))
  if (catalogIssues.length) {
    lines.push('')
    lines.push('## 课表页提示')
    for (const issue of catalogIssues) lines.push(`- ${issue.message}`)
  }

  return `${lines.join('\n')}\n`
}

export function renderHandover(handover) {
  const lines = []
  lines.push(`班主任课表  ${handover.generatedAt ? new Date(handover.generatedAt).toISOString() : ''}`)
  lines.push(`共 ${handover.summary.students} 名学生：已生效 ${handover.summary.effective}`
    + `（其中未同步 ${handover.summary.unsynced}），待确认 ${handover.summary.pending}，`
    + `保留原课 ${handover.summary.retained}`)
  for (const note of handover.notes) lines.push(`说明：${note}`)

  for (const student of handover.students) {
    lines.push('')
    lines.push(`## ${student.student}（${student.school}）${student.status}`)
    lines.push(`转课：${student.transfer.from} → ${student.transfer.to}`)
    if (student.timetable.length) {
      lines.push('课表：')
      for (const row of student.timetable) {
        const tag = {
          'retained-core': '原班必修',
          original: '原课',
          target: '转课后',
        }[row.kind] ?? row.kind
        lines.push(`- ${row.date} 第 ${row.period} 节 ${row.label}（${row.slot}）[${tag}]`
          + (row.note ? ` — ${row.note}` : ''))
      }
    } else {
      lines.push('课表：暂不排课（确认组未生效）')
    }
    for (const seat of student.sharedSeats) {
      lines.push(`订位依据：${seat.seatId}（${seat.joint}）`
        + `展示号 ${Object.entries(seat.displaySlots ?? {}).map(([school, slot]) => `${school}:${slot}`).join(' / ')}`)
      if (seat.basis) {
        lines.push(`- 总席位 ${seat.basis.total}；配额 ${
          Object.entries(seat.basis.allocation ?? {}).map(([school, value]) => `${school} ${value}`).join(' / ')
        }；已落位 ${seat.basis.occupiedCount ?? 0}`)
        if (seat.basis.reservedOpenAt) {
          lines.push(`- 放位时间 ${new Date(seat.basis.reservedOpenAt).toISOString()}`
            + `；渠道 ${seat.basis.allowedChannel ?? '未提供'}`)
        }
      }
      lines.push(`- ${seat.note}`)
    }
    for (const elective of student.pendingElectives) {
      lines.push(`尚未交接的选修：${elective.from} → ${elective.to}（${elective.reason}）`)
    }
    for (const confirmation of student.confirmation ?? []) {
      lines.push(`确认组 ${confirmation.group}：${confirmation.conclusion}`)
      for (const [school, state] of Object.entries(confirmation.sides)) {
        lines.push(`- ${school}：${state.state}（${state.reason}）`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}
