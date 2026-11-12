import { expect, mock, test } from 'claude-code/testing'

import type { PlanStep, TaskStatus } from '../types'
import { en, zh } from '../hooks/i18n'
import { applyPlan, cleanPlan, parseStep, rowsOf, taskLine } from '../hooks/progress'

const states = (steps: PlanStep[]) => steps.map(step => step.state)

test('the plan tools move the steps along', () => {
  let steps = applyPlan([], 'mcp__ccd_turn__update_plan', {
    items: [{ status: 'in_progress' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
  }, 0)
  steps = applyPlan(steps, 'mcp__ccd_turn__update_plan', { advance: true }, 1)
  expect(states(steps)).toEqual(['completed', 'in_progress', 'pending', 'pending'])
  expect(steps[1]?.since).toBe(1)
  steps = applyPlan(steps, 'mcp__ccd_turn__update_plan', { done: [2, 3], start: 4 }, 2)
  expect(states(steps)).toEqual(['completed', 'completed', 'completed', 'in_progress'])
  expect(states(applyPlan(steps, 'mcp__ccd_turn__wrap_up', { recap: 'x' }, 3))).toEqual(['completed', 'completed', 'completed', 'completed'])
  expect(states(applyPlan([], 'TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }, 0))).toEqual(['completed', 'pending'])
})

test('estimates and the needs-you mark are read from the end of each step', () => {
  const MIN = 60_000
  expect(parseStep('导出数据卷（20–40分）')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('在旧机执行脚本（10分钟·需要你）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: true })
  expect(parseStep('全盘备份（约 1.5-3 小时）')).toEqual({ lo: 90 * MIN, hi: 180 * MIN, needsYou: false })
  expect(parseStep('Build the app (5-10 min)')).toEqual({ lo: 5 * MIN, hi: 10 * MIN, needsYou: false })
  expect(parseStep('Restart (2m, needs you)')).toEqual({ lo: 2 * MIN, hi: 2 * MIN, needsYou: true })
  expect(parseStep('确认方案（需要你）')).toEqual({ lo: null, hi: null, needsYou: true })
  // 括号不在末尾、括号里没有时长：不算
  expect(parseStep('拷贝（20分）到新机')).toEqual({ lo: null, hi: null, needsYou: false })
  expect(parseStep('检查 M1 Max (64GB)')).toEqual({ lo: null, hi: null, needsYou: false })
  expect(parseStep(undefined)).toEqual({ lo: null, hi: null, needsYou: false })
  // 两端都写单位、几段组成的时长
  expect(parseStep('导出（20分–40分）')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('Export (20 min - 40 min)')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('备份（30分–1小时）')).toEqual({ lo: 30 * MIN, hi: 60 * MIN, needsYou: false })
  expect(parseStep('Back up (1h30m)')).toEqual({ lo: 90 * MIN, hi: 90 * MIN, needsYou: false })
  expect(parseStep('备份（1 小时 30 分–2小时）')).toEqual({ lo: 90 * MIN, hi: 120 * MIN, needsYou: false })
  expect(parseStep('Wait (5s, needs you)')).toEqual({ lo: 5000, hi: 5000, needsYou: true })
  // “至”“到”“需要你”“左右”紧跟在中文单位后面
  expect(parseStep('导出（20分至40分）')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('备份（1小时到2小时）')).toEqual({ lo: 60 * MIN, hi: 120 * MIN, needsYou: false })
  expect(parseStep('在旧机执行（10分需要你）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: true })
  // 旧写法“需你”也认
  expect(parseStep('在旧机执行（10分需你）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: true })
  expect(parseStep('导出（20–40分钟需要你）')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: true })
  expect(parseStep('编译（10分钟左右）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: false })
  // 中文标点、全角空格隔开也行
  expect(parseStep('在旧机执行（10分、需要你）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: true })
  expect(parseStep('在旧机执行（10分\u3000需要你）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: true })
  expect(parseStep('编译（10分上下）').hi).toBe(10 * MIN)
  // “to”、“内”“以内”“以上”也认；0、超过一周的当没写；借来的单位让前一个数更大时只算后一个
  expect(parseStep('Export (20 to 40 min)')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('Export (20 min to 40 min)')).toEqual({ lo: 20 * MIN, hi: 40 * MIN, needsYou: false })
  expect(parseStep('Back up (1h to 2h)')).toEqual({ lo: 60 * MIN, hi: 120 * MIN, needsYou: false })
  // “5mto”连在一起不算区间，只读到后面的 10m
  expect(parseStep('Back up (5mto 10m)')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: false })
  expect(parseStep('备份（约 1 个小时）')).toEqual({ lo: 60 * MIN, hi: 60 * MIN, needsYou: false })
  expect(parseStep('编译（10分钟内）')).toEqual({ lo: 10 * MIN, hi: 10 * MIN, needsYou: false })
  expect(parseStep('编译（10分钟以内）').hi).toBe(10 * MIN)
  expect(parseStep('拷贝（2小时以上）').hi).toBe(120 * MIN)
  expect(parseStep('编译（0分）').hi).toBeNull()
  expect(parseStep('Wait (9999 h)').hi).toBeNull()
  expect(parseStep('Wait (99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999 h)').hi).toBeNull()
  expect(parseStep('Back up (30-1h)')).toEqual({ lo: 60 * MIN, hi: 60 * MIN, needsYou: false })
  expect(parseStep('Runs alone (10 min, doesn’t need you)').needsYou).toBe(false)
  // 否定说法不算“需要你”
  expect(parseStep('自动跑（10分，不需要你）').needsYou).toBe(false)
  expect(parseStep('Runs alone (10 min, does not need you)').needsYou).toBe(false)
  expect(parseStep('Runs alone (10 min, doesn\'t need you)').needsYou).toBe(false)
  // 普通文字不当成时长
  for (const text of ['合并（3 分支）', '重排（第 2 分区）', 'Run (3 steps)', 'Import (1 M rows)', 'Sync (2 S3 buckets)', '(.5h)', '(1,5 h)', '(macOS 26)', '(2 TB)', '(100 Mbps)', '(2 months)']) {
    expect([text, parseStep(text).lo]).toEqual([text, null])
  }
  // 重发同样的清单：还在做的那步保留开始时间
  const first = applyPlan([], 'mcp__ccd_turn__update_plan', { items: [{ content: 'a（5分）', status: 'in_progress' }] }, 100)
  expect(applyPlan(first, 'mcp__ccd_turn__update_plan', { items: [{ content: 'a（5分）', status: 'in_progress' }] }, 900)[0]?.since).toBe(100)
  // 前面插进一步：还在做的那步按文字认出来，开始时间不丢；估时改了也认得
  const plan = applyPlan([], 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'completed' }, { content: 'B（10分）', status: 'in_progress' }, { content: 'C', status: 'pending' }] }, 1000)
  const inserted = applyPlan(plan, 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'completed' }, { content: 'A2', status: 'completed' }, { content: 'B（15分）', status: 'in_progress' }, { content: 'C', status: 'pending' }] }, 900_000)
  expect(inserted[2]?.since).toBe(1000)
  // 文字重复的步骤按第几次出现配对：后一个“Run tests”开始做时重新计时
  const twice = applyPlan([], 'TodoWrite', { todos: [{ content: 'Run tests (5m)', status: 'in_progress' }, { content: 'Fix', status: 'pending' }, { content: 'Run tests (5m)', status: 'pending' }] }, 0)
  const later = applyPlan(twice, 'TodoWrite', { todos: [{ content: 'Run tests (5m)', status: 'completed' }, { content: 'Fix', status: 'completed' }, { content: 'Run tests (5m)', status: 'in_progress' }] }, 30 * MIN)
  expect(later.map(item => item.since)).toEqual([null, null, 30 * MIN])
  // 同一个位置换成了别的步骤：重新计时
  expect(applyPlan(plan, 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'completed' }, { content: 'X', status: 'in_progress' }] }, 900_000)[1]?.since).toBe(900_000)
  // done 和 start 一起：开始的那步从这次算起；start 一个已经在做的步骤，开始时间不变
  const both = applyPlan(plan, 'mcp__ccd_turn__update_plan', { done: [2], start: 3 }, 5000)
  expect(both.map(step => [step.state, step.since])).toEqual([['completed', null], ['completed', null], ['in_progress', 5000]])
  expect(applyPlan(both, 'mcp__ccd_turn__update_plan', { start: 3 }, 9000)[2]?.since).toBe(5000)
  // TodoWrite 里的估时也读
  expect(applyPlan([], 'TodoWrite', { todos: [{ content: 'Build (5-10 min)', status: 'in_progress' }] }, 0)[0]).toMatchObject({ lo: 5 * MIN, hi: 10 * MIN, since: 0 })
})

const MIN = 60_000
// 每个会话默认有自己的桌面会话 id（同一个桌面会话的几份状态只列最新的）
const status = (over: Partial<TaskStatus>): TaskStatus => ({
  v: 1,
  cliId: 'a',
  localId: `local_${over.cliId ?? 'a'}`,
  title: '任务进度追踪面板',
  task: '做个进度条',
  state: 'running',
  startedAt: 0,
  updatedAt: 0,
  finishedAt: null,
  steps: null,
  ...over,
})

test('which tasks show, their percent and time left', () => {
  const now = 10 * MIN
  const rows = rowsOf(
    [
      // 两步做完一步、第二步在做：75%，用了 10 分钟，大约还要 3 分钟
      status({ cliId: 'a', steps: { done: 1, active: 1, total: 2 }, updatedAt: now }),
      // 没有分步骤：只说跑了多久
      status({ cliId: 'b', title: null, task: 'Fix local storage upload', startedAt: 4 * MIN, updatedAt: now }),
      // 刚跑完的：绿色 100%
      status({ cliId: 'c', state: 'done', startedAt: 2 * MIN, finishedAt: 8 * MIN, updatedAt: 8 * MIN }),
      // 一问一答很快就答完：不列
      status({ cliId: 'd', state: 'done', startedAt: 9 * MIN, finishedAt: 9 * MIN + 5000 }),
      // 好久没心跳的“正在跑”：当它已经不在了
      status({ cliId: 'e', updatedAt: 5 * MIN }),
      // 刚开始不到 20 秒、也没有步骤：先不列
      status({ cliId: 'f', startedAt: now - 5000, updatedAt: now }),
      // 被收起的那一轮
      status({ cliId: 'g', startedAt: MIN, updatedAt: now }),
      // 中途被打断的
      status({ cliId: 'h', state: 'stopped', finishedAt: now }),
    ],
    now,
    { g: MIN },
    'c',
    zh,
  )

  expect(rows.map(row => [row.cliId, row.state, row.percent, row.side, row.isSelf])).toEqual([
    ['a', 'running', 75, '~3m', false],
    ['b', 'running', null, '已跑 6m', false],
    ['c', 'done', 100, '6m', true],
  ])
  expect(rows[1]?.name).toBe('Fix local storage upload')
})

// 计划里写了估时的行：开工就有剩余区间，超出上限变警示色，后面要你在场的提前说
const step = (state: PlanStep['state'], lo: number | null, hi: number | null, needsYou = false, since: number | null = null): PlanStep => ({ state, lo, hi, needsYou, since })

test('a plan with estimates shows the time left from the start, warns when over, and says when it needs you', () => {
  const plan = (now: number, since: number) =>
    rowsOf(
      [
        status({
          cliId: 'p',
          updatedAt: now,
          steps: { done: 0, active: 1, total: 3 },
          plan: [step('in_progress', 10 * MIN, 20 * MIN, false, since), step('pending', 5 * MIN, 5 * MIN, true), step('pending', 20 * MIN, 40 * MIN)],
        }),
      ],
      now,
      {},
      'x',
      zh,
    )[0]

  // 刚开工：还剩 34–64 分钟，第一步大约 15 分钟后做完，接着就要你
  const fresh = plan(MIN, 0)
  expect([fresh?.side, fresh?.note, fresh?.isOver, fresh?.percent]).toEqual(['~34m–1h4m', '14m 后需要你', false, 2])
  // 第一步做了 25 分钟，超过它的上限：时间变警示色，下一步马上要你
  const late = plan(25 * MIN, 0)
  expect([late?.side, late?.note, late?.isOver]).toEqual(['~25–45m', '马上需要你', true])
  // 整个计划的上限是 65 分钟，跑了 80 分钟：显示超出多久
  expect(plan(80 * MIN, 0)?.side).toBe('超预计 15m')
  // 超出不到 1 分钟：只变警示色，照旧显示还剩多久；满 1 分钟才写“超预计”
  const barely = plan(65 * MIN + 30_000, 0)
  expect([barely?.side, barely?.isOver]).toEqual(['~25–45m', true])
  expect(plan(66 * MIN, 0)?.side).toBe('超预计 1m')

  // 要你在场的那步正在做；没写估时的步按写了的平均算
  const [now] = rowsOf(
    [status({ cliId: 'q', updatedAt: MIN, steps: { done: 1, active: 1, total: 3 }, plan: [step('completed', 10 * MIN, 10 * MIN), step('in_progress', null, null, true, 0), step('pending', 30 * MIN, 30 * MIN)] })],
    MIN,
    {},
    'x',
    en,
  )
  expect([now?.side, now?.note, now?.percent]).toEqual(['~49m', 'needs you', 18])

  // 各步都做完了（wrap_up 之后系统接着跑的一轮）：不报超时，照旧按步数算
  const [finished] = rowsOf([status({ cliId: 's', updatedAt: 90 * MIN, steps: { done: 2, active: 0, total: 2 }, plan: [step('completed', MIN, MIN), step('completed', MIN, MIN)] })], 90 * MIN, {}, 'x', zh)
  expect([finished?.side, finished?.isOver]).toEqual(['已跑 1h30m', false])

  // 没写估时的计划照旧按步数算
  const [plain] = rowsOf([status({ cliId: 'r', updatedAt: 10 * MIN, steps: { done: 1, active: 1, total: 2 }, plan: [step('completed', null, null), step('in_progress', null, null)] })], 10 * MIN, {}, 'x', zh)
  expect([plain?.side, plain?.note, plain?.percent]).toEqual(['~3m', null, 75])
})

test('a malformed plan in some session’s file only costs that file its estimates, never the band', () => {
  expect(cleanPlan('oops')).toBeUndefined()
  expect(cleanPlan([null])).toBeUndefined()
  expect(cleanPlan([{ state: 'running', lo: null, hi: null, needsYou: false, since: null }])).toBeUndefined()
  expect(cleanPlan([{ state: 'pending', lo: -1, hi: 5, needsYou: false, since: null }])).toBeUndefined()
  // lo、hi 写反、其中一头是天文数字：先排好再看上限，当没写
  expect(cleanPlan([{ state: 'in_progress', lo: 1e300, hi: 1, needsYou: false, since: 0 }])?.[0]).toMatchObject({ lo: null, hi: null })
  // 只写了一头的当没写
  expect(cleanPlan([{ state: 'pending', lo: null, hi: 5, needsYou: 'yes', since: null }])).toEqual([{ state: 'pending', lo: null, hi: null, needsYou: false, since: null }])
  for (const plan of ['oops', [null], { a: 1 }, 42, [{ state: 'pending', lo: Number.NaN, hi: 1, since: null }]]) {
    const rows = rowsOf([status({ cliId: 'bad', updatedAt: 10 * MIN, steps: { done: 1, active: 1, total: 2 }, plan: plan as never }), status({ cliId: 'good', updatedAt: 10 * MIN, steps: { done: 1, active: 0, total: 2 } })], 10 * MIN, {}, 'x', zh)
    expect(rows.map(row => [row.cliId, row.percent])).toEqual([['bad', 75], ['good', 50]])
  }
  // 别的字段坏到算不出这一行（标题不是文字）：只丢这一行
  const rows = rowsOf([status({ cliId: 'broken', title: 123 as never, updatedAt: 10 * MIN, steps: { done: 1, active: 0, total: 2 } }), status({ cliId: 'good', updatedAt: 10 * MIN, steps: { done: 1, active: 0, total: 2 } })], 10 * MIN, {}, 'x', zh)
  expect(rows.map(row => row.cliId)).toEqual(['good'])
})

test('a failed row with unfinished steps stops short of 100%', () => {
  const [failed] = rowsOf(
    [status({ cliId: 'f', state: 'failed', startedAt: 0, finishedAt: 30 * MIN, updatedAt: 30 * MIN, steps: { done: 0, active: 1, total: 2 }, plan: [step('in_progress', 10 * MIN, 20 * MIN, false, 0), step('pending', 1000, 1000)] })],
    31 * MIN,
    {},
    'x',
    zh,
  )
  expect([failed?.state, failed?.percent]).toEqual(['failed', 99])
})

test('the remaining time reads ≤ and <1m near the end', () => {
  const at = (since: number) => rowsOf([status({ cliId: 'e', startedAt: 15 * MIN, updatedAt: 20 * MIN, steps: { done: 0, active: 1, total: 1 }, plan: [step('in_progress', 2 * MIN, 5 * MIN, false, since)] })], 20 * MIN, {}, 'x', en)[0]?.side
  expect(at(17 * MIN)).toBe('≤2m')
  expect(at(15 * MIN + 30_000)).toBe('<1m')
})

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const HOME = '/Users/me'
const DIR = `${HOME}/.claude/task-progress`
const APP_RECORD = `${HOME}/Library/Application Support/Claude/claude-code-sessions/x/y/local_self.json`
const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// 模拟引擎：本会话和另一个会话的状态文件、桌面 App 的会话记录。
// 时钟用 mock.clock：往前拨时每 5 秒的定时刷新照样会跑；每个文件记着自己的修改时间，过期的问题才测得出来
type FakeOptions = { sessionIds?: string[]; isShown?: boolean; hasAppRecord?: boolean; now?: number; failing?: string[] }

function fakeSessions(on: any, language: string, options: FakeOptions = {}) {
  on('settings.read', () => ({ value: { language } }))
  const clock = mock.clock(on, { now: options.now ?? 1000 })
  // 这些调用一律出错（测 hook 不往外抛）
  const failing = new Set(options.failing)
  const fails = (name: string) => {
    if (failing.has(name)) throw new Error(`${name} failed`)
  }
  const files: Record<string, string> = {
    [APP_RECORD]: JSON.stringify({ sessionId: 'local_self', cliSessionId: 'self', title: '整理研究资料' }),
    // 别的会话的记录里也提到了这个 id（比如在摘要里），不能认错
    [`${HOME}/Library/Application Support/Claude/claude-code-sessions/x/y/local_aaa.json`]: JSON.stringify({ sessionId: 'local_aaa', cliSessionId: 'zzz', title: '别的会话', summary: 'self' }),
    [`${DIR}/other.json`]: JSON.stringify(status({ cliId: 'other', localId: 'local_other', title: 'Motion graphics showreel', startedAt: 1000, updatedAt: 3 * MIN, steps: { done: 2, active: 0, total: 4 } })),
  }
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map(path => [path, clock.now()]))
  // 别的会话写自己的文件（心跳、开始新的一轮）
  const write = (path: string, text: string, at = clock.now()) => {
    files[path] = text
    mtimes[path] = at
  }
  const ran: string[][] = []
  // 会话 id 按顺序给：/clear 之后换成下一个
  const ids = options.sessionIds ?? ['self']
  const session = { idIndex: 0 }
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', (_: unknown, e: any) => (fails('env.get'), { value: e.name === 'HOME' ? HOME : undefined }))
  on('session.id', () => (fails('session.id'), { value: ids[Math.min(session.idIndex, ids.length - 1)] }))
  on('session.surfaces', () => ({ value: options.isShown === false ? [] : ['desktop'] }))
  on('process.run', (_: unknown, e: any) => {
    ran.push(e.argv)
    fails(`process.run ${e.argv[0]}`)
    if (e.argv[0] === 'rm') {
      for (const path of e.argv.slice(3)) {
        delete files[path]
        delete mtimes[path]
      }
    }
    const found = `${HOME}/Library/Application Support/Claude/claude-code-sessions/x/y/local_aaa.json\n${options.hasAppRecord === false ? '' : `${APP_RECORD}\n`}`
    return { value: ok(e.argv[0] === 'grep' ? found : '') }
  })
  on('fs.read', (_: unknown, e: any) => {
    if (files[e.path] === undefined) throw new Error('missing')
    return { value: files[e.path] }
  })
  on('fs.write', (_: unknown, e: any) => {
    fails('fs.write')
    write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_: unknown, e: any) => ({
    value: Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: mtimes[path] ?? 0, isLink: false })),
  }))
  on('tool.call', () => ({ result: {} }))

  return { files, mtimes, write, ran, clock, session, failing }
}

test('a session writes its own progress, lists everyone’s, jumps and dismisses', async ($, on) => {
  const { files, ran, clock } = fakeSessions(on, 'chinese')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '整理研究资料\n按主题分', turnId: 't1' })
  const self = JSON.parse(files[`${DIR}/self.json`]!) as TaskStatus
  expect([self.state, self.localId, self.title, self.task]).toEqual(['running', 'local_self', '整理研究资料', '整理研究资料'])

  await clock.set(3 * MIN)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] })
  expect((JSON.parse(files[`${DIR}/self.json`]!) as TaskStatus).steps).toEqual({ done: 1, active: 1, total: 2 })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'open-other' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '整理研究资料' }))?.text).toBe('整理研究资料')
    expect((await ui.find({ type: 'Text', text: '本会话' }))?.text).toBe('本会话')
    expect((await ui.find({ type: 'Text', text: '75%' }))?.text).toBe('75%')
    expect((await ui.find({ type: 'Text', text: '50%' }))?.text).toBe('50%')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open-other' })
  expect(ran.at(-1)).toEqual(['open', 'claude://code/continue?session=local_other'])
  await ui.press({ key: 'dismiss-other' })
  expect(JSON.parse(files[`${DIR}/dismissed/other.json`]!)).toBe(1000)
  expect(await ui.find({ key: 'open-other' })).toBeUndefined()
  await ui.unmount()

  await clock.set(4 * MIN)
  await $.turn.complete({ answer: '', turnId: 't1', isAborted: false, reason: 'answer', durationMs: 3 * MIN })
  const done = JSON.parse(files[`${DIR}/self.json`]!) as TaskStatus
  expect([done.state, done.finishedAt]).toEqual(['done', 4 * MIN])
})

