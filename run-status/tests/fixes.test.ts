import { expect, test } from 'claude-code/testing'

// 测试运行时有 setTimeout，但 mod 的类型环境里没有（mod 本身不该用它，定时走 $.clock），这里只给测试声明一下
declare function setTimeout(handler: (...args: unknown[]) => void, ms: number): unknown

// 一套假引擎：英文界面、记下状态栏每次的内容；clock.now 每问一次走 3 秒
function fakeEngine(on: any, answer: (e: any) => unknown = e => ({ result: {}, isError: e.command.includes('fail') })) {
  const lines: (string | undefined)[] = []
  on('settings.read', () => ({ value: { language: 'english' } }))
  on('ui.status', (_: unknown, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })
  let now = 0
  on('clock.after', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: (now += 3000) }))
  on('tool.call', (_: unknown, e: any) => answer(e))
  on('classic.PostToolUse', () => ({}))
  return lines
}

const finished = (lines: readonly (string | undefined)[]) => lines.filter(line => /^[✓✗⏱]/.test(line ?? ''))

// 1. 重定向（尤其 2>&1）不再把命令断开
for (const [command, shown] of [
  ['npx tsc --noEmit 2>&1', 'npx tsc --noEmit'],
  ['cargo build 2>&1', 'cargo build'],
  ['npm test >out.log 2>&1', 'npm test'],
  ['npm test 1>&2', 'npm test'],
  ['npm test &>log.txt', 'npm test'],
  ['npm test &>> log.txt', 'npm test'],
  ['pytest <&0', 'pytest'],
  ['npm test >| out.txt', 'npm test'],
  ['make test 2>/dev/null', 'make test'],
  ['cd app && npm test 2>&1', 'npm test'],
] as const) {
  test(`redirections are not separators or words: ${command}`, async ($, on) => {
    const lines = fakeEngine(on)
    await $.tool.call({ tool: 'Bash', command })
    expect(finished(lines)).toEqual([expect.stringMatching(new RegExp(`^✓ .*\\(3s\\): ${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))])
  })
}

test('a redirection does not make a pipe or a trailing command count', async ($, on) => {
  const lines = fakeEngine(on)
  for (const command of ['npm test 2>&1 | tail -20', 'npm test 2>&1; echo done', 'npm test |& tee log']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(lines).toEqual([])
})

// 2. 状态栏里不出现密钥
// 像真密钥格式的假值在运行时拼出来：源码里不出现完整的样子，免得密钥扫描（包括 GitHub 推送保护）把测试当成泄露的密钥
const fake = (...parts: string[]) => parts.join('')
for (const [command, shown, secret] of [
  [`GITHUB_TOKEN=${fake('ghp', '_abcdefghijklmnopqrstuvwxyz0123456789')} npm test`, 'npm test', 'ghp_abc'],
  ['npm test -- --token=hunter2hunter2', 'npm test -- --token=…', 'hunter2'],
  ['npx jest --api-key s3cr3tvalue', 'npx jest --api-key …', 's3cr3t'],
  [`npm test ${fake('sk-ant', '-api03-abcdefghijklmnopqrst')}`, 'npm test sk-…', 'abcdefghij'],
  [`npm test ${fake('xoxb', '-1234567890-abcdefghijkl')}`, 'npm test xoxb-…', '1234567890'],
  [`make test KEY=${fake('AKIA', 'ABCDEFGHIJKLMNOP')}`, 'make test KEY=AKIA…', 'ABCDEFGHIJ'],
  ['go test -run 0123456789abcdef0123456789abcdef', 'go test -run …', '0123456789abcdef'],
  ['pytest https://bob:hunter2@db.local/x', 'pytest https://bob:…@db.local/x', 'hunter2'],
  ['pytest -pS3cretPass', 'pytest -p…', 'S3cret'],
  ['pytest -p no:cacheprovider tests', 'pytest -p no:cacheprovider tests', '\u0000'],
  ['xcodebuild -project App.xcodeproj test', 'xcodebuild -project App.xcodeproj test', '\u0000'],
] as const) {
  test(`secrets are masked in the status line: ${shown}`, async ($, on) => {
    const lines = fakeEngine(on)
    await $.tool.call({ tool: 'Bash', command })
    expect(lines.some(line => line?.includes(secret))).toBe(false)
    expect(finished(lines)).toEqual([expect.stringMatching(/^✓ /)])
    expect(finished(lines)[0]?.endsWith(`: ${shown}`)).toBe(true)
  })
}

// 3. 分类：修改文件的格式化、只打印版本或帮助、不构建的 gradle / mvn 任务都不报
for (const command of [
  'prettier --write .',
  'npx prettier -w src',
  'tsc --version',
  'npx tsc -v',
  'vitest --help',
  'eslint --print-config a.js',
  './gradlew clean',
  'mvn dependency:tree',
  'mvn spring-boot:run',
  'xcodebuild -list',
  'xcodebuild -showBuildSettings -scheme App',
  'xcodebuild clean',
  'cargo fmt',
  'ruff format .',
  'biome format --write .',
  'black src',
  'swiftlint --fix',
  'make clean',
  'npm install',
  'go run .',
]) {
  test(`not reported: ${command}`, async ($, on) => {
    const lines = fakeEngine(on)
    await $.tool.call({ tool: 'Bash', command })
    expect(lines).toEqual([])
  })
}

// 以前认不出、或认错的写法
for (const [command, kind] of [
  ['make -C app test', 'Tests'],
  ['make -f Build.mk test', 'Tests'],
  ['make -j 8 check', 'Tests'],
  ['make clean all', 'Build'],
  ['make lint', 'Checks'],
  ['npm --prefix app test', 'Tests'],
  ['npm -w web run build', 'Build'],
  ['pnpm -r test', 'Tests'],
  ['pnpm --filter web test', 'Tests'],
  ['pnpm -C app run lint', 'Checks'],
  ['yarn workspace web test', 'Tests'],
  ['npm run build:prod', 'Build'],
  ['npm run typecheck', 'Checks'],
  ['yarn lint:ci', 'Checks'],
  ['npm run test:e2e', 'Tests'],
  ['npm t', 'Tests'],
  ['npm exec -- vitest run', 'Tests'],
  ['go vet ./...', 'Checks'],
  ['go test ./...', 'Tests'],
  ['xcodebuild -scheme App', 'Build'],
  ['xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" test', 'Tests'],
  ['xcodebuild -quiet -scheme App build-for-testing', 'Build'],
  ['python3.11 -m pytest', 'Tests'],
  ['python -m unittest discover', 'Tests'],
  ['python3 -m mypy src', 'Checks'],
  ['uv run --with pytest-cov pytest', 'Tests'],
  ['bun test', 'Tests'],
  ['deno test', 'Tests'],
  ['deno task build', 'Build'],
  ['swift test', 'Tests'],
  ['swift build', 'Build'],
  ['./gradlew assembleDebug', 'Build'],
  ['./gradlew clean build', 'Build'],
  ['./gradlew :app:testDebugUnitTest', 'Tests'],
  ['gradle check', 'Tests'],
  ['mvn -q clean install', 'Build'],
  ['mvn -pl core verify', 'Tests'],
  ['mvn test -Dtest=FooTest', 'Tests'],
  ['prettier --check .', 'Checks'],
  ['eslint --fix .', 'Checks'],
  ['ruff check --fix .', 'Checks'],
  ['ruff format --check .', 'Checks'],
  ['cargo clippy', 'Checks'],
  ['cargo check', 'Checks'],
  ['cargo +nightly test', 'Tests'],
  ['cargo fmt --check', 'Checks'],
  ['tsc --noEmit', 'Checks'],
] as const) {
  test(`classified as ${kind}: ${command}`, async ($, on) => {
    const lines = fakeEngine(on)
    await $.tool.call({ tool: 'Bash', command })
    expect(finished(lines)).toEqual([expect.stringMatching(new RegExp(`^✓ ${kind} passed `))])
  })
}

// 4. 并行的 Bash 调用：各记各的
function gatedEngine($: any, on: any) {
  const gates = new Map<string, (answer: { isError: boolean; ms: number }) => void>()
  const lines = fakeEngine(on, async e => {
    const { isError, ms } = await new Promise<{ isError: boolean; ms: number }>(resolve => gates.set(e.command, resolve))
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: e.command }, tool_response: {}, tool_use_id: e.tool_use_id, duration_ms: ms })
    return isError ? { result: 'Exit code 1', isError: true } : { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const started = async (...commands: string[]) => {
    for (let tries = 0; tries < 200 && !commands.every(command => gates.has(command)); tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  const settle = (command: string, isError: boolean, ms: number) => {
    gates.get(command)?.({ isError, ms })
    gates.delete(command)
  }
  return { lines, started, settle }
}

test('parallel calls: a pass that finishes last does not hide the other call failing, and running stays visible', async ($, on) => {
  const { lines, started, settle } = gatedEngine($, on)

  const a = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await started('npm test')
  const b = $.tool.call({ tool: 'Bash', command: 'pytest' })
  await started('npm test', 'pytest')
  expect(lines.at(-1)).toBe('… Testing: pytest (+1 more)')

  settle('npm test', true, 4000)
  await a
  expect(lines.at(-1)).toBe('… Testing: pytest · ✗ Tests failed (4s): npm test')

  settle('pytest', false, 2000)
  await b
  expect(lines.at(-1)).toBe('✗ Tests failed (4s): npm test')

  // 同一条命令再跑一次通过了，失败才收起
  const c = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await started('npm test')
  settle('npm test', false, 1000)
  await c
  expect(lines.at(-1)).toBe('✓ Tests passed (1s): npm test')
})

test('a failure stays while other kinds pass, until a newer run of the same kind', async ($, on) => {
  const lines = fakeEngine(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail' })
  await $.tool.call({ tool: 'Bash', command: 'cargo build' })
  expect(lines.at(-1)).toBe('✗ Tests failed (3s): npm test -- fail')

  await $.tool.call({ tool: 'Bash', command: 'npx tsc -p . -- fail' })
  expect(lines.at(-1)).toBe('✗ Checks failed (3s): npx tsc -p . -- fail (+1 more)')

  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect(lines.at(-1)).toBe('✗ Checks failed (3s): npx tsc -p . -- fail')
})

test('the duration is the execution time PostToolUse reports, not the time spent waiting for approval', async ($, on) => {
  const { lines, started, settle } = gatedEngine($, on)
  const run = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await started('npm test')
  settle('npm test', false, 4200)
  await run
  expect(lines.at(-1)).toBe('✓ Tests passed (4s): npm test')
})

// 5. 打断、超时转后台、手动转后台都不是“通过”；转到后台的等完成通知（见 background.test.ts）
for (const [name, result, expected] of [
  ['interrupted', { stdout: '', stderr: '', interrupted: true }, undefined],
  ['moved to the background by the user', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1', backgroundedByUser: true }, '… Testing in background: npm test'],
  ['timed out', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2', timedOutAfterMs: 120_000 }, '⏱ Tests timed out (120s), moved to background: npm test'],
] as const) {
  test(`a run that was ${name} is not reported as passed`, async ($, on) => {
    const lines = fakeEngine(on, () => ({ result }))
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(lines).toEqual(['… Testing: npm test', expected])
  })
}

test('a non-zero exit (isError) is a failure', async ($, on) => {
  const lines = fakeEngine(on, () => ({ result: 'Exit code 2', isError: true }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(lines.at(-1)).toBe('✗ Tests failed (3s): npm test')
})
