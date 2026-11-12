import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Baseline, Place, Quota, Spend } from '../types'
import type { Text as Words } from './i18n'
import { textOf } from './i18n'

// 仓库归属哪家主体：路径或 origin 地址里含左边的字样，就标右边的名字。来自插件配置项 entities（每项写成“字样=名字”），
// 从插件市场装的 mod 一更新代码就被覆盖，所以不写在代码里。配置一改，引擎带着新值重新加载模块
let entities: [string, string][] = []

// “字样=名字”：按第一个等号分开，两边去掉空白；缺一边的不算
export function parseEntities(value: unknown): [string, string][] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return items.flatMap(item => {
    if (typeof item !== 'string') return []
    const at = item.indexOf('=')
    const hint = at < 0 ? '' : item.slice(0, at).trim()
    const name = at < 0 ? '' : item.slice(at + 1).trim()
    return hint && name ? [[hint, name] as [string, string]] : []
  })
}

// 用量主要靠引擎推过来（session.measure：每轮结束、额度窗口每动一个点）。回合进行中另外每 15 秒读一次，
// 花费涨得才跟得上；空闲时放慢到 2 分钟一次，只为接上别的会话存下的新额度、去掉过了重置时间的窗口
const SPEND_REFRESH_MS = 15_000
const IDLE_REFRESH_MS = 120_000
// 读用量超过这么久没回音就放弃这一次，免得排队的刷新越积越多
const USAGE_TIMEOUT_MS = 10_000

// 额度、上下文超过这个比例时变黄提醒，并显示多久后重置
const WARN_PERCENT = 80

const place = atom({ plugin: 'repo-bar', key: 'place' } as const, null)
const spend = atom({ plugin: 'repo-bar', key: 'spend' } as const, null)
const baseline = atom({ plugin: 'repo-bar', key: 'baseline' } as const, { usdAtLastTurn: null, quotaAtStart: {}, quotaResetsAt: {} })
const isCollapsed = atom({ plugin: 'repo-bar', key: 'isCollapsed' } as const, false)

// 只有可能换分支、换目录、动提交的命令之后才重读
const MOVES = /\bgit\s+(checkout|switch|commit|merge|rebase|reset|stash|pull|worktree|restore|add|rm|mv)\b|\bcd\s/

async function readPlace($: EngineInterface): Promise<Place> {
  const cwd = await $.session.cwd()
  const repo = await $.session.repo()
  const name = (repo?.root ?? cwd).split('/').filter(Boolean).pop() ?? cwd

  if (repo === null) {
    return { name, isRepo: false, branch: null, dirty: 0, entity: entityOf(cwd) }
  }

  const [head, status] = await Promise.all([
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 }),
    $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 5000 }),
  ])
  const branch = head.exitCode === 0 ? head.stdout.trim() : null
  const dirty = status.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : 0

  return { name, isRepo: true, branch, dirty, entity: entityOf(`${repo.root} ${repo.remote ?? ''}`) }
}

function entityOf(text: string): string | null {
  const lower = text.toLowerCase()

  return entities.find(([hint]) => lower.includes(hint.toLowerCase()))?.[1] ?? null
}

// 不往外抛错：几个 hook（包括 Bash 的 tool.call）都在工具跑完后调它
async function refresh($: EngineInterface): Promise<void> {
  const next = await readPlace($).catch(() => null)
  await update($, place, () => next).catch(() => {})
}

// App 重开后会话在新进程里恢复，会话里的读数会丢（热重载不丢）；引擎要等下一次回复才有额度，
// 一次回复也不一定带齐所有额度窗口。读数存进插件自己的存储（跨进程、跨会话）：额度是整个账号共用的，
// 存一份、按窗口逐项更新；上轮花费和“会话期间”的起点按会话分开存
const SAVED_QUOTAS = 'quotas'
// 每个会话一个键（turn:<会话键>），各写各的，几个会话同时写不会互相覆盖（存储没有按版本写的接口）
const SAVED_SESSION_PREFIX = 'turn:'
// 早先所有会话挤在一个键里，先读新键，读不到再从这里找
const LEGACY_SESSIONS = 'turns'
// 按会话存的只留最近这么多个会话
const SAVED_SESSIONS_MAX = 20
// 额度按这个顺序显示，少了哪项用存着的补上时位置也不变
const QUOTA_ORDER = ['five_hour', 'seven_day', 'spend_limit']

