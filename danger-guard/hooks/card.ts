import type { EngineInterface } from 'claude-code'

import type { Text } from './i18n'
import { textOf } from './i18n'

// 一张确认卡片：标题、一句话说明影响、逐项清单、提醒，以及几个按钮
export type CardRow = { icon: string; name: string; meta: string; warning: string | null }

export type Choice = {
  key: string
  label: string
  description: string
  // primary：推荐的做法，用主题橙色；danger：不可逆的，用警示红
  tone?: 'primary' | 'danger'
}

export type Card = {
  title: string
  // 卡片里那句“会怎样”
  question: string
  command: string
  // 命令里有风险的那几段：命令太长显示不全时单独列出来
  risky: string[]
  rows: CardRow[]
  more: number
  notes: string[]
  choices: Choice[]
  decision: string | null
}

export const PANE_ID = 'danger-guard'

// 等你决定的最长时间，过了就当取消
const HOLD_LIMIT_MS = 10 * 60 * 1000
const POLL_SECONDS = '0.25'

// 命令最多显示几行、一行最多几个字；面板和原生对话框各一套
export const COMMAND_LIMIT = { pane: { lines: 12, chars: 600 }, ask: { lines: 4, chars: 300 } }

// 正在等你决定的卡片；一次只摆一张，后来的排队。isPane：已经摆在侧边面板里；since：开始等的时间（刚占上还没读到时钟时为 null）
type Held = { card: Card; isPane: boolean; since: number | null }
let held: Held | null = null

// 原生对话框里因为人离开太久而自动结束的那次，答案不算数
const timedOut = new Set<string>()

export function heldCard(): Card | null {
  return held?.card ?? null
}

export function markTimedOut(question: string): void {
  timedOut.add(question)
}

// 只有 $ 调用里的等待不算 mod 自己的 10 秒预算，所以用一个短 sleep 来轮询
async function pause($: EngineInterface): Promise<void> {
  await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

// 命令按行显示，太长就截断，说清还有多少没显示
export function commandView(command: string, limit: { lines: number; chars: number }, t: Text): { lines: string[]; hidden: string | null } {
  const all = command.split('\n')
  const lines: string[] = []
  let chars = 0
  for (const line of all) {
    if (lines.length >= limit.lines || chars + line.length > limit.chars) {
      break
    }
    lines.push(line)
    chars += line.length
  }
  if (lines.length === all.length) {
    return { lines, hidden: null }
  }
  // 第一行就超长：显示它的开头，告诉还剩多少字
  if (lines.length === 0) {
    const head = all[0]!.slice(0, limit.chars)
    return { lines: [`${head}…`], hidden: all.length > 1 ? t.moreLines(all.length - 1) : t.moreChars(all[0]!.length - head.length) }
  }

  return { lines, hidden: t.moreLines(all.length - lines.length) }
}

// 退回原生对话框时问的那句话：带上命令，对话框画成什么样都看得到要批准的是什么
export function askTextOf(card: Card, t: Text): string {
  const { lines, hidden } = commandView(card.command, COMMAND_LIMIT.ask, t)
  const risky = hidden === null ? [] : [t.dangerParts, ...card.risky.map(part => `  ${part.slice(0, COMMAND_LIMIT.ask.chars)}`)]

  return [card.question, ...lines.map((line, index) => `${index === 0 ? '$ ' : '  '}${line}`), ...(hidden === null ? [] : [hidden]), ...risky].join('\n')
}

function paneRows(card: Card): number {
  const commandRows = Math.min(COMMAND_LIMIT.pane.lines + 1, Math.ceil(card.command.length / 60) + card.command.split('\n').length)
  return Math.min(40, 9 + commandRows + card.rows.length + card.notes.length + (card.more > 0 ? 1 : 0))
}

// 排队：前一张卡片还在等就等它，但最多等 10 分钟；它的面板已经被关掉、或者它早该超时却没收尾，就不再等。
// 看到空位的同一刻就占上（中间不能有 await），两张卡片才不会同时摆出来
async function claim($: EngineInterface, card: Card, signal: AbortSignal): Promise<Held | string> {
  let startedAt: number | null = null
  for (;;) {
    if (held === null) {
      held = { card, isPane: false, since: null }
      return held
    }
    if (signal.aborted) {
      return 'interrupted'
    }
    const now = await $.clock.now()
    startedAt ??= now
    if (now - startedAt > HOLD_LIMIT_MS) {
      return 'timeout'
    }
    const other = held
    if (other !== null && ((other.since !== null && now - other.since > HOLD_LIMIT_MS * 2) || (other.isPane && !(await isPaneShown($))))) {
      if (held === other) {
        held = null
      }
      continue
    }
    await pause($)
  }
}

// 原生对话框：等你回答，同样最多 10 分钟；中断或超时就不再等（对话框可能还开着，之后的回答不算数）
async function askNative($: EngineInterface, card: Card, signal: AbortSignal): Promise<string> {
  const t = await textOf($)
  const question = askTextOf(card, t)
  timedOut.delete(question)
  let isAnswered = false
  const asking = $.ui
    .ask(question, { options: card.choices.map(choice => choice.label), header: t.askHeader })
    .catch(() => null)
    .finally(() => {
      isAnswered = true
    })
  const startedAt = await $.clock.now()
  const limit = (async (): Promise<string | null> => {
    try {
      while (!isAnswered) {
        if (signal.aborted) {
          return 'interrupted'
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          return 'timeout'
        }
        await pause($)
      }
    } catch {
      return isAnswered ? null : 'error'
    }
    return null
  })()

  const first = await Promise.race([asking.then(answer => ({ answer })), limit.then(stop => ({ stop }))])
  isAnswered = true
  await limit
  if ('stop' in first && first.stop !== null) {
    return first.stop
  }
  const answer = 'answer' in first ? first.answer : await asking
  const picked = card.choices.find(choice => choice.label === answer)

  return picked === undefined || timedOut.delete(question) ? 'cancel' : picked.key
}

// 摆出卡片，等你按按钮；返回所选按钮的 key，没选就是 cancel / timeout / interrupted / error
export async function decide($: EngineInterface, card: Card, signal: AbortSignal): Promise<string> {
  let mine: Held | null = null
  let isOpened = false
  try {
    const claimed = await claim($, card, signal)
    if (typeof claimed === 'string') {
      return claimed
    }
    mine = claimed
    mine.since = await $.clock.now()

    const opened = await $.ui.open({ id: PANE_ID, title: card.title, focus: true, rows: paneRows(card) })
    isOpened = true
    $.ui.invalidate('ui.render')

    // 侧边面板放不下时，退回到原生的提问对话框，卡片清单画在它上方
    if (!opened.isPlaced) {
      await $.ui.close({ id: PANE_ID }).catch(() => {})
      isOpened = false
      return await askNative($, card, signal)
    }
    mine.isPane = true

    const startedAt = await $.clock.now()
    while (card.decision === null) {
      if (signal.aborted) {
        return 'interrupted'
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        return 'timeout'
      }
      // 面板被你手动关掉，也算取消
      if (!(await isPaneShown($))) {
        return 'cancel'
      }
      await pause($)
    }

    return card.decision
  } catch {
    return 'error'
  } finally {
    // 只收拾自己的：排在后面的卡片接手以后，不能把它的面板关掉
    if (mine !== null && held === mine) {
      if (isOpened) {
        await $.ui.close({ id: PANE_ID }).catch(() => {})
      }
      held = null
    }
    $.ui.invalidate('ui.render')
  }
}

export function whyNot(decision: string, t: Text): string {
  return t.why[decision] ?? t.noAnswer
}
