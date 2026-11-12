// 认一段命令是测试、检查还是构建；按词判断，`git commit -m "make it work"` 这种不会被当成构建
import type { Kind } from './i18n'
import { baseName, commandWords } from './shell'

const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'py.test', 'phpunit', 'rspec', 'mocha', 'ava', 'unittest', 'nose2'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

// 只是打印版本、帮助、配置，什么都没跑
const INFO_FLAGS = new Set(['--version', '--help', '-h', '--init', '--print-config', '--showConfig', '--show-config'])

// 各包管理器放在脚本名前面、要带一个值的全局选项（npm --prefix app test、pnpm --filter x test）
const PM_VALUE_FLAGS: Record<string, string[]> = {
  npm: ['--prefix', '-C', '-w', '--workspace'],
  pnpm: ['-C', '--dir', '--filter', '-F'],
  yarn: ['--cwd'],
  bun: ['--cwd', '--filter', '-F'],
}
const RUNNER_VALUE_FLAGS = ['-p', '--package']
const UV_VALUE_FLAGS = ['--with', '--python', '-p', '--package', '--extra', '--group', '--env-file', '--directory', '--project']
const MAKE_VALUE_FLAGS = ['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if', '--new-file']
const GRADLE_VALUE_FLAGS = ['-x', '--exclude-task', '-p', '--project-dir', '-b', '--build-file', '-c', '--settings-file', '-I', '--init-script', '--tests', '--console', '--warning-mode', '--max-workers']
const MVN_VALUE_FLAGS = ['-f', '--file', '-pl', '--projects', '-rf', '--resume-from', '-s', '--settings', '-gs', '-t', '-T', '--threads', '-P', '--activate-profiles', '-l', '--log-file', '-b', '--builder']
// xcodebuild 的动作；不写动作就是 build
const XCODE_ACTIONS = new Map<string, Kind | undefined>([
  ['build', 'build'],
  ['build-for-testing', 'build'],
  ['archive', 'build'],
  ['install', 'build'],
  ['test', 'test'],
  ['test-without-building', 'test'],
  ['analyze', 'check'],
  ['clean', undefined],
  ['docbuild', undefined],
  ['installsrc', undefined],
])
const XCODE_VALUE_FLAGS = ['-scheme', '-project', '-workspace', '-target', '-configuration', '-sdk', '-destination', '-arch', '-derivedDataPath', '-resultBundlePath', '-testPlan', '-xcconfig', '-toolchain']
// 只列信息、不构建的 xcodebuild 写法
const XCODE_INFO_FLAGS = ['-list', '-showBuildSettings', '-showsdks', '-showdestinations', '-showTestPlans', '-version', '-usage', '-help', '-resolvePackageDependencies', '-exportArchive']

// 同一条命令里出现好几种，按这个顺序取：有测试就算测试
const RANK: Record<Kind, number> = { test: 3, check: 2, build: 1 }

function strongest(kinds: readonly (Kind | undefined)[]): Kind | undefined {
  let best: Kind | undefined
  for (const kind of kinds) {
    if (kind !== undefined && (best === undefined || RANK[kind] > RANK[best])) {
      best = kind
    }
  }

  return best
}

// 跳过开头的选项（带值的选项连值一起跳），返回第一个不是选项的位置；`--` 之后都不算选项
function skipFlags(args: readonly string[], valueFlags: readonly string[] = []): number {
  let at = 0
  while (at < args.length && args[at]!.startsWith('-')) {
    if (args[at] === '--') {
      return at + 1
    }
    at += valueFlags.includes(args[at]!) ? 2 : 1
  }

  return at
}