// 桌面进度条按 1:1 像素画、长度用 vw，不再横向拉伸：格子再窄，两头也是正圆。
// 原来用 viewBox 拉伸，圆头靠往里收一段比例留位置，格子窄到约 270 像素以下就被裁成平头（2026-11-10）
test('desktop bars keep round ends at any width: drawn 1:1 with vw lengths, not stretched', async ($, on) => {
  const { write, clock } = fakeSessions(on, 'chinese')
  const other = (steps: TaskStatus['steps']) =>
    write(`${DIR}/other.json`, JSON.stringify(status({ cliId: 'other', localId: 'local_other', title: 'Motion graphics showreel', startedAt: 1000, updatedAt: clock.now(), steps })))
  const bar = async (alt: string) => {
    await clock.advance(5000)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const found = (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === alt)
    await ui.unmount()
    return found
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.set(3 * MIN)

  other({ done: 2, active: 0, total: 4 })
  const half = String((await bar('50%'))?.props.source)
  expect(half).toContain('viewBox="0 0 8 8" preserveAspectRatio="xMinYMid meet"')
  expect(half).not.toContain('preserveAspectRatio="none"')
  expect(half).toContain('<rect height="8" rx="4" fill="rgba(128,128,128,0.13)" style="width:100vw">')
  expect(half).toContain('<rect height="8" rx="4" fill="#D9603E" style="width:max(8px,50vw)">')

  // 算不出百分比时一小段来回滑：放进 iframe，用 x 的 vw 值移动，滑到头正好贴住右端
  other(null)
  const sliding = await bar('进行中')
  expect(sliding?.props.isInteractive).toBe(true)
  // 画在 iframe 里的那条要给宽度，不然默认只有 300px，宽屏下比别的行短
  expect(sliding?.props.width).toBe(4000)
  expect(String(sliding?.props.source)).toContain('style="width:max(8px,22vw)" opacity="0.85"><animate attributeName="x" values="0;78vw;0"')
})

test('estimates written in the plan reach the status file and the band', async ($, on) => {
  const { files, clock } = fakeSessions(on, 'chinese')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '迁移数据', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: '导出（20–40分）', status: 'in_progress' }, { content: '在旧机执行（10分·需要你）', status: 'pending' }] })
  const plan = (JSON.parse(files[`${DIR}/self.json`]!) as TaskStatus).plan
  expect(plan?.map(item => [item.lo, item.hi, item.needsYou])).toEqual([[20 * MIN, 40 * MIN, false], [10 * MIN, 10 * MIN, true]])

  await clock.set(5 * MIN)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '~25–45m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '25m 后需要你' })).toBeDefined()
    await ui.unmount()
  }
})

