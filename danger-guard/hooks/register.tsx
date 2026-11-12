import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { DeleteItem } from '../types'
import type { Hit } from './analyze'
import { scan } from './analyze'
import type { Card, CardRow, Choice } from './card'
import { COMMAND_LIMIT, askTextOf, commandView, decide, heldCard, markTimedOut, whyNot } from './card'
import { forbiddenIn, isLinkWithSlash, isRecoverableFromGit, needsReview, parseRm, planDeletion, purgeCommand, sizeOf, trashCommand } from './deletion'
import { GitError, classifyGit, previewGit } from './git'
import type { Text } from './i18n'
import { textOf } from './i18n'
import { OWNER_SCRIPT } from './scripts'

// 危险命令按 shell 的方式拆成词来认（见 analyze.ts）：rm、git、dropdb、kubectl delete……
// 命中任何一条，都要你在卡片上点头；自动模式的分类器也放不过去

// 密钥、证书、凭据一类的文件；.env.example 这类模板不算。不分大小写（APFS 上 .ENV 就是 .env）
const PROTECTED_FILES =
  /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.ssh\/.+|\.aws\/.+|\.gnupg\/.+|\.kube\/config|\.docker\/config\.json)$/i

// 退回原生对话框时，清单最多列几项：终端的对话框只有 12 行，桌面 48 行
const ASK_ROWS = { terminal: 3, other: 12 }

// 卡片上最多单独列几段有风险的命令
const RISKY_MAX = 4

const allowedDirs = atom({ plugin: 'danger-guard', key: 'allowedDirs' } as const, [])

// 你在卡片上点过同意的那一次工具调用（按调用 id 记，不按命令文字），权限检查不再问第二遍
const approved = new Set<string>()

async function runApproved<T>(callId: string | undefined, run: () => Promise<T>): Promise<T> {
  if (callId !== undefined) {
    approved.add(callId)
  }
  try {
    return await run()
  } finally {
    if (callId !== undefined) {
      approved.delete(callId)
    }
  }
}

// 命令里所有的危险操作，每种说一次（`git reset --hard && rm -rf ~` 两样都列出来）
function labelsOf(hits: readonly Hit[], t: Text): string[] {
  return [...new Set(hits.map(found => (found.kind === 'git' ? t.gitLabels[found.key] : t.commands[found.key])))]
}

function riskyOf(hits: readonly Hit[]): string[] {
  return [...new Set(hits.map(found => found.source))].slice(0, RISKY_MAX)
}

function cancelOf(t: Text): Choice {
  return { key: 'cancel', ...t.cancel }
}

// isOutsideShared：所有项都在项目外时，这句提醒统一放到卡片底部，不在每行重复
function warningOf(item: DeleteItem, t: Text, isOutsideShared = false): string | null {
  const notes = [
    item.git === 'repo' ? t.warnings.repo : null,
    item.git === 'history' ? t.warnings.history : null,
    item.git === 'internal' ? t.warnings.internal : null,
    item.git === 'dirty' ? t.warnings.dirty : null,
    item.git === 'none' ? t.warnings.none : null,
    item.isOutsideProject && !isOutsideShared ? t.warnings.outside : null,
  ].filter(note => note !== null)

  return notes.length > 0 ? notes.join(t.warnings.joiner) : null
}

function deleteRow(item: DeleteItem, isOutsideShared: boolean, t: Text): CardRow {
  // 显示原写法（带相对路径），两个同名的 build/ 也分得清
  const name = shortenPaths(item.given.replace(/\/+$/, '') || item.path)
  const files = item.type === 'dir' ? t.fileCount(item.files) : ''

  return {
    icon: item.type === 'dir' ? '📁' : item.type === 'link' ? '🔗' : '📄',
    name: item.type === 'dir' ? `${name}/` : name,
    meta: `${files}${sizeOf(item.kb)}`,
    warning: warningOf(item, t, isOutsideShared),
  }
}

// 清单里很长的绝对路径只留最后两级，免得一项占满三行（命令本身完整显示）
function shortenPaths(text: string): string {
  return text.replace(/\/(?:[^\s/]+\/){2,}([^\s/]+\/[^\s/]*)/g, '…/$1')
}

