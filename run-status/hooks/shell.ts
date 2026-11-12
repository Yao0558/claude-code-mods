// 按 shell 的方式把命令拆成一段一段、一个一个词：引号里的内容算一个词，
// 所以 `grep "rm -rf" .` 不会被当成删除，`rm -v -rf x; ls` 也能认出来

export type Segment = { words: string[]; joiner: string }

// 重定向符号从 at 开始有几个字符：>、>>、>|、>&、<、<<、<<-、<<<、<&、<>、&>、&>>；不是重定向就是 0
function redirectionAt(command: string, at: number): number {
  const found = /^(?:&>>?|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(command.slice(at, at + 3))?.[0]
  // <(…)、>(…) 是进程替换，照旧算词的一部分
  if (found === undefined || ((found === '<' || found === '>') && command[at + 1] === '(')) {
    return 0
  }

  return found.length
}

// joiner：这一段前面的连接符（&&、||、;、|、&、换行），第一段为空。
// 重定向（2>&1、&>log、>out、<in、<<EOF）和它的目标都不算词，所以 `2>&1` 里的 & 不会把命令断开
export function segmentsOf(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let isQuoted = false
  // 刚读到重定向符号：下一个词是它的目标（文件、文件描述符、heredoc 的结束标记），不留
  let isTarget = false
  let joiner = ''
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) {
      if (!isTarget) {
        words.push(word)
      }
      isTarget = false
    }
    word = ''
    hasWord = false
    isQuoted = false
  }
  const endSegment = (next: string) => {
    endWord()
    isTarget = false
    if (words.length > 0) {
      segments.push({ words, joiner })
    }
    words = []
    joiner = next
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && at + 1 < command.length) {
        at += 1
        word += command[at]
      } else {
        word += char
      }
      continue
    }
    const redirection = redirectionAt(command, at)
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
      isQuoted = true
    } else if (char === '\\' && at + 1 < command.length) {
      at += 1
      word += command[at]
      hasWord = true
      isQuoted = true
    } else if (redirection > 0) {
      // 紧贴在符号前的数字是文件描述符（2>、1>&2），不是参数
      if (hasWord && !isQuoted && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      endWord()
      isTarget = true
      at += redirection - 1
    } else if (char === '|' && command[at + 1] === '&') {
      // |& 是把 stderr 一起接进管道
      endSegment('|')
      at += 1
    } else if (char === '&' && command[at + 1] === '&') {
      endSegment('&&')
      at += 1
    } else if (char === '|' && command[at + 1] === '|') {
      endSegment('||')
      at += 1
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      endSegment(char)
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === '#' && !hasWord) {
      // 注释：跳到行尾
      while (at + 1 < command.length && command[at + 1] !== '\n') {
        at += 1
      }
    } else {
      word += char
      hasWord = true
    }
  }
  endSegment('')

  return segments
}

// 去掉命令前面的包装：环境变量赋值、sudo、env、time、nice、timeout 秒数、xargs 等，剩下真正要跑的命令
export function commandWords(words: readonly string[]): string[] {
  let rest = [...words]
  for (;;) {
    const head = rest[0]
    if (head === undefined) {
      return rest
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      rest = rest.slice(1)
    } else if (['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'xargs'].includes(head)) {
      rest = rest.slice(1)
      // 包装命令自己的选项，比如 sudo -u x、time -p、nice -n 5、xargs -0
      while (rest[0]?.startsWith('-')) {
        const flag = rest[0]
        rest = rest.slice(1)
        if (['-u', '-g', '-n', '-I', '-L', '-P'].includes(flag) && rest[0] !== undefined) {
          rest = rest.slice(1)
        }
      }
    } else if (head === 'timeout' || head === 'gtimeout') {
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-')) {
        rest = rest.slice(1)
      }
      rest = rest.slice(1)
    } else {
      return rest
    }
  }
}

export function baseName(word: string): string {
  return word.split('/').pop() ?? word
}

// rm 有没有递归：-r、-R、--recursive，或者合在一起的 -rf、-Rv 之类
export function isRecursiveRm(words: readonly string[]): boolean {
  const run = commandWords(words)
  if (baseName(run[0] ?? '') !== 'rm') {
    return false
  }
  for (const word of run.slice(1)) {
    if (word === '--') {
      return false
    }
    if (word === '--recursive' || /^-[a-zA-Z]*[rR]/.test(word)) {
      return true
    }
  }

  return false
}

// git 自己的全局选项（-C 目录、-c 配置、--git-dir=… 等）去掉以后，剩下子命令和它的参数
export function gitParts(words: readonly string[]): { gitDir: string | null; sub: string; args: string[] } | null {
  const run = commandWords(words)
  if (baseName(run[0] ?? '') !== 'git') {
    return null
  }

  let gitDir: string | null = null
  let at = 1
  while (at < run.length && run[at]!.startsWith('-')) {
    const flag = run[at]!
    if (flag === '-C' && run[at + 1] !== undefined) {
      gitDir = gitDir === null ? run[at + 1]! : `${gitDir}/${run[at + 1]!}`
      at += 2
    } else if ((flag === '-c' || flag === '--git-dir' || flag === '--work-tree' || flag === '--namespace') && run[at + 1] !== undefined) {
      at += 2
    } else {
      at += 1
    }
  }
  const sub = run[at]
  if (sub === undefined) {
    return null
  }

  return { gitDir, sub, args: run.slice(at + 1) }
}
