// 状态栏会显示命令；这里把看着像密钥、口令的部分换成 …，免得截图、录屏时带出去
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// 名字像是存密钥的：TOKEN、--api-key、--password……
const SECRET_NAME = /token|secret|passw(or)?d|pwd|api[-_]?key|auth|credential/i
// 常见服务的令牌前缀：GitHub、OpenAI / Anthropic、Slack、AWS、GitLab、npm
const TOKEN = /\b(gh[pousr]_|github_pat_|sk-|xox[abposr]-|A[KS]IA|glpat-)[\w-]{16,}|\bnpm_[A-Za-z0-9]{30,}/g
// 很长的一串随机字符：32 位以上的十六进制，或大小写和数字混着的 24 位以上
const OPAQUE = /[A-Za-z0-9+_=-]{24,}/g
// URL 里的 user:pass@
const URL_PASSWORD = /(\/\/[^/\s:@]+:)[^/\s@]+@/g

function isOpaque(run: string): boolean {
  if (/^[0-9a-f]{32,}$/i.test(run)) {
    return true
  }

  return /[a-z]/.test(run) && /[A-Z]/.test(run) && run.replace(/\D/g, '').length >= 3
}

function maskedWord(word: string): string {
  // --token=…、FOO_TOKEN=…：名字像密钥，值整个不显示
  const named = /^(-{0,2}[A-Za-z_][\w-]*=)(.+)$/.exec(word)
  if (named !== null && SECRET_NAME.test(named[1]!)) {
    return `${named[1]!}…`
  }
  // mysql -pPASSWORD 这种连在一起的口令；-project、-parallel-testing-enabled、-p no:cacheprovider 这类不动
  if (/^-p./.test(word) && !/^-p[a-z][a-z-]*$/.test(word) && !/^-p[\w-]+:[\w-]+$/.test(word)) {
    return '-p…'
  }

  return word
    .replace(URL_PASSWORD, '$1…@')
    .replace(TOKEN, (found, prefix: string | undefined) => `${prefix ?? 'npm_'}…`)
    .replace(OPAQUE, found => (isOpaque(found) ? '…' : found))
}

// 要显示的命令：去掉开头的 VAR=value，其余逐词遮掉像密钥的部分；`--token xxx` 这样分开写的，值也遮掉
export function shownWords(words: readonly string[]): string[] {
  let at = 0
  while (at < words.length && ASSIGNMENT.test(words[at]!)) {
    at += 1
  }

  return words.slice(at).map((word, index, rest) => {
    const before = rest[index - 1]
    if (before !== undefined && /^--?[\w-]+$/.test(before) && SECRET_NAME.test(before)) {
      return '…'
    }

    return maskedWord(word)
  })
}