test('in a narrow terminal the needs-you note goes before the time does; over turns the time to the warning colour', async ($, on) => {
  const { clock } = fakeSessions(on, 'english', { hasAppRecord: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Migrate', turnId: 't' })
  await $.tool.call({ tool: PLAN, items: [{ content: 'Export (20-40 min)', status: 'in_progress' }, { content: 'Run on the old Mac (10 min, needs you)', status: 'pending' }] })
  await clock.set(5 * MIN)
  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } })
  expect(await narrow.find({ type: 'Text', text: '~25–45m' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /needs you/ })).toBeUndefined()
  await narrow.unmount()
  const wide = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 120 } })
  expect(await wide.find({ type: 'Text', text: 'needs you in 25m' })).toBeDefined()
  await wide.unmount()
  // 带着进度条时，终端变宽，名字一栏只会变宽，不会为了带上提醒反而变窄
  let lastName = 0
  for (let bodyColumns = 40; bodyColumns <= 120; bodyColumns++) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
    const columns = rowColumns(await ui.drawn())
    if (columns.bar > 0) {
      expect([bodyColumns, columns.name >= lastName]).toEqual([bodyColumns, true])
      lastName = columns.name
    }
    await ui.unmount()
  }

  await clock.set(70 * MIN)
  const over = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await over.find({ type: 'Text', text: /over$/ }))?.props.color).toBe('warning')
  await over.unmount()
})

