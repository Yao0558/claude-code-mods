// 按 shell 的方式把命令拆成一段一段、一个一个词：引号里的内容算一个词，
// 所以 `grep "rm -rf" .` 不会被当成删除，`rm -v -rf x; ls` 也能认出来。
// 重定向（2>&1、&>log、>|out、<<EOF）单独记下来，不当成命令的参数；
// 命令替换 $(…)、反引号、<(…) 里的命令照样会执行，单独交出来让调用方再查一遍

// 一个词的细节：text 去掉引号以后的文字（变量、命令替换保留原样），raw 原文
export type WordInfo = {
  text: string
  raw: string
  // 含有运行时才知道的部分：$变量、${…}、$(…)、反引号
  isDynamic: boolean
  // 含有没加引号的通配符或花括号展开：* ? [ { ^ #，词中间的 ~，开头的 =
  isGlob: boolean
  // 最后一处运行时展开之后的字面部分；$HOME/bin/x 这种命令名靠它认出是 x
  tail: string
}

// joiner：这一段前面的连接符（&&、||、;、|、&、换行、括号），第一段为空
export type Segment = {
  words: string[]
  info: WordInfo[]
  joiner: string
  // 这一段的原文
  source: string
  // 重定向到的文件（2>&1 这种复制文件描述符的不算）
  redirects: string[]
  // heredoc 正文和 here-string：喂给这条命令的标准输入
  inputs: string[]
}

// inner：命令替换、进程替换里的命令，以及没加引号的 heredoc 正文里的命令替换
export type Parsed = { segments: Segment[]; inner: string[] }

type Redirect = 'file' | 'heredoc' | 'heredoc-strip' | 'herestring'
type Heredoc = { delimiter: string; strip: boolean; quoted: boolean; inputs: string[] }

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }

// 从 open（一个左括号）找到配对的右括号；引号里的括号不算。返回括号里的内容和右括号的位置
function closeParen(text: string, open: number): { body: string; end: number } {
  return closeBy(text, open, '(', ')')
}

function closeBy(text: string, open: number, left: string, right: string): { body: string; end: number } {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    const char = text[at]!
    if (char === '\\') {
      at += 1
    } else if (char === "'") {
      const close = text.indexOf("'", at + 1)
      at = close < 0 ? text.length : close
    } else if (char === '"') {
      at = closeQuote(text, at)
    } else if (char === left) {
      depth += 1
    } else if (char === right) {
      depth -= 1
      if (depth === 0) {
        return { body: text.slice(open + 1, at), end: at }
      }
    }
  }

  return { body: text.slice(open + 1), end: text.length }
}

// 双引号从 open 开始，返回配对的那个双引号的位置
function closeQuote(text: string, open: number): number {
  for (let at = open + 1; at < text.length; at += 1) {
    if (text[at] === '\\') {
      at += 1
    } else if (text[at] === '"') {
      return at
    }
  }

  return text.length
}

// 反引号从 open 开始：返回里面的命令（去掉转义）和结束的位置
function closeBacktick(text: string, open: number): { body: string; end: number } {
  let body = ''
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!
    if (char === '\\' && at + 1 < text.length) {
      const next = text[at + 1]!
      body += '`$\\'.includes(next) ? next : `\\${next}`
      at += 1
    } else if (char === '`') {
      return { body, end: at }
    } else {
      body += char
    }
  }

  return { body, end: text.length }
}

// 一段文字里（没加引号的 heredoc 正文、${…} 里面）会执行的命令替换
export function substitutionsIn(text: string): string[] {
  const found: string[] = []
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!
    if (char === '\\') {
      at += 1
    } else if (char === '`') {
      const { body, end } = closeBacktick(text, at)
      found.push(body)
      at = end
    } else if (char === '$' && text[at + 1] === '(') {
      const { body, end } = closeParen(text, at + 1)
      found.push(body)
      at = end
    } else if (char === '$' && text[at + 1] === '{') {
      const { body, end } = closeBy(text, at + 1, '{', '}')
      found.push(...substitutionsIn(body))
      at = end
    }
  }

  return found
}

