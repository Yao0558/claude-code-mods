import { expect, test } from 'claude-code/testing'

// 前面用 ;、换行、&& 连着的，整条命令的退出码就是最后那条检查的，照样报；|| 和管道连着的不报
test('a check at the end of a ; or newline sequence is reported, one after || or a pipe is not', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('clock.after', () => new Promise<never>(() => {}))
  on('clock.now', () => ({ value: 0 }))
  on('tool.call', () => ({ result: {} }))

  for (const command of ['T=/x/mk; mkdir -p $T && make -C $T test', 'cd app\nnpm test']) {
    lines.length = 0
    await $.tool.call({ tool: 'Bash', command })
    expect([command, lines.at(-1)?.startsWith('✓ 测试通过')]).toEqual([command, true])
  }
  for (const command of ['false || npm test', 'cat x | npm test']) {
    lines.length = 0
    await $.tool.call({ tool: 'Bash', command })
    expect([command, lines]).toEqual([command, []])
  }
})
