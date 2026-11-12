import { gitRiskOf } from './git'
import type { DangerKey, GitKind } from './i18n'
import type { CommandStart, Segment, WordInfo } from './shell'
import { baseName, commandStart, isRecursiveRm, parseShell } from './shell'

// 按命令真正执行的词来找危险操作：先按 shell 的方式拆开，去掉 sudo、xargs、if/then 这类包装，
// 再钻进 sh -c '…'、eval、$(…)、子 shell、heredoc 喂给 shell 的脚本里接着找。
// 引号里的文字、注释、heredoc 正文（除非是交给 shell 执行的）都不算命令。
// 静态看不出要执行什么的（变量当命令名、eval 拼出来的命令、把输出交给 shell），也算危险：宁可多问一次

// source：危险的那一段命令原文，卡片上命令太长时单独列出来
export type Hit = { kind: 'command'; key: DangerKey; source: string } | { kind: 'git'; key: GitKind; source: string }

// 一处递归删除：参数原文（都能安全地交给 shell 展开时才有），和它之前经过的 cd（不知道就是 null）
export type RmSite = { args: string[] | null; cd: string[] | null }

export type Scan = { hits: Hit[]; rms: RmSite[] }

const MAX_DEPTH = 6

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh']

// 出现这些客户端时，命令里（包括引号和 heredoc）写的 DROP TABLE 才会真的执行
const SQL_CLIENTS = ['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'clickhouse', 'clickhouse-client', 'duckdb', 'cockroach', 'mongosh', 'snowsql', 'sqlplus', 'bq', 'wrangler', 'turso']
const DROP_SQL = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i

// 能交给 shell 展开的参数原文：没有变量、命令替换、管道、重定向、换行、反斜杠
const UNSAFE_RAW = /[;|&<>`$()\n\\]/

// find 的这些动作后面跟一条命令，到 ; 或 + 为止
const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir']
const DELETERS = ['rm', 'unlink', 'shred', 'gshred', 'srm', 'rmdir', 'rimraf']

type Context = {
  found: Scan
  depth: number
  // 这一段之前经过的 cd（参数原文），null 表示不知道在哪个目录
  cd: string[] | null
  // 前面单独一段赋过字面值的变量：C="…/claude"; "$C" plugin test 认得出 $C 是什么。赋过不同的值记 null，当作认不出
  vars: Map<string, string | null>
}

// 子命令的上下文：quiet 只找命令本身（不报“看不出”，不记删除位置）；replace 是会被替换成输入内容的记号（xargs -I、find 的 {}）
type Options = { quiet?: boolean; replace?: string | null; noSite?: boolean }

export function scan(command: string): Scan {
  const found: Scan = { hits: [], rms: [] }
  scanInto(command, { found, depth: 0, cd: [], vars: new Map() })

  return found
}

function hit(context: Context, key: DangerKey, source: string): void {
  context.found.hits.push({ kind: 'command', key, source })
}

function scanInto(command: string, context: Context): void {
  if (context.depth > MAX_DEPTH) {
    hit(context, 'tooDeep', command)
    return
  }
  const { segments, inner } = parseShell(command)
  let cd = context.cd
  const vars = new Map(context.vars)
  for (const segment of segments) {
    segmentInto(segment, { ...context, cd, vars })
    cd = cdAfter(segment, cd)
    assignAfter(segment, vars)
  }
  // 命令替换、进程替换里的命令照样会执行
  for (const body of inner) {
    scanInto(body, { ...context, depth: context.depth + 1, cd, vars })
  }
  if (segments.some(segment => segment.words.some(word => SQL_CLIENTS.includes(baseName(word)))) && DROP_SQL.test(command)) {
    hit(context, 'dropTable', command)
  }
}

// cd 以后后面的命令在哪个目录跑：记下参数原文，交给 shell 展开时一并 cd 过去
function cdAfter(segment: Segment, cd: string[] | null): string[] | null {
  const start = commandStart(segment.words).at
  const words = segment.info.slice(start)
  if (words[0]?.text !== 'cd' && words[0]?.text !== 'pushd') {
    return cd
  }
  const target = words.slice(1).find(word => !/^-[LPe@]+$/.test(word.text))
  if (target === undefined) {
    return ['~']
  }
  if (target.text === '-' || UNSAFE_RAW.test(target.raw)) {
    return null
  }
  if (target.text.startsWith('/') || target.text.startsWith('~')) {
    return [target.raw]
  }

  return cd === null ? null : [...cd, target.raw]
}

// 只有赋值、不跑命令的一段（C=…、export C=…）：记下字面值，后面拿它当命令名时认得出。
// 值里有变量、命令替换、通配符的不记；同一个变量赋过不同的值（可能有一次在子 shell 里）就当作认不出
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/
const DECLARERS = ['export', 'readonly', 'typeset', 'declare', 'local']

function assignAfter(segment: Segment, vars: Map<string, string | null>): void {
  const words = DECLARERS.includes(segment.info[0]?.text ?? '') ? segment.info.slice(1) : segment.info
  if (words.length === 0 || commandStart(segment.words).at < segment.words.length) {
    return
  }
  for (const word of words) {
    const match = ASSIGN.exec(word.text)
    if (match === null) {
      continue
    }
    const [, name = '', value = ''] = match
    const known = !word.isDynamic && !word.isGlob ? value : null
    vars.set(name, vars.has(name) && vars.get(name) !== known ? null : known)
  }
}

function segmentInto(segment: Segment, context: Context): void {
  const start = commandStart(segment.words)
  // env -S 'rm -rf' x：字符串会再拆成一条命令，后面的词是它的参数
  for (const splitString of start.splits) {
    const rest = segment.info.slice(start.at).map(word => word.raw)
    scanInto([splitString, ...rest].join(' '), { ...context, depth: context.depth + 1 })
  }
  commandInto(segment.info.slice(start.at), segment, context, start, { replace: start.replace })

  // 包装命令的选项万一没认对（选项带不带参数认错了），真正的命令可能在前后一个词：只按命令本身再看一遍
  if (start.wrappers.length > 0) {
    for (let at = 0; at <= start.at + 1 && at < segment.info.length; at += 1) {
      if (at !== start.at) {
        commandInto(segment.info.slice(at), segment, context, start, { quiet: true })
      }
    }
  }
}

// 命令名：字面的直接用；$HOME/bin/x 这种最后一级是字面的也认得出；$R、$(which rm)、r* 认不出，返回 null
// 整个词就是一个变量（$C、"$C"、${C}），前面赋过字面值的：返回那个值
function variableValue(head: WordInfo, vars: ReadonlyMap<string, string | null>): string | undefined {
  const variable = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(head.raw)?.[1]
  const value = variable === undefined ? undefined : vars.get(variable)

  return typeof value === 'string' && value !== '' ? value : undefined
}

function commandName(head: WordInfo, vars: ReadonlyMap<string, string | null>): string | null {
  const value = variableValue(head, vars)
  if (value !== undefined) {
    return baseName(value)
  }
  if (head.isGlob && /[*?]|\{[^}]*(,|\.\.)[^}]*\}/.test(head.raw)) {
    return null
  }
  if (!head.isDynamic) {
    return baseName(head.text)
  }
  const slash = head.tail.lastIndexOf('/')
  const base = slash < 0 ? '' : head.tail.slice(slash + 1)

  return base === '' ? null : base
}

function commandInto(info: WordInfo[], segment: Segment, context: Context, start: CommandStart, options: Options): void {
  const head = info[0]
  if (head === undefined) {
    return
  }
  const source = segment.source
  const name = commandName(head, context.vars)
  if (name === null) {
    if (options.quiet !== true) {
      hit(context, 'dynamicCommand', source)
    }
    return
  }
  // 命令名是赋过值的变量时，按它的值来判断（R=rm; "$R" -rf x 就是 rm -rf x）
  const words = [variableValue(head, context.vars) ?? head.text, ...info.slice(1).map(word => word.text)]
  const args = info.slice(1)
  const deeper = { ...context, depth: context.depth + 1 }

  if (SHELLS.includes(name)) {
    shellInto(args, segment, context, start, options)
    return
  }
  if (name === 'eval' || name === 'trap') {
    // trap 'rm -rf x' EXIT：第一个参数是以后要执行的命令
    const code = name === 'eval' ? args : args.filter(word => !word.text.startsWith('-')).slice(0, 1)
    if (code.some(word => word.isDynamic)) {
      if (options.quiet !== true) {
        hit(context, 'dynamicEval', source)
      }
    } else if (code.length > 0) {
      scanInto(code.map(word => word.text).join(' '), deeper)
    }
    return
  }
  if (name === 'alias') {
    for (const word of args) {
      const equals = word.text.indexOf('=')
      if (equals > 0) {
        scanInto(word.text.slice(equals + 1), deeper)
      }
    }
    return
  }
  if (name === 'su' || name === 'watch' || name === 'npx' || name === 'pnpx' || name === 'bunx') {
    // su -c '命令'、npx -c '命令'；watch 和 npx 后面的词本身就是一条命令
    const at = args.findIndex(word => word.text === '-c' || word.text === '--command' || word.text === '--call')
    const code = at >= 0 ? args[at + 1] : undefined
    if (code?.isDynamic === true) {
      hit(context, 'dynamicEval', source)
    } else if (code !== undefined) {
      scanInto(code.text, deeper)
    }
    if (name !== 'su') {
      unwrapInto(afterOptions(args, ['-n', '--interval', '-p', '--package', '-c', '--call']), segment, deeper, options)
    }
    return
  }
  if (['pnpm', 'yarn', 'npm', 'bun'].includes(name) && ['dlx', 'exec', 'x'].includes(args[0]?.text ?? '')) {
    unwrapInto(afterOptions(args.slice(1), ['-p', '--package', '-c', '--call']), segment, deeper, options)
    return
  }
  if (name === 'find' || name === 'gfind') {
    findInto(args, segment, context)
    return
  }
  if (name === 'rm') {
    if (isRecursiveRm(words)) {
      hit(context, 'recursiveRm', source)
      if (options.quiet !== true && options.noSite !== true) {
        context.found.rms.push({ args: args.every(word => !UNSAFE_RAW.test(word.raw)) ? args.map(word => word.raw) : null, cd: context.cd })
      }
    }
    return
  }
  const risk = gitRiskOf(words, null)
  if (risk !== null) {
    context.found.hits.push({ kind: 'git', key: risk.kind, source })
    return
  }
  for (const key of dangersOf(name, args.map(word => word.text))) {
    hit(context, key, source)
  }
}

// 一串词本身又是一条命令（find -exec 后面、npx 后面）：同样先去掉 sudo 这类包装
function unwrapInto(info: WordInfo[], segment: Segment, context: Context, options: Options): void {
  const start = commandStart(info.map(word => word.text))
  commandInto(info.slice(start.at), segment, context, start, { ...options, replace: options.replace ?? start.replace })
}

// 跳过开头的选项（带参数的连参数一起），剩下的是一条命令
function afterOptions(args: WordInfo[], withArg: readonly string[]): WordInfo[] {
  let at = 0
  while (at < args.length && args[at]!.text.startsWith('-')) {
    const flag = args[at]!.text
    at += flag === '--' ? 1 : withArg.includes(flag) ? 2 : 1
    if (flag === '--') {
      break
    }
  }

  return args.slice(at)
}

// sh -c '…'：分析字符串；sh <<EOF、sh <<< '…'：分析喂进去的脚本；… | sh：脚本是别的命令的输出，看不出来
function shellInto(args: WordInfo[], segment: Segment, context: Context, start: CommandStart, options: Options): void {
  let at = 0
  let hasCommand = false
  let readsInput = false
  while (at < args.length) {
    const flag = args[at]!.text
    if (flag === '--' || flag === '-') {
      at += 1
      break
    }
    if (!/^[-+]./.test(flag)) {
      break
    }
    if (!flag.startsWith('--')) {
      hasCommand ||= flag.includes('c')
      readsInput ||= flag.includes('s')
    }
    at += ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(flag) ? 2 : 1
  }
  const operand = args[at]
  const source = segment.source
  const deeper = { ...context, depth: context.depth + 1 }
  const opaque = () => {
    if (options.quiet !== true) {
      hit(context, 'pipeShell', source)
    }
  }
  // 输入内容会替换进去的记号：xargs -I{}、find -exec 的 {}
  const replace = options.replace ?? null

  if (hasCommand) {
    if (operand === undefined) {
      return
    }
    if (operand.isDynamic) {
      if (options.quiet !== true) {
        hit(context, 'dynamicEval', source)
      }
    } else if (replace !== null && operand.text.includes(replace)) {
      opaque()
    } else {
      scanInto(operand.text, deeper)
    }
    return
  }
  if (operand === undefined || readsInput) {
    for (const input of segment.inputs) {
      scanInto(input, deeper)
    }
    // 从管道读脚本（curl … | sh），或者 xargs sh 把输入当成脚本名
    if (segment.joiner === '|' || start.wrappers.some(wrapper => wrapper.endsWith('xargs'))) {
      opaque()
    }
    return
  }
  // bash <(curl …)：脚本是运行时生成的
  if (/^[<=]\(/.test(operand.raw)) {
    opaque()
  }
}

function findInto(args: WordInfo[], segment: Segment, context: Context): void {
  let deletes = false
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!.text
    if (word === '-delete') {
      deletes = true
    }
    if (!FIND_EXEC.includes(word)) {
      continue
    }
    let end = at + 1
    while (end < args.length && args[end]!.text !== ';' && args[end]!.text !== '+') {
      end += 1
    }
    const command = args.slice(at + 1, end)
    if (DELETERS.includes(baseName(command[0]?.text ?? ''))) {
      deletes = true
    }
    unwrapInto(command, segment, { ...context, depth: context.depth + 1 }, { replace: '{}', noSite: true })
    at = end
  }
  if (deletes) {
    hit(context, 'findDelete', segment.source)
  }
}

// 子命令：去掉选项以后的那些词
function operands(args: readonly string[]): string[] {
  return args.filter(arg => !arg.startsWith('-'))
}

function follows(list: readonly string[], first: string, second: (word: string) => boolean): boolean {
  return list.some((word, index) => word === first && second(list[index + 1] ?? ''))
}

// 其它不能预览的危险命令：按命令名和它的子命令认
function dangersOf(name: string, args: readonly string[]): DangerKey[] {
  const plain = operands(args)
  if (name === 'dropdb') {
    return ['dropdb']
  }
  if (name.startsWith('mkfs') || name.startsWith('newfs')) {
    return ['format']
  }
  if (name === 'diskutil') {
    const [sub = '', next = ''] = plain.map(word => word.toLowerCase())
    const isFormat = /^(erase|zero|secureerase|partitiondisk|randomdisk|reformat)/.test(sub) || (sub === 'apfs' && /^(delete|erase)/.test(next))
    return isFormat ? ['format'] : []
  }
  if (name === 'dd') {
    return args.some(arg => arg.startsWith('of=')) ? ['dd'] : []
  }
  if (name === 'docker' || name === 'podman' || name === 'docker-compose') {
    const isPrune =
      follows(plain, 'system', word => word === 'prune') ||
      follows(plain, 'volume', word => ['rm', 'remove', 'prune'].includes(word)) ||
      (plain.includes('down') && (name === 'docker-compose' || plain.includes('compose')) && args.some(arg => arg === '-v' || arg === '--volumes'))
    return isPrune ? ['docker'] : []
  }
  if (name === 'kubectl' || name === 'oc' || name === 'kubecolor') {
    return plain.includes('delete') ? ['kubectl'] : []
  }
  if (name === 'terraform' || name === 'tofu' || name === 'terragrunt') {
    return plain.includes('destroy') || args.includes('-destroy') ? ['terraform'] : []
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    return plain.includes('publish') || plain.includes('unpublish') ? ['npmPublish'] : []
  }
  if (name === 'rimraf') {
    return ['rimraf']
  }
  if (name === 'rsync') {
    return args.some(arg => /^--(delete|remove-source-files)/.test(arg)) ? ['rsyncDelete'] : []
  }
  if (name === 'unlink') {
    return ['unlink']
  }
  if (name === 'shred' || name === 'gshred' || name === 'srm') {
    return ['shred']
  }

  return []
}