test('rows an older version left in state before a reload don’t break the band', async ($, on) => {
  fakeSessions(on, 'chinese')
  // 0.1.1 画的行：没有 isOver、note。重载后、第一次刷新前，state 里读到的就是它
  const oldRows = [{ cliId: 'x', localId: null, startedAt: 0, name: '旧的行', state: 'running', percent: 50, side: '~3m', isSelf: false }]
  const seeded: { value: unknown } = { value: oldRows }
  on('state.get', async (_: unknown, e: any, next: any) => (seeded.value !== null && e.key === 'rows' ? { value: { value: seeded.value, version: 1 } } : next(e)))
  // 没有形状标签：读作没有，不画
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '旧的行' })).toBeUndefined()
    await ui.unmount()
  }
  // 万一带着新标签漏过来：缺的字段补齐，照常画出
  seeded.value = { shape: 'rows-2', value: oldRows }
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '旧的行' })).toBeDefined()
    await ui.unmount()
  }
  // 重载后的第一次刷新照常画出新的行
  seeded.value = null
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'open-other' })).toBeDefined()
  await ui.unmount()
})

test('after a module reload the steps come back from the status file, estimates and start times included', async ($, on) => {
  const { files, clock } = fakeSessions(on, 'chinese')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '迁移数据', turnId: 't1' })
  await $.tool.call({ tool: PLAN, items: [{ content: '导出（20–40分）', status: 'in_progress' }, { content: '在旧机执行（10分·需要你）', status: 'pending' }] })
  await clock.set(5 * MIN)
  // 模块重载：session.start 再来一次，从自己的状态文件接回各步
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.set(6 * MIN)
  await $.tool.call({ tool: PLAN, advance: true })
  const plan = selfFile(files).plan
  expect(plan?.map(item => [item.state, item.lo, item.hi, item.needsYou, item.since])).toEqual([
    ['completed', 20 * MIN, 40 * MIN, false, null],
    ['in_progress', 10 * MIN, 10 * MIN, true, 6 * MIN],
  ])
})

