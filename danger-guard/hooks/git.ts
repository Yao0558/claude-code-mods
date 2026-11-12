import type { EngineInterface } from 'claude-code'

import type { CardRow } from './card'
import type { Text } from './i18n'
import { textOf } from './i18n'
import { WHERE_SCRIPT } from './scripts'
import { gitParts, parseShell } from './shell'

// 推送的一项：推上去的是哪个本地引用（默认 HEAD），覆盖远端的哪个分支（null 是当前分支的同名分支）
export type PushSpec = { source: string; ref: string | null }

// 能提前算出影响范围的 git 危险操作
export type GitRisk =
  | { kind: 'reset'; cd: string | null; gitDir: string | null; ref: string | null }
  // base：从哪个版本取回（null 是从暂存区取回）；withStaged：暂存区的改动也会被盖掉；paths：涉及哪些路径
  | { kind: 'discard'; cd: string | null; gitDir: string | null; base: string | null; withStaged: boolean; paths: string[] }
  | { kind: 'clean'; cd: string | null; gitDir: string | null; args: string[] }
  // source、ref 是第一项推送，specs 是全部；isAll：--all、--branches、--tags 一下推很多分支
  | { kind: 'push'; cd: string | null; gitDir: string | null; remote: string | null; source: string; ref: string | null; specs: PushSpec[]; isAll: boolean }
  // 删掉远端分支：--delete 和 :分支 点名删；--prune、--mirror 删掉本地没有的
  | { kind: 'pushDelete'; cd: string | null; gitDir: string | null; remote: string | null; branches: string[]; mode: 'delete' | 'prune' | 'mirror' }
  | { kind: 'branch'; cd: string | null; gitDir: string | null; name: string; names: string[] }
  // drop：丢掉哪一个储藏；null 是 git stash clear，全部丢掉
  | { kind: 'stash'; cd: string | null; gitDir: string | null; drop: string | null }

export type GitPreview = { title: string; question: string; rows: CardRow[]; more: number; notes: string[] }

// git 命令出错：带着 git 自己的报错（原文，不翻译）
export class GitError extends Error {
  constructor(readonly stderr: string) {
    super(stderr)
  }
}

const LIST_MAX = 12

type Split = { options: string[]; operands: string[]; afterDash: string[] | null; values: Record<string, string> }

// 子命令的参数分成选项和其余的词：withArg 里的选项会带走下一个词（-s REV），也认 --source=REV、-sREV；-- 之后都是路径
function split(args: readonly string[], withArg: readonly string[]): Split {
  const found: Split = { options: [], operands: [], afterDash: null, values: {} }
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!
    if (arg === '--') {
      found.afterDash = args.slice(at + 1)
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      found.operands.push(arg)
      continue
    }
    found.options.push(arg)
    const name = arg.split('=')[0]!
    if (withArg.includes(name)) {
      if (arg.includes('=')) {
        found.values[name] = arg.slice(name.length + 1)
      } else if (args[at + 1] !== undefined) {
        found.values[name] = args[at + 1]!
        at += 1
      }
    } else if (!arg.startsWith('--') && withArg.includes(arg.slice(0, 2)) && arg.length > 2) {
      found.values[arg.slice(0, 2)] = arg.slice(2)
    }
  }

  return found
}

// 合在一起的短选项里有没有这个字母（-df 里有 d 也有 f）
function hasShort(options: readonly string[], letter: string): boolean {
  return options.some(option => /^-[a-zA-Z]+$/.test(option) && option.slice(1).includes(letter))
}