// 一个会话存下的：算增量用的基准，加上一轮的花费
type SavedSession = Partial<Baseline> & { lastTurnUsd: number | null; at: number }

// 存储读写失败（或测试里没有替身）时当没存过，不影响这一行显示
async function loadSaved<T>($: EngineInterface, key: string): Promise<T | undefined> {
  return ((await $.store.get(key).catch(() => undefined)) ?? undefined) as T | undefined
}

// 上次写进存储的内容，没变就不重复写
let savedQuotasText = ''
let savedSessionText = ''

// 两个读数哪个新：重置时间更晚的是新窗口；同一个窗口里用量只增不减，百分比高的更新。
// 没有重置时间的读数无从比较，当它是新的
function isNewer(reading: SessionRateLimit, other: SessionRateLimit): boolean {
  const at = reading.resetsAt === undefined ? NaN : Date.parse(reading.resetsAt)
  const otherAt = other.resetsAt === undefined ? NaN : Date.parse(other.resetsAt)
  if (Number.isNaN(at) || Number.isNaN(otherAt)) {
    return true
  }

  return at !== otherAt ? at > otherAt : reading.percentUsed >= other.percentUsed
}

// 过了重置时间的窗口不算数：本次读数是上一次回复带来的，空闲几小时后可能早已过期
function isCurrent(limit: SessionRateLimit, now: number): boolean {
  return limit.resetsAt === undefined || Date.parse(limit.resetsAt) > now
}

// 额度：每个窗口取本次读数和存着的（别的会话可能刚读到更新的）里较新的那个；存着的在 canFill 时才用，
// 已过重置时间、或没有重置时间（无从判断是否过期）的存着的那项不补。存回去的也是较新的，不会拿旧读数盖掉新的
async function rateLimitsOf($: EngineInterface, measured: SessionRateLimit[], canFill: boolean, now: number): Promise<SessionRateLimit[]> {
  const live = measured.filter(limit => isCurrent(limit, now))
  if (!canFill && live.length === 0) {
    return []
  }
  const saved = await loadSaved<SessionRateLimit[]>($, SAVED_QUOTAS)
  const stored = (Array.isArray(saved) ? saved : []).filter(limit => limit.resetsAt !== undefined && isCurrent(limit, now))
  const kinds = [...new Set([...live, ...stored].map(limit => limit.kind))]
  const merged = kinds.flatMap(kind => {
    const reading = live.find(limit => limit.kind === kind)
    const other = stored.find(limit => limit.kind === kind)
    const newest = reading !== undefined && (other === undefined || isNewer(reading, other)) ? reading : other

    return newest === undefined ? [] : [newest]
  })
  const rank = (kind: string) => (QUOTA_ORDER.includes(kind) ? QUOTA_ORDER.indexOf(kind) : QUOTA_ORDER.length)
  merged.sort((x, y) => rank(x.kind) - rank(y.kind))

  const text = JSON.stringify(merged)
  if (live.length > 0 && text !== savedQuotasText) {
    // 写成功了才记下，失败的下次再写
    await $.store
      .set(SAVED_QUOTAS, merged)
      .then(() => {
        savedQuotasText = text
      })
      .catch(() => {})
  }
  return canFill ? merged : live
}

// 会话记录的键：桌面端用桌面会话 id（local_…），回退到之前的消息重来、App 重开都不变；
// 终端里没有这个变量，用 CLI 会话 id（回退后会变）
async function sessionKey($: EngineInterface): Promise<string | null> {
  const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID').catch(() => undefined)
  return host !== undefined && host !== '' ? host : await $.session.id().catch(() => null)
}

async function saveSession($: EngineInterface, session: Omit<SavedSession, 'at'>, now: number): Promise<void> {
  const id = await sessionKey($)
  // 连键一起比：换了键（比如 /clear 换了 CLI 会话 id）后，内容没变也要给新键记一份
  const text = `${id}\n${JSON.stringify(session)}`
  if (id === null || text === savedSessionText) {
    return
  }
  const isSaved = await $.store
    .set(`${SAVED_SESSION_PREFIX}${id}`, { ...session, at: now })
    .then(() => true)
    .catch(() => false)
  // 写成功了才记下，失败的下次再写
  if (isSaved) {
    savedSessionText = text
    await pruneSessions($).catch(() => {})
  }
}