function deleteCard(command: string, items: DeleteItem[], t: Text): Card {
  const dirs = items.filter(item => item.type === 'dir').length
  const files = items.length - dirs
  const kinds = [dirs > 0 ? t.folders(dirs) : null, files > 0 ? t.files(files) : null].filter(Boolean).join(t.kindsJoiner)
  const kb = items.reduce((sum, item) => sum + item.kb, 0)
  const lost = items.filter(item => !isRecoverableFromGit(item)).length
  const isOutsideShared = items.every(item => item.isOutsideProject)
  const rows = items.map(item => deleteRow(item, isOutsideShared, t))

  return {
    title: t.deleteTitle,
    question: t.deleteQuestion(items.length, kinds, sizeOf(kb)),
    command,
    risky: [],
    rows: rows.slice(0, 12),
    more: Math.max(0, rows.length - 12),
    notes: [
      ...(lost > 0 ? [t.lostNote(lost)] : []),
      ...(isOutsideShared ? [t.allOutside] : []),
      ...items.filter(isLinkWithSlash).map(item => t.linkNote(item.given)),
    ],
    choices: [
      cancelOf(t),
      { key: 'trash', label: t.trash.label, description: t.trash.description(items.length), tone: 'primary' },
      { key: 'purge', label: t.purge.label, tone: 'danger', description: t.purge.description(lost > 0) },
    ],
    decision: null,
  }
}

function proceedCard(t: Text, title: string, question: string, command: string, risky: string[], rows: CardRow[], more: number, notes: string[]): Card {
  return {
    title,
    question,
    command,
    risky,
    rows,
    more,
    notes,
    choices: [cancelOf(t), { key: 'proceed', ...t.proceed, tone: 'danger' }],
    decision: null,
  }
}

// 文件的真实位置（符号链接都解开）和它属于哪个目录；算不出来（坏掉的链接、绕圈、进不去）就是 null，按最坏的情况问你
async function realAndOwner($: EngineInterface, path: string): Promise<{ real: string; owner: string } | null> {
  const found = await $.process.run(['/bin/sh', '-c', OWNER_SCRIPT, 'owner', path], { timeoutMs: 5000 })
  const [real = '', owner = ''] = found.stdout.split('\n')

  return found.exitCode === 0 && real.startsWith('/') && owner.startsWith('/') ? { real, owner } : null
}

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

// path 在不在 dir 里面（或就是它）；APFS 不分大小写，按小写比
function isUnder(path: string, dir: string): boolean {
  const lower = path.toLowerCase()
  const base = dir.toLowerCase().replace(/\/+$/, '')

  return lower === base || lower.startsWith(`${base}/`)
}

// 项目记忆：~/.claude/projects/<项目>/memory/ 下的文件
function isMemory(path: string, home: string): boolean {
  const prefix = `${home}/.claude/projects/`.toLowerCase()
  const lower = path.toLowerCase()
  const parts = lower.slice(prefix.length).split('/')

  return lower.startsWith(prefix) && parts.length >= 3 && parts[0] !== '' && parts[1] === 'memory' && parts[2] !== ''
}