// 不加 -- 时，checkout 后面哪些词一看就是路径而不是分支名
function isPathspec(word: string): boolean {
  return word === '.' || word === '..' || word.startsWith('./') || word.startsWith('../') || word.startsWith(':/') || word.startsWith(':(') || /[*?]/.test(word)
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

function checkoutRisk(args: readonly string[], cd: string | null, gitDir: string | null): GitRisk | null {
  const { options, operands, afterDash } = split(args, ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'])
  if (afterDash !== null && afterDash.length > 0) {
    const base = operands[0] ?? null
    return { kind: 'discard', cd, gitDir, base, withStaged: base !== null, paths: afterDash }
  }
  const paths = operands.filter(isPathspec)
  if (paths.length > 0) {
    const base = operands.find(operand => !isPathspec(operand)) ?? null
    return { kind: 'discard', cd, gitDir, base, withStaged: base !== null, paths }
  }
  // checkout -f 切换（或不切换）时丢掉所有没提交的改动
  if (options.includes('--force') || hasShort(options.filter(option => !['-b', '-B'].includes(option)), 'f')) {
    return { kind: 'discard', cd, gitDir, base: 'HEAD', withStaged: true, paths: ['.'] }
  }

  return null
}

function restoreRisk(args: readonly string[], cd: string | null, gitDir: string | null): GitRisk | null {
  const { options, operands, afterDash, values } = split(args, ['-s', '--source', '--pathspec-from-file', '--conflict'])
  const paths = [...operands, ...(afterDash ?? [])]
  const fromFile = values['--pathspec-from-file']
  if (paths.length === 0 && fromFile === undefined) {
    return null
  }
  const isStaged = options.includes('--staged') || hasShort(options, 'S')
  const isWorktree = options.includes('--worktree') || hasShort(options, 'W')
  // 只有 --staged 而没有 --worktree，是取消暂存，不丢改动
  if (isStaged && !isWorktree) {
    return null
  }
  const source = values['-s'] ?? values['--source'] ?? null

  return { kind: 'discard', cd, gitDir, base: source ?? (isStaged ? 'HEAD' : null), withStaged: isStaged, paths: paths.length > 0 ? paths : ['.'] }
}

function pushRisk(args: readonly string[], cd: string | null, gitDir: string | null): GitRisk | null {
  const { options, operands } = split(args, ['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
  const remote = operands[0] ?? null
  const specs = operands.slice(1)
  if (options.includes('--mirror')) {
    return { kind: 'pushDelete', cd, gitDir, remote, branches: [], mode: 'mirror' }
  }
  if (options.includes('--prune')) {
    return { kind: 'pushDelete', cd, gitDir, remote, branches: [], mode: 'prune' }
  }
  const isDelete = options.includes('--delete') || hasShort(options, 'd')
  const deleted = isDelete
    ? specs.map(spec => branchName(spec.replace(/^\+/, '')))
    : specs.filter(spec => /^\+?:./.test(spec)).map(spec => branchName(spec.replace(/^\+?:/, '')))
  if (deleted.length > 0) {
    return { kind: 'pushDelete', cd, gitDir, remote, branches: deleted, mode: 'delete' }
  }

  const isForce =
    options.some(option => option === '--force' || option.startsWith('--force-with-lease')) || hasShort(options, 'f') || specs.some(spec => spec.startsWith('+'))
  if (!isForce) {
    return null
  }
  const pushed = specs.map((spec): PushSpec => {
    const [source = '', target] = spec.replace(/^\+/, '').split(':')
    return { source: source === '' ? 'HEAD' : source, ref: branchName(target ?? source) }
  })
  const [first = { source: 'HEAD', ref: null }] = pushed

  return {
    kind: 'push',
    cd,
    gitDir,
    remote,
    source: first.source,
    ref: first.ref,
    specs: pushed.length > 0 ? pushed : [first],
    isAll: options.some(option => ['--all', '--branches', '--tags'].includes(option)),
  }
}

// 一段命令里的 git 调用是不是危险操作；cd 是这一段前面 `cd 目录 &&` 的目录
export function gitRiskOf(words: readonly string[], cd: string | null): GitRisk | null {
  const parts = gitParts(words)
  if (parts === null) {
    return null
  }
  const { gitDir, sub, args } = parts
  const dashAt = args.indexOf('--')
  const plain = args.filter((arg, index) => !arg.startsWith('-') || index === dashAt).filter(arg => arg !== '--')

  if (sub === 'reset' && args.includes('--hard')) {
    return { kind: 'reset', cd, gitDir, ref: plain[0] ?? null }
  }
  if (sub === 'checkout') {
    return checkoutRisk(args, cd, gitDir)
  }
  if (sub === 'restore') {
    return restoreRisk(args, cd, gitDir)
  }
  if (sub === 'switch' && (args.includes('--force') || args.includes('--discard-changes') || hasShort(args, 'f'))) {
    return { kind: 'discard', cd, gitDir, base: 'HEAD', withStaged: true, paths: ['.'] }
  }
  // 除了演练（-n）都算：clean.requireForce 关掉时不加 -f 也会删
  if (sub === 'clean' && !args.includes('--dry-run') && !hasShort(args, 'n')) {
    return { kind: 'clean', cd, gitDir, args }
  }
  if (sub === 'push') {
    return pushRisk(args, cd, gitDir)
  }
  if (sub === 'branch') {
    const { options, operands } = split(args, ['-u', '--set-upstream-to', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
    const isDelete = options.includes('--delete') || hasShort(options, 'd') || hasShort(options, 'D')
    const isForce = options.includes('--force') || hasShort(options, 'f') || hasShort(options, 'D')
    if (isDelete && isForce && operands[0] !== undefined) {
      return { kind: 'branch', cd, gitDir, name: operands[0], names: operands }
    }
  }
  if (sub === 'stash' && plain[0] === 'clear') {
    return { kind: 'stash', cd, gitDir, drop: null }
  }
  if (sub === 'stash' && plain[0] === 'drop') {
    return { kind: 'stash', cd, gitDir, drop: plain[1] ?? 'stash@{0}' }
  }

  return null
}

// 能预览的形状：整条命令就是一个 git 调用，前面最多一个 `cd 目录 &&`；
// 有变量、命令替换，或用 --git-dir / --work-tree 指到别处，就不预览
export function classifyGit(command: string): GitRisk | null {
  const { segments, inner } = parseShell(command)
  if (inner.length > 0 || segments.some(segment => segment.info.some(word => word.isDynamic) || segment.inputs.length > 0)) {
    return null
  }
  const last = segments[segments.length - 1]
  if (last === undefined || gitParts(last.words)?.isRedirected === true) {
    return null
  }
  if (segments.length === 1) {
    return gitRiskOf(last.words, null)
  }
  const [first] = segments
  if (segments.length === 2 && first!.words[0] === 'cd' && first!.words.length === 2 && last.joiner === '&&') {
    return gitRiskOf(last.words, first!.words[1]!)
  }

  return null
}

async function whereIn($: EngineInterface, risk: GitRisk): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const steps = [risk.cd, risk.gitDir].filter((step): step is string => step !== null).map(step => step.replace(/^~(?=\/|$)/, home))
  const moved = await $.process.run(['/bin/sh', '-c', WHERE_SCRIPT, 'where', ...steps], { timeoutMs: 5000 })

  return moved.exitCode === 0 ? moved.stdout.trim() : null
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string[]> {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: 15000 })
  if (ran.exitCode !== 0) {
    throw new GitError(ran.stderr.trim())
  }

  return ran.stdout.split('\n').filter(Boolean)
}

// git status --porcelain 的一行：两个状态字母、一个空格、路径。
// 万一输出被去掉了开头的空格（" M a" 变成 "M a"），也按一个字母的状态认，不切掉路径的头一个字
function statusRow(line: string, t: Text['git']): CardRow {
  const [, code = 'M', path = line] = /^(.{2}) (.*)$/.exec(line) ?? /^(\S) (.*)$/.exec(line) ?? []
  const letter = code.trim()[0] ?? 'M'

  return { icon: '📄', name: path, meta: t.status[letter] ?? letter, warning: t.uncommittedLost }
}

function commitRow(line: string, warning: string): CardRow {
  const [hash = '', ...subject] = line.split(' ')

  return { icon: '◆', name: subject.join(' '), meta: hash, warning }
}

function listed(rows: CardRow[]): { rows: CardRow[]; more: number } {
  return { rows: rows.slice(0, LIST_MAX), more: Math.max(0, rows.length - LIST_MAX) }
}

function union(...lists: string[][]): string[] {
  return [...new Set(lists.flat())]
}

// 远端跟踪分支里，本地没有同名分支的那些（--prune、--mirror 会把它们从远端删掉）
async function orphanBranches($: EngineInterface, cwd: string, remote: string): Promise<string[]> {
  const remoteBranches = await git($, cwd, ['for-each-ref', '--format=%(refname:lstrip=3)', `refs/remotes/${remote}`])
  const local = new Set(await git($, cwd, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']))

  return remoteBranches.filter(branch => branch !== 'HEAD' && !local.has(branch))
}

async function discardPreview($: EngineInterface, cwd: string, risk: Extract<GitRisk, { kind: 'discard' }>, t: Text['git']): Promise<GitPreview> {
  const paths = ['--', ...risk.paths]
  // 会被改掉的文件：工作区和 base（或暂存区）不一样的；带 --staged 时还有暂存区和 base 不一样的
  const changed = union(
    await git($, cwd, ['diff', '--name-only', ...(risk.base === null ? [] : [risk.base]), ...paths]),
    risk.withStaged ? await git($, cwd, ['diff', '--cached', '--name-only', risk.base ?? 'HEAD', ...paths]) : [],
  )
  // 其中真正找不回的：有没提交的改动（工作区和暂存区不一样，或带 --staged 时暂存区和 HEAD 不一样）
  const uncommitted = new Set(
    risk.base === null
      ? changed
      : union(await git($, cwd, ['diff', '--name-only', ...paths]), risk.withStaged ? await git($, cwd, ['diff', '--cached', '--name-only', 'HEAD', ...paths]) : []),
  )
  const lost = changed.filter(path => uncommitted.has(path))
  const rows = [...lost, ...changed.filter(path => !uncommitted.has(path))].map(path =>
    uncommitted.has(path)
      ? { icon: '📄', name: path, meta: risk.withStaged ? t.uncommitted : t.unstaged, warning: t.changesLost }
      : { icon: '📄', name: path, meta: t.revertsTo(risk.base ?? 'HEAD'), warning: null },
  )

  return {
    title: t.discardTitle,
    question: lost.length > 0 ? t.discardQuestion(lost.length, risk.withStaged) : changed.length > 0 ? t.discardCommitted(changed.length) : t.discardSafe,
    ...listed(rows),
    notes: lost.length > 0 ? [t.discardNote] : [],
  }
}

async function pushPreview($: EngineInterface, cwd: string, risk: Extract<GitRisk, { kind: 'push' }>, t: Text['git']): Promise<GitPreview> {
  const remote = risk.remote ?? 'origin'
  if (risk.isAll) {
    return { title: t.pushTitle, question: t.pushAll(remote), rows: [], more: 0, notes: [t.pushNote] }
  }
  const rows: CardRow[] = []
  const names: string[] = []
  for (const spec of risk.specs) {
    const branch = spec.ref ?? (await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))[0] ?? 'HEAD'
    const tracking = `refs/remotes/${remote}/${branch}`
    names.push(`${remote}/${branch}`)
    const known = await $.process.run(['git', 'rev-parse', '--verify', '-q', tracking], { cwd, timeoutMs: 5000 })
    if (known.exitCode !== 0) {
      return { title: t.pushTitle, question: t.pushUnknown(`${remote}/${branch}`), rows: [], more: 0, notes: [t.pushFetch] }
    }
    // 推上去的是 source（git push -f origin feature 推的是本地 feature，不是当前分支）
    rows.push(...(await git($, cwd, ['log', '--oneline', `${spec.source}..${remote}/${branch}`])).map(line => commitRow(line, t.leavesRemote)))
  }
  const target = names.join(', ')

  return {
    title: t.pushTitle,
    question: rows.length > 0 ? t.pushDrops(target, rows.length) : t.pushSafe(target),
    ...listed(rows),
    notes: [t.pushNote],
  }
}

async function pushDeletePreview($: EngineInterface, cwd: string, risk: Extract<GitRisk, { kind: 'pushDelete' }>, t: Text['git']): Promise<GitPreview> {
  const remote = risk.remote ?? 'origin'
  const branches = risk.mode === 'delete' ? risk.branches : await orphanBranches($, cwd, remote)
  const rows: CardRow[] = []
  let lost = 0
  for (const branch of branches) {
    const known = await $.process.run(['git', 'rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`], { cwd, timeoutMs: 5000 })
    if (known.exitCode !== 0) {
      rows.push({ icon: '⎇', name: `${remote}/${branch}`, meta: t.noRecord, warning: null })
      continue
    }
    // 只在这个远端分支上、别的分支都没有的提交：删了分支就不在任何分支上了
    const only = await git($, cwd, ['log', '--oneline', `refs/remotes/${remote}/${branch}`, '--not', `--exclude=${remote}/${branch}`, '--remotes', '--branches'])
    lost += only.length
    rows.push({ icon: '⎇', name: `${remote}/${branch}`, meta: t.onlyHere(only.length), warning: only.length > 0 ? t.commitsLost : null })
  }
  const notes = [...(risk.mode === 'mirror' ? [t.mirrorNote] : []), ...(risk.mode === 'delete' ? [] : [t.pruneNote]), ...(lost > 0 ? [t.branchNote] : [])]

  return {
    title: t.pushDeleteTitle,
    question: branches.length > 0 ? t.pushDeletes(remote, branches.length, lost) : t.pushDeleteNone(remote),
    ...listed(rows),
    notes,
  }
}

async function stashPreview($: EngineInterface, cwd: string, risk: Extract<GitRisk, { kind: 'stash' }>, t: Text['git']): Promise<GitPreview> {
  const entries = await git($, cwd, ['stash', 'list'])
  // drop 写的可能是 stash@{1}，也可能只写 1
  const wanted = risk.drop === null ? null : /^\d+$/.test(risk.drop) ? `stash@{${risk.drop}}` : risk.drop
  const dropped = wanted === null ? entries : entries.filter(entry => entry.startsWith(`${wanted}:`))
  const rows = dropped.map(entry => {
    const [ref = entry, ...rest] = entry.split(': ')
    return { icon: '◆', name: rest.join(': ') || entry, meta: ref, warning: t.stashLost }
  })

  return {
    title: t.stashTitle,
    question: rows.length > 0 ? t.stashQuestion(rows.length) : t.stashNone,
    ...listed(rows),
    notes: rows.length > 0 ? [t.stashNote] : [],
  }
}

export async function previewGit($: EngineInterface, risk: GitRisk): Promise<GitPreview> {
  const texts = await textOf($)
  const t = texts.git
  const cwd = await whereIn($, risk)
  if (cwd === null) {
    return { title: texts.gitFallbackTitle, question: t.noDirQuestion, rows: [], more: 0, notes: [] }
  }

  if (risk.kind === 'reset') {
    const changed = await git($, cwd, ['status', '--porcelain', '--untracked-files=no'])
    const dropped = risk.ref === null ? [] : await git($, cwd, ['log', '--oneline', `${risk.ref}..HEAD`]).catch(() => [])
    const rows = [...changed.map(line => statusRow(line, t)), ...dropped.map(line => commitRow(line, t.leavesBranch))]
    const parts = [
      changed.length > 0 ? t.discardFiles(changed.length) : null,
      dropped.length > 0 ? t.leaveCommits(dropped.length) : null,
    ].filter((part): part is string => part !== null)

    return {
      title: t.resetTitle,
      question: parts.length > 0 ? t.willDo(parts) : t.resetSafe,
      ...listed(rows),
      notes: [...(changed.length > 0 ? [t.notRecorded] : []), ...(dropped.length > 0 ? [t.reflog] : [])],
    }
  }

  if (risk.kind === 'discard') {
    return discardPreview($, cwd, risk, t)
  }

  if (risk.kind === 'clean') {
    // 同样的参数加上 -n 先演练一遍（-n 优先于 -f）；去掉 -q，不然演练什么都不打印；保留 -ff，它会连嵌套的仓库一起删
    const dryArgs = risk.args
      .filter(arg => arg !== '--quiet')
      .map(arg => (/^-[a-zA-Z]+$/.test(arg) && !arg.includes('e') ? arg.replace(/q/g, '') : arg))
      .filter(arg => arg !== '-')
    const removed = (await git($, cwd, ['clean', '-n', ...dryArgs])).map(line => line.replace(/^Would remove /, ''))

    return {
      title: t.cleanTitle,
      question: removed.length > 0 ? t.cleanQuestion(removed.length) : t.cleanSafe,
      ...listed(
        removed.map(path => ({ icon: path.endsWith('/') ? '📁' : '📄', name: path, meta: t.untracked, warning: t.notInGit })),
      ),
      notes: removed.length > 0 ? [t.cleanNote] : [],
    }
  }

  if (risk.kind === 'push') {
    return pushPreview($, cwd, risk, t)
  }

  if (risk.kind === 'pushDelete') {
    return pushDeletePreview($, cwd, risk, t)
  }

  if (risk.kind === 'stash') {
    return stashPreview($, cwd, risk, t)
  }

  const rows: CardRow[] = []
  for (const name of risk.names) {
    const unmerged = await git($, cwd, ['log', '--oneline', `HEAD..${name}`]).catch(() => [])
    rows.push(...unmerged.map(line => commitRow(line, t.unmerged(name))))
  }
  const name = risk.names.join(', ')

  return {
    title: t.branchTitle,
    question: rows.length > 0 ? t.branchUnmerged(name, rows.length) : t.branchSafe(name),
    ...listed(rows),
    notes: rows.length > 0 ? [t.branchNote] : [],
  }
}