// 只留最近的 SAVED_SESSIONS_MAX 个会话；几个会话同时删同一个键也没关系
async function pruneSessions($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(SAVED_SESSION_PREFIX))
  if (keys.length <= SAVED_SESSIONS_MAX) {
    return
  }
  const dated = await Promise.all(keys.map(async key => ({ key, at: (await loadSaved<SavedSession>($, key))?.at ?? 0 })))
  const old = dated.sort((x, y) => y.at - x.at).slice(SAVED_SESSIONS_MAX)
  await Promise.all(old.map(({ key }) => $.store.delete(key).catch(() => {})))
}

// 先按会话记录的键找，找不到再按 CLI 会话 id 找（改用桌面会话 id 之前存下的记录）；
// 每样先找每个会话一个键的新存法，再找早先挤在一起的旧存法
async function loadSession($: EngineInterface): Promise<SavedSession | undefined> {
  const keys = [await sessionKey($), await $.session.id().catch(() => null)].filter((key): key is string => key !== null)
  for (const key of keys) {
    const saved = await loadSaved<SavedSession>($, `${SAVED_SESSION_PREFIX}${key}`)
    if (saved !== undefined) {
      return saved
    }
  }
  const legacy = await loadSaved<Record<string, SavedSession>>($, LEGACY_SESSIONS)
  for (const key of keys) {
    const saved = legacy?.[key]
    if (saved !== undefined) {
      return saved
    }
  }

  return undefined
}

// 定时刷新和回合结束的刷新会交错：排成一队逐个跑，免得后跑完的那次把先写好的基准写回旧值
let spendQueue: Promise<void> = Promise.resolve()

// 一次用量读数：$.session.usage() 读的，或 session.measure 推过来的
type Figures = { context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost }

// isTurnEnd：主回合结束时，把这次的累计花费记为下一轮的起点；figures：引擎推过来的读数，没有就自己读
function refreshSpend($: EngineInterface, isTurnEnd: boolean, figures?: Figures): Promise<void> {
  spendQueue = spendQueue.then(() => refreshSpendNow($, isTurnEnd, figures)).catch(() => {})
  return spendQueue
}

// 读用量，超时或出错是 null：一次卡住的读数不会把后面排队的刷新都堵住
function readUsage($: EngineInterface): Promise<Figures | null> {
  return new Promise(resolve => {
    const timer = $.clock.after(USAGE_TIMEOUT_MS, () => resolve(null))
    $.session.usage().then(
      usage => {
        timer.cancel()
        resolve(usage)
      },
      () => {
        timer.cancel()
        resolve(null)
      },
    )
  })
}

async function refreshSpendNow($: EngineInterface, isTurnEnd: boolean, figures?: Figures): Promise<void> {
  const usage = figures ?? (await readUsage($))
  if (usage === null) {
    return
  }
  lastSpendAt = await $.clock.now().catch(() => 0)
  const now = lastSpendAt

  const usd = usage.cost?.usd ?? null
  const base = await read($, baseline)
  // 会话里的基准丢了（刚重载）：上一轮的起点、上轮花费、“会话期间”的起点从存储里接回来
  const isLost = base.usdAtLastTurn === null && Object.keys(base.quotaAtStart).length === 0
  const saved = isLost ? await loadSession($) : undefined
  const restoredStart = base.usdAtLastTurn ?? saved?.usdAtLastTurn ?? null
  // 起点比现在的累计还大（/clear 后花费从 0 算起）：起点作废，按没有起点算
  const usdAtLastTurn = restoredStart !== null && usd !== null && usd < restoredStart ? null : restoredStart
  const quotaAtStart = { ...(saved?.quotaAtStart ?? base.quotaAtStart) }
  const quotaResetsAt = { ...(saved?.quotaResetsAt ?? base.quotaResetsAt ?? {}) }
  // 只有这个会话实测过额度（是订阅：这次或以前读到过）才用存着的补；存着的额度是整个账号共用的，API key 会话不该显示
  const hasMeasured = usage.rateLimits.length > 0 || Object.keys(quotaAtStart).length > 0
  const rateLimits = await rateLimitsOf($, usage.rateLimits, hasMeasured, now)
  // “会话期间”的起点只用本次实测、还没过期的读数定，存储补上的旧读数不算
  for (const limit of usage.rateLimits.filter(limit => isCurrent(limit, now))) {
    const start = quotaAtStart[limit.kind]
    const seenReset = quotaResetsAt[limit.kind]
    // 重置时间变了（或读数比基准还低），说明窗口中途重置过：新窗口的用量都发生在会话期间
    const hasReset = (seenReset !== undefined && limit.resetsAt !== undefined && limit.resetsAt !== seenReset) || (start !== undefined && limit.percentUsed < start)
    quotaAtStart[limit.kind] = start === undefined ? limit.percentUsed : hasReset ? 0 : start
    if (limit.resetsAt !== undefined) {
      quotaResetsAt[limit.kind] = limit.resetsAt
    }
  }

  const quotas: Quota[] = rateLimits.map(limit => ({
    kind: limit.kind,
    percentUsed: limit.percentUsed,
    sinceStart: Math.max(0, limit.percentUsed - (quotaAtStart[limit.kind] ?? limit.percentUsed)),
    resetsAt: limit.resetsAt ?? null,
  }))

  const old = await read($, spend)
  const lastTurnUsd = isTurnEnd ? (usd !== null ? usd - (usdAtLastTurn ?? 0) : null) : (old?.lastTurnUsd ?? saved?.lastTurnUsd ?? null)
  const next: Baseline = { usdAtLastTurn: isTurnEnd ? usd : (usdAtLastTurn ?? usd), quotaAtStart, quotaResetsAt }
  const shown: Spend = {
    usd,
    lastTurnUsd,
    contextTokens: usage.context.tokens ?? null,
    contextPercent: usage.context.percent ?? null,
    quotas,
  }
  // 数没变就不写，免得每次刷新都重画
  if (JSON.stringify(shown) !== JSON.stringify(old)) {
    await update($, spend, () => shown)
  }
  if (JSON.stringify(next) !== JSON.stringify(base)) {
    await update($, baseline, () => next)
  }
  await saveSession($, { ...next, lastTurnUsd }, now)
}

