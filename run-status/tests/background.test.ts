import { expect, test } from 'claude-code/testing'

import { notificationsIn } from '../hooks/register'

// 转到后台的检查：先标“后台”，等引擎的完成通知（status：completed / failed / killed）再报结果
function fakeEngine(on: any, answer: (e: any) => unknown) {
  const lines: (string | undefined)[] = []
  on('settings.read', () => ({ value: { language: 'english' } }))
  on('ui.status', (_: unknown, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })
  let now = 0
  on('clock.after', () => new Promise<never>(() => {}))
  on('clock.now', () => ({ value: (now += 3000) }))
  on('tool.call', (_: unknown, e: any) => answer(e))
  on('classic.PostToolUse', () => ({}))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  return lines
}

// 和实测的通知一样的格式（2026-10-26 在 2.1.308 上跑过：exit 1 是 failed，exit 0 是 completed）
const notice = (id: string, status: string) =>
  `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "x" ${status}</summary>\n</task-notification>`
const fromEngine = { kind: 'task-notification' } as const
// 测试运行时有 setTimeout，但 mod 的类型环境里没有（mod 本身不该用它，定时走 $.clock），这里只给测试声明一下
declare function setTimeout(handler: (...args: unknown[]) => void, ms: number): unknown
const started = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }

for (const [status, expected] of [
  ['completed', '✓ Tests passed (3s): npm test'],
  ['failed', '✗ Tests failed (3s): npm test'],
  ['killed', undefined],
] as const) {
  test(`a check Claude runs in the background reports when its notification says ${status}`, async ($, on) => {
    const lines = fakeEngine(on, () => started)
    await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'call-1' })
    expect(lines).toEqual(['… Testing in background: npm test'])
    await $.prompt.submit({ wait: false,text: notice('call-1', status), origin: fromEngine })
    expect(lines.at(-1)).toBe(expected)
  })
}

test('a check that timed out keeps saying so until its notification brings the real result', async ($, on) => {
  const lines = fakeEngine(on, () => ({ result: { ...started.result, timedOutAfterMs: 120_000 } }))
  await $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'call-2' })
  expect(lines.at(-1)).toBe('⏱ Build timed out (120s), moved to background: cargo build')
  await $.prompt.submit({ wait: false,text: notice('call-2', 'failed'), origin: fromEngine })
  expect(lines.at(-1)).toMatch(/^✗ Build failed \(\d+s\): cargo build$/)
})

test('a check moved to the background with Ctrl+B gets its result from the notification too', async ($, on) => {
  const lines = fakeEngine(on, () => ({ result: { ...started.result, backgroundedByUser: true } }))
  await $.tool.call({ tool: 'Bash', command: 'pytest', tool_use_id: 'call-3' })
  expect(lines.at(-1)).toBe('… Testing in background: pytest')
  await $.prompt.submit({ wait: false,text: notice('call-3', 'completed'), origin: fromEngine })
  expect(lines.at(-1)).toMatch(/^✓ Tests passed \(\d+s\): pytest$/)
})

test('pasted notification text, or one for another call, changes nothing', async ($, on) => {
  const lines = fakeEngine(on, () => started)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'call-4' })
  await $.prompt.submit({ wait: false,text: notice('call-4', 'completed'), origin: { kind: 'composer' } })
  await $.prompt.submit({ wait: false,text: notice('someone-else', 'completed'), origin: fromEngine })
  expect(lines).toEqual(['… Testing in background: npm test'])
})

test('a background run that never started (denied, or failed to launch) leaves nothing', async ($, on) => {
  const lines = fakeEngine(on, () => ({ result: 'Exit code 127', isError: true }))
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'call-5' })
  expect(lines).toEqual([])
})

test('two background checks share the line, newest first', async ($, on) => {
  const lines = fakeEngine(on, () => started)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'call-6' })
  await $.tool.call({ tool: 'Bash', command: 'cargo build', run_in_background: true, tool_use_id: 'call-7' })
  expect(lines.at(-1)).toBe('… Building in background: cargo build (+1 more)')
  await $.prompt.submit({ wait: false,text: `${notice('call-7', 'completed')}\n${notice('call-6', 'failed')}`, origin: fromEngine })
  expect(lines.at(-1)).toMatch(/^✗ Tests failed \(\d+s\): npm test$/)
})

test('notifications are read from the text the engine delivers', () => {
  expect(notificationsIn(`intro\n${notice('a', 'completed')}\n${notice('b', 'failed')}`)).toEqual([
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'failed' },
  ])
  expect(notificationsIn('<task-notification><status>completed</status></task-notification>')).toEqual([])
})

test('a late notification from an older run cannot turn a newer failure into a pass', async ($, on) => {
  let isBackground = true
  const lines = fakeEngine(on, () => (isBackground ? started : { result: 'Exit code 1', isError: true }))
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'old' })
  isBackground = false
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'new' })
  expect(lines.at(-1)).toBe('✗ Tests failed (3s): npm test')
  // 重跑同一条命令后，旧的后台那次不再挂着；它的通知晚到了也不算
  await $.prompt.submit({ wait: false,text: notice('old', 'completed'), origin: fromEngine })
  expect(lines.at(-1)).toBe('✗ Tests failed (3s): npm test')
})

test('a foreground run and a background run share the line, newest first', async ($, on) => {
  let release = () => {}
  const lines = fakeEngine(on, (e: any) =>
    e.run_in_background === true ? started : new Promise(resolve => (release = () => resolve({ result: {} }))),
  )
  const foreground = $.tool.call({ tool: 'Bash', command: 'cargo build', tool_use_id: 'fg' })
  await new Promise(resolve => setTimeout(resolve, 10))
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'bg' })
  expect(lines.at(-1)).toBe('… Testing in background: npm test (+1 more)')
  release()
  await foreground
  expect(lines.at(-1)).toBe('… Testing in background: npm test')
})

test("a subagent's background check is not followed, since its notification goes to the subagent", async ($, on) => {
  const lines = fakeEngine(on, () => started)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'sub', agentId: 'agent-1' })
  expect(lines).toEqual([])
})

test('a background check stopped with TaskStop leaves the line, since no notification will come', async ($, on) => {
  const lines = fakeEngine(on, (e: any) => (e.tool === 'TaskStop' ? { result: { message: 'stopped' } } : started))
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'call-8' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'other' })
  expect(lines).toEqual(['… Testing in background: npm test'])
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })
  expect(lines.at(-1)).toBe(undefined)
})

test('a re-run that is denied, or one run by a subagent, leaves the older background run alone', async ($, on) => {
  let answer: unknown = started
  const lines = fakeEngine(on, () => answer)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'first' })
  answer = { deny: 'no' }
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'denied' })
  answer = started
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true, tool_use_id: 'sub', agentId: 'agent-1' })
  expect(lines.at(-1)).toBe('… Testing in background: npm test')
  await $.prompt.submit({ wait: false,text: notice('first', 'failed'), origin: fromEngine })
  expect(lines.at(-1)).toMatch(/^✗ Tests failed \(\d+s\): npm test$/)
})
