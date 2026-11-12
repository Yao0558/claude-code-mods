import { expect, test } from 'claude-code/testing'

import type { Card } from '../hooks/card'
import { decide } from '../hooks/card'
import { failed, fakeEngine, ok } from './fake'

// 1. 通配符：按 Bash 工具用的 shell（zsh）展开；没匹配到时不能当成“什么也不删”直接放行
test('a glob that matched nothing is not taken as proof that nothing gets deleted', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf'], lines: [], press: 'cancel' })

  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf **/node_modules' })

  expect(seen.expanded[0]!.slice(0, 3)).toEqual(['/bin/zsh', '-f', '-c'])
  expect(seen.expanded[0]![3]).toContain('setopt nullglob')
  expect(seen.opened).toBe(1)
  expect(seen.ran).toEqual([])
  expect(result.deny).toContain('没有执行这条命令')
})

test('only literal paths that are all missing let the original command run as is', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'gone'], lines: ['missing\t0\t0\tnone\tgone\tgone'] })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf gone' })

  expect(seen.opened).toBe(0)
  expect(seen.ran).toEqual(['rm -rf gone'])
})

test('with bash as the login shell, the preview expands with bash', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/'], lines: ['dir\t9\t1200\tnone\t/p/temp\ttemp/'], press: 'cancel', env: { SHELL: '/bin/bash' } })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/' })

  expect(seen.expanded[0]!.slice(0, 4)).toEqual(['/bin/bash', '--noprofile', '--norc', '-c'])
  expect(seen.expanded[0]![4]).toContain('shopt -s nullglob')
})

// 5. 系统关键目录：任何写法都直接拒绝
for (const command of ['rm -rf ~ && echo done', 'sudo rm -rf /', '/bin/rm -rf ~', "bash -c 'rm -rf ~/'"]) {
  test(`critical folders are refused outright: ${command}`, async ($, on) => {
    const seen = fakeEngine($, on, { words: ['-rf', '/Users/me'], lines: ['critical\t0\t0\tnone\t/Users/me\t/Users/me'], press: 'proceed' })

    const result = await $.tool.call({ tool: 'Bash', command })

    expect(seen.opened).toBe(0)
    expect(seen.ran).toEqual([])
    expect(result.deny).toBe('danger-guard 拒绝：/Users/me 是系统关键目录，不允许删除。')
    // 只判断是不是关键目录，不去统计里面的文件
    expect(seen.inspected[0]!.slice(-2, -1)).toEqual(['quick'])
  })
}

// 6. 卡片上的命令：完整显示、太长时说清还有多少并单独列出有风险的那段；列出所有危险
test('the card shows the whole command, every danger in it, and the risky part of a long one', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel' })
  const long = [...Array.from({ length: 20 }, (_, index) => `echo step ${index}`), 'git reset --hard && rm -rf build'].join('\n')

  await $.tool.call({ tool: 'Bash', command: long })

  expect(seen.command).toContain('这条命令包含：丢弃本地改动（git reset --hard）；递归删除（rm -r）。没法提前算出影响范围。')
  expect(seen.command).toContain('$ echo step 0')
  expect(seen.command).toContain('  echo step 11')
  expect(seen.command).not.toContain('  echo step 12')
  expect(seen.command).toContain('…还有 9 行没显示')
  expect(seen.command).toContain('其中有风险的部分：')
  expect(seen.command).toContain('  rm -rf build')
})

test('the native dialog fallback shows the command in the question', async ($, on) => {
  const seen = fakeEngine($, on, { isPlaced: false, press: '继续执行' })

  await $.tool.call({ tool: 'Bash', command: 'terraform destroy -auto-approve' })

  expect(seen.asked).toEqual(['这是销毁 Terraform 资源，没法提前算出影响范围。\n$ terraform destroy -auto-approve'])
  expect(seen.ran).toEqual(['terraform destroy -auto-approve'])
})

// 4、7、13. 改文件前的检查：符号链接解开、不分大小写、~/.claude 每次都问
test('an edit through a symlink that points outside the project asks', async ($, on) => {
  const seen = fakeEngine($, on, {
    press: 'cancel',
    owner: path => (path === '/p/link.txt' ? ok('/outside/t.txt\n/outside\n') : ok(`${path}\n/p\n`)),
  })

  const result = await $.tool.call({ tool: 'Write', file_path: '/p/link.txt', content: 'x' })

  expect(seen.card).toEqual(['⚠ 编辑项目外的文件', '$ Write /outside/t.txt', '✏️ /outside/t.txt'])
  expect(result.deny).toContain('没有修改 /outside/t.txt')
})

