export type Place = {
  name: string
  isRepo: boolean
  branch: string | null
  dirty: number
  entity: string | null
}

export type Quota = {
  kind: string
  percentUsed: number
  // 本会话开始以来用掉的百分点
  sinceStart: number
  resetsAt: string | null
}

export type Spend = {
  usd: number | null
  lastTurnUsd: number | null
  // 当前对话占用的 token 数，和它占上下文窗口的比例
  contextTokens: number | null
  contextPercent: number | null
  quotas: Quota[]
}

// 算增量用的基准：上一轮结束时的累计花费、会话开始时各额度的读数
export type Baseline = {
  usdAtLastTurn: number | null
  quotaAtStart: Record<string, number>
  // 各额度窗口上次看到的重置时间；变了就说明窗口重置过
  quotaResetsAt: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'repo-bar': { place: Place | null; spend: Spend | null; baseline: Baseline; isCollapsed: boolean }
  }
}