// 语言跟着 Claude Code 的 language 设置走
for (const [language, self, untitled] of [
  ['english', 'this session', 'Untitled task'],
  ['chinese', '本会话', '未命名任务'],
] as const) {
  test(`with language set to ${language}, the band is in that language`, async ($, on) => {
    const { clock } = fakeSessions(on, language)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: '', turnId: 't1' })
    await clock.set(3 * MIN)
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: self }))?.text).toBe(self)
    expect((await ui.find({ type: 'Text', text: '整理研究资料' }))?.text).toBe('整理研究资料')
    await ui.unmount()
    expect(rowsOf([status({ cliId: 'b', title: null, task: '', startedAt: 0, updatedAt: clock.now() })], clock.now(), {}, 'self', language === 'english' ? en : zh)[0]?.name).toBe(untitled)
  })
}

const selfFile = (files: Record<string, string>, id = 'self') => JSON.parse(files[`${DIR}/${id}.json`]!) as TaskStatus
const TURN_END = { answer: '', isAborted: false, reason: 'answer', durationMs: 1000 } as const
const PLAN = 'mcp__ccd_turn__update_plan'

test('the task line skips system and harness blocks; a slash command counts as its command', () => {
  expect(taskLine('<system-reminder>\nnotes\n</system-reminder>\n整理研究资料\n按主题分')).toBe('整理研究资料')
  expect(taskLine('<system-reminder>a</system-reminder>\n<side-sessions-event>b</side-sessions-event>')).toBeNull()
  expect(taskLine('<task-notification>\n<task-id>x</task-id>\n</task-notification>')).toBeNull()
  expect(taskLine('<ci-monitor-event kind="check">failed</ci-monitor-event>\n')).toBeNull()
  expect(taskLine('')).toBeNull()
  // 旧版本存下的半个标签
  expect(taskLine('<system-reminder>')).toBeNull()
  expect(taskLine('<command-message>retro</command-message>\n<command-name>/retro</command-name>\n<command-args>now</command-args>')).toBe('/retro now')
  // 人写的 HTML 不算
  expect(taskLine('<div> 居中 </div> 怎么写')).toBe('<div> 居中 </div> 怎么写')
  // 终端里没有标题的行：旧文件里的标签不会当成名字
  expect(rowsOf([status({ cliId: 't', localId: null, title: null, task: '<system-reminder>', startedAt: 0, updatedAt: MIN })], MIN, {}, 'x', en)[0]?.name).toBe('Untitled task')
})