test('when the real location cannot be worked out, the edit asks and only offers once', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', owner: () => failed(5) })

  await $.tool.call({ tool: 'Write', file_path: '/p/extdir/newsub/x.txt', content: 'x' })

  expect(seen.opened).toBe(1)
  expect(seen.buttons).toEqual(['取消', '允许这一次'])
})

test('paths compare without case, as APFS does', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', root: '/Volumes/Data/Proj' })

  await $.tool.call({ tool: 'Write', file_path: '/volumes/data/proj/src/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/Users/ME/.claude/projects/x/memory/a.md', content: 'x' })

  expect(seen.opened).toBe(0)
  expect(seen.ran).toEqual(['Write /volumes/data/proj/src/a.ts', 'Write /Users/ME/.claude/projects/x/memory/a.md'])
})

test('a folder allowed for the session matches without case', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'dir' })

  await $.tool.call({ tool: 'Write', file_path: '/Volumes/Other/brand/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/volumes/other/BRAND/b.ts', content: 'x' })

  expect(seen.opened).toBe(1)
})

for (const file_path of ['/Users/me/.claude/settings.json', '/Users/me/.claude/mods/danger-guard/hooks/card.ts', '/Users/me/.claude/CLAUDE.md']) {
  test(`files under ~/.claude ask every time and never offer the session: ${file_path}`, async ($, on) => {
    const seen = fakeEngine($, on, { press: 'once', root: '/Users/me' })

    await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

    expect(seen.opened).toBe(2)
    expect(seen.buttons.slice(0, 2)).toEqual(['取消', '允许这一次'])
    expect(seen.card[0]).toBe('⚠ 修改 Claude 的配置')
  })
}

// 项目本身在 ~/.claude 里（如 ~/.claude/mods）：项目里的文件不问，项目外的 ~/.claude 文件照样每次都问
test('a project inside ~/.claude edits its own files without a card', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', root: '/Users/me/.claude/mods' })

  await $.tool.call({ tool: 'Write', file_path: '/Users/me/.claude/mods/tools/x.py', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/Users/ME/.claude/Mods/danger-guard/hooks/card.ts', old_string: 'a', new_string: 'b' })

  expect(seen.opened).toBe(0)
  expect(seen.ran).toEqual(['Write /Users/me/.claude/mods/tools/x.py', 'Edit /Users/ME/.claude/Mods/danger-guard/hooks/card.ts'])
})

test('a project inside ~/.claude still asks every time for the rest of ~/.claude', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', root: '/Users/me/.claude/mods' })

  const result = await $.tool.call({ tool: 'Edit', file_path: '/Users/me/.claude/settings.json', old_string: 'a', new_string: 'b' })

  expect(seen.opened).toBe(1)
  expect(seen.buttons.slice(0, 2)).toEqual(['取消', '允许这一次'])
  expect(seen.card[0]).toBe('⚠ 修改 Claude 的配置')
  expect(seen.ran).toEqual([])
  expect(result.deny).toContain('它在 ~/.claude 下（Claude 的配置）')
  expect(result.deny).not.toContain('之外')
})

test('~/.claude itself as the project does not open ~/.claude', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', root: '/Users/me/.claude/' })

  await $.tool.call({ tool: 'Write', file_path: '/Users/me/.claude/mods/tools/x.py', content: 'x' })

  expect(seen.opened).toBe(1)
  expect(seen.card[0]).toBe('⚠ 修改 Claude 的配置')
})

test('an edit outside the project still says it is outside the project', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel' })

  const result = await $.tool.call({ tool: 'Write', file_path: '/Volumes/Other/x.ts', content: 'x' })

  expect(seen.opened).toBe(1)
  expect(result.deny).toContain('它在当前项目 /p 之外')
})

test('memory files and temp folders are always writable; other system caches are not', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel' })

  for (const file_path of [
    '/Users/me/.claude/projects/-p/memory/MEMORY.md',
    '/private/tmp/claude-502/scratch/a.md',
    '/private/var/folders/ab/cd/T/x.txt',
  ]) {
    await $.tool.call({ tool: 'Write', file_path, content: 'x' })
  }
  expect(seen.opened).toBe(0)

  await $.tool.call({ tool: 'Write', file_path: '/private/var/folders/ab/cd/C/cache.db', content: 'x' })
  expect(seen.opened).toBe(1)
})

// 9. 卡片上同意过的修改，权限检查不再问第二遍
test('an edit allowed once on the card is not asked about again', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const seen = fakeEngine($, on, { press: 'once' })

  await $.tool.call({ tool: 'Write', file_path: '/Volumes/Other/x.ts', content: 'x' })

  expect(seen.ran).toEqual(['Write /Volumes/Other/x.ts'])
})

