// 每个会话写一份自己的状态文件，所有会话都读
export type StepCount = { done: number; active: number; total: number }

export type StepState = 'pending' | 'in_progress' | 'completed'

// 计划里的一步：估时区间（毫秒，没写是 null）、要不要你在场、正在做的那步从什么时候开始；
// key 是去掉末尾括号的步骤文字，重发清单时用它认出同一步（旧版本写的没有）
export type PlanStep = { state: StepState; lo: number | null; hi: number | null; needsYou: boolean; since: number | null; key?: string }

export type TaskStatus = {
  v: 1
  cliId: string
  // 桌面 App 里的会话 id（local_…），用来跳过去；终端里的会话没有
  localId: string | null
  // 桌面 App 给会话起的标题
  title: string | null
  // 这一轮你说的第一行话
  task: string
  state: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  steps: StepCount | null
  // 各步明细（旧版本写的文件没有）
  plan?: PlanStep[]
}

// 输入框上方画出来的一行
export type Row = {
  cliId: string
  localId: string | null
  startedAt: number
  name: string
  state: 'running' | 'done' | 'failed'
  percent: number | null
  // “~15m”、估时区间、超出多久，或运行了多久
  side: string
  // 超出估时：时间那一栏变成警示色
  isOver: boolean
  // 后面要你在场的提醒，如“25m 后需要你”
  note: string | null
  isSelf: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // 行的形状变了就换标签（rows-2 起有 isOver、note），热重载后旧代码画的行读作没有
    'task-progress': { rows: Shaped<Row[]> }
  }
}