// 主回合是否在跑，和上次刷新用量的时间：定时器按它们决定这次要不要读
let isTurnRunning = false
let lastSpendAt = 0

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const shown = await read($, spend)
  const hasExpired = shown?.quotas.some(quota => quota.resetsAt !== null && Date.parse(quota.resetsAt) <= now) ?? false
  if (isTurnRunning || hasExpired || now - lastSpendAt >= IDLE_REFRESH_MS) {
    await refreshSpend($, false)
  }
}

function resetsIn(resetsAt: string | null, now: number, t: Words): string | null {
  const at = resetsAt === null ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) {
    return null
  }

  const minutes = Math.round((at - now) / 60000)
  if (minutes < 60) {
    return t.resetsInMinutes(minutes)
  }
  if (minutes < 48 * 60) {
    return t.resetsInHours(Math.round(minutes / 60))
  }

  return t.resetsInDays(Math.round(minutes / 1440))
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

export const register: Register = (on, options) => {
  entities = parseEntities(options.entities)
  // 每条 hook 都不往外抛错：出错只是这一次不更新
  on('session.start', async ($, e, next) => {
    $.clock.every(SPEND_REFRESH_MS, () => {
      void tick($).catch(() => {})
    })
    const result = await next(e)
    await Promise.all([refresh($), refreshSpend($, false)])

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
    }

    return next(e)
  })

  // 引擎推过来的用量：每轮结束、额度窗口每动一个点
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshSpend($, false, e)

    return result
  })

  // 子代理的回合也花钱，花费每个回合结束都刷新；“上轮”和仓库只按主回合算
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMain = e.agentId === undefined
    if (isMain) {
      isTurnRunning = false
    }
    await Promise.all([isMain ? refresh($) : undefined, refreshSpend($, isMain)])

    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (MOVES.test(e.command)) {
      await refresh($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 下层（比如 done-alert 的完成提示）画的内容接在这一行下面，几个 mod 能共用输入框上方
    const below = await next(e)
    const here = await read($, place)
    const spent = await read($, spend)
    if (e.props.hasSurvey || (here === null && spent === null)) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const grid = gridOf(e.surface)
    const isTerminal = e.surface === 'terminal'
    const t = await textOf($)
    const isShort = await read($, isCollapsed)
    // 只有要显示重置时间时才读时钟
    const now = spent?.quotas.some(quota => quota.percentUsed >= WARN_PERCENT) ? await $.clock.now() : 0
    // 有额度读数说明是订阅，美元只是按 API 价格折算
    const isSubscription = (spent?.quotas.length ?? 0) > 0

    // 一项数据：淡色标签 + 加粗数值，整体不拆行。终端以外，一行放不下时备注整段换到下一行、从这一项的起点开始，
    // 不在旁边折成细长的一列（桌面三栏最窄时这块只有约 235px）
    const figure = (key: string, label: string, value: string, isWarn = false, note?: string) => (
      <Box key={key} columnGap={1} {...(isTerminal ? {} : { flexWrap: 'wrap' as const })}>
        <Text dimColor>{label}</Text>
        <Text bold color={isWarn ? 'warning' : undefined}>
          {value}
        </Text>
        {note !== undefined && <Text dimColor>{note}</Text>}
      </Box>
    )

    const quotaFigures = (spent?.quotas ?? []).map(quota => {
      const isWarn = quota.percentUsed >= WARN_PERCENT
      const label = t.quotas[quota.kind] ?? quota.kind
      if (isShort) {
        return figure(`quota-${quota.kind}`, label, `${quota.percentUsed}%`, isWarn)
      }

      const parts = [
        quota.sinceStart > 0 ? t.sinceStart(quota.sinceStart.toFixed(1)) : null,
        isWarn ? resetsIn(quota.resetsAt, now, t) : null,
      ].filter(part => part !== null)

      return figure(`quota-${quota.kind}`, label, `${quota.percentUsed}%`, isWarn, parts.length > 0 ? `(${parts.join(t.noteJoiner)})` : undefined)
    })

    // 左边是和卡片同宽的图标列放“−/+”，右边的数据一行放得下就一行，窄了折行时从正文起点对齐
    return (
      <Box flexDirection="column">
        <Box paddingLeft={grid.padX} columnGap={grid.gap} alignItems="flex-start" marginBottom={hasContent(below) ? GAP : 0}>
          <Box width={grid.icon} flexShrink={0} justifyContent="center">
            {/* 减号收起，加号展开 */}
            <Button key="toggle" plain dimColor label={isShort ? '+' : '−'} onPress={() => update($, isCollapsed, old => !old)} />
          </Box>
          {/* 右端留 textEnd（一行放不下、折行时才看得出）：桌面外壳没有右内边距，留出后右端和其他行 × 的右缘齐平 */}
          {/* 终端以外加 minWidth={0}：不写的话这一层的最小宽度是最宽那一项的整行宽度，里面的分支名截不断、把整块撑宽 */}
          <Box flexGrow={1} flexWrap="wrap" columnGap={2} alignItems="center" paddingRight={grid.textEnd} {...(isTerminal ? {} : { minWidth: 0 })}>
            {here !== null && !isShort && (
              // 终端以外：一行放不下时“· 分支 · 状态”整段换到第二行，分支名在那里截断，状态始终完整（不会出框）
              <Box key="place" columnGap={1} {...(isTerminal ? {} : { flexWrap: 'wrap' as const, minWidth: 0 })}>
                {here.entity !== null && <Text bold>{here.entity} ·</Text>}
                <Text>{here.name}</Text>
                {here.isRepo && isTerminal ? (
                  <Text dimColor>
                    · {here.branch ?? t.unknownBranch}
                    {here.dirty > 0 ? t.uncommitted(here.dirty) : t.clean}
                  </Text>
                ) : here.isRepo ? (
                  <Box minWidth={0}>
                    <Text dimColor wrap="truncate-end">
                      · {here.branch ?? t.unknownBranch}
                    </Text>
                    <Box flexShrink={0}>
                      <Text dimColor>{here.dirty > 0 ? t.uncommitted(here.dirty) : t.clean}</Text>
                    </Box>
                  </Box>
                ) : (
                  <Text dimColor>{t.notRepo}</Text>
                )}
              </Box>
            )}
            {isSubscription && (
              <Text key="api" bold color="claude">
                {t.apiEquivalent}
              </Text>
            )}
            {spent?.usd != null && figure('usd', t.session, `$${spent.usd.toFixed(2)}`)}
            {spent?.lastTurnUsd != null && figure('turn', t.lastTurn, `$${spent.lastTurnUsd.toFixed(2)}`)}
            {quotaFigures}
            {spent?.contextTokens != null &&
              figure(
                'context',
                t.context,
                String(spent.contextTokens).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
                (spent.contextPercent ?? 0) >= WARN_PERCENT,
                spent.contextPercent != null ? `(${spent.contextPercent}%)` : undefined,
              )}
            {spent?.contextTokens == null &&
              spent?.contextPercent != null &&
              figure('context', t.context, `${spent.contextPercent}%`, spent.contextPercent >= WARN_PERCENT)}
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
