#!/usr/bin/env node
// 教务代办命令行。
//
//   node bin/edu.mjs plan      [--source URL] [--students S1,S2] [--json] [--out FILE]
//   node bin/edu.mjs handover  [--source URL] [--json] [--out FILE]
//   node bin/edu.mjs check     [--source URL]
//   node bin/edu.mjs submit    [--source URL] [--group GRP-S1-S2 | --students S1,S2]
//                              [--unknown S3,S4] [--step N] [--json]
//
// --source 默认 http://127.0.0.1:4173。
// --unknown 表示这些学生已经提交过但回条还没查清，计划会为它们保留原位。
// --step 只在联调时使用：先 PUT /replay 切到指定发布时刻再读。

import { writeFile } from 'node:fs/promises'
import { refresh, splitIndependent, submitGroup } from '../lib/transaction.mjs'
import { renderPlan, renderHandover } from '../lib/report.mjs'

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, source: process.env.SOURCE_URL ?? 'http://127.0.0.1:4173' }
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`)
    const key = token.slice(2)
    if (['json', 'help', 'commit'].includes(key)) {
      options[key] = true
      continue
    }
    const value = rest[++index]
    if (value === undefined) throw new Error(`参数 --${key} 缺少取值`)
    options[key] = value
  }
  return options
}

function students(value) {
  return value ? value.split(/[,，\s]+/).filter(Boolean) : null
}

async function replay(step, source) {
  if (step === undefined) return
  const response = await fetch(new URL('/replay', source), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: Number(step) }),
  })
  if (!response.ok) throw new Error(`切换发布时刻失败：${response.status}`)
}

const USAGE = `用法：
  edu plan      [--source URL] [--students S1,S2] [--json]
  edu handover  [--source URL] [--json]
  edu check     [--source URL]
  edu submit    [--source URL] [--group GRP-S1-S2 | --students S1,S2] [--commit]

说明：
  plan      列出哪些申请可以办理、哪些必须整组、哪些只能候补、哪些保留原课
  handover  生成可交给班主任的课表（含共用课订位依据与未同步标记）
  check     核对来源是否可读，列出沿用的旧资料
  submit    展示将要提交的整组内容；加 --commit 才真正 POST /enroll
`

async function main(argv) {
  const options = parseArgs(argv)
  if (!options.command || options.command === 'help' || options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  await replay(options.step, options.source)
  const selected = students(options.students)
  const refreshed = await refresh(options.source, null, {
    prepare: { students: selected ?? undefined },
  })
  const { snapshot, plan, handover } = refreshed.prepared

  if (options.command === 'plan') {
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    else process.stdout.write(renderPlan(plan))
    return plan.summary.blocked > 0 ? 2 : 0
  }

  if (options.command === 'handover') {
    if (options.json) process.stdout.write(`${JSON.stringify(handover, null, 2)}\n`)
    else process.stdout.write(renderHandover(handover))
    return 0
  }

  if (options.command === 'check') {
    const stale = Object.entries(plan.source.stale)
    const lines = [
      `来源 ${options.source}`,
      `现在 ${plan.now ? new Date(plan.now).toISOString() : '未提供'}`,
      `席位版本 ${plan.source.seatsVersion ?? '未提供'}`,
      `确认组 ${plan.source.confirmations} 个`,
      `课表页锚点 东校 ${plan.source.anchorDates.east ?? '未读到'} / 西校 ${plan.source.anchorDates.west ?? '未读到'}`,
      stale.length ? `沿用旧资料：${stale.map(([key]) => key).join('、')}` : '所有来源均可读',
      `课表页提示 ${plan.catalog.issues.length} 条`,
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    return stale.length ? 1 : 0
  }

  if (options.command === 'submit') {
    const targets = options.group
      ? plan.groups.find(group => group.key === options.group
        || group.students.join(',') === options.group)?.students
      : selected
    if (!targets?.length) {
      process.stderr.write('没有指定要提交的一组（用 --group 或 --students）\n')
      return 2
    }
    const split = splitIndependent(plan, targets)
    if (!options.commit) {
      const recorded = plan.students
        .filter(member => targets.includes(member.student) && member.receipt)
        .map(member => ({ student: member.student, group: member.receipt.group, conclusion: member.receipt.conclusion }))
      process.stdout.write(`${JSON.stringify({
        source: options.source,
        seatsVersion: snapshot.seats?.version ?? null,
        request: split.independent,
        kept: split.kept,
        recorded,
        note: '未加 --commit，只是预览；联动项不会提交。',
      }, null, 2)}\n`)
      return split.kept.length ? 2 : 0
    }
    const recorded = plan.students.filter(member =>
      targets.includes(member.student) && member.receipt)
    if (recorded.length) {
      process.stderr.write('门户已有这组记录，先核对实际接收状态，不重复提交：\n')
      for (const member of recorded) {
        process.stderr.write(`- ${member.student}：${member.receipt.group}，${member.receipt.conclusion}\n`)
      }
      return 2
    }
    if (split.kept.length) {
      process.stderr.write('这组里有必须联动或仍不成立的申请，先处理它们后再提交：\n')
      for (const kept of split.kept) process.stderr.write(`- ${kept.students.join('、')}：${kept.reason}\n`)
      return 2
    }
    const group = split.independent.map(row => row.student)
    const result = await submitGroup(options.source, group, { plan, snapshot })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.state === 'rejected' || result.state === 'unknown') return 2
    return 0
  }

  process.stderr.write(`未知命令：${options.command}\n${USAGE}`)
  return 2
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
}).catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
