import { expect, test } from 'claude-code/testing'

import { parseRm, splitRmArgs } from '../hooks/deletion'
import { classifyGit } from '../hooks/git'
import { fakeEngine } from './fake'

test('only a plain rm, optionally after one cd, is previewed', () => {
  expect(parseRm('rm -rf dist')).toEqual({ cd: null, args: '-rf dist', isLiteral: true })
  expect(parseRm('cd app && rm -r "old stuff" *.psd')).toEqual({ cd: 'app', args: '-r "old stuff" *.psd', isLiteral: false })
  expect(parseRm('rm -rf $DIR')).toBeNull()
  expect(parseRm('rm -rf dist && npm run build')).toBeNull()
  expect(parseRm('ls | xargs rm')).toBeNull()
  expect(parseRm('rmdir x')).toBeNull()
  expect(splitRmArgs(['-rf', 'a', '--', '-weird'])).toEqual({ isRecursive: true, removesDirs: false, targets: ['a', '-weird'] })
  expect(splitRmArgs(['-f', 'a'])).toEqual({ isRecursive: false, removesDirs: false, targets: ['a'] })
})

test('git operations that can be measured are recognised', () => {
  expect(classifyGit('git reset --hard')).toMatchObject({ kind: 'reset', ref: null })
  expect(classifyGit('cd app && git reset --hard HEAD~2')).toMatchObject({ kind: 'reset', cd: 'app', ref: 'HEAD~2' })
  expect(classifyGit('git checkout -- .')).toMatchObject({ kind: 'discard' })
  expect(classifyGit('git restore --staged .')).toBeNull()
  expect(classifyGit('git clean -fdx')).toMatchObject({ kind: 'clean', args: ['-fdx'] })
  expect(classifyGit('git -C ../site push -f origin main')).toMatchObject({ kind: 'push', gitDir: '../site', remote: 'origin', ref: 'main' })
  expect(classifyGit('git push origin +main')).toMatchObject({ kind: 'push', ref: 'main' })
  expect(classifyGit('git push origin main')).toBeNull()
  expect(classifyGit('git branch -D old')).toMatchObject({ kind: 'branch', name: 'old' })
  expect(classifyGit('git reset --hard && rm -rf x')).toBeNull()
})

const RISKY = [
  'dir\t9\t1200\tnone\t/p/temp\ttemp/',
  'file\t1\t320\tclean\t/p/logo.png\tlogo.png',
  'file\t1\t36000\tdirty\t/p/old.psd\told.psd',
]

test('a risky delete shows a card with buttons; trash moves exactly the reviewed paths', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/', 'logo.png', 'old.psd'], lines: RISKY, press: 'trash' })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/ logo.png old.psd' })

  expect(seen.card).toEqual(['⚠ 删除前确认', '$ rm -rf temp/ logo.png old.psd', '📁 temp/'])
  expect(seen.ran).toEqual(["trash '/p/temp' '/p/logo.png' '/p/old.psd'"])
})

test('permanent delete removes the reviewed paths without a second prompt', async ($, on) => {
  const checked: string[] = []
  on('tool.check', { tool: 'Bash' }, (_, e) => {
    checked.push((e.input as { command: string }).command)
    return { decision: 'ask' }
  })
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/', 'logo.png'], lines: [RISKY[0]!, RISKY[1]!], press: 'purge' })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/ *.png' })

  // 引擎这层说“要问人”，但卡片上已经同意过：照样执行，不再问第二遍
  expect(seen.ran).toEqual(["rm -rf -- '/p/temp' '/p/logo.png'"])
  expect(checked).toEqual(["rm -rf -- '/p/temp' '/p/logo.png'"])
})

test('a settings deny rule still wins after the card was approved', async ($, on) => {
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'Bash(git push --force:*) is denied' }))
  const seen = fakeEngine($, on, { git: { 'rev-parse --abbrev-ref HEAD': 'main\n' }, press: 'proceed' })

  const result = await $.tool.call({ tool: 'Bash', command: 'git push --force' })

  expect(seen.ran).toEqual([])
  expect(result.deny ?? (result as { text?: string }).text ?? '').not.toBe('')
})

test('the shell-aware screen catches common forms and ignores quoted text', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel' })

  for (const command of [
    'rm -r build && ls',
    'rm -v -Rf build; ls',
    'git -C ~/p reset --hard origin/main && git log -1',
    'git -c core.x=y reset --hard',
    'git clean -d -f && ls',
    'git checkout HEAD -- . && ls',
    'git restore --staged --worktree .',
    'sudo rm -rf /tmp/x | tee log',
  ]) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect([command, result.deny === undefined]).toEqual([command, false])
  }
  for (const command of ['grep -rn "rm -rf" .', 'git commit -m "undo git reset --hard"', 'git restore --staged .', 'ls -la']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(seen.ran).toEqual(['grep -rn "rm -rf" .', 'git commit -m "undo git reset --hard"', 'git restore --staged .', 'ls -la'])
})


test('cancel on the card deletes nothing', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/'], lines: [RISKY[0]!], press: 'cancel' })

  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toBe('没有删除任何文件：你选了取消。除非用户要求，不要重试。')
})

test('where the pane cannot be placed, the native dialog answers instead', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/'], lines: [RISKY[0]!], isPlaced: false, press: '移到废纸篓' })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/' })

  // 问题里带上命令：对话框画成什么样，都看得到批准的是哪条命令
  expect(seen.asked).toEqual(['要怎么处理这 1 项（1 个文件夹，共 1.2 MB）？\n$ rm -rf temp/'])
  expect(seen.ran).toEqual(["trash '/p/temp'"])
})

