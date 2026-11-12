import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Notice } from '../types'
import type { Text } from './i18n'
import { textOf } from './i18n'

// 短于这个时长的回合不打扰；算的是真在干活的时间，等你点“允许”、回答提问的时间不算
const MIN_MS = 60_000

// 提示里任务名最多显示多少字
const TASK_MAX = 30

// Claude 桌面 App 的 bundle id
const DESKTOP_APP = 'com.anthropic.claudefordesktop'

// 本身就是在等你回答的工具：整段调用都算等你
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

const notice = atom({ plugin: 'done-alert', key: 'notice' } as const, null)
const lastTask = atom({ plugin: 'done-alert', key: 'lastTask' } as const, '')

// 这一轮里在等你的时间段（权限确认、提问），轮末从时长里扣掉；几段可能重叠（并行的调用一起等你）
let waits: { from: number; to: number }[] = []
// tool.check 判成要问你的调用
const asked = new Set<string>()
// PostToolUse 报的执行时长，不含等权限和 hook 的时间
const executedMs = new Map<string, number>()
// 当前这一轮是不是接着上一轮自己继续的（不是你发消息开始的）
let isContinuation = false

// 桌面 App 是不是当前最前面的应用；查不出来就当在前台，宁可多响一声也不漏掉
async function isDesktopInFront($: EngineInterface): Promise<boolean> {
  const front = await $.process
    .run(['/bin/bash', '-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'], { timeoutMs: 3000 })
    .catch(() => null)
  if (front === null || front.exitCode !== 0) {
    return true
  }

  // 只认整个 bundle id 相同；前缀相同的别的应用不算
  return /"CFBundleIdentifier"="([^"]*)"/.exec(front.stdout)?.[1] === DESKTOP_APP
}

