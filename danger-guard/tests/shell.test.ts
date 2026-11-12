import { expect, test } from 'claude-code/testing'

import { scan } from '../hooks/analyze'
import { parseRm } from '../hooks/deletion'
import { classifyGit } from '../hooks/git'
import { parseShell, segmentsOf } from '../hooks/shell'

const wordsOf = (command: string) => segmentsOf(command).map(segment => segment.words)

test('redirections stay out of the words, and their targets are never arguments', () => {
  for (const command of ['rm -rf x 2>&1', 'rm -rf x >&2', 'rm -rf x &>log', 'rm -rf x &>>log', 'rm -rf x <&0', 'rm -rf x >|out', 'rm -rf x 2>/dev/null', 'rm -rf x > out 2>&1']) {
    expect([command, wordsOf(command)]).toEqual([command, [['rm', '-rf', 'x']]])
  }
  expect(segmentsOf('make &>build.log; ls')[0]!.redirects).toEqual(['build.log'])
  expect(wordsOf('a 2>&1 | b')).toEqual([['a'], ['b']])
  // 一个 & 仍然是后台运行
  expect(wordsOf('sleep 1 & rm -rf x')).toEqual([['sleep', '1'], ['rm', '-rf', 'x']])
  // 重定向的 rm 也能列清单：展开时不带 2>
  expect(parseRm('rm -rf x 2>&1')).toEqual({ cd: null, args: '-rf x', isLiteral: true })
})

test('quotes, ANSI-C strings and line continuations are read as the shell reads them', () => {
  expect(wordsOf("$'rm' -rf x")).toEqual([['rm', '-rf', 'x']])
  expect(wordsOf('r\\\nm -rf x')).toEqual([['rm', '-rf', 'x']])
  expect(wordsOf('"r"m -rf x')).toEqual([['rm', '-rf', 'x']])
  expect(wordsOf("echo 'a b' \"c $d\"")).toEqual([['echo', 'a b', 'c $d']])
})

test('heredoc bodies are input, not commands; substitutions in them still count', () => {
  const parsed = parseShell('cat <<EOF > notes.md\nterraform destroy\n$(rm -rf x)\nEOF\nls')
  expect(parsed.segments.map(segment => segment.words)).toEqual([['cat'], ['ls']])
  expect(parsed.segments[0]!.inputs).toEqual(['terraform destroy\n$(rm -rf x)'])
  expect(parsed.inner).toEqual(['rm -rf x'])
  // 加了引号的定界符不展开
  expect(parseShell("cat <<'EOF'\n$(rm -rf x)\nEOF").inner).toEqual([])
})

test('every danger in a command is reported, each with its own segment', () => {
  const found = scan('git reset --hard && rm -rf build; npm publish')
  expect(found.hits.map(hit => [hit.key, hit.source])).toEqual([
    ['reset', 'git reset --hard'],
    ['recursiveRm', 'rm -rf build'],
    ['npmPublish', 'npm publish'],
  ])
  expect(scan('sudo rm -rf / && echo').rms).toEqual([{ args: ['-rf', '/'], cd: [] }])
  expect(scan('cd /tmp && rm -rf *').rms).toEqual([{ args: ['-rf', '*'], cd: ['/tmp'] }])
  expect(scan('rm -rf "$X"').rms).toEqual([{ args: null, cd: [] }])
})

test('the new git operations are recognised with their details', () => {
  expect(classifyGit('git push origin --delete feature')).toMatchObject({ kind: 'pushDelete', remote: 'origin', branches: ['feature'], mode: 'delete' })
  expect(classifyGit('git push origin :feature')).toMatchObject({ kind: 'pushDelete', branches: ['feature'] })
  expect(classifyGit('git push --mirror backup')).toMatchObject({ kind: 'pushDelete', remote: 'backup', mode: 'mirror' })
  expect(classifyGit('git push --prune origin')).toMatchObject({ kind: 'pushDelete', mode: 'prune' })
  expect(classifyGit('git branch -d -f a b')).toMatchObject({ kind: 'branch', names: ['a', 'b'] })
  expect(classifyGit('git checkout HEAD~1 -- src/a.ts')).toMatchObject({ kind: 'discard', base: 'HEAD~1', withStaged: true, paths: ['src/a.ts'] })
  expect(classifyGit('git checkout -- src/a.ts')).toMatchObject({ kind: 'discard', base: null, withStaged: false })
  expect(classifyGit("git restore '*'")).toMatchObject({ kind: 'discard', paths: ['*'] })
  expect(classifyGit('git restore -s HEAD~2 src')).toMatchObject({ kind: 'discard', base: 'HEAD~2', withStaged: false, paths: ['src'] })
  expect(classifyGit('git restore --source=v1 -SW .')).toMatchObject({ kind: 'discard', base: 'v1', withStaged: true })
  expect(classifyGit('git switch --discard-changes main')).toMatchObject({ kind: 'discard', base: 'HEAD', paths: ['.'] })
  expect(classifyGit('git stash drop stash@{2}')).toMatchObject({ kind: 'stash', drop: 'stash@{2}' })
  expect(classifyGit('git stash clear')).toMatchObject({ kind: 'stash', drop: null })
  expect(classifyGit('git push -f origin a b:c')).toMatchObject({ kind: 'push', specs: [{ source: 'a', ref: 'a' }, { source: 'b', ref: 'c' }] })
  // 指到别的仓库、带变量的，不预览（交给通用的确认卡片）
  expect(classifyGit('git --git-dir=/x/.git reset --hard')).toBeNull()
  expect(classifyGit('git reset --hard $REV')).toBeNull()
  expect(classifyGit('git clean -n -d')).toBeNull()
})