// 剥掉“用别的工具来跑”的那一层：npx、bunx、uvx、pnpm exec、npm exec、uv run、poetry run、python -m
function unwrapped(words: readonly string[]): string[] {
  let run = commandWords(words)
  for (;;) {
    const head = baseName(run[0] ?? '')
    const rest = run.slice(1)
    const pmAt = PACKAGE_MANAGERS.has(head) ? skipFlags(rest, PM_VALUE_FLAGS[head]) : -1
    if (['npx', 'bunx', 'pnpx', 'uvx'].includes(head)) {
      run = rest.slice(skipFlags(rest, RUNNER_VALUE_FLAGS))
    } else if (pmAt >= 0 && ['exec', 'dlx', 'x'].includes(rest[pmAt] ?? '')) {
      const after = rest.slice(pmAt + 1)
      run = after.slice(skipFlags(after, RUNNER_VALUE_FLAGS))
    } else if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch'].includes(head) && rest[0] === 'run') {
      const after = rest.slice(1)
      run = after.slice(skipFlags(after, UV_VALUE_FLAGS))
    } else if (/^python[\d.]*$/.test(head) && rest.indexOf('-m') >= 0 && rest.slice(0, rest.indexOf('-m')).every(word => word.startsWith('-'))) {
      run = rest.slice(rest.indexOf('-m') + 1)
    } else {
      return run
    }
  }
}

// package.json 里脚本名的约定：test、test:unit、lint、typecheck、build:prod……
function scriptKind(script: string): Kind | undefined {
  if (/^(t|tst)$/.test(script) || /^test([:.-]|$)/.test(script)) return 'test'
  if (/^(lint|typecheck|type-check|types|tsc|check)([:.-]|$)/.test(script) || /^(format|fmt|prettier)[:.-]check$/.test(script)) return 'check'
  if (/^build([:.-]|$)/.test(script) || script === 'compile') return 'build'

  return undefined
}

// npm test、npm --prefix app test、pnpm -r test、pnpm --filter x run build、yarn workspace app test、bun test
function packageKind(tool: string, args: readonly string[]): Kind | undefined {
  let rest = args.slice(skipFlags(args, PM_VALUE_FLAGS[tool]))
  if (tool === 'yarn' && rest[0] === 'workspace') {
    rest = rest.slice(2)
  }
  if (rest[0] === 'run' || rest[0] === 'run-script') {
    rest = rest.slice(1)
    rest = rest.slice(skipFlags(rest))
  }

  return rest[0] === undefined ? undefined : scriptKind(rest[0])
}

// 格式化、代码检查工具：只改文件的写法（prettier --write）退出码说明不了什么，不报；
// eslint --fix、ruff check --fix 改完还会对剩下的问题报错，退出码照样代表检查结果，照报
function lintKind(tool: string, args: readonly string[]): Kind | undefined {
  const sub = args[skipFlags(args)]
  switch (tool) {
    case 'tsc':
      return args.includes('-v') ? undefined : 'check'
    case 'eslint':
    case 'mypy':
    case 'pyright':
      return 'check'
    case 'prettier':
      return args.some(word => ['--check', '-c', '--list-different', '-l'].includes(word)) ? 'check' : undefined
    case 'black':
      return args.includes('--check') ? 'check' : undefined
    case 'ruff':
      return sub === 'format' && !args.includes('--check') && !args.includes('--diff') ? undefined : 'check'
    case 'biome':
      if (sub === 'format') return args.includes('--write') || args.includes('--apply') ? undefined : 'check'
      return ['check', 'lint', 'ci'].includes(sub ?? '') ? 'check' : undefined
    case 'swiftlint':
      return args.includes('--fix') || args.includes('--autocorrect') || sub === 'autocorrect' || sub === 'version' ? undefined : 'check'
    default:
      return undefined
  }
}

// make 的目标：test / check 算测试，lint 算检查，不写目标、build、all 算构建；-C 目录、-f 文件这些值不是目标
function makeKind(args: readonly string[]): Kind | undefined {
  const targets: string[] = []
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!
    if (MAKE_VALUE_FLAGS.includes(word) || ((word === '-j' || word === '-l') && /^\d+$/.test(args[at + 1] ?? ''))) {
      at += 1
    } else if (!word.startsWith('-') && !word.includes('=')) {
      targets.push(word)
    }
  }
  if (targets.length === 0) {
    return 'build'
  }

  return strongest(
    targets.map(target => {
      if (/^(test|tests|check)([-_:].*)?$/.test(target)) return 'test'
      if (/^(lint|typecheck)([-_:].*)?$/.test(target)) return 'check'
      return ['build', 'all'].includes(target) ? 'build' : undefined
    }),
  )
}