// $'…'：按 ANSI-C 的规则解开转义，返回文字和结束的单引号位置
function ansiQuoted(text: string, open: number): { value: string; end: number } {
  let value = ''
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!
    if (char === "'") {
      return { value, end: at }
    }
    if (char !== '\\' || at + 1 >= text.length) {
      value += char
      continue
    }
    at += 1
    const next = text[at]!
    const hex = next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0
    if (hex > 0) {
      const digits = /^[0-9a-fA-F]+/.exec(text.slice(at + 1, at + 1 + hex))?.[0] ?? ''
      value += digits === '' ? `\\${next}` : String.fromCodePoint(parseInt(digits, 16))
      at += digits.length
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{1,3}/.exec(text.slice(at, at + 3))![0]
      value += String.fromCharCode(parseInt(digits, 8))
      at += digits.length - 1
    } else if (next === 'c' && at + 1 < text.length) {
      at += 1
      value += String.fromCharCode(text[at]!.toUpperCase().charCodeAt(0) ^ 64)
    } else {
      value += ANSI_ESCAPES[next] ?? next
    }
  }

  return { value, end: text.length }
}

export function parseShell(command: string): Parsed {
  const segments: Segment[] = []
  const inner: string[] = []
  let words: string[] = []
  let info: WordInfo[] = []
  let redirects: string[] = []
  let inputs: string[] = []
  let word = ''
  let wordStart = 0
  let hasWord = false
  let isDynamic = false
  let isGlob = false
  let isQuoted = false
  let dynamicEnd = 0
  let joiner = ''
  let segmentStart = 0
  let redirect: Redirect | null = null
  let heredocs: Heredoc[] = []

  const begin = (at: number) => {
    if (!hasWord) {
      hasWord = true
      wordStart = at
    }
  }
  const dynamic = (text: string) => {
    word += text
    isDynamic = true
    dynamicEnd = word.length
  }
  const endWord = (at: number) => {
    if (hasWord) {
      const raw = command.slice(wordStart, at)
      if (redirect === 'file') {
        redirects.push(word)
      } else if (redirect === 'heredoc' || redirect === 'heredoc-strip') {
        heredocs.push({ delimiter: word, strip: redirect === 'heredoc-strip', quoted: /['"\\]/.test(raw), inputs })
      } else if (redirect === 'herestring') {
        inputs.push(word)
      } else {
        words.push(word)
        info.push({ text: word, raw, isDynamic, isGlob, tail: word.slice(dynamicEnd) })
      }
      redirect = null
    }
    word = ''
    hasWord = false
    isDynamic = false
    isGlob = false
    isQuoted = false
    dynamicEnd = 0
  }
  const endSegment = (at: number, next: string) => {
    endWord(at)
    redirect = null
    if (words.length > 0 || redirects.length > 0 || inputs.length > 0) {
      segments.push({ words, info, joiner, source: command.slice(segmentStart, at).trim(), redirects, inputs })
    }
    words = []
    info = []
    redirects = []
    inputs = []
    joiner = next
  }
  // heredoc 的正文从换行后开始，一直到只有定界符的那一行；返回正文结束后的位置
  const readHeredocs = (from: number): number => {
    let at = from
    for (const doc of heredocs) {
      const lines: string[] = []
      while (at < command.length) {
        const newline = command.indexOf('\n', at)
        const end = newline < 0 ? command.length : newline
        const line = doc.strip ? command.slice(at, end).replace(/^\t+/, '') : command.slice(at, end)
        at = end + 1
        if (line === doc.delimiter) {
          break
        }
        lines.push(line)
      }
      const body = lines.join('\n')
      doc.inputs.push(body)
      if (!doc.quoted) {
        inner.push(...substitutionsIn(body))
      }
    }
    heredocs = []

    return Math.min(at, command.length)
  }
  // $ 开头的展开：变量、${…}、$(…)、$'…'、$"…"；返回处理到的位置，不是展开就返回 null
  const dollar = (at: number, isInDouble: boolean): number | null => {
    const next = command[at + 1]
    if (next === '(') {
      const { body, end } = closeParen(command, at + 1)
      inner.push(body)
      dynamic(command.slice(at, end + 1))
      return end
    }
    if (next === '{') {
      const { body, end } = closeBy(command, at + 1, '{', '}')
      inner.push(...substitutionsIn(body))
      dynamic(command.slice(at, end + 1))
      return end
    }
    if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) {
      const name = /^([A-Za-z_][A-Za-z0-9_]*|.)/.exec(command.slice(at + 1))![0]
      dynamic(`$${name}`)
      return at + name.length
    }
    if (!isInDouble && next === "'") {
      const { value, end } = ansiQuoted(command, at + 1)
      word += value
      isQuoted = true
      return end
    }
    if (!isInDouble && next === '"') {
      return double(at + 1)
    }

    return null
  }
  // 双引号从 open 开始；返回结束的双引号位置
  const double = (open: number): number => {
    isQuoted = true
    for (let at = open + 1; at < command.length; at += 1) {
      const char = command[at]!
      if (char === '"') {
        return at
      }
      if (char === '\\' && at + 1 < command.length) {
        const next = command[at + 1]!
        if (next !== '\n') {
          word += '$`"\\'.includes(next) ? next : `\\${next}`
        }
        at += 1
      } else if (char === '`') {
        const { body, end } = closeBacktick(command, at)
        inner.push(body)
        dynamic(command.slice(at, end + 1))
        at = end
      } else if (char === '$') {
        const end = dollar(at, true)
        if (end === null) {
          word += char
        } else {
          at = end
        }
      } else {
        word += char
      }
    }

    return command.length
  }
  // < 或 > 开头的重定向；返回操作符最后一个字符的位置
  const redirection = (at: number): number => {
    // 紧挨在前面的数字（2>、10<）或 {fd} 是文件描述符，不是参数
    if (hasWord && !isDynamic && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\})$/.test(word)) {
      word = ''
      hasWord = false
    } else {
      endWord(at)
    }
    let end = at
    const rest = command.slice(at, at + 3)
    if (rest === '<<<') {
      redirect = 'herestring'
      return at + 2
    }
    if (rest.startsWith('<<')) {
      redirect = rest === '<<-' ? 'heredoc-strip' : 'heredoc'
      return rest === '<<-' ? at + 2 : at + 1
    }
    if (rest.startsWith('>>')) {
      end = at + 1
    }
    const after = command[end + 1]
    if (after === '&') {
      // 2>&1、<&0、>&-：复制或关闭文件描述符，后面没有文件
      const fd = /^(\d+|-)/.exec(command.slice(end + 2))?.[0]
      if (fd !== undefined) {
        return end + 1 + fd.length
      }
      end += 1
    } else if (after === '|' || after === '!' || (command[at] === '<' && after === '>')) {
      end += 1
    }
    redirect = 'file'

    return end
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!
    const next = command[at + 1]
    if (char === '\\') {
      // 反斜杠加换行是续行：两边接成一个词
      if (next !== '\n') {
        begin(at)
        word += next ?? ''
        isQuoted = true
      }
      at += 1
    } else if (char === "'") {
      begin(at)
      isQuoted = true
      const close = command.indexOf("'", at + 1)
      const end = close < 0 ? command.length : close
      word += command.slice(at + 1, end)
      at = end
    } else if (char === '"') {
      begin(at)
      at = double(at)
    } else if (char === '$') {
      begin(at)
      const end = dollar(at, false)
      if (end === null) {
        word += char
      } else {
        at = end
      }
    } else if (char === '`') {
      begin(at)
      const { body, end } = closeBacktick(command, at)
      inner.push(body)
      dynamic(command.slice(at, end + 1))
      at = end
    } else if ((char === '<' || char === '>' || (char === '=' && !hasWord)) && next === '(') {
      // 进程替换 <(…)、>(…)、zsh 的 =(…)：里面的命令会执行，整体当成一个文件名
      begin(at)
      const { body, end } = closeParen(command, at + 1)
      inner.push(body)
      dynamic(command.slice(at, end + 1))
      at = end
    } else if (char === '<' || char === '>') {
      at = redirection(at)
    } else if (char === '&' && next === '&') {
      endSegment(at, '&&')
      at += 1
      segmentStart = at + 1
    } else if (char === '&' && next === '>') {
      // &> 和 &>>：标准输出和错误一起重定向
      endWord(at)
      at += 1
      if (command[at + 1] === '>') {
        at += 1
      }
      if (command[at + 1] === '|' || command[at + 1] === '!') {
        at += 1
      }
      redirect = 'file'
    } else if (char === '|' && next === '|') {
      endSegment(at, '||')
      at += 1
      segmentStart = at + 1
    } else if (char === '|' || char === '&' || char === ';') {
      // |&（连错误一起接管道）、&|、&!（zsh 的后台）、;;、;&、;|（case 的分支结尾）都按一个连接符算
      endSegment(at, char)
      if ((char === '|' && next === '&') || (char === '&' && (next === '|' || next === '!')) || (char === ';' && next !== undefined && ';&|'.includes(next))) {
        at += 1
      }
      segmentStart = at + 1
    } else if (char === '(' || char === ')') {
      // 子 shell、函数定义 f()、for 的 zsh 短写法：括号两边按不同的命令算
      endSegment(at, char)
      segmentStart = at + 1
    } else if (char === '\n') {
      endSegment(at, '\n')
      at = heredocs.length > 0 ? readHeredocs(at + 1) - 1 : at
      segmentStart = at + 1
    } else if (char === ' ' || char === '\t') {
      endWord(at)
    } else if (char === '#' && !hasWord) {
      // 注释：跳到行尾
      while (at + 1 < command.length && command[at + 1] !== '\n') {
        at += 1
      }
    } else {
      begin(at)
      // 通配符和花括号展开；^ # 和词中间的 ~ 在 zsh 开了 extendedglob 时也是通配符
      if ('*?[{^#'.includes(char) || (char === '~' && word !== '') || (char === '=' && word === '')) {
        isGlob = true
      }
      word += char
    }
  }
  endSegment(command.length, '')

  return { segments, inner }
}

