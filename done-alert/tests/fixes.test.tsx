import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const base = { answer: '', turnId: 't', isAborted: false, reason: 'answer' } as const
const BAND = {
  plugin: 'done-alert',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
// 你在输入框里发的消息：引擎会带上来源，测试里照样补上
const COMPOSER = { wait: false, origin: { kind: 'composer' } } as const
// 测试运行时有 setTimeout，但 mod 的类型环境里没有（mod 本身不该用它，定时走 $.clock），这里只给测试声明一下
declare function setTimeout(handler: (...args: unknown[]) => void, ms: number): unknown

// 假引擎：桌面 App、可以拨动的时钟；工具调用由 tool 决定怎么答
function fakeEngine(on: any, options: { frontApp?: string; language?: string; verdict?: string; tool?: (e: any) => unknown } = {}) {
  const seen = { sounds: [] as string[], clock: 1_000_000 }
  on('settings.read', () => ({ value: { language: options.language ?? 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('clock.now', () => ({ value: seen.clock }))
  on('process.run', () => ({ value: ok(`"CFBundleIdentifier"="${options.frontApp ?? 'com.anthropic.claudefordesktop'}"\n`) }))
  on('audio.play', (_: unknown, e: any) => {
    seen.sounds.push(String(e.clip.asset))
    return { value: undefined }
  })
  on('tool.check', () => ({ decision: options.verdict ?? 'ask' }))
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
  on('classic.PostToolUse', () => ({}))
  on('tool.call', (_: unknown, e: any) => options.tool?.(e) ?? { result: { stdout: '', stderr: '', interrupted: false } })
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

async function userTurn($: any, text: string) {
  await $.prompt.submit({ ...COMPOSER, text })
  await $.turn.start({ text, turnId: 't' })
}

// 6. 等你点“允许”的时间不算进时长
test('time spent waiting for a permission prompt does not count: a 10 s command approved after 5 min is not a long turn', async ($, on) => {
  const seen = fakeEngine(on, {
    tool: async (e: any) => {
      seen.clock += 300_000 + 10_000
      await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: e.tool_use_id, duration_ms: 10_000 })
      return { result: { stdout: '', stderr: '', interrupted: false } }
    },
  })
  await userTurn($, '跑一下脚本')
  await $.tool.call({ tool: 'Bash', command: 'sh run.sh' })
  seen.clock += 10_000
  await $.turn.complete({ ...base, durationMs: 320_000 })

  expect(await bandText($)).toEqual([])
  expect(seen.sounds).toEqual([])
})

test('a long turn that also waited for approval shows only the working time', async ($, on) => {
  const seen = fakeEngine(on, {
    tool: async (e: any) => {
      seen.clock += 300_000 + 200_000
      await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: e.tool_use_id, duration_ms: 200_000 })
      return { result: { stdout: '', stderr: '', interrupted: false } }
    },
  })
  await userTurn($, '跑全部测试')
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  seen.clock += 20_000
  await $.turn.complete({ ...base, durationMs: 520_000 })

  expect(await bandText($)).toEqual(['✓', '任务完成：跑全部测试', '· 4 分钟'])
})

test('a call refused at the prompt counts wholly as waiting', async ($, on) => {
  const seen = fakeEngine(on, {
    tool: () => {
      seen.clock += 300_000
      return { result: 'The user rejected this tool use', isError: true }
    },
  })
  await userTurn($, '清理旧文件')
  await $.tool.call({ tool: 'Bash', command: 'git clean -n' })
  seen.clock += 30_000
  await $.turn.complete({ ...base, durationMs: 330_000 })

  expect(await bandText($)).toEqual([])
})

test('the time you spend answering a question the model asked counts as waiting', async ($, on) => {
  const seen = fakeEngine(on, {
    verdict: 'allow',
    tool: () => {
      seen.clock += 400_000
      return { result: { questions: [], answers: {} } }
    },
  })
  await userTurn($, '帮我选个方案')
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: '用哪个？', header: '方案', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
  } as any)
  seen.clock += 20_000
  await $.turn.complete({ ...base, durationMs: 420_000 })

  expect(await bandText($)).toEqual([])
})

