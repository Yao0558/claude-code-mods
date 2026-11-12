import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const base = { answer: '', turnId: 't', isAborted: false, reason: 'answer' } as const
const BAND = {
  plugin: 'done-alert',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
// 你在输入框里发的消息、敲的命令：引擎会带上来源（和命令显示在哪），测试里照样补上
const COMPOSER = { wait: false, origin: { kind: 'composer' } } as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

// 记下提醒去了哪里：系统通知、声音
function fakeEngine(on: any, surface: 'desktop' | 'terminal', frontApp: string | null, language = 'chinese') {
  const seen = { notes: [] as string[], sounds: [] as string[] }
  on('settings.read', () => ({ value: { language } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.surfaces', () => ({ value: [surface] }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', () => {
    if (frontApp === null) {
      throw new Error('lsappinfo missing')
    }
    return { value: ok(`"CFBundleIdentifier"="${frontApp}"\n`) }
  })
  on('ui.notify', (_: unknown, e: any) => {
    seen.notes.push(e.text)
    return { value: { isSent: true, channel: 'terminal' } }
  })
  on('audio.play', (_: unknown, e: any) => {
    seen.sounds.push(String(e.clip.asset))
    return { value: undefined }
  })
  return seen
}

async function bandText($: any, surface: 'desktop' | 'terminal' = 'desktop'): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts: string[] = []
  for (const pattern of [/^[✓✗]$/, /^(任务|Task)/, /^· /]) {
    const found = await ui.find({ type: 'Text', text: pattern })
    if (found) texts.push(found.text)
  }
  await ui.unmount()
  return texts
}

test('a long turn leaves a green notice above the prompt naming the task, and rings while in front', async ($, on) => {
  const seen = fakeEngine(on, 'desktop', 'com.anthropic.claudefordesktop')

  await $.prompt.submit({ ...COMPOSER,text: '整理研究资料\n按主题分好类' })
  await $.turn.start({ text: '整理研究资料\n按主题分好类', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 5_000 })
  await $.turn.complete({ ...base, durationMs: 90_000, agentId: 'a1' })
  expect(await bandText($)).toEqual([])

  await $.turn.complete({ ...base, durationMs: 150_000 })
  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await bandText($, surface)).toEqual(['✓', '任务完成：整理研究资料', '· 3 分钟'])
  }
  expect(seen.sounds).toEqual(['sounds/done.aiff'])
  expect(seen.notes).toEqual([])
})

test('in the background it stays silent but the notice waits for you', async ($, on) => {
  const seen = fakeEngine(on, 'desktop', 'com.apple.Safari')

  await $.prompt.submit({ ...COMPOSER,text: '跑全部测试' })
  await $.turn.start({ text: '跑全部测试', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 90_000 })

  expect(seen.sounds).toEqual([])
  expect(await bandText($)).toEqual(['✓', '任务完成：跑全部测试', '· 90 秒'])
})

test('a failed turn shows a red notice and the failure sound', async ($, on) => {
  const seen = fakeEngine(on, 'desktop', null)

  await $.prompt.submit({ ...COMPOSER,text: '部署到测试环境' })
  await $.turn.start({ text: '部署到测试环境', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 90_000, reason: 'error' })

  expect(seen.sounds).toEqual(['sounds/failed.aiff'])
  expect(await bandText($)).toEqual(['✗', '任务出错停下了：部署到测试环境', '· 90 秒'])
})

test('the next prompt or the × button clears the notice', async ($, on) => {
  fakeEngine(on, 'desktop', 'com.anthropic.claudefordesktop')

  await $.prompt.submit({ ...COMPOSER,text: '第一件事' })
  await $.turn.start({ text: '第一件事', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 90_000 })
  await $.prompt.submit({ ...COMPOSER,text: '第二件事' })
  await $.turn.start({ text: '第二件事', turnId: 't' })
  expect(await bandText($)).toEqual([])

  await $.turn.complete({ ...base, durationMs: 90_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /^任务/ })).toBeUndefined()
  await ui.unmount()
})

test('in a terminal it also sends the terminal notification', async ($, on) => {
  const seen = fakeEngine(on, 'terminal', 'com.apple.Terminal')

  await $.prompt.submit({ ...COMPOSER,text: '重构登录模块' })
  await $.turn.start({ text: '重构登录模块', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 90_000 })

  expect(seen.notes).toEqual(['任务完成（用时 90 秒）'])
  expect(seen.sounds).toEqual(['sounds/done.aiff'])
})

test('/done-alert-preview shows the notice without waiting for a long task', async ($, on) => {
  fakeEngine(on, 'desktop', 'com.anthropic.claudefordesktop')
  on('command.register', () => ({ value: { command: 'done-alert-preview' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...COMMAND,command: 'done-alert-preview', args: '' })
  expect(await bandText($)).toEqual(['✓', '任务完成：整理研究资料（预览）', '· 3 分钟'])

  await $.command.run({ ...COMMAND,command: 'done-alert-preview', args: 'fail' })
  expect(await bandText($)).toEqual(['✗', '任务出错停下了：部署到测试环境（预览）', '· 3 分钟'])
})

// 语言跟着 Claude Code 的 language 设置走
for (const [language, band, note] of [
  ['english', ['✓', 'Task done: Run all tests', '· 3 min'], 'Task done (took 3 min)'],
  ['chinese', ['✓', '任务完成：Run all tests', '· 3 分钟'], '任务完成（用时 3 分钟）'],
] as const) {
  test(`with language set to ${language}, the notice is in that language`, async ($, on) => {
    const seen = fakeEngine(on, 'terminal', 'com.apple.Terminal', language)

    await $.prompt.submit({ ...COMPOSER,text: 'Run all tests' })
    await $.turn.start({ text: 'Run all tests', turnId: 't' })
    await $.turn.complete({ ...base, durationMs: 180_000 })

    expect(await bandText($, 'terminal')).toEqual(band)
    expect(seen.notes).toEqual([note])
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

test('the notice card lines up with the prompt box on desktop, its 1px border let out; unchanged on the terminal, VS Code and phones', async ($, on) => {
  fakeEngine(on, 'desktop', 'com.anthropic.claudefordesktop')
  await $.prompt.submit({ ...COMPOSER, text: '整理研究资料' })
  await $.turn.start({ text: '整理研究资料', turnId: 't' })
  await $.turn.complete({ ...base, durationMs: 90_000 })

  expect(await gridOn($, BAND, 'desktop')).toEqual(GRID.desktopCard)
  expect(await gridOn($, BAND, 'terminal')).toEqual(GRID.terminal)
  expect(await gridOn($, BAND, 'vscode')).toEqual(GRID.other)
  expect(await gridOn($, BAND, 'mobile')).toEqual(GRID.other)
  // 正文可以收缩，长标题在桌面上截断而不把卡片撑宽
  expect(boxIn(await drawnOn($, BAND, 'desktop'), props => props.flexGrow === 1 && props.columnGap === 1)?.minWidth).toBe(0)
  // 耗时不跟着正文收缩，不会被压成几行（图标列也不收缩，但它定了宽度）
  expect(boxIn(await drawnOn($, BAND, 'desktop'), (props, box) => props.flexShrink === 0 && props.width === undefined && JSON.stringify(box.children ?? []).includes('· '))).not.toBe(null)
})
