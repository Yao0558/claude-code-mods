import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { kindOfWords } from './classify'
import type { Kind, Text } from './i18n'
import { textOf } from './i18n'
import { shownWords } from './secrets'
import { segmentsOf } from './shell'

// 结果在状态栏留多久
const KEEP_MS = 10 * 60_000
// 转到后台的检查最多等这么久的完成通知；会话关掉、通知丢了，就不再挂着“后台跑”
const BACKGROUND_MAX_MS = 2 * 60 * 60_000
// 状态栏里命令最多显示多少字
const SHOWN_MAX = 40

type Run = { kind: Kind; command: string; shown: string; order: number }
type Outcome = 'passed' | 'failed'
type Result = Run & { outcome: Outcome; seconds: number; endOrder: number }
// Bash 结果里用得上的几项
type BashRecord = { interrupted?: boolean; backgroundTaskId?: string; timedOutAfterMs?: number }

// 只认“结果能代表这次检查”的写法：认出来的那段是最后一段，前面用 &&、; 或换行连着（比如 `cd app && npm test`、`T=x; make -C $T test`），
// 这时整条命令的退出码就是它的。`npm test | tail`、`npm test || true`、`npm test; echo done` 的退出码是后面那条的，
// `a || npm test` 在 a 成功时根本不跑测试，报出来都会是假的“通过”
const SEQUENCE = ['&&', ';', '\n']

function kindOf(command: string): Omit<Run, 'order'> | undefined {
  const segments = segmentsOf(command)
  const last = segments.at(-1)
  if (last === undefined || segments.slice(1).some(segment => !SEQUENCE.includes(segment.joiner))) {
    return undefined
  }
  const kind = kindOfWords(last.words)
  if (kind === undefined) {
    return undefined
  }

  return { kind, command: last.words.join(' '), shown: shownWords(last.words).join(' ').slice(0, SHOWN_MAX) }
}

// 几条检查可以同时跑（并行的 Bash 调用），各记各的：正在跑的按 tool_use_id，Map 按开始先后排
const running = new Map<string, Run>()
// 转到后台跑的检查（Claude 放到后台、跑到超时上限被转过去、你按了 Ctrl+B），按 tool_use_id 等完成通知；
// timedOutMs：跑到超时上限转过去的，等通知期间照旧显示“超时，已转到后台”
// taskId：后台任务的 id，被 TaskStop 停掉时用它找回这一条（停掉的任务不发完成通知，2026-10-26 实测）
type Waiting = Run & { startedAt: number; taskId: string; timedOutMs?: number; expire: { cancel: () => void } | null }
const background = new Map<string, Waiting>()
// PostToolUse 报的执行时长，不含等你确认权限和 hook 的时间
const executedMs = new Map<string, number>()
// 跑完的结果，按结束先后排
let results: Result[] = []
// 开始、结束各占一个序号，用来判断谁比谁新
let order = 0
// 结果的清除计时，有新结果时重新计
let clearLater: { cancel: () => void } | null = null

function reset() {
  for (const waiting of background.values()) {
    waiting.expire?.cancel()
  }
  background.clear()
  running.clear()
  executedMs.clear()
  results = []
  clearLater?.cancel()
  clearLater = null
}

// 这次调用转到后台去了：结果要等完成通知，现在报“通过”是假的
function backgroundOf(ran: ToolCallResult, isAborted: boolean): BashRecord | undefined {
  const record = (ran.result ?? {}) as BashRecord

  return ran.deny === undefined && !isAborted && ran.isError !== true && record.backgroundTaskId !== undefined ? record : undefined
}

// 这次调用算什么结果；拒绝、被你打断的都不算，不留结果
function outcomeOf(ran: ToolCallResult, isAborted: boolean): { outcome: Outcome; ms?: number } | undefined {
  if (ran.deny !== undefined || isAborted) {
    return undefined
  }
  // 退出码不是 0 时 Bash 报错，isError 为真
  if (ran.isError === true) {
    return { outcome: 'failed' }
  }
  const record = (ran.result ?? {}) as BashRecord

  return record.interrupted === true || record.backgroundTaskId !== undefined ? undefined : { outcome: 'passed' }
}

// 后台任务的完成通知（<task-notification>）里的调用 id 和状态：completed 是通过，failed 是退出码不为 0，killed 是被停掉
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

