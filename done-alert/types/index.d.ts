// 输入框上方那条完成提示：成功还是出错、做的是什么、用了多久
export type Notice = {
  hasFailed: boolean
  task: string
  took: string
}

declare module 'claude-code' {
  interface PluginState {
    'done-alert': { notice: Notice | null; lastTask: string }
  }
}