// 11. .git 里面的东西
test('deleting .git says it is the whole history; a stale lock file goes to the trash without a card', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-f', '.git/index.lock'], lines: ['file\t1\t0\tlock\t/p/.git/index.lock\t.git/index.lock'], press: 'cancel' })

  await $.tool.call({ tool: 'Bash', command: 'rm -f .git/index.lock' })
  expect(seen.opened).toBe(0)
  expect(seen.ran).toEqual(["trash '/p/.git/index.lock'"])
})

test('deleting the .git folder warns that the whole history goes', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', '.git'], lines: ['dir\t40\t900\thistory\t/p/.git\t.git'], press: 'cancel' })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf .git' })

  expect(seen.command).toContain('⚠ 仓库的全部 git 历史')
})

// 12. link/：只处理链接本身，并且告诉模型
test('a symlink written with a trailing slash: only the link is handled, and the model is told so', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'link/'], lines: ['link\t1\t0\tnone\t/p/link\tlink/\t/data/big'], press: 'trash' })

  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf link/' })

  expect(seen.ran).toEqual(["trash '/p/link'"])
  expect(seen.command).toContain('⚠ link/ 是符号链接：只处理链接本身，不动它指向的文件夹')
  expect(result.context).toEqual([
    'danger-guard：原命令没有照原样执行，改为移到废纸篓审过的 1 项：/p/link。',
    'link/ 是符号链接：只处理了链接本身，它指向的 /data/big 和里面的内容都没有动。',
  ])
})

// 14. 等待的上限、面板被关、中断、排队
test('the native dialog also ends as a deny after 10 minutes', async ($, on) => {
  const seen = fakeEngine($, on, { isPlaced: false, askHangs: true, tick: 60_000 })

  const result = await $.tool.call({ tool: 'Bash', command: 'terraform destroy' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toBe('没有执行这条命令：10 分钟内没人回答。除非用户要求，不要重试。')
})

test('closing the pane counts as cancel', async ($, on) => {
  const seen = fakeEngine($, on, { panes: () => [] })

  const result = await $.tool.call({ tool: 'Bash', command: 'terraform destroy' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toBe('没有执行这条命令：你选了取消。除非用户要求，不要重试。')
})

// 直接调 decide：手搓一个最小的 $，在第一次等待时中断这一轮
test('an interrupted turn stops waiting and closes its pane', async () => {
  const card: Card = { title: 't', question: 'q', command: 'c', risky: [], rows: [], more: 0, notes: [], choices: [], decision: null }
  const controller = new AbortController()
  const calls: string[] = []
  let now = 0
  const engine = {
    clock: { now: async () => (now += 1000) },
    ui: {
      open: async () => ({ isPlaced: true }),
      close: async () => calls.push('close'),
      invalidate: () => {},
      panes: async () => [{ id: 'danger-guard' }],
    },
    process: {
      run: async () => {
        controller.abort()
        return ok('')
      },
    },
  }

  expect(await decide(engine as never, card, controller.signal)).toBe('interrupted')
  expect(calls).toEqual(['close'])
})

test('a second card waits its turn, then gets its own pane', async ($, on) => {
  const seen = fakeEngine($, on, { pressAll: 'cancel' })

  const results = await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'terraform destroy' }),
    $.tool.call({ tool: 'Bash', command: 'npm publish' }),
  ])

  expect(seen.opened).toBe(2)
  expect(seen.card.filter(text => text.startsWith('⚠ '))).toEqual(['⚠ 危险命令', '⚠ 危险命令'])
  expect(results.map(result => result.deny)).toEqual([
    '没有执行这条命令：你选了取消。除非用户要求，不要重试。',
    '没有执行这条命令：你选了取消。除非用户要求，不要重试。',
  ])
})

// 手搓的 $：clock 每读一次走 tick；pause（sleep）可以一直挂着，直到测试放开
function engineOf(options: { tick: number; panes: () => { id: string }[]; hang?: Promise<unknown> }) {
  const calls: string[] = []
  let now = 0
  const engine = {
    clock: { now: async () => (now += options.tick) },
    ui: {
      open: async () => {
        calls.push('open')
        return { isPlaced: true }
      },
      close: async () => calls.push('close'),
      invalidate: () => {},
      panes: async () => options.panes(),
    },
    process: {
      run: async () => {
        await options.hang
        return ok('')
      },
    },
  }
  return { engine: engine as never, calls }
}