export function segmentsOf(command: string): Segment[] {
  return parseShell(command).segments
}

// 包装命令：执行后面那条命令；值是它自己的哪些选项要带一个参数
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-D', '-C', '-h', '-p', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--chdir', '--close-from', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout', '--chroot'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-P', '-S', '--unset', '--chdir', '--split-string'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  nice: ['-n', '--adjustment'],
  caffeinate: ['-t', '-w'],
  xargs: ['-J', '-I', '-s', '-n', '-L', '-E', '-R', '-S', '-P', '-d', '-a', '--delimiter', '--arg-file', '--max-args', '--max-procs', '--max-lines', '--max-chars'],
  gxargs: ['-I', '-s', '-n', '-L', '-E', '-P', '-d', '-a', '--delimiter', '--arg-file', '--max-args', '--max-procs', '--max-lines', '--max-chars'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  gstdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  arch: ['-arch', '-e', '-d'],
  noglob: [],
  nocorrect: [],
  '-': [],
  setsid: [],
  chronic: [],
  unbuffer: [],
}

// 写在命令前面的关键字：去掉以后才是真正要跑的命令
const KEYWORDS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac', 'coproc']

// 整段只是循环或分支的开头（for x in a b、case $x in），本身不执行命令
const HEADERS = ['for', 'select', 'case', 'foreach']

