import { expect, test } from 'claude-code/testing'

// 假的 Bash 结果：失败时和引擎一样只给出错文字、标 isError；成功时给正常的输出
const bashResult = (isError: boolean) =>
  isError ? { result: 'Exit code 1', isError: true as const } : { result: { stdout: '', stderr: '', interrupted: false } }
// 测试里的定时器一律不到点（这些用例不需要它触发），所以 clock.after 的答复永远不回来

test('test and build commands report pass or fail, others leave the status alone', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  let now = 0
  on('clock.after', () => new Promise<never>(() => {}))
  on('clock.now', () => ({ value: (now += 3000) }))
  on('tool.call', (_, e) => bashResult((e as { command: string }).command.includes('fail')))

  // 不是检查类命令，或者结果代表不了检查本身（管道、|| true、后面还跟着别的命令、放到后台）：都不报
  for (const command of [
    'ls -la',
    'git commit -m "make the eslint test pass"',
    'npm test | tail -20',
    'npm test || true',
    'npm test; echo done',
    'make clean',
    'xcodebuild -scheme App test-app-x',
  ]) {
    await $.tool.call({ tool: 'Bash', command })
  }
  // 说要放后台、却没真的转到后台（结果里没有 backgroundTaskId）的，也不报；真转到后台的见 background.test.ts
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
  expect(lines).toEqual([])

  for (const command of [
    'npm test',
    'cargo build # fail',
    'make',
    'cd app && npx vitest run',
    'CI=1 pnpm run test:unit',
    'python3 -m pytest -q',
    'uv run pytest tests/',
  ]) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(lines.filter(l => l?.startsWith('✓') || l?.startsWith('✗'))).toEqual([
    '✓ 测试通过（3s）：npm test',
    '✗ 构建失败（3s）：cargo build',
    '✓ 构建通过（3s）：make',
    '✓ 测试通过（3s）：npx vitest run',
    '✓ 测试通过（3s）：pnpm run test:unit',
    '✓ 测试通过（3s）：python3 -m pytest -q',
    '✓ 测试通过（3s）：uv run pytest tests/',
  ])
})

// 语言跟着 Claude Code 的 language 设置走
for (const [language, expected] of [
  ['english', ['… Testing: npm test', '✓ Tests passed (3s): npm test', '… Building: cargo build', '✗ Build failed (3s): cargo build']],
  ['chinese', ['… 测试中：npm test', '✓ 测试通过（3s）：npm test', '… 构建中：cargo build', '✗ 构建失败（3s）：cargo build']],
] as const) {
  test(`with language set to ${language}, the status is in that language`, async ($, on) => {
    const lines: (string | undefined)[] = []
    on('settings.read', () => ({ value: { language } }))
    on('ui.status', (_, e) => {
      lines.push(e.text)
      return { value: undefined }
    })
    let now = 0
    on('clock.after', () => new Promise<never>(() => {}))
    on('clock.now', () => ({ value: (now += 3000) }))
    on('tool.call', (_, e) => bashResult((e as { command: string }).command.includes('cargo')))
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'cargo build' })
    expect(lines).toEqual(expected)
  })
}