export function notificationsIn(text: string): { id: string; status: string }[] {
  const found: { id: string; status: string }[] = []
  for (const match of text.matchAll(NOTIFICATION)) {
    const body = match[1] ?? ''
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim()
    if (id !== undefined && status !== undefined) {
      found.push({ id, status })
    }
  }

  return found
}

// 同一条命令更早开始的结果、在这次开始之前就结束了的同类结果，都被这次取代；
// 并行跑的另一条通过了，不会盖掉这条的失败。后台的结果可能很晚才到：
// 同一条命令已经有更晚开始的结果了，这条旧的就不记，免得旧的“通过”盖掉新的失败
function record(result: Result) {
  if (results.some(old => old.command === result.command && old.order > result.order)) {
    return
  }
  results = results.filter(old => !(old.command === result.command && old.order < result.order) && !(old.kind === result.kind && old.endOrder < result.order))
  results.push(result)
}

// 同一条命令又跑了一次：后台还在等的旧一次不再挂在状态行上
function supersede(command: string) {
  for (const [id, waiting] of background) {
    if (waiting.command === command) {
      waiting.expire?.cancel()
      background.delete(id)
    }
  }
}

function lineOf(t: Text, result: Result): string {
  return result.outcome === 'failed' ? t.failed(result.kind, result.seconds, result.shown) : t.passed(result.kind, result.seconds, result.shown)
}

// 还没结果的一条：前台在跑的、后台在跑的、超时转到后台的
function pendingLine(t: Text, run: Run | Waiting): string {
  if (!('startedAt' in run)) {
    return t.running(run.kind, run.shown)
  }

  return run.timedOutMs === undefined ? t.background(run.kind, run.shown) : t.timedOut(run.kind, Math.round(run.timedOutMs / 1000), run.shown)
}

// 一行放下全部：最新开始的那条在跑的、最新的那条没过的，其余只记个数；都过了才显示最新那条“通过”
function statusOf(t: Text): string | undefined {
  const parts: string[] = []
  const runs = [...running.values(), ...background.values()].sort((a, b) => a.order - b.order)
  const latestRun = runs.at(-1)
  if (latestRun !== undefined) {
    parts.push(pendingLine(t, latestRun) + (runs.length > 1 ? t.more(runs.length - 1) : ''))
  }
  const problems = results.filter(result => result.outcome !== 'passed')
  const latestProblem = problems.at(-1)
  if (latestProblem !== undefined) {
    parts.push(lineOf(t, latestProblem) + (problems.length > 1 ? t.more(problems.length - 1) : ''))
  }
  const latest = results.at(-1)
  if (parts.length === 0 && latest !== undefined) {
    parts.push(lineOf(t, latest))
  }

  return parts.length === 0 ? undefined : parts.join(' · ')
}

// 转到后台：结果等完成通知再报；等太久就放弃这一条
function toBackground($: EngineInterface, t: Text, id: string, run: Run, startedAt: number, record: BashRecord) {
  const waiting: Waiting = { ...run, startedAt, taskId: record.backgroundTaskId ?? '', timedOutMs: record.timedOutAfterMs, expire: null }
  background.set(id, waiting)
  waiting.expire = $.clock.after(BACKGROUND_MAX_MS, () => {
    if (background.get(id) === waiting) {
      background.delete(id)
      $.ui.status(statusOf(t))
    }
  })
  $.ui.status(statusOf(t))
}

// 后台的检查跑完了：用时从开始算到收到通知
function settleBackground($: EngineInterface, t: Text, id: string, status: string, now: number) {
  const waiting = background.get(id)
  if (waiting === undefined) {
    return
  }
  background.delete(id)
  waiting.expire?.cancel()
  const outcome = status === 'completed' ? 'passed' : status === 'failed' ? 'failed' : undefined
  report($, t, waiting, outcome === undefined ? undefined : { outcome, ms: now - waiting.startedAt }, 0)
}

function finish($: EngineInterface, t: Text, id: string, outcome: { outcome: Outcome; ms?: number } | undefined, ms: number) {
  const run = running.get(id)
  running.delete(id)
  executedMs.delete(id)
  report($, t, run, outcome, ms)
}