test('two parallel calls waiting for approval at the same time are counted once', async ($, on) => {
  const gates: (() => void)[] = []
  const seen = fakeEngine(on, {
    tool: async () => {
      await new Promise<void>(resolve => gates.push(resolve))
      return { result: 'The user rejected this tool use', isError: true }
    },
  })
  await userTurn($, '两件事一起做')
  const calls = [$.tool.call({ tool: 'Bash', command: 'a.sh' }), $.tool.call({ tool: 'Bash', command: 'b.sh' })]
  for (let tries = 0; tries < 200 && gates.length < 2; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  seen.clock += 200_000
  gates.forEach(open => open())
  await Promise.all(calls)
  seen.clock += 70_000
  await $.turn.complete({ ...base, durationMs: 270_000 })

  expect(await bandText($)).toEqual(['✓', '任务完成：两件事一起做', '· 70 秒'])
})

// 7. 60 秒的界线、小时的写法
for (const [durationMs, language, took] of [
  [59_600, 'chinese', null],
  [60_000, 'chinese', '· 60 秒'],
  [119_000, 'chinese', '· 119 秒'],
  [120_000, 'chinese', '· 2 分钟'],
  [59 * 60_000, 'chinese', '· 59 分钟'],
  [2 * 3_600_000, 'chinese', '· 2 小时'],
  [185 * 60_000, 'chinese', '· 3 小时 5 分'],
  [185 * 60_000, 'english', '· 3 h 5 min'],
  [2 * 3_600_000, 'english', '· 2 h'],
] as const) {
  test(`a ${durationMs} ms turn in ${language} shows ${took ?? 'nothing'}`, async ($, on) => {
    fakeEngine(on, { language })
    await userTurn($, 'Run all tests')
    await $.turn.complete({ ...base, durationMs })
    const band = await bandText($)
    expect(took === null ? band : band.at(-1)).toEqual(took === null ? [] : took)
  })
}

// 8. 接着上一轮继续的回合沿用上一个任务名；标签块不当成你说的话
for (const [text, task] of [
  ['', '任务完成：整理研究资料'],
  ['<system-reminder>\nThe user is away.\n</system-reminder>', '任务完成：整理研究资料'],
  ['<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', '任务完成：整理研究资料'],
  ['<side-sessions-event kind="done">x</side-sessions-event>\n', '任务完成：整理研究资料'],
  ['<system-reminder>r</system-reminder>\n修一下登录页', '任务完成：修一下登录页'],
  ['<command-message>retro</command-message>\n<command-name>/retro</command-name>\n<command-args>本周</command-args>', '任务完成：/retro 本周'],
  ['<div>标题</div> 改成蓝色', '任务完成：<div>标题</div> 改成蓝色'],
] as const) {
  test(`a turn starting with ${JSON.stringify(text.slice(0, 24))} names the task ${task}`, async ($, on) => {
    fakeEngine(on)
    await userTurn($, '整理研究资料')
    await $.turn.complete({ ...base, durationMs: 5_000 })
    await $.turn.start({ text, turnId: 't2' })
    await $.turn.complete({ ...base, turnId: 't2', durationMs: 90_000 })
    expect((await bandText($))[1]).toBe(task)
  })
}

// 9. 提示跟着你开始的最新一轮走
test('a quick failure in a continuation turn turns the earlier done notice red', async ($, on) => {
  fakeEngine(on)
  await userTurn($, '整理研究资料')
  await $.turn.complete({ ...base, durationMs: 90_000 })
  expect(await bandText($)).toEqual(['✓', '任务完成：整理研究资料', '· 90 秒'])

  // 后台任务回来唤醒的短回合，顺利结束：提示不动
  await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 't2' })
  await $.turn.complete({ ...base, turnId: 't2', durationMs: 4_000 })
  expect(await bandText($)).toEqual(['✓', '任务完成：整理研究资料', '· 90 秒'])

  // 再一个短回合出错了：不能还绿着
  await $.turn.start({ text: '', turnId: 't3' })
  await $.turn.complete({ ...base, turnId: 't3', durationMs: 4_000, reason: 'error' })
  expect(await bandText($)).toEqual(['✗', '任务出错停下了：整理研究资料', '· 90 秒'])
})

test('a new turn you start clears the notice even without prompt.submit, and a quick failure then leaves nothing green', async ($, on) => {
  fakeEngine(on)
  await userTurn($, '整理研究资料')
  await $.turn.complete({ ...base, durationMs: 90_000 })
  await $.turn.start({ text: '再查一下引用', turnId: 't2' })
  expect(await bandText($)).toEqual([])
  await $.turn.complete({ ...base, turnId: 't2', durationMs: 3_000, reason: 'error' })
  expect(await bandText($)).toEqual([])
})

test('an aborted long turn leaves no notice', async ($, on) => {
  const seen = fakeEngine(on)
  await userTurn($, '整理研究资料')
  await $.turn.complete({ ...base, durationMs: 300_000, isAborted: true, reason: 'aborted' })
  expect(await bandText($)).toEqual([])
  expect(seen.sounds).toEqual([])
})

// lsappinfo 报的不是桌面 App（包括 bundle id 只是前缀相同的）就不响
for (const frontApp of ['com.apple.Safari', 'com.anthropic.claudefordesktop.helper', '']) {
  test(`with ${JSON.stringify(frontApp)} in front it does not ring`, async ($, on) => {
    const seen = fakeEngine(on, { frontApp })
    await userTurn($, '跑全部测试')
    await $.turn.complete({ ...base, durationMs: 90_000 })
    expect(seen.sounds).toEqual([])
    expect(await bandText($)).toEqual(['✓', '任务完成：跑全部测试', '· 90 秒'])
  })
}