const cardOf = (title: string): Card => ({ title, question: title, command: 'c', risky: [], rows: [], more: 0, notes: [], choices: [], decision: null })

test('a queued card gives up after 10 minutes even if the card ahead never finishes', async () => {
  let release = () => {}
  const hang = new Promise<void>(resolve => {
    release = resolve
  })
  const ahead = cardOf('ahead')
  const first = decide(engineOf({ tick: 1, panes: () => [{ id: 'danger-guard' }], hang }).engine, ahead, new AbortController().signal)
  const queued = engineOf({ tick: 60_000, panes: () => [{ id: 'danger-guard' }] })

  expect(await decide(queued.engine, cardOf('queued'), new AbortController().signal)).toBe('timeout')
  expect(queued.calls).toEqual([])

  ahead.decision = 'cancel'
  release()
  expect(await first).toBe('cancel')
})

test('a queued card takes over when the pane of the card ahead is gone', async () => {
  let release = () => {}
  const hang = new Promise<void>(resolve => {
    release = resolve
  })
  const ahead = cardOf('ahead')
  const first = decide(engineOf({ tick: 1, panes: () => [{ id: 'danger-guard' }], hang }).engine, ahead, new AbortController().signal)
  // 让前一张卡片先摆进面板
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const next = cardOf('next')
  next.decision = 'proceed'
  const queued = engineOf({ tick: 1000, panes: () => [] })

  expect(await decide(queued.engine, next, new AbortController().signal)).toBe('proceed')
  expect(queued.calls).toEqual(['open', 'close'])

  ahead.decision = 'cancel'
  release()
  await first
})

// 15. 界面语言：git 出错时说明用中文，git 自己的报错原样附上
test('a git preview failure is explained in the UI language, with git’s own message labelled', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', git: { 'status --porcelain --untracked-files=no': failed(128, 'fatal: not a git repository') } })

  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })

  expect(seen.command).toContain('算不出影响范围（git 报错：fatal: not a git repository）。')
})

test('a git failure with nothing on stderr leaks no English', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', git: { 'status --porcelain --untracked-files=no': failed(1) } })

  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })

  expect(seen.command).toContain('算不出影响范围（预览时出错）。')
})

// git 预览：restore --source 按实际会丢的算；推送删除分支；储藏
test('restore from another version lists files that change, and flags only uncommitted ones as lost', async ($, on) => {
  const seen = fakeEngine($, on, {
    press: 'cancel',
    git: { 'diff --name-only HEAD~2 -- src': 'src/a.ts\nsrc/b.ts\n', 'diff --name-only -- src': 'src/a.ts\n' },
  })

  await $.tool.call({ tool: 'Bash', command: 'git restore -s HEAD~2 src' })

  expect(seen.command).toContain('这会丢弃 1 个文件里还没暂存的改动。')
  expect(seen.command).toContain('📄 src/a.ts')
  expect(seen.command).toContain('📄 src/b.ts')
  expect(seen.command).toContain('改回 HEAD~2 的版本')
})

test('deleting a remote branch lists the commits that live only there', async ($, on) => {
  const seen = fakeEngine($, on, {
    press: 'cancel',
    git: { 'log --oneline refs/remotes/origin/feature --not --exclude=origin/feature --remotes --branches': 'abc123 wip\n' },
  })

  await $.tool.call({ tool: 'Bash', command: 'git push origin --delete feature' })

  expect(seen.card[0]).toBe('⚠ 删除远端分支')
  expect(seen.command).toContain('这会删除 origin 上的 1 个分支，其中 1 个提交不在任何别的分支上。')
})

test('git stash clear lists the stashes it drops', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', git: { 'stash list': 'stash@{0}: WIP on main: abc fix\nstash@{1}: On main: try\n' } })

  await $.tool.call({ tool: 'Bash', command: 'git stash clear' })

  expect(seen.command).toContain('这会丢掉 2 个储藏里的改动。')
  expect(seen.command).toContain('◆ WIP on main: abc fix')
})

// process.run 的输出如果去掉了开头的空格，状态行也不会切掉路径的第一个字
test('a status line that lost its leading space keeps the whole path', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel', git: { 'status --porcelain --untracked-files=no': 'M src/app.ts\nM  README.md\n' } })

  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })

  expect(seen.command).toContain('📄 src/app.ts')
  expect(seen.command).toContain('📄 README.md')
})

// 权限模式是 bypass 时，危险命令照样要你点头
test('in bypass mode the engine allows, but the guard still holds the dangerous command', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow', reason: 'bypassPermissions mode' }))

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: "sh -c 'rm -rf build'" } })

  expect(verdict.decision).toBe('ask')
})
