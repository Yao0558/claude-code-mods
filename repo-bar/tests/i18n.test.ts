import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'repo-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const HOME = '/Users/me'
const CONFIG = `${HOME}/Library/Application Support/Claude/config.json`
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// 没写 language 设置、系统是中文时：桌面会话跟着 App 的界面语言走，终端会话不跟
const cases = [
  { name: 'a desktop session follows the app locale over the system language', entry: 'claude-desktop', locale: 'en-US', want: /not a git repo/ },
  { name: 'a desktop session in a Chinese app stays Chinese', entry: 'claude-desktop', locale: 'zh-CN', want: /非 git 目录/ },
  { name: 'a terminal session ignores the desktop app locale', entry: 'cli', locale: 'en-US', want: /非 git 目录/ },
] as const

for (const c of cases) {
  test(c.name, async ($, on) => {
    on('settings.read', () => ({ value: {} }))
    on('env.get', (_, e) => ({ value: ({ CLAUDE_CODE_ENTRYPOINT: c.entry, HOME } as Record<string, string>)[e.name] }))
    on('fs.read', (_, e) => {
      if (e.path !== CONFIG) throw new Error('missing')
      return { value: JSON.stringify({ locale: c.locale }) }
    })
    on('process.run', () => ({ value: ok('(\n    "zh-Hans-CN",\n    "en-CN"\n)\n') }))
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/x' }))
    on('session.repo', () => ({ value: null }))

    await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: c.want })).toBeDefined()
    await ui.unmount()
  })
}

// 覆盖设置写名字也认；认不出的值（比如别的路径）不算，照常往下判断
const overrides = [
  { value: 'english', want: /not a git repo/ },
  { value: '中文', want: /非 git 目录/ },
  { value: '/Users/me', want: /非 git 目录/ },
] as const

for (const o of overrides) {
  test(`CLAUDE_MODS_LANG=${o.value}`, async ($, on) => {
    on('settings.read', () => ({ value: { language: 'chinese' } }))
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_MODS_LANG' ? o.value : undefined }))
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/x' }))
    on('session.repo', () => ({ value: null }))

    await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: o.want })).toBeDefined()
    await ui.unmount()
  })
}
