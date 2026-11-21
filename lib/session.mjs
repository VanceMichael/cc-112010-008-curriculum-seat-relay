// 教务代办会话：把「先核对、再填报、再核对」串起来。
//
// 同一批申请反复办理时，最容易出错的是拿旧回条当新结果。所以会话会
// 记住哪些提交还没有查清；这些组在查清前沿用原位与目标位的双重保留，
// 其他申请不能用它们的名额。

import { snapshot } from './fetch.mjs'
import {
  sealSnapshot, prepare, revalidateFrom, submitGroup, splitIndependent, payloadFor,
} from './transaction.mjs'
import { buildPlan } from './plan.mjs'
import { buildHandover } from './handover.mjs'

export class Session {
  constructor(base, options = {}) {
    if (!base) throw new TypeError('需要资料源地址')
    this.base = base
    this.options = { fetchOptions: options.fetchOptions ?? {} }
    this.raw = null
    this.sealed = null
    this.plan = null
    this.handover = null
    this.unknowns = new Map()
  }

  // 重新读取全部来源；读不到的沿用上一份并记在 plan.source.stale。
  async refresh(planOptions = {}) {
    this.raw = await snapshot(this.base, this.raw, this.options.fetchOptions)
    this.sealed = sealSnapshot(this.raw)
    this.plan = buildPlan(this.sealed, {
      ...planOptions,
      unknownSubmissions: [...this.unknowns.values()],
    })
    this.handover = buildHandover(this.sealed, this.plan, this.sealed.catalog, this.sealed.seatIndex)
    return this
  }

  async ensure() {
    if (!this.plan) await this.refresh()
    return this
  }

  async planFor(planOptions = {}) {
    await this.ensure()
    return buildPlan(this.sealed, {
      ...planOptions,
      unknownSubmissions: [...this.unknowns.values()],
    })
  }

  async handoverFor() {
    await this.ensure()
    return this.handover
  }

  async recheck(planOptions = {}) {
    await this.ensure()
    const result = await revalidateFrom(this.base, this.plan, {
      ...this.options,
      previous: this.raw,
      plan: { ...planOptions, unknownSubmissions: [...this.unknowns.values()] },
    })
    this.raw = result.snapshot
    this.plan = result.plan
    this.handover = result.handover
    return result
  }

  // 提交前先把整组拆干净：联动项不动，独立项才发出去。
  // 已经出现在门户确认组里的申请不再重复提交，先按门户实际记录处理。
  async submit(students, planOptions = {}) {
    await this.ensure()
    const plan = await this.planFor(planOptions)
    const split = splitIndependent(plan, students)
    const group = split.independent.map(row => row.student)

    if (!group.length) {
      const known = plan.students
        .filter(member => students.includes(member.student) && member.receipt)
        .map(member => member.receipt)
      return {
        state: known.length ? 'recorded' : 'kept',
        split,
        receipts: known,
        message: known.length
          ? '门户已有这组的记录，先核对实际接收状态，不重复提交'
          : '这组里有必须联动或仍不成立的申请，未提交任何内容',
      }
    }

    const result = await submitGroup(this.base, group, {
      plan,
      snapshot: this.sealed,
      fetchOptions: this.options.fetchOptions,
    })
    if (result.state === 'unknown') {
      for (const student of group) {
        this.unknowns.set(student, {
          student,
          group: result.group ?? group.join(','),
          students: group,
        })
      }
    } else {
      for (const student of group) this.unknowns.delete(student)
    }
    return { ...result, split }
  }

  // 已经提交但没查清的组，再核对一次门户实际接收记录。
  async recheckSubmission(students) {
    const group = [...students].sort()
    await this.refresh()
    const known = this.plan.students.filter(member => group.includes(member.student))
    const receipts = known.map(member => member.receipt).filter(Boolean)
    if (receipts.length) {
      for (const student of group) this.unknowns.delete(student)
      return {
        state: receipts.every(receipt => receipt.effective) ? 'confirmed' : 'pending',
        receipts,
        message: receipts.every(receipt => receipt.effective)
          ? '门户已有生效记录，可以按确认课节交接'
          : '门户已登记，尚未生效',
      }
    }
    return {
      state: 'unknown',
      message: '门户还没有这组的接收记录，继续保留原位和可能已接收的位置',
      retainedOriginal: group,
      reservedUnknown: group,
    }
  }

  payload(students) {
    if (!this.plan) throw new Error('先调用 refresh()')
    return payloadFor(students, this.plan, this.sealed?.seats?.version ?? null)
  }

  unknownGroups() {
    return [...this.unknowns.values()]
  }
}

export function connect(base, options) {
  return new Session(base, options)
}

export { prepare, buildPlan }
