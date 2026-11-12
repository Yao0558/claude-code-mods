// clean：git 里有且没改动，删了能从 git 恢复；dirty：有未提交或未跟踪的内容；
// none：不在 git 里；repo：整个仓库目录，连 git 历史一起删；
// history：.git 本身（仓库的全部历史）；internal：.git 里面的文件；lock：.git 里 git 中断后留下的 *.lock
export type GitState = 'clean' | 'dirty' | 'none' | 'repo' | 'history' | 'internal' | 'lock'

export type DeleteItem = {
  type: 'file' | 'dir' | 'link' | 'missing' | 'critical'
  files: number
  kb: number
  git: GitState
  path: string
  given: string
  // 符号链接指向哪里（readlink 的原文），别的类型为空
  target: string
  isOutsideProject: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // 你在卡片上选了“本会话都允许”的项目外目录（小写）
    'danger-guard': { allowedDirs: string[] }
  }
}
