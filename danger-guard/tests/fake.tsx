// 测试共用的模拟引擎：shell、git、面板，以及真正执行的命令

export const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
export const failed = (exitCode: number, stderr = '') => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

export const PANE = {
  plugin: 'danger-guard',
  component: 'Pane',
  requestId: 'danger-guard',
  props: { title: '', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

export type Setup = {
  words?: string[]
  lines?: string[]
  git?: Record<string, string | ReturnType<typeof failed>>
  isPlaced?: boolean
  // 卡片摆出来以后按哪个按钮（面板）或选哪个选项（原生对话框）；null 表示离开太久自动结束
  press?: string | null
  // 每张摆出来的卡片都按（排队的测试用）
  pressAll?: string
  root?: string
  // Claude Code 的 language 设置，默认中文
  language?: string
  // 自己回答 owner 脚本（解符号链接）
  owner?: (path: string) => ReturnType<typeof ok>
  env?: Record<string, string>
  // 每读一次时钟走多少毫秒
  tick?: number
  // 面板列表：默认一直有 danger-guard
  panes?: () => { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[]
  // 原生对话框一直不回答
  askHangs?: boolean
}

export const ENV: Record<string, string> = { HOME: '/Users/me', SHELL: '/bin/zsh', TMPDIR: '/var/folders/ab/cd/T/' }

const SHOWN = [{ id: 'danger-guard', title: '', isShown: true, isFocused: true, isPlaced: true }]

export function fakeEngine($: any, on: any, setup: Setup) {
  const seen = {
    ran: [] as string[],
    card: [] as string[],
    command: [] as string[],
    buttons: [] as string[],
    asked: [] as string[],
    opened: 0,
    expanded: [] as string[][],
    inspected: [] as string[][],
  }
  let pressed = false
  let mounting: Promise<void> | null = null
  let now = 0
  const env = { ...ENV, ...setup.env }
  on('settings.read', () => ({ value: { language: setup.language ?? 'chinese' } }))
  on('session.root', () => ({ value: setup.root ?? '/p' }))
  on('session.cwd', () => ({ value: '/p' }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('clock.now', () => ({ value: (now += setup.tick ?? 1000) }))
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: setup.isPlaced ?? true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: setup.panes?.() ?? SHOWN }))
  // 把面板画出来，记下卡片上的文字和按钮，再按下 key
  const pressCard = async (key: string) => {
    // 两张卡片之间没有卡片可画：面板画不出来，这次不按
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' }).catch(() => null)
    if (ui === null) {
      return
    }
    try {
      if ((await ui.find({ type: 'Text', text: /^⚠ / })) === undefined) {
        return
      }
      for (const pattern of [/^⚠ /, /^\$ /, /^(📁|📄|◆|✏️|⎇|🔗)/]) {
        const found = await ui.find({ type: 'Text', text: pattern })
        if (found) seen.card.push(found.text)
      }
      seen.command.push(...(await ui.findAll({ type: 'Text' })).map((found: { text: string }) => found.text))
      seen.buttons.push(...(await ui.findAll({ type: 'Button' })).map((found: { text: string }) => found.text))
      await ui.press({ key })
    } finally {
      await ui.unmount()
    }
  }
  on('process.run', async (_: unknown, e: { argv: string[] }) => {
    const [cmd] = e.argv
    const label = e.argv.find(arg => ['inspect', 'owner', 'where', 'expand'].includes(arg))
    if (cmd === 'sleep') {
      const key = setup.pressAll ?? (!pressed && setup.isPlaced !== false ? setup.press : null)
      // 两张卡片同时在等时，同一时刻只挂一个面板；另一个等它画完（一直空转的话，面板永远等不到画完）
      if (mounting !== null) {
        await mounting
      } else if (key != null) {
        pressed = true
        mounting = pressCard(key).finally(() => {
          mounting = null
        })
        await mounting
      }
      return { value: ok('') }
    }
    if (cmd === 'git') {
      const answer = setup.git?.[e.argv.slice(1).join(' ')] ?? ''
      return { value: typeof answer === 'string' ? ok(answer) : answer }
    }
    if (label === 'inspect') {
      seen.inspected.push(e.argv)
      // 和真实脚本一样：每个字段后面跟一个 NUL，7 个字段
      return { value: ok((setup.lines ?? []).map(line => [...line.split('\t'), '', ''].slice(0, 7).map(field => `${field}\0`).join('')).join('')) }
    }
    if (label === 'owner') {
      // 第一行真实路径，第二行归属目录
      const path = e.argv[4]!
      return { value: setup.owner?.(path) ?? ok(`${path}\n${path.replace(/\/[^/]*$/, '')}\n`) }
    }
    if (label === 'where') {
      return { value: ok('/p\n') }
    }
    seen.expanded.push(e.argv)
    return { value: ok(['/p', ...(setup.words ?? [])].map(w => w + '\0').join('')) }
  })
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0].question
      seen.asked.push(question)
      if (setup.askHangs === true) {
        return new Promise(() => {})
      }
      return setup.press === null
        ? { result: { questions: e.questions, answers: { [question]: '移到废纸篓' }, afkTimeoutMs: 60000 } }
        : { result: { questions: e.questions, answers: { [question]: setup.press } } }
    }
    seen.ran.push(e.command ?? `${e.tool} ${e.file_path}`)
    return { result: {} }
  })
  return seen
}