test('a native dialog that timed out while away counts as cancel', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', 'temp/'], lines: [RISKY[0]!], isPlaced: false, press: null })

  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toContain('没有删除任何文件')
})

test('a few clean tracked files go to the trash without a card', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['logo.png'], lines: [RISKY[1]!], press: 'cancel' })

  await $.tool.call({ tool: 'Bash', command: 'rm logo.png' })

  expect(seen.opened).toBe(0)
  expect(seen.ran).toEqual(["trash '/p/logo.png'"])
})

test('home and system folders are refused outright', async ($, on) => {
  const seen = fakeEngine($, on, { words: ['-rf', '/Users/me'], lines: ['critical\t0\t0\tnone\t/Users/me\t/Users/me'] })

  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toContain('系统关键目录')
})

test('git reset --hard lists the uncommitted changes it would throw away', async ($, on) => {
  const seen = fakeEngine($, on, {
    git: { 'status --porcelain --untracked-files=no': ' M src/app.ts\nM  README.md\n' },
    press: 'proceed',
  })

  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })

  expect(seen.card).toEqual(['⚠ 丢弃本地改动', '$ git reset --hard', '📄 src/app.ts'])
  expect(seen.ran).toEqual(['git reset --hard'])
})

test('a force push lists the remote commits it would drop; cancel stops it', async ($, on) => {
  const seen = fakeEngine($, on, {
    git: { 'rev-parse --abbrev-ref HEAD': 'main\n', 'log --oneline HEAD..origin/main': 'abc123 fix login\n' },
    press: 'cancel',
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'git push --force' })

  expect(seen.card).toEqual(['⚠ 强制推送', '$ git push --force', '◆ fix login'])
  expect(seen.ran).toEqual([])
  expect(result.deny).toBe('没有执行这条命令：你选了取消。除非用户要求，不要重试。')
})

test('other dangerous commands still need a press, with no preview', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'proceed' })

  await $.tool.call({ tool: 'Bash', command: 'terraform destroy' })

  expect(seen.card.slice(0, 2)).toEqual(['⚠ 危险命令', '$ terraform destroy'])
  expect(seen.ran).toEqual(['terraform destroy'])
})

test('editing outside the project asks once per folder when allowed for the session', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'dir' })

  await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/Users/me/.claude/projects/x/memory/a.md', content: 'x' })
  expect(seen.opened).toBe(0)

  await $.tool.call({ tool: 'Write', file_path: '/Volumes/Other/brand/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/Volumes/Other/brand/b.ts', content: 'x' })

  expect(seen.opened).toBe(1)
  expect(seen.card).toEqual(['⚠ 编辑项目外的文件', '$ Write /Volumes/Other/brand/a.ts', '✏️ /Volumes/Other/brand/a.ts'])
  expect(seen.ran).toEqual([
    'Write /p/src/a.ts',
    'Write /Users/me/.claude/projects/x/memory/a.md',
    'Write /Volumes/Other/brand/a.ts',
    'Write /Volumes/Other/brand/b.ts',
  ])
})

test('cancelling an outside edit leaves the file alone', async ($, on) => {
  const seen = fakeEngine($, on, { press: 'cancel' })

  const result = await $.tool.call({ tool: 'Edit', file_path: '/Volumes/Other/x.ts', old_string: 'a', new_string: 'b' })

  expect(seen.ran).toEqual([])
  expect(result.deny).toContain('在当前项目 /p 之外')
})

test('the command on the card is shown whole, long paths included', async ($, on) => {
  const outside = ['dir\t5\t20\tnone\t/x/a/b/c/repo/old\told', 'file\t1\t4\tclean\t/x/a/b/c/repo/logo.png\tlogo.png']
  const seen = fakeEngine($, on, { words: ['-rf', 'old', 'logo.png'], lines: outside, press: 'cancel' })

  await $.tool.call({ tool: 'Bash', command: 'cd /x/a/b/c/repo && rm -rf old logo.png' })

  expect(seen.card[1]).toBe('$ cd /x/a/b/c/repo && rm -rf old logo.png')
})

// 语言跟着 Claude Code 的 language 设置走：卡片、给模型的拒绝理由、权限检查的说明
for (const [language, card, deny, reason] of [
  [
    'english',
    ['⚠ Confirm delete', '$ rm -rf temp/', '📁 temp/'],
    'No files were deleted: the user chose Cancel. Do not retry unless the user asks.',
    'danger-guard: Recursive delete (rm -r) needs your confirmation',
  ],
  [
    'chinese',
    ['⚠ 删除前确认', '$ rm -rf temp/', '📁 temp/'],
    '没有删除任何文件：你选了取消。除非用户要求，不要重试。',
    'danger-guard：递归删除（rm -r），需要你确认',
  ],
] as const) {
  test(`with language set to ${language}, the card and the reasons are in that language`, async ($, on) => {
    on('tool.check', () => ({ decision: 'allow' }))
    const seen = fakeEngine($, on, { words: ['-rf', 'temp/'], lines: [RISKY[0]!], press: 'cancel', language })

    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf temp/' })

    expect(seen.card).toEqual(card)
    expect(result.deny).toBe(deny)
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf temp/' } })).reason).toBe(reason)
  })
}