export type CommandStart = {
  // 真正要跑的命令从第几个词开始；等于词数表示这一段不执行命令
  at: number
  // env -S 带的字符串：会再拆成一条命令
  splits: string[]
  // 经过了哪些包装命令
  wrappers: string[]
  // xargs -I/-J 的替换记号
  replace: string | null
}

// 包装命令自己的选项：选项带参数的（sudo -u x、xargs -n 1）把参数也跳过；-n1 这种参数连写的不用跳
function skipOptions(words: readonly string[], from: number, withArg: readonly string[], onArg: (flag: string, value: string) => void): number {
  let at = from
  while (at < words.length) {
    const flag = words[at]!
    if (flag === '--') {
      return at + 1
    }
    if (!flag.startsWith('-') || flag === '-') {
      return at
    }
    at += 1
    const long = flag.split('=')[0]!
    if (flag.startsWith('--') || withArg.includes(flag)) {
      if (withArg.includes(long) && !flag.includes('=') && at < words.length) {
        onArg(long, words[at]!)
        at += 1
      } else if (flag.includes('=')) {
        onArg(long, flag.slice(long.length + 1))
      }
      continue
    }
    // 合在一起的短选项（-Hu root、-n1、-I{}）：遇到带参数的那个字母，后面连着的就是参数，没连着就用下一个词
    for (let index = 1; index < flag.length; index += 1) {
      const short = `-${flag[index]}`
      if (withArg.includes(short)) {
        const attached = flag.slice(index + 1)
        if (attached !== '') {
          onArg(short, attached)
        } else if (at < words.length) {
          onArg(short, words[at]!)
          at += 1
        }
        break
      }
    }
  }

  return at
}