// 系统和 App 附在消息里的标签块（<system-reminder>、<task-notification>、<side-sessions-event>……）不是你说的话。
// 只认名字带连字符的标签：HTML 自带的标签名都不带，你贴进来的 <div> 不会被当成标签块去掉
const HARNESS_BLOCK = /<([a-z]+(?:-[a-z]+)+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g

// 用你这一轮说的第一行话当任务名；斜杠命令用命令本身（/retro 参数）；只有标签块、没有你的话时为空
function taskOf(text: string): string {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim()
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim()
  const said = command ? [command, args].filter(Boolean).join(' ') : text.replace(HARNESS_BLOCK, '')
  const line = said.trim().split('\n')[0]?.trim() ?? ''
  const points = [...line]

  return points.length > TASK_MAX ? `${points.slice(0, TASK_MAX - 1).join('')}…` : line
}

// 不到 2 分钟用秒，不到 1 小时用分钟，再长用小时加分钟
function tookOf(t: Text, seconds: number): string {
  if (seconds < 120) {
    return t.seconds(seconds)
  }
  const minutes = Math.round(seconds / 60)

  return minutes < 60 ? t.minutes(minutes) : t.hours(Math.floor(minutes / 60), minutes % 60)
}

// 几段等待落在 [from, to] 里的总长，重叠的只算一次
function overlapMs(spans: readonly { from: number; to: number }[], from: number, to: number): number {
  const clipped = spans
    .map(span => ({ from: Math.max(span.from, from), to: Math.min(span.to, to) }))
    .filter(span => span.to > span.from)
    .sort((a, b) => a.from - b.from)
  let total = 0
  let reached = from
  for (const span of clipped) {
    if (span.to > reached) {
      total += span.to - Math.max(span.from, reached)
      reached = span.to
    }
  }

  return total
}

// 一次工具调用里有多久是在等你：问过你的，除了执行本身都算；没收到执行时长、又问过你的（比如你拒绝了），整段都算
function waitOf(tool: string, id: string, startedAt: number, endedAt: number): { from: number; to: number } | undefined {
  const ranMs = executedMs.get(id)
  executedMs.delete(id)
  const wasAsked = asked.delete(id)
  if (ASKING_TOOLS.has(tool) || (wasAsked && ranMs === undefined)) {
    return { from: startedAt, to: endedAt }
  }
  // 没问过你时，除执行以外剩下的只是各 hook 的时间（毫秒级）；别的 mod 弹的确认卡片也落在这里
  if (ranMs !== undefined) {
    return { from: startedAt, to: Math.max(startedAt, endedAt - ranMs) }
  }

  return undefined
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
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'done-alert-preview',
      description: (await textOf($)).previewCommand,
    })

    return next(e)
  })

  // 不用真等一个长任务，直接看提示的样子
  on('command.run', { command: 'done-alert-preview' }, async ($, e) => {
    const t = await textOf($)
    const hasFailed = e.args.trim() === 'fail'
    await update($, notice, () => ({ hasFailed, task: t.previewTask(hasFailed), took: t.minutes(3) }))

    return { text: t.previewShown(hasFailed) }
  })

  // 你一发新消息，上一条完成提示就收起
  // 下面几个 hook 只在旁边计时、记任务名，出错时原样放行，不能因此挡住你的消息或工具调用
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta !== true) {
      await update($, notice, () => null)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 记下要问你的调用：tool.check 判成 ask 的，接下来会弹权限确认
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      asked.add(e.tool_use_id)
    }

    return verdict
  }).catch(($, e, next) => next(e))

  // 执行本身用了多久：PostToolUse 报的时长不含等权限和 hook 的时间
  on('classic.PostToolUse', async ($, e, next) => {
    if (e.duration_ms !== undefined) {
      executedMs.set(e.tool_use_id, e.duration_ms)
    }

    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (e.duration_ms !== undefined) {
      executedMs.set(e.tool_use_id, e.duration_ms)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 每次工具调用量一下总时长，减去执行时长，剩下的就是在等你（子代理里的调用也算：这一轮同样卡在那里等你）
  on('tool.call', async ($, e, next) => {
    // 量不了时间就不量，绝不能因为计时让工具调用失败
    const startedAt = await $.clock.now().catch(() => null)
    if (startedAt === null) {
      return next(e)
    }
    try {
      return await next(e)
    } finally {
      // 调用被打断时这里也要跑完，不能让时钟的错误盖掉原来的结果
      const endedAt = await $.clock.now().catch(() => startedAt)
      const wait = waitOf(e.tool, e.tool_use_id, startedAt, endedAt)
      if (wait !== undefined && wait.to > wait.from) {
        waits.push(wait)
      }
    }
  }).catch(($, e, next) => next(e))

  // 任务名取开始这一轮的那条消息；长任务跑着时你又排了一条，不会张冠李戴。
  // 接着上一轮自己继续的回合（没有你的话，只有系统附的标签块）沿用上一个任务名，也不收起提示
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const task = taskOf(e.text)
      isContinuation = task === ''
      waits = []
      asked.clear()
      executedMs.clear()
      if (!isContinuation) {
        await update($, lastTask, () => task)
        // 你开始了新的一轮，上一轮的提示就过时了
        await update($, notice, () => null)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // 子代理的回合、你自己打断的回合都不提醒
    if (e.agentId !== undefined || e.isAborted) {
      return result
    }

    const endedAt = await $.clock.now()
    const activeMs = e.durationMs - overlapMs(waits, endedAt - e.durationMs, endedAt)
    waits = []
    const hasFailed = e.reason === 'error' || e.reason === 'refusal'

    // 太短的回合不提醒；但接着上一轮继续的回合很快出了错，上一条“完成”提示不能还绿着说成功
    if (activeMs < MIN_MS) {
      if (hasFailed && isContinuation) {
        await update($, notice, shown => (shown === null ? null : { ...shown, hasFailed: true }))
      }
      return result
    }

    const t = await textOf($)
    const took = tookOf(t, Math.round(activeMs / 1000))
    const task = await read($, lastTask)
    // 提示一直留在输入框上方，你从别的应用回来也能看到
    await update($, notice, () => ({ hasFailed, task, took }))

    const sound = { asset: hasFailed ? 'sounds/failed.aiff' : 'sounds/done.aiff' }
    const surfaces = await $.session.surfaces()

    if (surfaces.includes('desktop')) {
      // 桌面 App 在后台时，它自带的“任务完成”横幅会提醒，这里不再响铃
      if (await isDesktopInFront($)) {
        void $.audio.play(sound).catch(() => {})
      }

      return result
    }

    // 终端里没有 App 的通知，用终端自己的通知通道
    void $.audio.play(sound).catch(() => {})
    await $.ui.notify(t.notification(hasFailed, took), { title: 'Claude Code' }).catch(() => undefined)

    return result
  })

  // 画在输入框正上方；别的 mod 画的内容（比如 repo-bar）留在它上面
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const above = await next(e)
    const shown = await read($, notice)
    if (shown === null || e.props.hasSurvey) {
      return above
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const grid = gridOf(e.surface)
    const t = await textOf($)
    const color = shown.hasFailed ? 'error' : 'success'
    const tint = shown.hasFailed ? 'diffRemovedDimmed' : 'diffAddedDimmed'

    return (
      <Box flexDirection="column">
        {above}
        <Box
          key="notice"
          marginTop={hasContent(above) ? GAP : 0}
          // 淡底色作提醒；左右边距按共用网格（edgesOf），图标列和 repo-bar、task-progress 上下对齐。
          // 桌面要圆角：Box 没有圆角属性，桌面只在有边框时加圆角，所以给一条和底色同色的淡边框，主要为了圆角。
          // 用 single 而不是 round：桌面上 round 的圆角大一档，single 是基础圆角，比外面面板的圆角小，内外同心才协调。
          // 桌面有边框时默认加一圈卡片内边距，paddingY={0} 压掉上下那部分，高度不变。只在桌面加边框（终端画不出圆角，VS Code、手机也不加）。
          // 半透明的底色会铺到边框下面，同色边框叠上去边缘就亮一圈（深色下明显）；borderDimColor 把边框降到约 60%，亮边淡下去
          {...(e.surface === 'desktop' ? { borderStyle: 'single', borderColor: tint, borderDimColor: true, paddingY: 0 } : {})}
          backgroundColor={tint}
          {...edgesOf(e.surface, e.surface === 'desktop')}
          columnGap={grid.gap}
          alignItems="center"
        >
          <Box width={grid.icon} flexShrink={0} justifyContent="center">
            <Text color={color} bold>
              {shown.hasFailed ? '✗' : '✓'}
            </Text>
          </Box>
          {/* minWidth={0}：桌面上横排里的 flex 子项默认不收缩到内容宽度以下（min-width:auto），不写的话里面 truncate-end 的文字不截断、把这一行撑宽。
              正文能收缩后，不截断的耗时要放进 flexShrink={0} 的 Box，否则会跟着被压窄、折成几行 */}
          <Box flexGrow={1} minWidth={0} columnGap={1} alignItems="center">
            <Text weight="medium" wrap="truncate-end">
              {t.headline(shown.hasFailed)}
              {shown.task !== '' ? t.taskSuffix(shown.task) : ''}
            </Text>
            <Box flexShrink={0}>
              <Text dimColor>· {shown.took}</Text>
            </Box>
            <Box flexGrow={1} />
            <Button key="dismiss" plain dimColor label="×" onPress={() => update($, notice, () => null).catch(() => {})} />
          </Box>
        </Box>
      </Box>
    )
  })
}
