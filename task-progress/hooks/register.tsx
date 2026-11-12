import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanStep, Row, TaskStatus } from '../types'
import { textOf } from './i18n'
import { applyPlan, cleanPlan, countSteps, rowsOf, taskLine } from './progress'

// 每个会话把自己的状态写成 <会话 id>.json，所有会话都来读
const STATUS_DIR = '.claude/task-progress'
// 收起记录一行一个文件（dismissed/<会话 id>.json），几个会话同时收起也不会互相覆盖
const DISMISSED_DIR = 'dismissed'
// 半小时没更新的状态文件不再读：正在跑的每 20 秒都会更新，跑完的只留半小时
const READ_WITHIN_MS = 31 * 60_000
// 一周没更新的状态文件删掉，收起记录跟着它走；每个会话启动时和每小时清一次，几个会话同时清也没关系
const KEEP_FILES_MS = 7 * 24 * 60 * 60_000
const CLEAN_EVERY_MS = 60 * 60_000
// 没有人话的一轮接着算上一个任务；上一个任务已经结束这么久了就不接，当新的一轮算（用时才不会把空闲的几小时算进去）
const CONTINUE_WITHIN_MS = 30 * 60_000
// 早先版本把所有收起记录写在一个文件里，现在不用了，见到就删
const LEGACY_DISMISSED = 'dismissed.json'
// 桌面 App 记录各会话的地方，用来查本会话在 App 里的 id 和标题
const APP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions'
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/

const REFRESH_MS = 5000
const HEARTBEAT_MS = 20_000
// 名字一栏按最长的名字定宽：几行的进度条起点对齐，名字短时也不会空出一大截
const NAME_MIN = 8
const NAME_MAX = 26
// 终端太窄时依次让步：名字压到 NAME_MIN 还放不下 BAR_MIN 格的进度条，就不画进度条；
// 名字再压到 NAME_FLOOR 还放不下，就不显示时间那一栏
const BAR_MIN = 6
// 桌面上进度条最短 1 格（约 9px，仍画得出一个圆点）：进度条、百分比和时间连这 1 格都放不下时，整组换到下一行。
// 取 1 格是为了单栏窗口最窄（灰底约 580px）时排法和以前一样：Chrome 模型按 1ch=8.75px、名字 26 格、带“需要你”算，
// 564px 下仍是一行、和改前逐像素一致（取 3 格时差几像素就会换行）；未在 App 里实测
const DESKTOP_BAR_MIN = 1
const NAME_FLOOR = 4