// gradle / mvn 按任务、目标来分：clean、dependency:tree、spring-boot:run 都不算
function taskKind(args: readonly string[], valueFlags: readonly string[], isMaven: boolean): Kind | undefined {
  const kinds: (Kind | undefined)[] = []
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!
    if (valueFlags.includes(word)) {
      at += 1
      continue
    }
    // mvn 的 a:b 是插件目标；gradle 的 :app:test 是子项目里的任务，取最后一节
    if (word.startsWith('-') || (isMaven && word.includes(':'))) {
      continue
    }
    const task = word.split(':').pop() ?? ''
    if (/^(test\w*|check|verify|\w+Test)$/.test(task)) {
      kinds.push('test')
    } else if (/^lint\w*$/.test(task)) {
      kinds.push('check')
    } else if (/^(build|assemble\w*|compile\w*|jar|bootJar|shadowJar|package|install)$/.test(task)) {
      kinds.push('build')
    }
  }

  return strongest(kinds)
}

// xcodebuild：没写动作就是 build；-list、-showBuildSettings 这类只是查信息；认不出的词就不猜
function xcodeKind(args: readonly string[]): Kind | undefined {
  if (args.some(word => XCODE_INFO_FLAGS.includes(word))) {
    return undefined
  }
  const kinds: (Kind | undefined)[] = []
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!
    if (word.startsWith('-')) {
      // 选项大多带一个值；后面紧跟的不是动作，就当它的值跳过
      const value = args[at + 1]
      if (value !== undefined && (XCODE_VALUE_FLAGS.includes(word) || (!value.startsWith('-') && !XCODE_ACTIONS.has(value)))) {
        at += 1
      }
    } else if (XCODE_ACTIONS.has(word)) {
      kinds.push(XCODE_ACTIONS.get(word))
    } else if (!word.includes('=')) {
      return undefined
    }
  }
  if (kinds.length === 0) {
    return 'build'
  }

  return strongest(kinds)
}

// go / cargo / swift / dotnet / mix / deno 这类“工具 子命令”的写法
function subcommandKind(tool: string, args: readonly string[]): Kind | undefined {
  // cargo +nightly test：工具链写在子命令前面
  const rest = args.filter(word => !word.startsWith('+'))
  const sub = rest[skipFlags(rest)] ?? ''
  const kinds: Record<string, Record<string, Kind>> = {
    go: { test: 'test', build: 'build', vet: 'check' },
    cargo: { test: 'test', nextest: 'test', build: 'build', clippy: 'check', check: 'check' },
    swift: { test: 'test', build: 'build' },
    dotnet: { test: 'test', build: 'build' },
    mix: { test: 'test', compile: 'build' },
    deno: { test: 'test', check: 'check', lint: 'check' },
  }
  if (tool === 'cargo' && sub === 'fmt') {
    return args.includes('--check') ? 'check' : undefined
  }
  if (tool === 'deno' && sub === 'task') {
    const script = rest[skipFlags(rest) + 1]
    return script === undefined ? undefined : scriptKind(script)
  }

  const table = kinds[tool]

  return table !== undefined && Object.prototype.hasOwnProperty.call(table, sub) ? table[sub] : undefined
}

export function kindOfWords(words: readonly string[]): Kind | undefined {
  const run = unwrapped(words)
  const tool = baseName(run[0] ?? '')
  const args = run.slice(1)
  if (args.some(word => INFO_FLAGS.has(word))) {
    return undefined
  }

  if (PACKAGE_MANAGERS.has(tool)) return packageKind(tool, args)
  if (TEST_RUNNERS.has(tool)) return 'test'
  if (['go', 'cargo', 'swift', 'dotnet', 'mix', 'deno'].includes(tool)) return subcommandKind(tool, args)
  if (tool === 'xcodebuild') return xcodeKind(args)
  if (tool === 'make' || tool === 'gmake') return makeKind(args)
  if (tool === 'gradle' || tool === 'gradlew') return taskKind(args, GRADLE_VALUE_FLAGS, false)
  if (tool === 'mvn' || tool === 'mvnw') return taskKind(args, MVN_VALUE_FLAGS, true)

  return lintKind(tool, args)
}