// 临时目录：/tmp（会话的 scratchpad 在 /private/tmp/claude-* 下）和 $TMPDIR；$TMPDIR 长得不像系统临时目录就不算
async function tempDirs($: EngineInterface): Promise<string[]> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')
  const dirs = ['/private/tmp', '/tmp']
  if (/^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/.test(tmp)) {
    dirs.push(tmp.replace(/^\/var\//, '/private/var/'), tmp.replace(/^\/private\/var\//, '/var/'))
  }

  return dirs
}

// 归属是主目录、根目录这种太大的，不给“本会话都允许”，免得一下放开一大片
function isBroad(owner: string, home: string): boolean {
  const lower = owner.toLowerCase().replace(/\/+$/, '') || '/'

  return ['/', '/users', '/volumes', '/system/volumes/data', home.toLowerCase()].includes(lower)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = await textOf($)
    const run = (command: string, description?: string) =>
      runApproved(e.tool_use_id, () => next(description === undefined ? e : { ...e, command, description }))
    const found = scan(e.command)

    // 1. 能预览的 rm：列清单，默认移到废纸篓
    const rm = parseRm(e.command)
    const plan = rm === null ? null : await planDeletion($, rm).catch(() => null)
    if (plan !== null && plan !== 'unsafe' && plan.forbidden !== null) {
      return { deny: t.forbidden(plan.forbidden) }
    }
    // 别的写法（sudo rm -rf /、rm -rf ~ && …、/bin/rm -rf ~）碰到系统关键目录，同样直接拒绝
    if (plan === null || plan === 'unsafe') {
      const forbidden = await forbiddenIn($, found.rms).catch(() => null)
      if (forbidden !== null) {
        return { deny: t.forbidden(forbidden) }
      }
    }

    let labels = labelsOf(found.hits, t)
    if (rm !== null && plan !== null && plan !== 'unsafe') {
      // 没加 -r 的 rm 本来就删不了文件夹（-d 能删空的）：只处理文件，文件夹留着
      const present = plan.items.filter(item => item.type !== 'missing' && (plan.isRecursive || plan.removesDirs || item.type !== 'dir'))
      if (present.length > 0) {
        return deleteReviewed($, e.command, present, needsReview(plan), t, rm.cd, run, next.signal)
      }
      // 要删的都不存在：只有参数全是字面路径（没有通配符）时，才能确定原命令什么也不删，照常跑
      if (rm.isLiteral) {
        return run(e.command)
      }
      // 通配符一个也没匹配到：你的 shell 设置可能和预览时不同，递归删除要你确认，非递归的交回正常流程
      if (!plan.isRecursive) {
        return next(e)
      }
      labels = [t.unmatched]
    } else if (rm !== null) {
      labels = [plan === 'unsafe' ? t.unsafeList : t.unlisted]
    }

    // 2. 常见的 git 危险操作：先算出会丢什么；3. 其它危险命令，或者 rm 预览不了：也要你点头
    const gitRisk = rm === null ? classifyGit(e.command) : null
    if (gitRisk === null && labels.length === 0) {
      return next(e)
    }

    const risky = riskyOf(found.hits)
    const card =
      gitRisk !== null
        ? await previewGit($, gitRisk)
            .then(preview => proceedCard(t, preview.title, preview.question, e.command, risky, preview.rows, preview.more, preview.notes))
            .catch((error: unknown) =>
              proceedCard(
                t,
                t.gitFallbackTitle,
                t.gitFallbackQuestion(error instanceof GitError && error.stderr !== '' ? t.gitSaid(error.stderr.slice(0, 160)) : t.gitCheckFailed),
                e.command,
                risky,
                [],
                0,
                [],
              ),
            )
        : proceedCard(t, t.dangerTitle, t.dangerQuestion(labels), e.command, risky, [], 0, [t.dangerNote])

    const decision = await decide($, card, next.signal)
    if (decision !== 'proceed') {
      return { deny: t.notRun(whyNot(decision, t)) }
    }

    return run(e.command)
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: (await textOf($)).commandCheckFailed }))

  // 改项目目录外的文件：可能是在别的项目、别的主体的目录里动手；~/.claude 下的（记忆除外）每次都问
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const args = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const raw = typeof args.file_path === 'string' ? args.file_path : args.notebook_path
    if (typeof raw !== 'string' || raw === '') {
      return next(e)
    }

    // ~ 和相对路径也要算出真正的位置；符号链接解开，看它实际指向哪里
    const home = (await $.env.get('HOME')) ?? ''
    const absolute = raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : raw.startsWith('/') ? raw : `${await $.session.cwd()}/${raw}`
    const lexical = normalize(absolute)
    const where = await realAndOwner($, lexical)
    const path = where === null ? lexical : normalize(where.real)
    const root = await $.session.root()
    const claude = `${home}/.claude`
    // 项目本身就在 ~/.claude 里（如 ~/.claude/mods）时，项目里的文件按普通项目文件处理；以 ~/.claude 本身为项目不算
    const isClaudeProject = home !== '' && isUnder(root, claude) && !isUnder(claude, root)
    const isClaude = home !== '' && isUnder(path, claude) && !isMemory(path, home) && !(isClaudeProject && isUnder(path, root))
    if (where !== null && !isClaude) {
      if (isMemory(path, home) || isUnder(path, root) || (await tempDirs($)).some(dir => isUnder(path, dir))) {
        return next(e)
      }
      const allowed = await read($, allowedDirs)
      if (allowed.some(dir => isUnder(path, dir))) {
        return next(e)
      }
    }

    const t = await textOf($)
    const owner = where?.owner ?? null
    // ~/.claude 下的、算不出实际位置的、归属太大（或者包含 ~/.claude）的，只给“允许这一次”
    const canAllowDir = owner !== null && !isClaude && !isBroad(owner, home) && !isUnder(claude, owner)
    const card: Card = {
      title: isClaude ? t.claudeTitle : t.outsideTitle,
      question: isClaude ? t.claudeQuestion : t.outsideQuestion,
      command: `${e.tool} ${path}`,
      risky: [],
      rows: [
        {
          icon: '✏️',
          name: path,
          meta: owner === null ? '' : t.ownedBy(owner),
          warning: where === null ? t.unresolvedWarning : isClaude ? t.claudeWarning : t.warnings.outside,
        },
      ],
      more: 0,
      notes: [t.currentProject(root)],
      choices: [
        cancelOf(t),
        { key: 'once', ...t.once, tone: 'primary' },
        ...(canAllowDir ? [{ key: 'dir', label: t.session.label, description: t.session.description(owner) }] : []),
      ],
      decision: null,
    }

    const decision = await decide($, card, next.signal)
    if (decision === 'dir' && canAllowDir) {
      await update($, allowedDirs, dirs => [...dirs, owner])
    } else if (decision !== 'once') {
      return { deny: isClaude ? t.notEditedClaude(path, whyNot(decision, t)) : t.notEdited(path, whyNot(decision, t), root) }
    }

    // 卡片上同意过：权限检查不再问第二遍
    return runApproved(e.tool_use_id, () => next(e))
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: (await textOf($)).editCheckFailed }))

  // 退回原生对话框时：选项加上说明；记下是不是人离开太久自动结束的
  // 只是改写提问框里的说明文字，出错时原样放行，不能让提问本身失败
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const card = heldCard()
    const first = e.questions[0]
    if (card === null || first?.question !== askTextOf(card, await textOf($))) {
      return next(e)
    }

    const options = card.choices.map(choice => ({ label: choice.label, description: choice.description }))
    const asked = await next({ ...e, questions: [{ ...first, options }] })
    if (asked.deny === undefined && asked.isError !== true && asked.result.afkTimeoutMs !== undefined) {
      markTimedOut(first.question)
    }

    return asked
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const input = (e.input ?? {}) as { command?: unknown; file_path?: unknown; notebook_path?: unknown }
    const t = await textOf($)
    if (e.tool_use_id !== undefined && approved.has(e.tool_use_id)) {
      // 你在卡片上同意过，但设置里明令禁止的仍然禁止
      const verdict = await next(e)
      return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: t.approved }
    }

    // 卡片那一步没拦住的（比如它出错被跳过了），这里兜底要人确认；权限模式是 bypass 或 auto 时也一样
    const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
    const danger =
      typeof input.command === 'string'
        ? labelsOf(scan(input.command).hits, t).join(t.dangerJoiner) || undefined
        : typeof path === 'string' && PROTECTED_FILES.test(path)
          ? t.sensitiveFile(path)
          : undefined
    const verdict = await next(e)

    if (danger === undefined || verdict.decision === 'deny') {
      return verdict
    }

    return { decision: 'ask', reason: t.needsConfirm(danger) }
  }).catch(async $ => ({ decision: 'ask', reason: (await textOf($)).selfError }))

  // 侧边面板里的确认卡片：清单 + 真按钮
  on('ui.render', { component: 'Pane', requestId: 'danger-guard' }, async ($, e, next) => {
    const card = heldCard()
    if (card === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await textOf($)
    // 面板窄的时候，每项分两行：名字一行，大小和提醒一行
    const isWide = e.props.bodyColumns >= 64
    // 命令完整显示（自动换行）；太长时截断并说清还有多少，再单独列出有风险的那几段
    const command = commandView(card.command, COMMAND_LIMIT.pane, t)
    // 按钮只回答它画出来时的那张卡片
    const choose = (key: string) => () => {
      if (card.decision === null) {
        card.decision = key
      }
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} rowGap={1}>
        <Box flexDirection="column">
          <Text color="claude" size="heading" weight="semibold">
            ⚠ {card.title}
          </Text>
          <Text weight="medium">{card.question}</Text>
          {command.lines.map((line, index) => (
            <Text key={`command-${index}`} dimColor mono size="caption" wrap="wrap">
              {index === 0 ? '$ ' : '  '}
              {line}
            </Text>
          ))}
          {command.hidden !== null && (
            <Text dimColor size="caption">
              {command.hidden}
            </Text>
          )}
        </Box>
        {command.hidden !== null && card.risky.length > 0 && (
          <Box flexDirection="column">
            <Text color="warning" size="caption">
              {t.dangerParts}
            </Text>
            {card.risky.map((part, index) => (
              <Text key={`risky-${index}`} mono size="caption" wrap="wrap">
                {'  '}
                {part.slice(0, COMMAND_LIMIT.pane.chars)}
              </Text>
            ))}
          </Box>
        )}
        {card.rows.length > 0 && (
          <Box flexDirection="column" rowGap={isWide ? 0 : 1}>
            {card.rows.map((row, index) =>
              isWide ? (
                <Box key={`row-${index}`} columnGap={2}>
                  <Text weight="medium">
                    {row.icon} {row.name}
                  </Text>
                  <Text dimColor tabular>
                    {row.meta}
                  </Text>
                  {row.warning !== null && <Text color="warning">⚠ {row.warning}</Text>}
                </Box>
              ) : (
                <Box key={`row-${index}`} flexDirection="column">
                  <Text weight="medium" wrap="truncate-middle">
                    {row.icon} {row.name}
                  </Text>
                  <Box columnGap={2}>
                    <Text dimColor tabular size="caption">
                      {'   '}
                      {row.meta}
                    </Text>
                    {row.warning !== null && (
                      <Text color="warning" size="caption">
                        ⚠ {row.warning}
                      </Text>
                    )}
                  </Box>
                </Box>
              ),
            )}
            {card.more > 0 && <Text dimColor>{t.more(card.more)}</Text>}
          </Box>
        )}
        {card.notes.length > 0 && (
          <Box flexDirection="column">
            {card.notes.map((note, index) => (
              <Text key={`note-${index}`} color="warning" size="caption">
                ⚠ {note}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Box columnGap={1} flexWrap="wrap">
            {card.choices.map(choice => (
              <Button
                key={choice.key}
                label={choice.label}
                hotkey={choice.key === 'cancel' ? '1' : undefined}
                variant={choice.tone === 'primary' ? 'primary' : undefined}
                autoFocus={choice.key === 'cancel' ? true : undefined}
                hover={
                  choice.tone === undefined
                    ? undefined
                    : { scope: `choice-${choice.key}`, color: choice.tone === 'primary' ? 'claude' : 'error' }
                }
                onPress={choose(choice.key)}
              >
                <Text
                  color={choice.tone === 'primary' ? 'claude' : choice.tone === 'danger' ? 'error' : undefined}
                  weight={choice.tone === undefined ? 'regular' : 'semibold'}
                >
                  {choice.label}
                </Text>
              </Button>
            ))}
          </Box>
          <Text dimColor size="caption">
            {t.paneFooter}
          </Text>
        </Box>
      </Box>
    )
  })

  // 退回原生对话框时，把卡片清单画在它上方（命令已经写在问题里）
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const card = heldCard()
    const first = e.props.questions[0] as { question?: string } | undefined
    const t = await textOf($)
    if (card === null || first?.question !== askTextOf(card, t)) {
      return next(e)
    }

    const dialog = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const shown = card.rows.slice(0, e.surface === 'terminal' ? ASK_ROWS.terminal : ASK_ROWS.other)
    const more = card.rows.length - shown.length + card.more

    return (
      <Box flexDirection="column">
        <Text bold color="claude">
          ⚠ {card.title}
        </Text>
        {shown.map((row, index) => (
          <Box key={`row-${index}`} columnGap={2}>
            <Text>
              {row.icon} {row.name}
            </Text>
            <Text dimColor>{row.meta}</Text>
            {row.warning !== null ? <Text color="warning">⚠ {row.warning}</Text> : <Text dimColor>{t.gitRecoverable}</Text>}
          </Box>
        ))}
        {more > 0 && <Text dimColor>{t.more(more)}</Text>}
        {card.notes.map((note, index) => (
          <Text key={`note-${index}`} color="warning">
            ⚠ {note}
          </Text>
        ))}
        {dialog}
      </Box>
    )
  })
}

// 审过的删除：需要时先摆卡片，然后只处理这份清单（绝对路径），不再重新解释原命令里的通配符；
// 告诉模型实际做了什么（原命令没照原样跑；link/ 只动了链接本身）
async function deleteReviewed(
  $: EngineInterface,
  command: string,
  present: DeleteItem[],
  isReview: boolean,
  t: Text,
  cd: string | null,
  run: (command: string, description?: string) => Promise<ToolCallResult<'Bash'>>,
  signal: AbortSignal,
) {
  let isPurge = false
  if (isReview) {
    // 有风险的排前面
    const items = [...present].sort((a, b) => Number(warningOf(b, t) !== null) - Number(warningOf(a, t) !== null))
    const decision = await decide($, deleteCard(command, items, t), signal)
    if (decision !== 'trash' && decision !== 'purge') {
      return { deny: t.notDeleted(whyNot(decision, t)) }
    }
    isPurge = decision === 'purge'
  }

  const prefix = cd === null ? '' : `cd ${cd} && `
  const ran = await run(`${prefix}${isPurge ? purgeCommand(present) : trashCommand(present)}`, t.runDescription(isPurge, present.length))
  if (ran.deny !== undefined || ran.isError === true) {
    return ran
  }
  $.ui.log(isPurge ? t.purged(present.length) : t.trashed(present.length))
  const notes = [
    t.didInstead(isPurge, present.length, present.slice(0, 20).map(item => item.path)),
    ...present.filter(isLinkWithSlash).map(item => t.linkOnly(item.given, item.target)),
  ]

  return { ...ran, context: [...(ran.context ?? []), ...notes] }
}
