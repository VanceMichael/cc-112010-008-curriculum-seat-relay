// 跨校资料读取：按来源地址取页，并保留「上一份仍在沿用」的语义。
// 读取失败不覆盖已有快照；调用方据 snapshot.source 判断是否陈旧。

import { parseSchoolPage, parseSeats, parseChanges, parseConfirmations } from './parse.mjs'

export class SourceError extends Error {
  constructor(message, { path, status, body } = {}) {
    super(message)
    this.name = 'SourceError'
    this.path = path
    this.status = status
    this.body = body
  }
}

async function fetchRaw(base, path, { method = 'GET', body, fetchImpl = fetch, timeout = 5000 } = {}) {
  const options = { method, signal: AbortSignal.timeout(timeout) }
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  const response = await fetchImpl(new URL(path, base), options)
  const text = await response.text()
  let parsed = text
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      parsed = text.length ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
  }
  return { status: response.status, body: parsed, text }
}

export async function readEast(base, options) {
  const raw = await fetchRaw(base, '/east', options)
  if (raw.status !== 200) throw new SourceError(`东校课表读取失败（${raw.status}）`, { path: '/east', ...raw })
  return parseSchoolPage(raw.text, 'east')
}

export async function readWest(base, options) {
  const raw = await fetchRaw(base, '/west', options)
  if (raw.status !== 200) throw new SourceError(`西校课表读取失败（${raw.status}）`, { path: '/west', ...raw })
  return parseSchoolPage(raw.text, 'west')
}

export async function readSeats(base, options) {
  const raw = await fetchRaw(base, '/seats', options)
  if (raw.status !== 200) throw new SourceError(`席位目录读取失败（${raw.status}）`, { path: '/seats', ...raw })
  return parseSeats(raw.body)
}

export async function readChanges(base, options) {
  const raw = await fetchRaw(base, '/changes', options)
  if (raw.status !== 200) throw new SourceError(`调课表读取失败（${raw.status}）`, { path: '/changes', ...raw })
  return parseChanges(raw.body)
}

export async function readConfirmations(base, options) {
  const raw = await fetchRaw(base, '/confirmations', options)
  if (raw.status !== 200) throw new SourceError(`确认组读取失败（${raw.status}）`, { path: '/confirmations', ...raw })
  return parseConfirmations(raw.body)
}

export async function postEnroll(base, payload, options) {
  const raw = await fetchRaw(base, '/enroll', { ...options, method: 'POST', body: payload })
  return raw
}

// 同一份快照只刷新能读到的部分：读不到的来源沿用 last 中的内容并标注陈旧。
export async function snapshot(base, last = null, options = {}) {
  const result = {
    east: last?.east ?? null,
    west: last?.west ?? null,
    seats: last?.seats ?? null,
    changes: last?.changes ?? null,
    confirmations: last?.confirmations ?? null,
    stale: {},
  }
  const failures = {}
  await Promise.allSettled([
    readEast(base, options).then(value => { result.east = value }, error => { failures.east = error }),
    readWest(base, options).then(value => { result.west = value }, error => { failures.west = error }),
    readSeats(base, options).then(value => { result.seats = value }, error => { failures.seats = error }),
    readChanges(base, options).then(value => { result.changes = value }, error => { failures.changes = error }),
    readConfirmations(base, options).then(value => { result.confirmations = value }, error => { failures.confirmations = error }),
  ])
  result.stale = Object.fromEntries(Object.entries(failures).map(([key, error]) => [key, {
    message: error.message,
    status: error.status ?? null,
  }]))
  return result
}