test('turns with no human text carry on the current task: same name, start and steps, and the finished row still shows', async ($, on) => {
  const { files, clock } = fakeSessions(on, 'english', { hasAppRecord: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '<system-reminder>\nsome context\n</system-reminder>\nTidy the research notes\nby topic', turnId: 't1' })
  expect(selfFile(files).task).toBe('Tidy the research notes')
  await $.tool.call({ tool: PLAN, items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] })
  await clock.set(2 * MIN)
  await $.turn.complete({ ...TURN_END, turnId: 't1' })

  const texts = ['<task-notification>\n<task-id>x</task-id>\n</task-notification>', '<system-reminder>a</system-reminder>\n<side-sessions-event>b</side-sessions-event>', '']
  for (const [index, text] of texts.entries()) {
    await $.turn.start({ text, turnId: `c${index}` })
    const self = selfFile(files)
    expect([self.task, self.startedAt, self.state, self.steps]).toEqual(['Tidy the research notes', 1000, 'running', { done: 0, active: 1, total: 3 }])
  }
  // 接着上一轮的计划往下走，这一轮没有新的 items
  await $.tool.call({ tool: PLAN, advance: true })
  expect(selfFile(files).steps).toEqual({ done: 1, active: 1, total: 3 })
  await clock.set(3 * MIN)
  await $.turn.complete({ ...TURN_END, turnId: 'c2' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Tidy the research notes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /</ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '100%' })).toBeDefined()
  await ui.unmount()

  // 上一个任务结束一小时后才来的系统通知：当新的一轮算，不把空闲的时间算进用时
  await clock.set(63 * MIN)
  await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 'late' })
  expect([selfFile(files).task, selfFile(files).startedAt, selfFile(files).steps]).toEqual(['', 63 * MIN, null])

  // 有人话的一轮才是新任务：起点、步骤重来
  await clock.set(64 * MIN)
  await $.turn.start({ text: '<system-reminder>x</system-reminder>\nNext thing\nmore', turnId: 't2' })
  const next = selfFile(files)
  expect([next.task, next.startedAt, next.steps]).toEqual(['Next thing', 64 * MIN, null])
})

test('a dismissed row stays dismissed while that task runs on, and comes back with its next task', async ($, on) => {
  const { files, write, clock } = fakeSessions(on, 'chinese')
  const other = (at: number, startedAt = 1000) =>
    write(`${DIR}/other.json`, JSON.stringify(status({ cliId: 'other', localId: 'local_other', title: 'Motion graphics showreel', startedAt, updatedAt: at, steps: { done: 2, active: 0, total: 4 } })), at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.set(3 * MIN)
  other(3 * MIN)
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss-other' })
  expect(await ui.find({ key: 'open-other' })).toBeUndefined()
  await ui.unmount()

  // 那个会话一直在跑（心跳不停），过了半小时多
  await clock.set(40 * MIN)
  other(40 * MIN)
  await clock.advance(5000)
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ key: 'open-other' })).toBeUndefined()
  await later.unmount()
  expect(files[`${DIR}/dismissed/other.json`]).toBe('1000')

  // 它开始了新的一轮：行回来，旧的收起记录删掉
  other(41 * MIN, 41 * MIN)
  await clock.set(41 * MIN + 5000)
  const fresh = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await fresh.find({ key: 'open-other' })).toBeDefined()
  await fresh.unmount()
  expect(files[`${DIR}/dismissed/other.json`]).toBeUndefined()
})

test('after /clear the session writes under its new id', async ($, on) => {
  const { files, clock, session } = fakeSessions(on, 'chinese', { sessionIds: ['self', 'fresh'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '整理研究资料', turnId: 't1' })
  await clock.set(MIN)
  await $.turn.complete({ ...TURN_END, turnId: 't1' })

  // /clear：进程不变，会话 id 换了，不会再有 session.start
  session.idIndex = 1
  await clock.set(2 * MIN)
  await $.turn.start({ text: '新的话题', turnId: 't2' })
  const fresh = selfFile(files, 'fresh')
  expect([fresh.cliId, fresh.task, fresh.localId]).toEqual(['fresh', '新的话题', 'local_self'])
  expect(selfFile(files).task).toBe('整理研究资料')

  // 同一个桌面会话的两份状态只列新的那份，标成本会话
  await clock.advance(25_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'task-fresh' })).toBeDefined()
  expect(await ui.find({ key: 'task-self' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '本会话' })).toBeDefined()
  await ui.unmount()
})

test('one desktop session left with several status files shows once, the newest', () => {
  const rows = rowsOf(
    [
      status({ cliId: 'old', localId: 'local_x', state: 'done', startedAt: 0, finishedAt: 2 * MIN, updatedAt: 2 * MIN }),
      status({ cliId: 'new', localId: 'local_x', state: 'done', startedAt: 3 * MIN, finishedAt: 5 * MIN, updatedAt: 5 * MIN }),
      status({ cliId: 'term1', localId: null, title: 'a', state: 'done', startedAt: 0, finishedAt: 2 * MIN, updatedAt: 2 * MIN }),
      status({ cliId: 'term2', localId: null, title: 'b', state: 'done', startedAt: 0, finishedAt: 2 * MIN, updatedAt: 2 * MIN }),
    ],
    6 * MIN,
    {},
    'x',
    zh,
  )
  expect(rows.map(row => row.cliId)).toEqual(['term1', 'term2', 'new'])
})