function report($: EngineInterface, t: Text, run: Run | undefined, outcome: { outcome: Outcome; ms?: number } | undefined, ms: number) {
  if (run !== undefined && outcome !== undefined) {
    order += 1
    record({ kind: run.kind, command: run.command, shown: run.shown, order: run.order, outcome: outcome.outcome, seconds: Math.round((outcome.ms ?? ms) / 1000), endOrder: order })
  }
  $.ui.status(statusOf(t))
  if (run !== undefined && outcome !== undefined) {
    // 过一阵就收起，免得很久以前的结果一直挂着
    clearLater?.cancel()
    clearLater = $.clock.after(KEEP_MS, () => {
      results = []
      clearLater = null
      $.ui.status(statusOf(t))
    })
  }
}

export const register: Register = on => {
  // 加载或重载时先清掉旧结果，免得上一个版本留下的状态一直挂着
  on('session.start', async ($, e, next) => {
    reset()
    $.ui.status(undefined)

    return next(e)
  })

  // 执行时长以 PostToolUse 报的为准：从调用开始算会把等你点“允许”的时间也算进去
  const noteExecuted = (id: string, ms: number | undefined) => {
    if (ms !== undefined && running.has(id)) {
      executedMs.set(id, ms)
    }
  }
  // 下面几个 hook 只在旁边记结果，出错时原样放行，不能因此让你的命令失败
  on('classic.PostToolUse', async ($, e, next) => {
    noteExecuted(e.tool_use_id, e.duration_ms)

    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e, next) => {
    noteExecuted(e.tool_use_id, e.duration_ms)

    return next(e)
  }).catch(($, e, next) => next(e))

  // 后台任务的完成通知：是我们等着的那条检查，就报出结果。只认引擎标成通知的提示，你贴进来的文字不算
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification' && background.size > 0) {
      const found = notificationsIn(e.text).filter(({ id }) => background.has(id))
      if (found.length > 0) {
        const t = await textOf($)
        const now = await $.clock.now()
        for (const { id, status } of found) {
          settleBackground($, t, id, status, now)
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 后台任务被 TaskStop 停掉不会有完成通知：停成功了就把那一条拿掉
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const taskId = e.task_id ?? e.shell_id
    if (ran.deny === undefined && ran.isError !== true && taskId !== undefined && taskId !== '') {
      for (const [id, waiting] of background) {
        if (waiting.taskId === taskId) {
          waiting.expire?.cancel()
          background.delete(id)
          $.ui.status(statusOf(await textOf($)))
        }
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = kindOf(e.command)
    if (found === undefined) {
      return next(e)
    }
    const id = e.tool_use_id
    const t = await textOf($)
    const startedAt = await $.clock.now()
    // 这次的序号当场记下：后台那一支要等调用返回，期间别的调用会把 order 往前推
    const mine = (order += 1)
    // 完成通知只回到主对话：子代理放到后台的检查等不到通知，不跟，也不去顶替主对话里在等的那条
    const canFollow = e.agentId === undefined
    // 这次真跑起来了（有了结果或转到后台），同一条命令在后台等着的旧一次才作废；被拒绝、没启动的不算
    const replaceOlder = () => {
      if (canFollow) {
        supersede(found.command)
      }
    }

    // Claude 一开始就放到后台跑：调用马上返回，结果等完成通知
    if (e.run_in_background === true) {
      if (!canFollow) {
        return next(e)
      }
      const ran = await next(e)
      const moved = backgroundOf(ran, next.signal.aborted)
      if (moved !== undefined) {
        replaceOlder()
        toBackground($, t, id, { ...found, order: mine }, startedAt, moved)
      }
      return ran
    }

    running.set(id, { ...found, order: mine })
    $.ui.status(statusOf(t))

    const ran = await next(e).catch((error: unknown) => {
      finish($, t, id, undefined, 0)
      throw error
    })
    // 跑着跑着转到后台了（跑到超时上限，或你按了 Ctrl+B）：结果等完成通知
    const moved = backgroundOf(ran, next.signal.aborted)
    const run = running.get(id)
    if (moved !== undefined && run !== undefined) {
      running.delete(id)
      executedMs.delete(id)
      replaceOlder()
      if (canFollow) {
        toBackground($, t, id, run, startedAt, moved)
      } else {
        $.ui.status(statusOf(t))
      }
      return ran
    }
    // 没收到 PostToolUse 的执行时长时，退回到从调用开始算
    const elapsedMs = executedMs.get(id) ?? (await $.clock.now()) - startedAt
    const outcome = outcomeOf(ran, next.signal.aborted)
    if (outcome !== undefined) {
      replaceOlder()
    }
    finish($, t, id, outcome, elapsedMs)

    return ran
  }).catch(($, e, next) => next(e))
}
