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

// 返回固定文字的函数要写明返回 string：不写的话类型会被推成这几句中文本身，英文那份就对不上 Text
const zh = {
  previewCommand: '预览完成提示的样子；加 fail 预览出错的样子',
  previewTask: (hasFailed: boolean): string => (hasFailed ? '部署到测试环境（预览）' : '整理研究资料（预览）'),
  previewShown: (hasFailed: boolean): string =>
    hasFailed ? '已显示出错提示的预览，点 × 或发下一条消息收起。' : '已显示完成提示的预览，点 × 或发下一条消息收起。',
  minutes: (n: number) => `${n} 分钟`,
  seconds: (n: number) => `${n} 秒`,
  hours: (h: number, m: number) => (m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`),
  headline: (hasFailed: boolean): string => (hasFailed ? '任务出错停下了' : '任务完成'),
  taskSuffix: (task: string) => `：${task}`,
  notification: (hasFailed: boolean, took: string) => `${hasFailed ? '任务出错停下了' : '任务完成'}（用时 ${took}）`,
}

const en: Text = {
  previewCommand: 'Preview the done notice; add "fail" to preview the error one',
  previewTask: hasFailed => (hasFailed ? 'Deploy to staging (preview)' : 'Organize research notes (preview)'),
  previewShown: hasFailed =>
    `Showing a preview of the ${hasFailed ? 'error' : 'done'} notice. Click × or send a message to dismiss it.`,
  minutes: n => `${n} min`,
  seconds: n => `${n}s`,
  hours: (h, m) => (m === 0 ? `${h} h` : `${h} h ${m} min`),
  headline: hasFailed => (hasFailed ? 'Task stopped with an error' : 'Task done'),
  taskSuffix: task => `: ${task}`,
  notification: (hasFailed, took) => `${hasFailed ? 'Task stopped with an error' : 'Task done'} (took ${took})`,
}

export type Text = typeof zh

export async function textOf($: EngineInterface): Promise<Text> {
  return (await langOf($)) === 'zh' ? zh : en
}