// 终端：每行的格数加起来不超过 bodyColumns；“this session” 按整格留够宽度，太窄时先压名字、再不画进度条
const rowColumns = (drawn: any): { name: number; bar: number; hasSide: boolean; total: number } => {
  const line = drawn.children[0].children[0]
  const [, body] = line.children
  // 不画进度条时这一格没有元素
  const [name, ...rest] = body.children
  const [bar, percent, side] = rest.length === 3 ? rest : [null, ...rest]
  const barText = bar === null ? '' : bar.children.map((part: any) => part.children[0]).join('')
  // 时间那一栏（可能不显示）+ 1 格间隔 + “×”
  const sideWidth = side.children.length === 2 ? side.children[0].props.width + 1 + 1 : 1
  const gaps = (body.children.length - 1) * 2

  return { name: name.props.width, bar: [...barText].length, hasSide: side.children.length === 2, total: 4 + 4 + 1 + name.props.width + [...barText].length + percent.props.width + sideWidth + gaps }
}
for (const [bodyColumns, hasBar, hasLabel, hasSide] of [
  [100, true, true, true],
  [40, false, false, true],
  [30, false, false, false],
] as const) {
  test(`in a ${bodyColumns}-column terminal the row fits`, async ($, on) => {
    const { clock } = fakeSessions(on, 'english', { hasAppRecord: false })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'Fix the upload', turnId: 't' })
    await clock.advance(25_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
    const columns = rowColumns(await ui.drawn())
    expect(columns.total <= bodyColumns).toBe(true)
    expect(columns.bar > 0).toBe(hasBar)
    expect(columns.hasSide).toBe(hasSide)
    expect((await ui.find({ type: 'Text', text: 'this session' })) !== undefined).toBe(hasLabel)
    if (hasLabel) {
      // 名字 14 格 + 1 格间隔 + “this session” 12 格
      expect(columns.name).toBe(Math.min(26, 14 + 1 + 12))
    }
    await ui.unmount()
  })
}

test('old status files and stray dismissals are cleaned up; the legacy dismissed.json goes', async ($, on) => {
  const DAY = 24 * 60 * MIN
  const now = 10 * DAY
  const { files, write, clock } = fakeSessions(on, 'chinese', { now })
  write(`${DIR}/ancient.json`, JSON.stringify(status({ cliId: 'ancient', updatedAt: 2 * DAY })), 2 * DAY)
  write(`${DIR}/week.json`, JSON.stringify(status({ cliId: 'week', updatedAt: 5 * DAY })), 5 * DAY)
  // 不是本 mod 写的格式：不碰
  write(`${DIR}/foreign.json`, JSON.stringify({ hello: 1 }), 2 * DAY)
  write(`${DIR}/dismissed.json`, JSON.stringify({ a: 1 }), 2 * DAY)
  write(`${DIR}/dismissed/gone.json`, '5', 9 * DAY)
  write(`${DIR}/dismissed/week.json`, '0', 9 * DAY)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(files[`${DIR}/ancient.json`]).toBeUndefined()
  expect(files[`${DIR}/dismissed.json`]).toBeUndefined()
  expect(files[`${DIR}/dismissed/gone.json`]).toBeUndefined()
  expect(files[`${DIR}/week.json`]).toBeDefined()
  expect(files[`${DIR}/foreign.json`]).toBeDefined()
  expect(files[`${DIR}/dismissed/week.json`]).toBe('0')
})

test('a headless -p run writes no status file', async ($, on) => {
  const { files } = fakeSessions(on, 'english', { isShown: false })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.turn.start({ text: 'reply ok', turnId: 't' })
  await $.turn.complete({ ...TURN_END, turnId: 't' })
  expect(files[`${DIR}/self.json`]).toBeUndefined()
})

test('when HOME and the session id fail at start, the timer is still set and picks the session up later', async ($, on) => {
  const { files, clock, failing } = fakeSessions(on, 'chinese', { failing: ['env.get', 'session.id'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  failing.clear()
  await $.turn.start({ text: '整理研究资料', turnId: 't' })
  await clock.advance(25_000)
  expect(selfFile(files).task).toBe('整理研究资料')
})

for (const failing of ['process.run open', 'fs.write'] as const) {
  test(`pressing a row's buttons survives a failing ${failing}`, async ($, on) => {
    const { clock } = fakeSessions(on, 'chinese', { failing: [failing] })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.set(3 * MIN)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'open-other' })
    await ui.press({ key: 'dismiss-other' })
    await ui.unmount()
  })
}

// 输入框上方共用的左侧网格（五个 mod 的测试里逐字一致，repo-bar 的 grid-same.test.sh 会比对）：
// 从画出来的树里找图标列，即第一个设了数字宽度、父层设了 columnGap 的 Box；读它的宽度、收缩（shrink）、父层的间隔，
// 以及往上最近一层设了 paddingX 或 paddingLeft 的外壳：内边距是左右（x）还是只有左边（left）、多少，外边距，上下内边距，有没有边框
type GridSeen = { side: 'x' | 'left' | null; pad: unknown; marginX: unknown; padY: unknown; gap: unknown; icon: unknown; shrink: unknown; border: boolean }
type GridNode = { type?: string; props?: Record<string, unknown>; children?: unknown }
const GRID = {
  desktop: { side: 'x', pad: 0, marginX: 0, padY: null, gap: 0.75, icon: 3.3, shrink: 0, border: false },
  desktopCard: { side: 'x', pad: 0, marginX: -0.11, padY: 0, gap: 0.75, icon: 3.3, shrink: 0, border: true },
  terminal: { side: 'x', pad: 2, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: false },
  terminalCard: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: true },
  other: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: false },
  otherCard: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: true },
  // 会顶到右端的长文字另留的右端（textEnd）
  textEnd: { desktop: 1.3, terminal: 0, other: 0 },
} as const

