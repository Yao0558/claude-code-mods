import type { EngineInterface } from 'claude-code'

// 界面文字用中文还是英文，按这个顺序定：
// ① 环境变量 CLAUDE_MODS_LANG=zh|en，几个 mod 共用的覆盖设置；
// ② Claude Code 的 language 设置：自由文本，提到中文就用中文，写了别的语言就用英文；
// ③ 桌面会话看桌面 App 自己的界面语言（App 设置里改的，存在 config.json 的 locale）；
// ④ 系统语言：先看 LC_ALL、LC_MESSAGES、LANG（终端里启动的会话有），桌面 App 启动的进程没有这些，
//    macOS 上再读系统的首选语言。插件运行时里 Intl 固定报 en-US、不随系统变（2026-10-26 实测），所以不用它；
// ⑤ 都没有就用英文。
// 结果缓存一分钟，所以在 App 里切换语言不是立即生效，这是故意的，不是 bug：缓存过期后，
// 等 mod 下次重画界面才换成新语言（通常一分钟左右），回合进行中也一样；已经画出来、不再重画的卡片、提示、状态行会留着旧语言。不用重开会话
export type Lang = 'zh' | 'en'

const CACHE_MS = 60_000
// 桌面 App 的设置文件，相对于 HOME
const DESKTOP_CONFIG = 'Library/Application Support/Claude/config.json'

let detected: { at: number; lang: Promise<Lang> } | null = null

export function langOf($: EngineInterface): Promise<Lang> {
  const now = Date.now()
  if (detected === null || now - detected.at > CACHE_MS) {
    detected = { at: now, lang: detect($) }
  }

  return detected.lang
}

// locale 的写法（zh_CN.UTF-8、zh-Hans-CN、en-US）属于哪种语言；C、POSIX 这类不算
function localeLang(value: string | undefined): Lang | undefined {
  const code = /^([a-z]{2,3})(?:[-_.@]|$)/i.exec(value?.trim() ?? '')?.[1]?.toLowerCase()
  if (code === undefined) {
    return undefined
  }

  return code === 'zh' ? 'zh' : 'en'
}

// 用名字写的语言（Claude Code 的 language 设置是自由文本）：提到中文就是中文，写了别的语言就是英文
function nameLang(value: unknown): Lang | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  return /chinese|mandarin|cantonese|中文|汉语|漢語|华语|華語|普通话|^zh/i.test(value.trim()) ? 'zh' : 'en'
}

// 只在桌面 App 启动的会话里看 App 的语言；终端会话不跟着桌面 App 走
async function desktopLang($: EngineInterface): Promise<Lang | undefined> {
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) !== 'claude-desktop') {
    return undefined
  }
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined) {
    return undefined
  }
  const config = await $.fs.read(`${home}/${DESKTOP_CONFIG}`).catch(() => null)
  if (config === null) {
    return undefined
  }
  try {
    const locale = (JSON.parse(config) as { locale?: unknown }).locale

    return typeof locale === 'string' ? localeLang(locale) : undefined
  } catch {
    return undefined
  }
}