// 紧跟在包装命令后面的那几个选项
function optionsAfter(words: readonly string[], at: number): string[] {
  const options: string[] = []
  for (const word of words.slice(at + 1)) {
    if (!word.startsWith('-') || word === '--') {
      break
    }
    options.push(word)
  }

  return options
}

// 去掉命令前面的包装：环境变量赋值、关键字、sudo、env、time、nice、timeout 时长、xargs 等，找到真正要跑的命令
export function commandStart(words: readonly string[]): CommandStart {
  const found: CommandStart = { at: 0, splits: [], wrappers: [], replace: null }
  for (;;) {
    const head = words[found.at]
    if (head === undefined) {
      return found
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(head)) {
      found.at += 1
    } else if (KEYWORDS.includes(head)) {
      found.at += 1
    } else if (HEADERS.includes(head)) {
      return { ...found, at: words.length }
    } else if (head === 'function' || head === 'repeat') {
      // function 名字 { …; }、zsh 的 repeat 3 命令
      found.at += 2
    } else if (head === 'timeout' || head === 'gtimeout') {
      found.wrappers.push(head)
      found.at = skipOptions(words, found.at + 1, ['-s', '-k', '--signal', '--kill-after'], () => {}) + 1
    } else if (head === 'command' && optionsAfter(words, found.at).some(word => /^-[a-zA-Z]*[vV]/.test(word))) {
      // command -v 只是查命令在哪，不执行
      return { ...found, at: words.length }
    } else if (WRAPPERS[head] !== undefined) {
      found.wrappers.push(head)
      found.at = skipOptions(words, found.at + 1, WRAPPERS[head]!, (flag, value) => {
        if (head === 'env' && (flag === '-S' || flag === '--split-string')) {
          found.splits.push(value)
        } else if (head.endsWith('xargs') && (flag === '-I' || flag === '-J')) {
          found.replace = value
        }
      })
    } else {
      return found
    }
  }
}

export function commandWords(words: readonly string[]): string[] {
  return words.slice(commandStart(words).at)
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

// git 自己的全局选项（-C 目录、-c 配置、--git-dir=… 等）去掉以后，剩下子命令和它的参数。
// isRedirected：用 --git-dir / --work-tree 指到了别处，按当前目录算出的预览不准
export function gitParts(words: readonly string[]): { gitDir: string | null; sub: string; args: string[]; isRedirected: boolean } | null {
  const run = commandWords(words)
  if (baseName(run[0] ?? '') !== 'git') {
    return null
  }

  let gitDir: string | null = null
  let isRedirected = false
  let at = 1
  while (at < run.length && run[at]!.startsWith('-')) {
    const flag = run[at]!
    isRedirected ||= /^--(git-dir|work-tree)(=|$)/.test(flag)
    if (flag === '-C' && run[at + 1] !== undefined) {
      gitDir = gitDir === null ? run[at + 1]! : `${gitDir}/${run[at + 1]!}`
      at += 2
    } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(flag) && run[at + 1] !== undefined) {
      at += 2
    } else {
      at += 1
    }
  }
  const sub = run[at]
  if (sub === undefined) {
    return null
  }

  return { gitDir, sub, args: run.slice(at + 1), isRedirected }
}
