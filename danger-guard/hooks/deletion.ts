import type { EngineInterface } from 'claude-code'

import type { DeleteItem, GitState } from '../types'
import type { RmSite } from './analyze'
import { EXPAND_PRELUDE, INSPECT_SCRIPT } from './scripts'
import { baseName, parseShell } from './shell'

// 能安全预览的 rm：整条命令就是一个 rm，前面最多带一个 `cd 目录 &&`，后面可以有重定向。
// 出现变量、命令替换、管道、多条命令，就不预览，交给确认卡片。
// isLiteral：参数里没有通配符和花括号，展开结果和你的 shell 一定一样
const UNSAFE = /[;|&<>`$()\n\\]/

export type RmCommand = { cd: string | null; args: string; isLiteral: boolean }

export function parseRm(command: string): RmCommand | null {
  const { segments, inner } = parseShell(command)
  const rm = segments[segments.length - 1]
  if (inner.length > 0 || rm === undefined || rm.info[0]?.raw !== 'rm' || rm.inputs.length > 0) {
    return null
  }
  const [cd] = segments
  const hasCd = segments.length === 2 && cd!.info.length === 2 && cd!.info[0]!.raw === 'cd' && rm.joiner === '&&'
  if (segments.length > (hasCd ? 2 : 1)) {
    return null
  }
  const words = [...(hasCd ? [cd!.info[1]!] : []), ...rm.info.slice(1)]
  if (words.some(word => UNSAFE.test(word.raw))) {
    return null
  }

  return {
    cd: hasCd ? cd!.info[1]!.raw : null,
    args: rm.info.slice(1).map(word => word.raw).join(' '),
    isLiteral: !rm.info.slice(1).some(word => word.isGlob),
  }
}

// rm 的参数里分出选项和目标；选项只关心是否递归、能不能删空文件夹（-d）
export function splitRmArgs(words: readonly string[]): { isRecursive: boolean; removesDirs: boolean; targets: string[] } {
  let isRecursive = false
  let removesDirs = false
  let isEndOfOptions = false
  const targets: string[] = []

  for (const word of words) {
    if (!isEndOfOptions && word === '--') {
      isEndOfOptions = true
    } else if (!isEndOfOptions && word.startsWith('-') && word.length > 1) {
      isRecursive ||= word === '--recursive' || /^-[a-zA-Z]*[rR]/.test(word)
      removesDirs ||= word === '--dir' || /^-[a-zA-Z]*d/.test(word)
    } else {
      targets.push(word)
    }
  }

  return { isRecursive, removesDirs, targets }
}

type Shell = { argv: string[]; prelude: string; env: Record<string, string> }

// 用 Bash 工具执行命令的那个 shell 来展开（这台机器上是 zsh：** 会递归匹配，bash 3.2 不会）。
// 不读 rc 文件，免得它打印东西搅乱输出；不认识的 shell 一律用 zsh
async function shellOf($: EngineInterface): Promise<Shell> {
  const shell = (await $.env.get('SHELL')) ?? ''
  if (baseName(shell) === 'bash') {
    return { argv: [shell, '--noprofile', '--norc', '-c'], prelude: EXPAND_PRELUDE.bash, env: { BASH_ENV: '' } }
  }

  return { argv: [baseName(shell) === 'zsh' ? shell : '/bin/zsh', '-f', '-c'], prelude: EXPAND_PRELUDE.zsh, env: {} }
}

// 让 shell 自己展开引号、通配符、~ 和花括号，结果用 NUL 分隔；第一个是展开后的工作目录
async function expand($: EngineInterface, shell: Shell, cd: readonly string[], args: string): Promise<{ dir: string; words: string[] } | null> {
  const steps = cd.map(step => `cd -- ${step} || exit 3; `).join('')
  const expanded = await $.process.run([...shell.argv, `${shell.prelude}${steps}printf '%s\\0' "$PWD" ${args}`, 'expand'], {
    env: shell.env,
    timeoutMs: 5000,
  })
  if (expanded.exitCode !== 0) {
    return null
  }
  const [dir, ...words] = expanded.stdout.split('\0').slice(0, -1)

  return dir === undefined ? null : { dir, words }
}

async function inspect($: EngineInterface, shell: Shell, dir: string, targets: readonly string[], mode: 'full' | 'quick'): Promise<DeleteItem[] | null> {
  const inspected = await $.process.run([...shell.argv, INSPECT_SCRIPT, 'inspect', mode, ...targets], {
    cwd: dir,
    env: shell.env,
    timeoutMs: 30000,
  })
  if (inspected.exitCode !== 0) {
    return null
  }

  const root = await $.session.root()
  const fields = inspected.stdout.split('\0').slice(0, -1)
  if (fields.length % 7 !== 0) {
    return null
  }
  const items: DeleteItem[] = []
  for (let at = 0; at < fields.length; at += 7) {
    items.push(itemOf(fields.slice(at, at + 7), root))
  }

  return items
}

// 临时目录里删东西不算“项目外”
const TEMP_DIRS = /^(\/private\/tmp\/|\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/)/i

export type DeletePlan = {
  isRecursive: boolean
  // 加了 -d：空文件夹也会删
  removesDirs: boolean
  items: DeleteItem[]
  // 绝不允许删的系统关键目录，命中就直接拒绝
  forbidden: string | null
}

// unsafe：文件名里有换行或制表符，没法安全地列清单
export async function planDeletion($: EngineInterface, rm: RmCommand): Promise<DeletePlan | 'unsafe' | null> {
  const shell = await shellOf($)
  const expanded = await expand($, shell, rm.cd === null ? [] : [rm.cd], rm.args)
  if (expanded === null) {
    return null
  }

  const { isRecursive, removesDirs, targets } = splitRmArgs(expanded.words)
  if (targets.length === 0) {
    return { isRecursive, removesDirs, items: [], forbidden: null }
  }
  if (targets.some(target => /[\n\t]/.test(target))) {
    return 'unsafe'
  }

  const items = await inspect($, shell, expanded.dir, targets, 'full')
  if (items === null) {
    return null
  }

  return { isRecursive, removesDirs, items, forbidden: items.find(item => item.type === 'critical')?.path ?? null }
}

// 别的写法里的递归删除（`sudo rm -rf /`、`rm -rf ~ && …`、`/bin/rm -rf ~`）：只看有没有系统关键目录，
// 有就返回它。不知道在哪个目录跑的，只看绝对路径和 ~ 开头的参数
export async function forbiddenIn($: EngineInterface, sites: readonly RmSite[]): Promise<string | null> {
  const shell = await shellOf($)
  for (const site of sites) {
    if (site.args === null) {
      continue
    }
    const args = site.cd === null ? site.args.filter(arg => arg.startsWith('-') || /^['"]?[/~]/.test(arg)) : site.args
    const expanded = await expand($, shell, site.cd ?? [], args.join(' ')).catch(() => null)
    const targets = expanded === null ? [] : splitRmArgs(expanded.words).targets.filter(target => !/[\n\t]/.test(target))
    if (expanded === null || targets.length === 0) {
      continue
    }
    const items = await inspect($, shell, expanded.dir, targets, 'quick').catch(() => null)
    const critical = items?.find(item => item.type === 'critical')
    if (critical !== undefined) {
      return critical.path
    }
  }

  return null
}

function itemOf(fields: string[], root: string): DeleteItem {
  const [type = 'missing', files = '0', kb = '0', git = 'none', path = '', given = '', target = ''] = fields
  // APFS 不分大小写：/P/Src 和 /p/src 是同一个地方
  const lower = path.toLowerCase()
  const rootLower = root.toLowerCase()
  const isInside = lower === rootLower || lower.startsWith(`${rootLower}/`) || TEMP_DIRS.test(path)

  return {
    type: type as DeleteItem['type'],
    files: Number(files) || 0,
    kb: Number(kb) || 0,
    git: git as GitState,
    path,
    given,
    target,
    isOutsideProject: !isInside,
  }
}

// 不弹卡片的情况：少量、非递归、都在项目里、都是 git 里干净的文件（或者 git 中断后留下的锁文件）
export function needsReview(plan: DeletePlan): boolean {
  const present = plan.items.filter(item => item.type !== 'missing')

  return (
    plan.isRecursive ||
    present.length > 3 ||
    present.some(item => item.type === 'dir' || (item.git !== 'clean' && item.git !== 'lock') || item.isOutsideProject)
  )
}

export function isRecoverableFromGit(item: DeleteItem): boolean {
  return item.git === 'clean'
}

// 写了 link/ 的符号链接：真正的 rm 会去动它指向的文件夹，这里只处理链接本身
export function isLinkWithSlash(item: DeleteItem): boolean {
  return item.type === 'link' && item.given.endsWith('/')
}

function quoted(items: readonly DeleteItem[]): string {
  return items.map(item => `'${item.path.replace(/'/g, `'\\''`)}'`).join(' ')
}

export function trashCommand(items: readonly DeleteItem[]): string {
  return `trash ${quoted(items)}`
}

// 永久删除也只删审过的绝对路径
export function purgeCommand(items: readonly DeleteItem[]): string {
  return `rm -rf -- ${quoted(items)}`
}

export function sizeOf(kb: number): string {
  if (kb < 1024) {
    return `${kb} KB`
  }
  if (kb < 1024 * 1024) {
    return `${(kb / 1024).toFixed(1)} MB`
  }

  return `${(kb / 1024 / 1024).toFixed(2)} GB`
}