// 显示宽度：中日韩文字占两格
function cells(text: string): number {
  return [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
}

// 桌面上的进度条：细的圆角条，底轨淡灰，进行中橙色、完成绿色、出错红色
const BAR_PX = 8
const BAR_COLORS = { running: '#D9603E', done: '#6F8F4C', failed: '#D14B45' }
const BAR_TRACK = 'rgba(128,128,128,0.13)'

// 桌面把 SVG 当图片画（动画那条放进 iframe）：写 width="100%" 认不出来，会退回默认的 300 像素宽，
// 所以给一个很大的宽度，让它被所在的格子截到正好一行剩下的宽度。
// 不能再用 viewBox 横向拉伸：图形会跟着压扁，圆头只能靠往里收一段比例留位置，
// 格子一窄（约 270 像素以下）圆头就被裁成平头（2026-11-10 查到）。
// 现在 viewBox 只取一个 BAR_PX 见方、等比显示，1 个单位就是 1 像素，图形不变形；
// 长度用 vw 写，在 SVG 图片和 iframe 里 vw 都是条的实际显示宽度，圆角矩形两头在任何宽度下都是正圆
function barSvg(state: Row['state'], percent: number | null): string {
  const radius = BAR_PX / 2
  const rect = (width: string, color: string, extra = '') =>
    `<rect height="${BAR_PX}" rx="${radius}" fill="${color}" style="width:${width}"${extra}>`
  // 填充最短画成一个圆点，免得 1% 时只剩一条竖线
  const atLeastDot = (vw: number) => `max(${BAR_PX}px,${Math.round(vw * 100) / 100}vw)`
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${BAR_PX}" viewBox="0 0 ${BAR_PX} ${BAR_PX}" preserveAspectRatio="xMinYMid meet">`
  const track = `${rect('100vw', BAR_TRACK)}</rect>`

  if (percent === null) {
    // 算不出百分比：一小段在底轨上来回滑，表示还在跑
    const length = 22
    return (
      `${open}${track}${rect(atLeastDot(length), BAR_COLORS[state], ' opacity="0.85"')}` +
      `<animate attributeName="x" values="0;${100 - length}vw;0" dur="2.4s" repeatCount="indefinite"/></rect></svg>`
    )
  }

  // 有进度时至少画出一个圆点，0% 就只有底轨
  const fill = percent > 0 ? `${rect(atLeastDot(Math.min(100, percent)), BAR_COLORS[state])}</rect>` : ''

  return `${open}${track}${fill}</svg>`
}

// 桌面上几行任务之间的分隔线：1 像素的淡灰细线，和进度条一样用大宽度 + 拉伸铺满所在的格子
const DIVIDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1" viewBox="0 0 100 1" preserveAspectRatio="none">' +
  '<rect x="0" y="0" width="100" height="1" fill="rgba(128,128,128,0.18)"/></svg>'

const rows = atom({ plugin: 'task-progress', key: 'rows' } as const, [], { shape: 'rows-2' })

// 本会话自己的状态，模块重载后从 session.start 重新开始
let home: string | null = null
let dir: string | null = null
let selfId = ''
// -p 这类没人看的会话不写状态文件，免得在别的会话里冒出一行
let canWrite = false
let isInteractive = false
let lastClean = 0
let identity: { localId: string | null; title: string | null } = { localId: null, title: null }
let mine: TaskStatus | null = null
let steps: PlanStep[] = []
let lastBeat = 0
// 第一次刷新一定写一次：重载后 $.state 里可能还留着旧的行
let lastRows: string | null = null

async function save($: EngineInterface): Promise<void> {
  if (dir !== null && mine !== null && canWrite) {
    await $.fs.write(`${dir}/${mine.cliId}.json`, JSON.stringify(mine))
  }
}

// 在桌面 App 的会话记录里找到本会话：App 里的 id（点了能跳过来）和标题
async function findIdentity($: EngineInterface): Promise<void> {
  if (home === null) {
    return
  }
  const found = await $.process
    .run(['grep', '-rl', '--include=local_*.json', selfId, `${home}/${APP_SESSIONS}`], { timeoutMs: 5000 })
    .catch(() => null)
  const candidates = found?.exitCode === 0 ? found.stdout.split('\n').filter(Boolean) : []

  // id 也可能出现在别的会话的标题、摘要里：要确认记录本身就是这个会话
  let record: { sessionId?: unknown; title?: unknown; cliSessionId?: unknown } | null = null
  for (const path of candidates) {
    const parsed = await readJson<{ sessionId?: unknown; title?: unknown; cliSessionId?: unknown }>($, path)
    if (parsed?.cliSessionId === selfId) {
      record = parsed
      break
    }
  }
  if (record === null) {
    return
  }
  identity = {
    localId: typeof record.sessionId === 'string' && LOCAL_ID.test(record.sessionId) ? record.sessionId : null,
    title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim() : null,
  }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    // 别的会话正写到一半，下一轮再读
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (dir === null) {
    return
  }

  const now = await $.clock.now()
  const listed = await jsonFiles($, dir)
  const files = (listed ?? []).filter(entry => entry.name !== LEGACY_DISMISSED)
  const loaded = await Promise.all(
    files.filter(entry => now - entry.mtimeMs < READ_WITHIN_MS).map(async entry => [entry.name, await readJson<TaskStatus>($, `${dir}/${entry.name}`)] as const),
  )
  const byName = new Map(loaded.filter((pair): pair is readonly [string, TaskStatus] => pair[1] !== null && pair[1].v === 1))
  // 目录没列出来（偶发的读错）时不清理收起记录，免得误删
  const dismissed = await readDismissed($, dir, now, listed === null ? null : new Map(files.map(entry => [entry.name, entry.mtimeMs])), byName)
  const next = rowsOf([...byName.values()], now, dismissed, selfId, await textOf($))

  // 没变就不写，免得每 5 秒重画一次
  const text = JSON.stringify(next)
  if (text !== lastRows) {
    lastRows = text
    await update($, rows, () => next)
  }
}

type Listed = { name: string; mtimeMs: number }

// 列不出来（目录还没建、读错）是 null
async function jsonFiles($: EngineInterface, path: string): Promise<Listed[] | null> {
  const entries = await $.fs.list(path).catch(() => null)

  return entries === null ? null : entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
}

// 收起记录不看它自己有多旧：那一轮还是同一轮（startedAt 对得上）就一直收着。
// 对应的状态文件没了、太旧，或那个会话已经开始了新的一轮，这条记录就没用了，顺手删掉
async function readDismissed(
  $: EngineInterface,
  base: string,
  now: number,
  mtimes: Map<string, number> | null,
  statuses: Map<string, TaskStatus>,
): Promise<Record<string, number>> {
  const dismissed: Record<string, number> = {}
  const stale: string[] = []
  for (const entry of (await jsonFiles($, `${base}/${DISMISSED_DIR}`)) ?? []) {
    const path = `${base}/${DISMISSED_DIR}/${entry.name}`
    const mtime = mtimes?.get(entry.name)
    if (mtimes !== null && (mtime === undefined || now - mtime >= KEEP_FILES_MS)) {
      stale.push(path)
      continue
    }
    const startedAt = await readJson<number>($, path)
    const status = statuses.get(entry.name)
    if (typeof startedAt !== 'number') {
      continue
    }
    if (status !== undefined && status.startedAt !== startedAt) {
      stale.push(path)
      continue
    }
    dismissed[entry.name.slice(0, -'.json'.length)] = startedAt
  }
  await remove($, stale)

  return dismissed
}

// 插件接口没有删文件的调用，用 rm；别的会话可能刚删过，-f 不报错
async function remove($: EngineInterface, paths: string[]): Promise<void> {
  if (paths.length > 0) {
    await $.process.run(['rm', '-f', '--', ...paths], { timeoutMs: 5000 }).catch(() => null)
  }
}

// 删掉一周没动的状态文件（只删本 mod 自己写的格式）和早先版本的收起记录文件
async function cleanUp($: EngineInterface, now: number): Promise<void> {
  if (dir === null) {
    return
  }
  lastClean = now
  const old: string[] = []
  for (const entry of (await jsonFiles($, dir)) ?? []) {
    const path = `${dir}/${entry.name}`
    if (entry.name === LEGACY_DISMISSED) {
      old.push(path)
    } else if (now - entry.mtimeMs >= KEEP_FILES_MS) {
      const status = await readJson<TaskStatus>($, path)
      if (status?.v === 1 && `${status.cliId}.json` === entry.name) {
        old.push(path)
      }
    }
  }
  await remove($, old)
}

async function tick($: EngineInterface): Promise<void> {
  // 启动时没读到 HOME 或会话 id（偶发出错）：每次定时刷新再试一次
  if (dir === null) {
    await start($).catch(() => {})
  }
  const now = await $.clock.now()
  if (now - lastClean >= CLEAN_EVERY_MS) {
    await cleanUp($, now).catch(() => {})
  }
  if (mine?.state === 'running' && now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now
    mine = { ...mine, updatedAt: now }
    await save($).catch(() => {})
  }
  await refresh($)
}

// 收起一行：所有会话都不再显示它，直到那个会话开始新的一轮
async function dismiss($: EngineInterface, row: Row): Promise<void> {
  if (dir === null) {
    return
  }
  await $.fs.write(`${dir}/${DISMISSED_DIR}/${row.cliId}.json`, JSON.stringify(row.startedAt))
  await refresh($)
}

async function jumpTo($: EngineInterface, localId: string): Promise<void> {
  if (LOCAL_ID.test(localId)) {
    await $.process.run(['open', `claude://code/continue?session=${localId}`], { timeoutMs: 5000 })
  }
}

// 把各步还原回来（模块重载后从自己的状态文件接回来）；旧版本只存了步数，估时就没有了
function stepsOf(saved: TaskStatus): PlanStep[] {
  const count = saved.steps
  const plan = cleanPlan(saved.plan)
  if (plan !== undefined) {
    return plan
  }

  return count === null
    ? []
    : Array.from({ length: count.total }, (_, index): PlanStep => ({
        state: index < count.done ? 'completed' : index < count.done + count.active ? 'in_progress' : 'pending',
        lo: null,
        hi: null,
        needsYou: false,
        since: null,
      }))
}

async function start($: EngineInterface): Promise<void> {
  home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  selfId = await $.session.id().catch(() => '')
  canWrite = isInteractive || (await $.session.surfaces().catch(() => [])).length > 0
  if (home === null || selfId === '') {
    return
  }
  dir = `${home}/${STATUS_DIR}`
  await findIdentity($).catch(() => {})
  // 模块重载后接着用自己文件里的状态：一轮进行中被重载，这一轮不会变成没人管的“正在跑”；
  // 跑完了的也接回来，接下来系统插进来的一轮（后台任务的通知）还能接着算这个任务
  const saved = await readJson<TaskStatus>($, `${dir}/${selfId}.json`)
  if (saved?.v === 1 && saved.cliId === selfId) {
    mine = saved
    steps = stepsOf(saved)
  }
  await cleanUp($, await $.clock.now()).catch(() => {})
}

// /clear 后进程还在、会话 id 换了，也不会再有 session.start：每轮开始时对一下
async function reidentify($: EngineInterface): Promise<void> {
  const id = await $.session.id().catch(() => selfId)
  if (id === '' || id === selfId) {
    return
  }
  selfId = id
  mine = null
  steps = []
  // 桌面里还是同一个会话：找不到新记录就沿用原来的 App 会话 id 和标题
  await findIdentity($).catch(() => {})
}

async function beginTurn($: EngineInterface, text: string): Promise<void> {
  await reidentify($)
  if (selfId === '') {
    return
  }
  if (!canWrite) {
    canWrite = (await $.session.surfaces().catch(() => [])).length > 0
  }
  const now = await $.clock.now()
  const task = taskLine(text)
  lastBeat = now
  const canContinue = mine !== null && (mine.finishedAt === null || now - mine.finishedAt < CONTINUE_WITHIN_MS)
  if (task === null && mine !== null && canContinue) {
    // 没有人话的一轮（空的续接、后台任务的通知、系统提醒）：还是原来那个任务，起点和步骤都不动
    mine = { ...mine, ...identity, state: 'running', updatedAt: now, finishedAt: null }
  } else {
    steps = []
    mine = {
      v: 1,
      cliId: selfId,
      ...identity,
      task: task ?? '',
      state: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      steps: null,
    }
  }
  await save($)
}

async function afterPlan($: EngineInterface, tool: string, input: unknown): Promise<void> {
  if (mine?.state !== 'running') {
    return
  }
  const now = await $.clock.now()
  steps = applyPlan(steps, tool, input, now)
  mine = { ...mine, steps: countSteps(steps), plan: steps, updatedAt: now }
  await save($).catch(() => {})
  await refresh($).catch(() => {})
}

async function finishTurn($: EngineInterface, state: TaskStatus['state']): Promise<void> {
  if (mine?.state !== 'running') {
    return
  }
  const now = await $.clock.now()
  // 标题可能是这一轮才起好的
  await findIdentity($).catch(() => {})
  mine = { ...mine, ...identity, state, updatedAt: now, finishedAt: now }
  await save($).catch(() => {})
  await refresh($).catch(() => {})
}

// 终端里一行的格数：左右内边距各 2（和 repo-bar 的左缩进一致）、图标列和间隔，名字，（2 格间隔 + 进度条），
// 2 格间隔 + 百分比，2 格间隔 + 时间（和它后面 1 格）+ “×” 1 格。加起来不超过 bodyColumns
function terminalColumns(bodyColumns: number, wantedName: number, percentColumns: number, sideColumns: number) {
  const room = bodyColumns - (2 * TERMINAL_GRID.padX + TERMINAL_GRID.icon + TERMINAL_GRID.gap)
  const sideBox = (sideColumns > 0 ? sideColumns + 1 : 0) + 1
  const rest = 2 + percentColumns + 2 + sideBox
  const withBar = Math.min(wantedName, room - rest - 2 - BAR_MIN)
  if (withBar >= Math.min(wantedName, NAME_MIN)) {
    return { nameColumns: withBar, barColumns: room - rest - 2 - withBar, showSide: true }
  }
  const withoutBar = Math.min(wantedName, room - rest)
  if (withoutBar >= NAME_FLOOR || sideColumns === 0) {
    return { nameColumns: Math.max(NAME_FLOOR, withoutBar), barColumns: 0, showSide: true }
  }

  return { nameColumns: Math.max(NAME_FLOOR, Math.min(wantedName, room - rest + sideColumns + 1)), barColumns: 0, showSide: false }
}

// 输入框上方各层之间统一用这一档间距
const GAP = 'xs'

// 输入框上方几个 mod 共用的左侧网格（repo-bar、task-progress、done-alert、retro-watch、upgrade-check 逐字一致，
// repo-bar 的测试 grid-same.test.sh 会比对）。左右内边距、图标列（内容居中、不收缩）、间隔、正文右端留白按显示端分别设定：
// - 终端：内边距 2 格、图标列 4 格、间隔 1 格，右端不另留白。
// - 桌面：横向的数字（宽度、左右内外边距、columnGap）按 CSS 的 ch 画（正文字体里数字 0 的宽度，约 8.75px，按截图反推），
//   可以写小数、负数（App 渲染代码查得）。
//   内边距 0、图标列 3.3 格、间隔 0.75 格：图标中心、正文起点、右端的 × 对齐下面输入框的“+”、提示文字、麦克风
//   （2026-11-11 截图逐像素量了 repo-bar、task-progress、done-alert：图标偏右 0.5–0.75px，文字 ±1px，× 偏 0.25px，
//   repo-bar 的“−”和 ●、✓ 中心重合；retro-watch、upgrade-check 不在截图里，按同一套数推定）。
//   外壳没有右内边距：会顶到右端的文字再留 1.3 格（textEnd），目标是右端和 × 字形右缘齐平
//   （按截图里 × 字形右缘到它那一行右边缘约 11.5px 推算，未实测）。
// - 其他（VS Code、手机）照旧：内边距 1 格、图标列 4 格、间隔 1 格，右端不另留白。
// 带边框的卡片用 edgesOf：终端的边框占 1 格，内边距少给 1 格；桌面的边框只有 1px，左右外边距给 -0.11 格（约 1px）
// 把它让到外面（输入框上方的容器把 mod 画区 [data-engine-site] 用 -mx-[8px] 往两边各伸出 8px、再用 px-[8px] 缩回内容，
// 外移的边框落在伸出的 8px 里，截图里没被裁），
// 卡片里的图标、正文、× 和不带边框的行在同一位置；
// 其他显示端不补偿。repo-bar、task-progress 不带边框，用不到 edgesOf，为了五份一致照样保留。
// 外壳上的 paddingX、paddingLeft（桌面上值是 0）不要当成多余删掉：桌面 App 的渲染代码对没有 hover、属性只有外边距、
// flexDirection、flexWrap、alignItems、justifyContent、gap 类的 Box 另有处理（2026-11-11 审查时查到判定条件，
// 命中后的效果没实测），带着内边距属性就不会命中
type Grid = { padX: number; icon: number; gap: number; textEnd: number }
const TERMINAL_GRID: Grid = { padX: 2, icon: 4, gap: 1, textEnd: 0 }
const DESKTOP_GRID: Grid = { padX: 0, icon: 3.3, gap: 0.75, textEnd: 1.3 }
const OTHER_GRID: Grid = { padX: 1, icon: 4, gap: 1, textEnd: 0 }
const DESKTOP_BORDER_OUTSET = -0.11

function gridOf(surface: string): Grid {
  return surface === 'terminal' ? TERMINAL_GRID : surface === 'desktop' ? DESKTOP_GRID : OTHER_GRID
}

// 一层外壳的左右内外边距；hasBorder 是这一层在这个显示端上带不带边框
function edgesOf(surface: string, hasBorder: boolean): { paddingX: number; marginX: number } {
  const { padX } = gridOf(surface)
  if (!hasBorder) {
    return { paddingX: padX, marginX: 0 }
  }

  return surface === 'terminal' ? { paddingX: padX - 1, marginX: 0 } : surface === 'desktop' ? { paddingX: padX, marginX: DESKTOP_BORDER_OUTSET } : { paddingX: padX, marginX: 0 }
}

// 几个 mod 叠在输入框上方：下面只剩 App 自己那层（空的）时不留间距，各层之间的间距才都一样
function hasContent(node: unknown): boolean {
  return !(typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'engine')
}

export const register: Register = on => {
  // 每条 hook 都不往外抛错：出错只是这一次不更新，下一次定时刷新再来
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 定时器先挂上：后面哪一步出错，也照样每 5 秒刷新
    $.clock.every(REFRESH_MS, () => {
      void tick($).catch(() => {})
    })
    isInteractive = e.isInteractive
    await start($).catch(() => {})
    await refresh($).catch(() => {})

    return result
  })

  // 你发了一条消息，一轮开始
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await beginTurn($, e.text).catch(() => {})
    }

    return next(e)
  })

  // 进度来自任务清单：每做完一步，百分比往前走
  on('tool.call', { tool: ['TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up'] }, async ($, e, next) => {
    const ran = await next(e)
    // 计划真的更新成功了才算数
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      await afterPlan($, String(tool), input).catch(() => {})
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const state = e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
      await finishTurn($, state).catch(() => {})
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    if (mine?.state === 'running') {
      const now = await $.clock.now().catch(() => mine?.updatedAt ?? 0)
      mine = { ...mine, state: 'stopped', finishedAt: now }
      await save($).catch(() => {})
    }

    return next(e)
  })

  // 画在输入框上方；别的 mod（repo-bar、done-alert）画的内容接在下面
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    // 形状标签已经挡掉旧版本画的行；万一漏过来（没有 note、isOver），也先补齐，不让整条画不出来
    const list = (await read($, rows)).map(row => ({ ...row, isOver: row.isOver === true, note: typeof row.note === 'string' ? row.note : null }))
    if (list.length === 0 || e.props.hasSurvey) {
      return below
    }

    const isTerminal = e.surface === 'terminal'
    const isDesktop = e.surface === 'desktop'
    const grid = gridOf(e.surface)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Svg = isDesktop ? $.ui.resolve(e).Svg : null
    const t = await textOf($)
    // “本会话”在桌面是小一号的字；终端不认字号，按整格算，再加和名字之间的 1 格
    const selfColumns = isTerminal ? cells(t.self) + 1 : t.selfColumns
    const wantedName = Math.min(NAME_MAX, Math.max(NAME_MIN, ...list.map(row => cells(row.name) + (row.isSelf ? selfColumns : 0))))
    // 时间那一栏：正在跑的是预计还剩多久（或已跑多久），跑完的是用了多久，始终显示
    // 百分比和时间两栏按实际最宽的文字定宽：右对齐的数字都对得齐，后面也不会空出一截
    const percentText = (row: Row) => (row.percent === null ? '—' : `${row.percent}%`)
    const percentColumns = Math.max(...list.map(row => cells(percentText(row))))
    // “需要你”的提醒跟在时间后面，隔 1 格
    const withNote = Math.max(...list.map(row => cells(row.side) + (row.note === null ? 0 : 1 + cells(row.note))))
    const timeOnly = Math.max(...list.map(row => cells(row.side)))
    // 只有终端按格数排；桌面的进度条自己填满剩下的宽度，名字一栏照旧。
    // 终端里进度条和时间都放得下、名字也不用为它变窄，才带上提醒；不然先省掉提醒，时间照留
    const full = isTerminal ? terminalColumns(e.props.bodyColumns, wantedName, percentColumns, withNote) : null
    const plain = isTerminal ? terminalColumns(e.props.bodyColumns, wantedName, percentColumns, timeOnly) : null
    // 提示只占进度条让出来的地方：要压窄名字才放得下，就不带（不然终端变宽一格，名字反而变短）
    const showNote = full === null || plain === null || (full.barColumns > 0 && full.showSide && full.nameColumns >= plain.nameColumns)
    const sideColumns = showNote ? withNote : timeOnly
    const { nameColumns, barColumns, showSide } = isTerminal
      ? (showNote ? full : plain) ?? { nameColumns: wantedName, barColumns: 0, showSide: true }
      : { nameColumns: wantedName, barColumns: 0, showSide: true }
    // 名字一栏被压窄到放不下“本会话”时就不标了
    const showSelf = !isTerminal || nameColumns >= selfColumns + NAME_FLOOR

    return (
      <Box flexDirection="column">
        {/* 不带外框：只按共用网格留内边距（repo-bar 只有左内边距），图标列、正文起点和 repo-bar 上下对齐；
            几行之间靠 xs 一档的行距分开（桌面留一点空，终端是 0 行、照旧紧凑） */}
        <Box flexDirection="column" rowGap={GAP} paddingX={grid.padX} marginBottom={hasContent(below) ? GAP : 0}>
          {list.flatMap((row, index) => {
            const color = row.state === 'running' ? 'claude' : row.state === 'done' ? 'success' : 'error'
            const percent = row.percent ?? 0
            const filled = Math.round((percent / 100) * barColumns)
            // 分隔线只画在桌面上，从正文起点开始（图标列不画），和名字左对齐；
            // 终端里每条线要多占一行，输入框上方的行数有限，照旧不画
            const divider =
              index > 0 && Svg !== null ? (
                <Box key={`divider-${row.cliId}`} marginLeft={grid.icon + grid.gap}>
                  {/* alt 不能留空（空的可能让整棵树被拒）；画不出图的地方显示成一道短横，正好也是分隔 */}
                  <Svg source={DIVIDER_SVG} alt="—" height={1} />
                </Box>
              ) : null

            const icon = (
              <Box width={grid.icon} flexShrink={0} justifyContent="center">
                <Text color={color} bold>
                  {row.state === 'running' ? '●' : row.state === 'done' ? '✓' : '✗'}
                </Text>
              </Box>
            )
            const open = <Button key={`open-${row.cliId}`} plain label={row.name} onPress={() => void jumpTo($, row.localId ?? '').catch(() => {})} />
            // 名字一栏：终端按算好的格数定宽、不收缩；别处先按 nameColumns 占位（几行的进度条起点对齐），
            // 窄到一行放不下名字时才收缩、截断（minWidth={0} 让它能缩到内容宽度以下）
            const name = (
              <Box width={nameColumns} {...(isTerminal ? { flexShrink: 0 } : { minWidth: 0 })} columnGap={1}>
                {row.isSelf || row.localId === null ? (
                  <Text wrap="truncate-end">{row.name}</Text>
                ) : isDesktop ? (
                  // 桌面的原生按钮左侧自带一段留白：把按钮左移 1 格，和纯文字的名字、上面 repo-bar 的文字对齐
                  // （2026-11-11 截图量过：比纯文字的名字靠右约 0.5–1px）；
                  // 宽度多给 1 格抵掉左移，名字照样在这一栏里截断，这一栏的位置和宽度不变，后面的进度条各行仍然对齐
                  <Box marginLeft={-1} width={nameColumns + 1} minWidth={0}>
                    {open}
                  </Box>
                ) : (
                  open
                )}
                {row.isSelf && showSelf && (
                  <Box flexShrink={0}>
                    <Text dimColor size="caption">
                      {t.self}
                    </Text>
                  </Box>
                )}
              </Box>
            )
            const bar =
              Svg !== null ? (
                // 动画的那条画在 iframe 里，不给宽度时默认只有 300px，宽屏下比别的行短：给一个很大的宽度，让格子截到剩下的宽度
                <Svg source={barSvg(row.state, row.percent)} alt={row.percent === null ? t.inProgress : `${row.percent}%`} height={BAR_PX} {...(row.percent === null && row.state === 'running' ? { isInteractive: true, width: 4000 } : {})} />
              ) : null
            // 不收缩：进度条图片的固有宽度很大，收缩量按它分摊时，没写的话这一栏会被压到文字宽度，几行的进度条右端就不齐
            const percentBox = (
              <Box width={percentColumns} flexShrink={0} justifyContent="flex-end">
                <Text bold={row.state === 'running' ? true : undefined} tabular dimColor={row.percent === null}>
                  {percentText(row)}
                </Text>
              </Box>
            )
            const side =
              sideColumns > 0 && showSide ? (
                // 终端以外：时间和“需要你”放不下时，“需要你”换到时间下面（最窄时这一栏比正文还宽）
                <Box width={sideColumns} {...(isTerminal ? {} : { minWidth: 0, flexWrap: 'wrap' as const })} columnGap={1}>
                  <Text color={row.isOver ? 'warning' : undefined} dimColor={row.isOver ? undefined : true} tabular>
                    {row.side}
                  </Text>
                  {showNote && row.note !== null && (
                    <Text color="claude" bold>
                      {row.note}
                    </Text>
                  )}
                </Box>
              ) : null
            const dismissButton = <Button key={`dismiss-${row.cliId}`} plain dimColor label="×" onPress={() => void dismiss($, row).catch(() => {})} />

            if (isTerminal) {
              // 终端按格数排好，一行放得下（放不下的已在 terminalColumns 里让掉）
              return [
                <Box key={`task-${row.cliId}`} columnGap={grid.gap} alignItems="center">
                  {icon}
                  <Box flexGrow={1} columnGap={2} alignItems="center">
                    {name}
                    {barColumns > 0 && (
                      <Text>
                        <Text color={color}>{'━'.repeat(filled)}</Text>
                        <Text dimColor>{'─'.repeat(barColumns - filled)}</Text>
                      </Text>
                    )}
                    {percentBox}
                    <Box columnGap={1} alignItems="center">
                      {side}
                      {dismissButton}
                    </Box>
                  </Box>
                </Box>,
              ]
            }

            // 桌面等其他显示端：宽度够时一行（名字、进度条、百分比、时间），各行的进度条照样对齐；
            // 一行放不下时进度条那一组整组换到第二行，从正文起点开始；再窄时间换到第三行，“需要你”换到时间下面。
            // × 在正文外面、图标列和它都对着第一行（alignItems="flex-start"，各项都是一行高）。
            // 进度条那一组按“最短进度条 + 百分比 + 时间”占位，放不下才换行；换行后占满一行
            // 只有桌面画进度条；别处那一栏只是撑开的空白，不占位
            const barMin = bar !== null ? DESKTOP_BAR_MIN : 0
            const progressBasis = barMin + 2 + percentColumns + (side !== null ? 2 + sideColumns : 0)
            return [
              divider,
              <Box key={`task-${row.cliId}`} columnGap={grid.gap} alignItems="flex-start">
                {icon}
                <Box flexGrow={1} minWidth={0} flexWrap="wrap" columnGap={2} rowGap={GAP} alignItems="center">
                  {name}
                  <Box flexGrow={1} width={progressBasis} minWidth={0} flexWrap="wrap" columnGap={2} rowGap={GAP} alignItems="center">
                    <Box flexGrow={1} width={barMin} minWidth={0} alignItems="center">
                      {bar}
                    </Box>
                    {percentBox}
                    {side}
                  </Box>
                </Box>
                {/* 和时间之间共 1 格：外层间隔 grid.gap，再补上差的那点 */}
                <Box flexShrink={0} paddingLeft={1 - grid.gap}>
                  {dismissButton}
                </Box>
              </Box>,
            ].filter(node => node !== null)
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
