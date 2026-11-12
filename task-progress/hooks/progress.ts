import type { PlanStep, Row, StepCount, StepState, TaskStatus } from '../types'
import type { Text } from './i18n'

// 跑了不到这么久的不列出来，免得一问一答也占一行
export const SHOW_RUNNING_AFTER_MS = 20_000
// 一轮只跑了这么短就结束的，完成后也不列
const SHOW_DONE_IF_RAN_MS = 30_000
// 跑完的留多久
const KEEP_DONE_MS = 30 * 60_000
// 正在跑的会话多久没动静就当它已经不在了（比如崩了）
const STALE_MS = 90_000
const MAX_ROWS = 6
// 超出估时不到这么多，只变警示色、照旧显示还剩多久；超过了才写“超预计”，免得超几秒也报
const OVER_GRACE_MS = 60_000
const NAME_MAX = 24

// 计划工具的输入：桌面 App 的 update_plan，终端的 TodoWrite
type PlanItem = { status?: unknown; content?: unknown }
type PlanInput = {
  items?: PlanItem[]
  advance?: unknown
  done?: unknown
  start?: unknown
  todos?: PlanItem[]
}

function stateOf(value: unknown): StepState {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

// 每步末尾圆括号里的估时和“需要你”：“导出数据卷（20–40分）”“在旧机执行脚本（10分·需要你）”“Build (5-10 min)”
const TRAILING = /[（(]([^（）()]*)[）)]\s*$/
// 一段时长：数字紧跟单位；单位后面直接接字母或汉字的不算（“3 分支”“3 steps”），
// 只看紧跟的第一个字：至 到 需 不 左 约 内 以 上 下 开头的可以（“至”“需要你”“不需”“左右”“以内”“上下”…），
// 中文标点（、。全角空格，U+3000–303F）不算汉字；英文单位只认小写
const UNIT = '(小时|分钟|分|秒|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-zA-Z]|(?![至到需不左约内以上下])[\\u2e80-\\u2fff\\u3040-\\u9fff])'
const NUMBER = '(?<![\\d.,])(\\d+(?:\\.\\d+)?)'
// 数字和单位之间可以有个“个”（“1 个小时”）
const PART = `${NUMBER}\\s*个?\\s*${UNIT}`
// 一个时长可以由几段组成（“1h30m”“1 小时 30 分”）；区间前一个数可以不写单位（“20–40分”）
const VALUE = `(?:${PART}\\s*)+`
// “to”前面的空格可能已经被前一个时长吃掉（“20 min to 40 min”），所以用 \b 认词首
const SEP = '(?:\\s*[-–—~～至到]\\s*|\\s*\\bto\\s+)'
const SPAN = new RegExp(`(${VALUE})(?:${SEP}(${VALUE}))?|${NUMBER}${SEP}(${VALUE})`)
const NEEDS_YOU = /需要?你|\bneeds?\s+you\b/i
const NOT_NEEDED = /不需|无需|無需|不用你|(?:\bnot|n['’]t|\bno)\s+need/i
// 估时超过一周当成写错了，不算
const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000

function unitMs(unit: string): number {
  if (unit === '小时' || unit.startsWith('h')) {
    return 3_600_000
  }

  return unit === '秒' || unit.startsWith('s') ? 1000 : 60_000
}

// 把“1h30m”这样的几段加起来
function msOf(text: string): number {
  let total = 0
  for (const part of text.matchAll(new RegExp(PART, 'g'))) {
    total += Number(part[1]) * unitMs(part[2] ?? '')
  }

  return total
}

// 读出一步的估时区间（毫秒）和要不要你在场；没写就是 null
export function parseStep(content: unknown): Pick<PlanStep, 'lo' | 'hi' | 'needsYou'> {
  const inside = typeof content === 'string' ? TRAILING.exec(content)?.[1] : undefined
  if (inside === undefined) {
    return { lo: null, hi: null, needsYou: false }
  }
  const needsYou = NEEDS_YOU.test(inside) && !NOT_NEEDED.test(inside)
  const span = SPAN.exec(inside)
  if (span === null) {
    return { lo: null, hi: null, needsYou }
  }
  let from: number
  let to: number
  if (span[1] !== undefined) {
    from = msOf(span[1])
    to = span[4] === undefined ? from : msOf(span[4])
  } else {
    // 前一个数没写单位，用后一个时长的第一段单位；借来的单位让前一个数反而更大（“30-1h”），就只算后一个
    to = msOf(span[8] ?? '')
    const unit = new RegExp(PART).exec(span[8] ?? '')?.[2] ?? ''
    from = Number(span[7]) * unitMs(unit)
    if (from > to) {
      from = to
    }
  }
  // 0、太大、算不出来的都当没写
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  if (!Number.isFinite(hi) || hi <= 0 || hi > MAX_ESTIMATE_MS) {
    return { lo: null, hi: null, needsYou }
  }

  return { lo, hi, needsYou }
}

// 认同一步用的文字：去掉末尾的估时括号和首尾空白
function keyOf(content: unknown): string {
  return typeof content === 'string' ? content.replace(TRAILING, '').trim() : ''
}

const isTime = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

// 别的会话（或坏掉的文件）写来的计划：格式不对的整个丢掉，按没有计划算，一个坏文件不连累别的行
export function cleanPlan(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const steps: PlanStep[] = []
  for (const item of raw as unknown[]) {
    const step = (item ?? {}) as Partial<Record<keyof PlanStep, unknown>>
    const state = step.state
    if ((state !== 'pending' && state !== 'in_progress' && state !== 'completed') || !isTime(step.lo) || !isTime(step.hi) || !isTime(step.since)) {
      return undefined
    }
    // 只写了一头的当没写；先排好大小再看上限，免得 lo、hi 写反了把一个天文数字放进来
    const both = step.lo !== null && step.hi !== null
    const lo = both ? Math.min(step.lo as number, step.hi as number) : 0
    const hi = both ? Math.max(step.lo as number, step.hi as number) : 0
    const known = both && hi > 0 && hi <= MAX_ESTIMATE_MS
    steps.push({
      state,
      lo: known ? lo : null,
      hi: known ? hi : null,
      needsYou: step.needsYou === true,
      since: step.since as number | null,
      ...(typeof step.key === 'string' ? { key: step.key } : {}),
    })
  }

  return steps
}

function begin(step: PlanStep, now: number): PlanStep {
  return step.state === 'in_progress' ? step : { ...step, state: 'in_progress', since: now }
}

function settle(step: PlanStep, state: 'completed' | 'pending'): PlanStep {
  return { ...step, state, since: null }
}

// 按计划工具这一次的调用，更新各步状态；正在做的那步记下从什么时候开始做
export function applyPlan(steps: PlanStep[], tool: string, raw: unknown, now: number): PlanStep[] {
  const input = (raw ?? {}) as PlanInput
  // 重发的清单里同一步还在做：接着用它开始做的时间。按步骤文字认，不按位置
  // （中间插进、删掉一步，后面的不会张冠李戴）；文字重复的按第几次出现配对；
  // 旧版本恢复来的步骤没有文字，才退回按位置认
  const fromItems = (items: PlanItem[]) => {
    const seen = new Map<string, number>()

    return items.map((raw, index): PlanStep => {
      const item = (raw ?? {}) as PlanItem
      const state = stateOf(item.status)
      const key = keyOf(item.content)
      const nth = seen.get(key) ?? 0
      seen.set(key, nth + 1)
      const held = steps.filter(step => step.key !== undefined && step.key === key)[nth] ?? (steps[index]?.key === undefined ? steps[index] : undefined)
      const since = state !== 'in_progress' ? null : held?.state === 'in_progress' && held.since !== null ? held.since : now

      return { state, ...parseStep(item.content), since, key }
    })
  }

  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return fromItems(input.todos)
  }
  if (tool.endsWith('wrap_up')) {
    return steps.map(step => settle(step, 'completed'))
  }
  if (!tool.endsWith('update_plan')) {
    return steps
  }
  if (Array.isArray(input.items)) {
    return fromItems(input.items)
  }

  const next = [...steps]
  if (input.advance === true) {
    const at = next.findIndex(step => step.state === 'in_progress')
    if (at !== -1) {
      next[at] = settle(next[at]!, 'completed')
    }
    const following = next.findIndex((step, index) => index > at && step.state === 'pending')
    if (following !== -1) {
      next[following] = begin(next[following]!, now)
    }
  }
  if (Array.isArray(input.done)) {
    for (const index of input.done) {
      if (typeof index === 'number' && next[index - 1] !== undefined) {
        next[index - 1] = settle(next[index - 1]!, 'completed')
      }
    }
  }
  if (typeof input.start === 'number' && next[input.start - 1] !== undefined) {
    const target = input.start - 1
    next.forEach((step, index) => {
      if (step.state === 'in_progress' && index !== target) {
        next[index] = settle(step, 'pending')
      }
    })
    next[target] = begin(next[target]!, now)
  }

  return next
}

export function countSteps(steps: readonly PlanStep[]): StepCount | null {
  return steps.length === 0
    ? null
    : {
        done: steps.filter(step => step.state === 'completed').length,
        active: steps.filter(step => step.state === 'in_progress').length,
        total: steps.length,
      }
}

type Estimate = {
  // 还剩多久（区间）
  remainingLo: number
  remainingHi: number
  // 整个计划估时的上限
  totalHi: number
  // 按估时加权的完成比例
  fraction: number
  // 正在做的那步已经超过它自己的估时上限
  isStepOver: boolean
  // 下一个要你在场的步骤：正在做（now），或者大约多久以后
  needsYou: { now: boolean; inMs: number } | null
}

// 计划里至少一步写了估时才算；没写的步按写了的那些平均算
export function estimateOf(raw: unknown, now: number): Estimate | null {
  const plan = cleanPlan(raw)
  const known = (plan ?? []).filter(step => step.lo !== null && step.hi !== null)
  // 各步都做完了（wrap_up 之后系统接着跑的一轮）就不再按估时算，免得报“超预计”
  if (plan === undefined || known.length === 0 || plan.every(step => step.state === 'completed')) {
    return null
  }
  const averageLo = known.reduce((sum, step) => sum + (step.lo ?? 0), 0) / known.length
  const averageHi = known.reduce((sum, step) => sum + (step.hi ?? 0), 0) / known.length

  let totalHi = 0
  let totalMid = 0
  let doneMid = 0
  let remainingLo = 0
  let remainingHi = 0
  let isStepOver = false
  let wait = 0
  let needsYou: Estimate['needsYou'] = null
  for (const step of plan) {
    const lo = step.lo ?? averageLo
    const hi = step.hi ?? averageHi
    const mid = (lo + hi) / 2
    totalHi += hi
    totalMid += mid
    if (step.state === 'completed') {
      doneMid += mid
      continue
    }
    const spent = step.state === 'in_progress' && step.since !== null ? Math.max(0, now - step.since) : 0
    isStepOver ||= spent > hi
    doneMid += Math.min(spent, mid)
    remainingLo += Math.max(0, lo - spent)
    remainingHi += Math.max(0, hi - spent)
    if (needsYou === null && step.needsYou) {
      needsYou = { now: step.state === 'in_progress', inMs: wait }
    } else if (needsYou === null) {
      wait += Math.max(0, mid - spent)
    }
  }

  return { remainingLo, remainingHi, totalHi, fraction: totalMid > 0 ? doneMid / totalMid : 0, isStepOver, needsYou }
}

// 系统、宿主插进来的整块（<system-reminder>…</system-reminder>、<task-notification>…、<side-sessions-event>…）：
// 标签名都带连字符，人写的 HTML 标签（<div>）不会这样
const HARNESS_BLOCK = /^\s*<([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/i
// 只剩开头的半个这种标签：旧版本只存了第一行，留下的就是 "<system-reminder>"
const HARNESS_OPEN = /^\s*<[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+(?:\s[^>]*)?>/i

// 这一轮你说的第一行话：去掉开头系统插进来的整块；斜杠命令按命令本身算。
// 一句人话都没有（空的续接、后台任务完成的通知、系统提醒）就是 null：不是新任务，接着算原来那个
export function taskLine(text: string): string | null {
  let rest = text
  let command = ''
  for (let match = HARNESS_BLOCK.exec(rest); match !== null; match = HARNESS_BLOCK.exec(rest)) {
    const [whole, tag = '', body = ''] = match
    if (tag === 'command-name' || tag === 'command-args') {
      command = `${command} ${body.trim()}`.trim()
    }
    rest = rest.slice(whole.length)
  }
  const line = rest.trim().split('\n')[0]?.trim() ?? ''
  if (line !== '' && !HARNESS_OPEN.test(line)) {
    return line
  }

  return command !== '' ? command : null
}

function clip(text: string, max: number): string {
  const points = [...text]

  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) {
    return `${Math.max(1, Math.round(ms / 1000))}s`
  }
  if (minutes < 60) {
    return `${minutes}m`
  }

  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
}

// 剩余时间的区间：“~20–40m”“~1h–1h30m”；快做完了是“<1m”
function spanText(lo: number, hi: number): string {
  if (hi < 60_000) {
    return '<1m'
  }
  const from = duration(lo)
  const to = duration(hi)
  if (lo < 60_000) {
    return `≤${to}`
  }
  if (from === to) {
    return `~${to}`
  }
  const plain = /^(\d+)([smh])$/
  const [a, b] = [plain.exec(from), plain.exec(to)]

  return a !== null && b !== null && a[2] === b[2] ? `~${a[1]}–${to}` : `~${from}–${to}`
}

// 做完的步数，加上正在做的那步算一半
function fractionOf(steps: StepCount): number {
  return Math.min(1, (steps.done + steps.active * 0.5) / steps.total)
}

function isVisible(status: TaskStatus, now: number, dismissed: Record<string, number>): boolean {
  if (dismissed[status.cliId] === status.startedAt) {
    return false
  }
  if (status.state === 'running') {
    return now - status.updatedAt < STALE_MS && (now - status.startedAt >= SHOW_RUNNING_AFTER_MS || status.steps !== null)
  }
  if (status.state === 'stopped' || status.finishedAt === null) {
    return false
  }

  return now - status.finishedAt < KEEP_DONE_MS && status.finishedAt - status.startedAt >= SHOW_DONE_IF_RAN_MS
}

function rowOf(status: TaskStatus, now: number, selfId: string, t: Text): Row {
  // 旧版本写下的 task 可能是 "<system-reminder>"，这里再洗一遍，名字里不会出现标签
  const name = clip(status.title ?? (taskLine(status.task) ?? t.untitled), NAME_MAX)
  const base = { cliId: status.cliId, localId: status.localId, startedAt: status.startedAt, name, isSelf: status.cliId === selfId }

  if (status.state !== 'running') {
    // 出错停下的：有估时按估时加权，没做完最多 99%
    const weighted = status.state === 'failed' ? estimateOf(status.plan, status.finishedAt ?? now) : null
    const percent =
      status.state === 'done' ? 100 : weighted !== null ? Math.min(99, Math.round(weighted.fraction * 100)) : status.steps === null ? null : Math.round(fractionOf(status.steps) * 100)

    // 跑完的显示这一轮用了多久
    const took = duration((status.finishedAt ?? now) - status.startedAt)

    return { ...base, state: status.state === 'failed' ? 'failed' : 'done', percent, side: took, isOver: false, note: null }
  }

  const elapsed = now - status.startedAt
  const estimate = estimateOf(status.plan, now)
  if (estimate !== null) {
    // 计划里写了估时：开工就有预估，超出上限就提醒，后面要你在场的步骤提前说
    const over = elapsed - estimate.totalHi
    const side = over >= OVER_GRACE_MS ? t.over(duration(over)) : spanText(estimate.remainingLo, estimate.remainingHi)
    const { needsYou } = estimate
    const note = needsYou === null ? null : needsYou.now ? t.needsYouNow : needsYou.inMs < 60_000 ? t.needsYouSoon : t.needsYouIn(duration(needsYou.inMs))

    return { ...base, state: 'running', percent: Math.min(99, Math.round(estimate.fraction * 100)), side, isOver: over > 0 || estimate.isStepOver, note }
  }
  if (status.steps === null) {
    // 没有分步骤的任务算不出百分比，只说跑了多久
    return { ...base, state: 'running', percent: null, side: t.elapsed(duration(elapsed)), isOver: false, note: null }
  }

  const fraction = fractionOf(status.steps)
  // 至少做完一步再估剩余时间，不然只是瞎猜
  const side = status.steps.done >= 1 && fraction > 0 && fraction < 1 ? `~${duration((elapsed * (1 - fraction)) / fraction)}` : t.elapsed(duration(elapsed))

  return { ...base, state: 'running', percent: Math.min(99, Math.round(fraction * 100)), side, isOver: false, note: null }
}

// 同一个桌面会话（/clear、回退会换 CLI 会话 id）留下的几份状态，只算最新的那份
function newestPerSession(statuses: readonly TaskStatus[]): TaskStatus[] {
  const newest = new Map<string, TaskStatus>()
  for (const status of statuses) {
    const held = status.localId === null ? undefined : newest.get(status.localId)
    if (status.localId !== null && (held === undefined || status.updatedAt > held.updatedAt || (status.updatedAt === held.updatedAt && status.startedAt > held.startedAt))) {
      newest.set(status.localId, status)
    }
  }

  return statuses.filter(status => status.localId === null || newest.get(status.localId) === status)
}

export function rowsOf(statuses: readonly TaskStatus[], now: number, dismissed: Record<string, number>, selfId: string, t: Text): Row[] {
  return newestPerSession(statuses)
    .filter(status => isVisible(status, now, dismissed))
    // 一个会话的文件算不出来（坏了、格式不认得），只丢它自己那一行
    .flatMap(status => {
      try {
        return [rowOf(status, now, selfId, t)]
      } catch {
        return []
      }
    })
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.startedAt - b.startedAt)
    .slice(0, MAX_ROWS)
}