async function detect($: EngineInterface): Promise<Lang> {
  // 覆盖设置写 zh、en 这样的代码，或 chinese、english、中文这样的名字都行
  const forced = await $.env.get('CLAUDE_MODS_LANG').catch(() => undefined)
  const forcedName = typeof forced === 'string' && /^(chinese|english|中文|英文)$/i.test(forced.trim()) ? nameLang(forced) : undefined
  const forcedLang = localeLang(forced) ?? forcedName
  if (forcedLang !== undefined) {
    return forcedLang
  }

  const setting = nameLang(await $.settings.read({ key: 'language' }).catch(() => undefined))
  if (setting !== undefined) {
    return setting
  }

  const desktop = await desktopLang($)
  if (desktop !== undefined) {
    return desktop
  }

  const locales = [
    await $.env.get('LC_ALL').catch(() => undefined),
    await $.env.get('LC_MESSAGES').catch(() => undefined),
    await $.env.get('LANG').catch(() => undefined),
  ]
  for (const locale of locales) {
    const lang = localeLang(locale)
    if (lang !== undefined) {
      return lang
    }
  }

  // 只有 macOS 有这条命令，输出形如 ( "zh-Hans-CN", "en-CN" )；别的系统跑不起来，落到英文
  const apple = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 3000 }).catch(() => null)
  if (apple !== null && apple.exitCode === 0) {
    const lang = localeLang(apple.stdout.replace(/[(),"]/g, ' ').trim().split(/\s+/)[0])
    if (lang !== undefined) {
      return lang
    }
  }

  return 'en'
}

export type DangerKey =
  | 'recursiveRm'
  | 'dropTable'
  | 'dropdb'
  | 'findDelete'
  | 'format'
  | 'dd'
  | 'docker'
  | 'kubectl'
  | 'terraform'
  | 'npmPublish'
  | 'rimraf'
  | 'rsyncDelete'
  | 'unlink'
  | 'shred'
  | 'dynamicCommand'
  | 'dynamicEval'
  | 'pipeShell'
  | 'tooDeep'
export type GitKind = 'reset' | 'discard' | 'clean' | 'push' | 'pushDelete' | 'branch' | 'stash'

export const zh = {
  commands: {
    recursiveRm: '递归删除（rm -r）',
    dropTable: '删除数据库表或库',
    dropdb: '删除数据库（dropdb）',
    findDelete: '批量删除文件（find -delete / -exec rm）',
    format: '格式化磁盘',
    dd: '直接写磁盘（dd）',
    docker: '清理 Docker 数据卷',
    kubectl: '删除 Kubernetes 资源',
    terraform: '销毁 Terraform 资源',
    npmPublish: '发布到 npm',
    rimraf: '递归删除（rimraf）',
    rsyncDelete: '同步时删除文件（rsync --delete）',
    unlink: '删除文件（unlink）',
    shred: '彻底抹掉文件（shred / srm）',
    dynamicCommand: '用变量或命令替换决定要运行的程序，看不出会做什么',
    dynamicEval: '执行运行时才拼出来的命令（eval / sh -c），看不出会做什么',
    pipeShell: '把别的命令的输出当成命令执行（… | sh 这类），看不出会做什么',
    tooDeep: '层层嵌套的命令，看不过来',
  } as Record<DangerKey, string>,
  gitLabels: {
    reset: '丢弃本地改动（git reset --hard）',
    discard: '丢弃工作区改动（git checkout / restore / switch -f）',
    clean: '删除未跟踪文件（git clean）',
    push: '强制推送（git push --force）',
    pushDelete: '删除远端分支（git push --delete / --prune / --mirror）',
    branch: '强制删除分支（git branch -D）',
    stash: '丢弃储藏的改动（git stash drop / clear）',
  } as Record<GitKind, string>,
  dangerJoiner: '；',

  // 卡片按钮和原生对话框
  cancel: { label: '取消', description: '什么都不做' },
  proceed: { label: '继续执行', description: '照原样执行这条命令' },
  askHeader: '危险操作确认',
  why: {
    cancel: '你选了取消',
    timeout: '10 分钟内没人回答',
    interrupted: '这一轮被中断了',
    error: 'danger-guard 等待确认时出错',
  } as Record<string, string>,
  noAnswer: '没有收到答复',

  // 删除前确认
  warnings: {
    repo: '整个仓库，git 历史一起删',
    history: '仓库的全部 git 历史',
    internal: 'git 内部文件，删了可能损坏仓库',
    dirty: '有未提交或未跟踪的内容',
    none: '不在 git 里',
    outside: '在项目目录外',
    joiner: '，',
  },
  fileCount: (n: number) => `${n > 100000 ? '10 万+' : n} 个文件 · `,
  folders: (n: number) => `${n} 个文件夹`,
  files: (n: number) => `${n} 个文件`,
  kindsJoiner: '、',
  deleteTitle: '删除前确认',
  deleteQuestion: (n: number, kinds: string, size: string) => `要怎么处理这 ${n} 项（${kinds}，共 ${size}）？`,
  lostNote: (n: number) => `其中 ${n} 项 git 找不回，选永久删除就彻底没了`,
  allOutside: '这些都在当前项目目录外',
  linkNote: (name: string) => `${name} 是符号链接：只处理链接本身，不动它指向的文件夹`,
  trash: { label: '移到废纸篓', description: (n: number) => `只处理这 ${n} 项，需要时可以从废纸篓找回` },
  // 返回固定文字的函数写明返回 string：不写的话类型会被推成这两句中文本身，英文那份就对不上 Text
  purge: { label: '永久删除', description: (isLost: boolean): string => (isLost ? '不经过废纸篓，无法找回' : '不经过废纸篓；这些项 git 里还能找回') },
  runDescription: (isPurge: boolean, n: number) => `${isPurge ? '永久删除' : '移到废纸篓'}：${n} 项`,
  purged: (n: number) => `danger-guard：已永久删除 ${n} 项，没有经过废纸篓。`,
  trashed: (n: number) => `danger-guard：已把 ${n} 项移到废纸篓，可以从废纸篓找回。`,
  // 告诉模型实际做了什么：原命令没跑，跑的是审过的清单
  didInstead: (isPurge: boolean, n: number, paths: string[]) =>
    `danger-guard：原命令没有照原样执行，改为${isPurge ? '永久删除' : '移到废纸篓'}审过的 ${n} 项：${paths.join('、')}${paths.length < n ? ' 等' : ''}。`,
  linkOnly: (given: string, target: string) =>
    `${given} 是符号链接：只处理了链接本身，它指向的 ${target || '文件夹'} 和里面的内容都没有动。`,
  unsafeList: '删除（文件名里有换行或制表符，无法安全列出清单）',
  unlisted: '删除（没能列出要删的文件）',
  unmatched: '删除（通配符一个也没匹配到；你的 shell 设置可能不同，没法确认）',

  // 其它危险命令
  gitFallbackTitle: '危险的 git 操作',
  gitFallbackQuestion: (detail: string) => `算不出影响范围（${detail}）。`,
  gitSaid: (stderr: string) => `git 报错：${stderr}`,
  gitCheckFailed: '预览时出错',
  dangerTitle: '危险命令',
  dangerQuestion: (dangers: string[]) =>
    dangers.length > 1 ? `这条命令包含：${dangers.join('；')}。没法提前算出影响范围。` : `这是${dangers[0] ?? ''}，没法提前算出影响范围。`,
  dangerNote: '请看清命令再决定',
  dangerParts: '其中有风险的部分：',
  moreLines: (n: number) => `…还有 ${n} 行没显示`,
  moreChars: (n: number) => `…还有 ${n} 个字符没显示`,

  // 编辑项目外的文件
  outsideTitle: '编辑项目外的文件',
  outsideQuestion: '要改的文件不在当前项目里，确定要改吗？',
  claudeTitle: '修改 Claude 的配置',
  claudeQuestion: '要改的是 ~/.claude 下的文件（设置、mod、技能或全局规则），确定要改吗？',
  claudeWarning: '每次都要确认',
  unresolvedWarning: '算不出它实际在哪（符号链接解不开）',
  ownedBy: (owner: string) => `属于 ${owner}`,
  currentProject: (root: string) => `当前项目：${root}`,
  once: { label: '允许这一次', description: '只放行这一次修改' },
  session: { label: '本会话都允许', description: (owner: string) => `这个会话里再改 ${owner} 下的文件不再问` },

  // 退回给模型的拒绝理由
  forbidden: (path: string) => `danger-guard 拒绝：${path} 是系统关键目录，不允许删除。`,
  notDeleted: (why: string) => `没有删除任何文件：${why}。除非用户要求，不要重试。`,
  notRun: (why: string) => `没有执行这条命令：${why}。除非用户要求，不要重试。`,
  notEdited: (path: string, why: string, root: string) => `没有修改 ${path}：${why}。它在当前项目 ${root} 之外；除非用户要求，不要重试。`,
  notEditedClaude: (path: string, why: string) => `没有修改 ${path}：${why}。它在 ~/.claude 下（Claude 的配置）；除非用户要求，不要重试。`,
  commandCheckFailed: 'danger-guard 检查这条命令时出错，为安全起见没有执行；可以换个写法再试。',
  editCheckFailed: 'danger-guard 检查这次修改时出错，为安全起见没有修改。',

  // 权限检查那一步
  sensitiveFile: (path: string) => `改动敏感文件 ${path}`,
  approved: 'danger-guard：已在确认卡片上同意',
  needsConfirm: (danger: string) => `danger-guard：${danger}，需要你确认`,
  selfError: 'danger-guard 自身出错，这一步请人工确认',

  // 卡片上的其它文字
  more: (n: number) => `还有 ${n} 项…`,
  paneFooter: '回车或按 1 取消，其它请点按钮 · 10 分钟没回答算取消',
  gitRecoverable: 'git 可恢复',

  // git 操作的影响预览
  git: {
    status: { M: '已修改', A: '新加入', D: '已删除', R: '改了名', C: '复制', T: '类型变了', U: '有冲突' } as Record<string, string>,
    uncommittedLost: '未提交的改动会丢',
    noDirQuestion: '找不到命令要进入的目录，无法预览影响。',
    resetTitle: '丢弃本地改动',
    leavesBranch: '这个提交会离开当前分支',
    discardFiles: (n: number) => `丢弃 ${n} 个文件的未提交改动`,
    leaveCommits: (n: number) => `让 ${n} 个提交离开当前分支`,
    willDo: (parts: string[]) => `这会${parts.join('，并')}。`,
    resetSafe: '工作区没有未提交的改动，这次重置不会丢东西。',
    notRecorded: '未提交的改动 git 里没有记录，丢了找不回',
    reflog: '离开分支的提交 90 天内还能从 reflog 找回',
    discardTitle: '丢弃工作区改动',
    unstaged: '未暂存',
    uncommitted: '未提交',
    changesLost: '改动会丢',
    revertsTo: (base: string) => `改回 ${base} 的版本`,
    discardQuestion: (n: number, withStaged: boolean) => `这会丢弃 ${n} 个文件里${withStaged ? '未提交（包括已暂存）的改动' : '还没暂存的改动'}。`,
    discardCommitted: (n: number) => `这会把 ${n} 个文件改回指定版本的内容；它们没有未提交的改动，git 里都找得回。`,
    discardSafe: '没有会被丢掉的改动，这条命令不会丢东西。',
    discardNote: '这些改动 git 里没有记录，丢了找不回',
    cleanTitle: '删除未跟踪的文件',
    cleanQuestion: (n: number) => `这会删除 ${n} 个没被 git 跟踪的文件或文件夹。`,
    cleanSafe: '没有可删的未跟踪文件，这条命令不会删东西。',
    untracked: '未跟踪',
    notInGit: 'git 找不回',
    cleanNote: 'git clean 不经过废纸篓，删了就没了',
    pushTitle: '强制推送',
    pushUnknown: (remote: string) => `本地没有 ${remote} 的记录，算不出强推会覆盖掉什么。`,
    pushFetch: '可以先 git fetch，再让我重试一次，就能看到会丢哪些提交',
    pushDrops: (remote: string, n: number) => `这会覆盖远端 ${remote}，丢掉上面 ${n} 个你本地没有的提交。`,
    pushSafe: (remote: string) => `远端 ${remote} 没有你本地缺的提交，这次强推不会丢掉别人的东西。`,
    pushAll: (remote: string) => `这会强制覆盖 ${remote} 上的多个分支或标签，没法逐个算出会丢什么。`,
    leavesRemote: '会从远端分支上消失',
    pushNote: '按上次 fetch 时的远端状态计算；别人之后又推了的话，实际会丢更多',
    pushDeleteTitle: '删除远端分支',
    pushDeletes: (remote: string, n: number, lost: number) =>
      `这会删除 ${remote} 上的 ${n} 个分支${lost > 0 ? `，其中 ${lost} 个提交不在任何别的分支上` : ''}。`,
    pushDeleteNone: (remote: string) => `按本地记录，${remote} 上没有会被删掉的分支。`,
    noRecord: '本地没有它的记录',
    onlyHere: (n: number) => (n > 0 ? `${n} 个提交只在这里` : '提交在别的分支上都有'),
    commitsLost: '删了这些提交就不在任何分支上',
    mirrorNote: '--mirror 还会强制覆盖远端所有分支和标签',
    pruneNote: '按本地记录估算：远端上本地没有同名分支的，都会被删',
    branchTitle: '强制删除分支',
    branchUnmerged: (name: string, n: number) => `分支 ${name} 上有 ${n} 个提交没合并到当前分支，删了分支它们就不在任何分支上了。`,
    branchSafe: (name: string) => `分支 ${name} 的提交都已经在当前分支里，删了不会丢东西。`,
    unmerged: (name: string) => `没合并（${name}）`,
    branchNote: '90 天内还能从 reflog 找回',
    stashTitle: '丢弃储藏',
    stashQuestion: (n: number) => `这会丢掉 ${n} 个储藏里的改动。`,
    stashNone: '没有对应的储藏，这条命令不会丢东西。',
    stashLost: '储藏的改动会丢',
    stashNote: '丢掉的储藏在 git 垃圾回收前还能用 git fsck 找回，但很麻烦',
  },
}

// 英文的单复数：1 file、2 files
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const en: Text = {
  commands: {
    recursiveRm: 'Recursive delete (rm -r)',
    dropTable: 'Drop a database table or database',
    dropdb: 'Drop a database (dropdb)',
    findDelete: 'Bulk-delete files (find -delete / -exec rm)',
    format: 'Format a disk',
    dd: 'Write directly to a disk (dd)',
    docker: 'Prune Docker volumes',
    kubectl: 'Delete Kubernetes resources',
    terraform: 'Destroy Terraform resources',
    npmPublish: 'Publish to npm',
    rimraf: 'Recursive delete (rimraf)',
    rsyncDelete: 'Delete files while syncing (rsync --delete)',
    unlink: 'Delete a file (unlink)',
    shred: 'Shred files beyond recovery (shred / srm)',
    dynamicCommand: "Runs a program chosen by a variable or command substitution, so what it does can't be seen",
    dynamicEval: "Runs a command assembled at run time (eval / sh -c), so what it does can't be seen",
    pipeShell: "Runs another command's output as commands (… | sh and the like), so what it does can't be seen",
    tooDeep: 'Commands nested too deeply to check',
  },
  gitLabels: {
    reset: 'Discard local changes (git reset --hard)',
    discard: 'Discard working-tree changes (git checkout / restore / switch -f)',
    clean: 'Delete untracked files (git clean)',
    push: 'Force push (git push --force)',
    pushDelete: 'Delete remote branches (git push --delete / --prune / --mirror)',
    branch: 'Force-delete a branch (git branch -D)',
    stash: 'Drop stashed changes (git stash drop / clear)',
  },
  dangerJoiner: '; ',

  cancel: { label: 'Cancel', description: 'Do nothing' },
  proceed: { label: 'Run anyway', description: 'Run the command as written' },
  askHeader: 'Danger check',
  why: {
    cancel: 'the user chose Cancel',
    timeout: 'no one answered within 10 minutes',
    interrupted: 'the turn was interrupted',
    error: 'danger-guard hit an error while waiting for confirmation',
  },
  noAnswer: 'no answer was received',

  warnings: {
    repo: 'whole repo, git history included',
    history: "the repo's entire git history",
    internal: 'git internals; deleting may corrupt the repo',
    dirty: 'has uncommitted or untracked changes',
    none: 'not in git',
    outside: 'outside the project',
    joiner: ', ',
  },
  fileCount: n => `${n > 100000 ? '100k+ files' : count(n, 'file')} · `,
  folders: n => count(n, 'folder'),
  files: n => count(n, 'file'),
  kindsJoiner: ', ',
  deleteTitle: 'Confirm delete',
  deleteQuestion: (n, kinds, size) =>
    n === 1 ? `What should happen to this item (${kinds}, ${size})?` : `What should happen to these ${n} items (${kinds}, ${size} total)?`,
  lostNote: n => `${count(n, 'item')} can't be recovered from git; deleting permanently means gone for good`,
  allOutside: 'All of these are outside the current project',
  linkNote: name => `${name} is a symlink: only the link itself is handled, not the folder it points to`,
  trash: { label: 'Move to Trash', description: n => `Only ${n === 1 ? 'this item' : `these ${n} items`}; you can restore from the Trash` },
  purge: { label: 'Delete permanently', description: isLost => (isLost ? 'Skips the Trash; cannot be recovered' : 'Skips the Trash; still recoverable from git') },
  runDescription: (isPurge, n) => `${isPurge ? 'Delete permanently' : 'Move to Trash'}: ${count(n, 'item')}`,
  purged: n => `danger-guard: permanently deleted ${count(n, 'item')}, skipping the Trash.`,
  trashed: n => `danger-guard: moved ${count(n, 'item')} to the Trash; you can restore from there.`,
  didInstead: (isPurge, n, paths) =>
    `danger-guard: the original command was not run as written; instead ${n === 1 ? 'the reviewed item was' : `the ${n} reviewed items were`} ${isPurge ? 'permanently deleted' : 'moved to the Trash'}: ${paths.join(', ')}${paths.length < n ? ', …' : ''}.`,
  linkOnly: (given, target) => `${given} is a symlink: only the link itself was handled; ${target || 'the folder'} it points to and its contents were not touched.`,
  unsafeList: "Delete (file names contain newlines or tabs, so they can't be listed safely)",
  unlisted: "Delete (couldn't list the files to delete)",
  unmatched: "Delete (the wildcards matched nothing here, but your shell's settings may differ, so it can't be confirmed)",

  gitFallbackTitle: 'Risky git operation',
  gitFallbackQuestion: detail => `Couldn't work out the impact (${detail}).`,
  gitSaid: stderr => `git said: ${stderr}`,
  gitCheckFailed: 'the preview failed',
  dangerTitle: 'Dangerous command',
  dangerQuestion: dangers => `${dangers.join('; ')}: the impact can't be worked out in advance.`,
  dangerNote: 'Read the command carefully before deciding',
  dangerParts: 'The risky parts:',
  moreLines: n => `…${count(n, 'more line')} not shown`,
  moreChars: n => `…${count(n, 'more character')} not shown`,

  outsideTitle: 'Edit a file outside the project',
  outsideQuestion: "This file isn't in the current project. Edit it anyway?",
  claudeTitle: "Change Claude's configuration",
  claudeQuestion: 'This file is under ~/.claude (settings, mods, skills or global rules). Edit it anyway?',
  claudeWarning: 'asks every time',
  unresolvedWarning: "can't work out where it really is (a symlink can't be resolved)",
  ownedBy: owner => `in ${owner}`,
  currentProject: root => `Current project: ${root}`,
  once: { label: 'Allow once', description: 'Allow just this edit' },
  session: { label: 'Allow for this session', description: owner => `Don't ask again this session for files under ${owner}` },

  forbidden: path => `danger-guard refused: ${path} is a critical system folder and can't be deleted.`,
  notDeleted: why => `No files were deleted: ${why}. Do not retry unless the user asks.`,
  notRun: why => `The command was not run: ${why}. Do not retry unless the user asks.`,
  notEdited: (path, why, root) => `${path} was not modified: ${why}. It is outside the current project ${root}; do not retry unless the user asks.`,
  notEditedClaude: (path, why) => `${path} was not modified: ${why}. It is under ~/.claude (Claude's configuration); do not retry unless the user asks.`,
  commandCheckFailed: 'danger-guard hit an error checking this command, so it was not run to be safe. Try writing it another way.',
  editCheckFailed: 'danger-guard hit an error checking this edit, so the file was not changed to be safe.',

  sensitiveFile: path => `Editing sensitive file ${path}`,
  approved: 'danger-guard: approved on the confirmation card',
  needsConfirm: danger => `danger-guard: ${danger} needs your confirmation`,
  selfError: 'danger-guard itself hit an error; please confirm this step manually',

  more: n => `${n} more…`,
  paneFooter: 'Enter or 1 cancels; click a button for anything else · no answer in 10 minutes counts as Cancel',
  gitRecoverable: 'recoverable from git',

  git: {
    status: { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflicted' },
    uncommittedLost: 'uncommitted changes will be lost',
    noDirQuestion: "Can't find the folder the command runs in, so the impact can't be previewed.",
    resetTitle: 'Discard local changes',
    leavesBranch: 'this commit will leave the current branch',
    discardFiles: n => `discard uncommitted changes in ${count(n, 'file')}`,
    leaveCommits: n => `move ${count(n, 'commit')} off the current branch`,
    willDo: parts => `This will ${parts.join(' and ')}.`,
    resetSafe: 'No uncommitted changes in the working tree; this reset loses nothing.',
    notRecorded: "Uncommitted changes aren't recorded in git; once lost, they're gone",
    reflog: 'Commits that leave the branch can be recovered from the reflog for 90 days',
    discardTitle: 'Discard working-tree changes',
    unstaged: 'unstaged',
    uncommitted: 'uncommitted',
    changesLost: 'changes will be lost',
    revertsTo: base => `reverts to ${base}`,
    discardQuestion: (n, withStaged) => `This will discard ${withStaged ? 'uncommitted (including staged)' : 'unstaged'} changes in ${count(n, 'file')}.`,
    discardCommitted: n => `This will put ${count(n, 'file')} back to the given version; none has uncommitted changes, so all are recoverable from git.`,
    discardSafe: 'Nothing would be discarded; this command loses nothing.',
    discardNote: "These changes aren't recorded in git; once lost, they're gone",
    cleanTitle: 'Delete untracked files',
    cleanQuestion: n => `This will delete ${count(n, 'untracked file or folder', 'untracked files or folders')}.`,
    cleanSafe: 'No untracked files to delete; this command deletes nothing.',
    untracked: 'untracked',
    notInGit: 'not recoverable via git',
    cleanNote: 'git clean skips the Trash; once deleted, they are gone',
    pushTitle: 'Force push',
    pushUnknown: remote => `There's no local record of ${remote}, so what the force push would overwrite can't be worked out.`,
    pushFetch: 'Run git fetch, then have me retry to see which commits would be lost',
    pushDrops: (remote, n) => `This will overwrite ${remote} and drop the ${count(n, 'commit')} above that you don't have locally.`,
    pushSafe: remote => `${remote} has no commits missing locally; this force push won't drop anyone else's work.`,
    pushAll: remote => `This force-overwrites several branches or tags on ${remote}; what each would lose can't be listed.`,
    leavesRemote: 'will vanish from the remote branch',
    pushNote: 'Based on the remote as of your last fetch; if others pushed since, more will be lost',
    pushDeleteTitle: 'Delete remote branches',
    pushDeletes: (remote, n, lost) => `This will delete ${count(n, 'branch', 'branches')} on ${remote}${lost > 0 ? `; ${count(lost, 'commit')} on them ${lost === 1 ? 'is' : 'are'} on no other branch` : ''}.`,
    pushDeleteNone: remote => `By the local records, no branch on ${remote} would be deleted.`,
    noRecord: 'no local record',
    onlyHere: n => (n > 0 ? `${count(n, 'commit')} only here` : 'all commits are on other branches'),
    commitsLost: 'these commits end up on no branch',
    mirrorNote: '--mirror also force-overwrites every branch and tag on the remote',
    pruneNote: 'Estimated from local records: remote branches with no local branch of the same name get deleted',
    branchTitle: 'Force-delete branch',
    branchUnmerged: (name, n) => `${count(n, 'commit')} on ${name} ${n === 1 ? "isn't" : "aren't"} merged into the current branch; deleting it leaves them on no branch.`,
    branchSafe: name => `All commits on ${name} are already in the current branch; deleting it loses nothing.`,
    unmerged: name => `not merged (${name})`,
    branchNote: 'Recoverable from the reflog for 90 days',
    stashTitle: 'Drop stashes',
    stashQuestion: n => `This will drop the changes in ${count(n, 'stash', 'stashes')}.`,
    stashNone: 'No matching stash; this command loses nothing.',
    stashLost: 'stashed changes will be lost',
    stashNote: 'A dropped stash can be dug out with git fsck until git garbage-collects it, but it is fiddly',
  },
}

export type Text = typeof zh

export async function textOf($: EngineInterface): Promise<Text> {
  return (await langOf($)) === 'zh' ? zh : en
}