function gridIn(node: unknown, chain: GridNode[] = []): GridSeen | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = gridIn(child, chain)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as GridNode
  const parent = chain[chain.length - 1]
  if (element.type === 'Box' && typeof element.props?.width === 'number' && parent?.props?.columnGap !== undefined) {
    const shell = [...chain].reverse().find(box => box.props?.paddingX !== undefined || box.props?.paddingLeft !== undefined)
    const props = shell?.props ?? {}
    return {
      side: props.paddingX !== undefined ? 'x' : props.paddingLeft !== undefined ? 'left' : null,
      pad: props.paddingX ?? props.paddingLeft,
      marginX: props.marginX ?? 0,
      padY: props.paddingY ?? null,
      gap: parent.props.columnGap,
      icon: element.props.width,
      shrink: element.props.flexShrink,
      border: props.borderStyle !== undefined,
    }
  }
  return gridIn(element.children, [...chain, element])
}

// 第一个满足条件的 Box 的属性；条件拿到属性和 Box 本身（要看里面的文字时用）
function boxIn(node: unknown, test: (props: Record<string, unknown>, box: GridNode) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = boxIn(child, test)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as GridNode
  if (element.type === 'Box' && test(element.props ?? {}, element)) return element.props ?? {}
  return boxIn(element.children, test)
}

async function drawnOn($: any, band: Record<string, unknown>, surface: string): Promise<unknown> {
  const ui = await $.ui.mount({ ...band, surface })
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}

async function gridOn($: any, band: Record<string, unknown>, surface: string): Promise<GridSeen | null> {
  return gridIn(await drawnOn($, band, surface))
}

// 本会话和另一个会话各一行
const twoRows = async ($: any, on: any) => {
  const { clock } = fakeSessions(on, 'chinese')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '整理研究资料', turnId: 't1' })
  await clock.set(3 * MIN)
}

test('the rows line up with the prompt box on desktop and are unchanged on the terminal', async ($, on) => {
  await twoRows($, on)
  expect(await gridOn($, BAND, 'desktop')).toEqual(GRID.desktop)
  expect(await gridOn($, BAND, 'terminal')).toEqual(GRID.terminal)
})

test('the rows are unchanged on VS Code and phones', async ($, on) => {
  await twoRows($, on)
  expect(await gridOn($, BAND, 'vscode')).toEqual(GRID.other)
  expect(await gridOn($, BAND, 'mobile')).toEqual(GRID.other)
})

test('the divider between rows (desktop only) starts at the text', async ($, on) => {
  await twoRows($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'open-other' })).toBeDefined()
  const dividers = (await ui.findAll({ type: 'Box' })).filter((box: any) => String(box.key ?? '').startsWith('divider-'))
  await ui.unmount()
  expect(dividers.length).toBe(1)
  expect(dividers[0]?.props.marginLeft).toBe(GRID.desktop.icon + GRID.desktop.gap)
})

test('narrow desktop: the progress group wraps under the name as a whole, the name and time can shrink, × stays outside; the terminal keeps one fixed row', async ($, on) => {
  await twoRows($, on)
  const desktop = await drawnOn($, BAND, 'desktop')
  // 正文：能收缩、放不下就换行
  expect(boxIn(desktop, props => props.flexWrap === 'wrap' && props.columnGap === 2 && props.width === undefined)?.minWidth).toBe(0)
  // 进度条那一组：按最短进度条 + 百分比 + 时间占位，换行后占满一行
  const group = boxIn(desktop, props => props.flexWrap === 'wrap' && typeof props.width === 'number' && props.flexGrow === 1)
  expect([group?.minWidth, typeof group?.width === 'number' && group.width > 8]).toEqual([0, true])
  // 进度条按 1 格占位、可以缩到 0；VS Code、手机不画进度条，那一栏不占位
  expect(boxIn(desktop, props => props.width === 1 && props.flexGrow === 1)?.minWidth).toBe(0)
  expect(boxIn(await drawnOn($, BAND, 'vscode'), props => props.width === 0 && props.flexGrow === 1)?.minWidth).toBe(0)
  // × 在正文外面，图标列和它都对着第一行
  expect(boxIn(desktop, props => props.flexShrink === 0 && props.paddingLeft !== undefined)?.paddingLeft).toBe(1 - GRID.desktop.gap)
  expect(boxIn(desktop, props => props.alignItems === 'flex-start' && props.columnGap === GRID.desktop.gap)).not.toBe(null)
  // 名字一栏、名字按钮都能缩，窄时截断；时间那一栏放不下时“需要你”换到下面
  expect(boxIn(desktop, props => props.columnGap === 1 && typeof props.width === 'number' && props.flexWrap === undefined && props.marginLeft === undefined)?.minWidth).toBe(0)
  expect(boxIn(desktop, props => props.marginLeft === -1)?.minWidth).toBe(0)
  const side = boxIn(desktop, props => props.flexWrap === 'wrap' && typeof props.width === 'number' && props.flexGrow === undefined)
  expect([side?.minWidth, side?.columnGap]).toEqual([0, 1])
  // 那一组按“最短进度条 1 格 + 百分比 + 时间”加两处 2 格间隔占位
  const percent = boxIn(desktop, props => props.justifyContent === 'flex-end' && typeof props.width === 'number')
  expect(group?.width).toBe(1 + 2 + Number(percent?.width) + 2 + Number(side?.width))
  // 终端照旧：没有换行的 Box，名字一栏不收缩
  const terminal = await drawnOn($, BAND, 'terminal')
  expect(boxIn(terminal, props => props.flexWrap === 'wrap')).toBe(null)
  expect(boxIn(terminal, props => props.alignItems === 'flex-start')).toBe(null)
})

test('the percent column does not shrink, so the bars of every row end at the same place', async ($, on) => {
  await twoRows($, on)
  const percent = boxIn(await drawnOn($, BAND, 'desktop'), props => props.justifyContent === 'flex-end' && typeof props.width === 'number')
  expect(percent?.flexShrink).toBe(0)
})
