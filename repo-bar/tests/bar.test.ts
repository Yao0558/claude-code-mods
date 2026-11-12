import type { SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'repo-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band names the repo, branch and uncommitted files, on terminal and desktop', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/code/shop' }))
  on('session.repo', () => ({ value: { root: '/code/shop', remote: null, internal: false, name: null } }))
  on('process.run', (_, e) => ({
    value: e.argv[1] === 'rev-parse'
      ? { exitCode: 0, stdout: 'feature/cart\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/code/shop', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /shop/ }))?.text).toBe('shop')
    // 终端是一整段；别处分成分支（窄时截断）和状态（始终完整）两段
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: /feature\/cart/ }))?.text).toContain('2 个文件未提交')
    } else {
      expect((await ui.find({ type: 'Text', text: /feature\/cart/ }))?.text).toBe('· feature/cart')
      expect((await ui.find({ type: 'Text', text: /未提交/ }))?.text).toBe(' · 2 个文件未提交')
      // 分支名截断、状态不收缩，两者外面那层能缩
      expect((await ui.find({ type: 'Text', text: /feature\/cart/ }))?.props.wrap).toBe('truncate-end')
      const tree = await ui.drawn()
      expect(boxIn(tree, (props, box) => props.flexShrink === 0 && JSON.stringify(box.children ?? []).includes('未提交'))).not.toBe(null)
      expect(boxIn(tree, (props, box) => props.minWidth === 0 && props.flexWrap === undefined && JSON.stringify(box.children ?? []).includes('feature/cart'))).not.toBe(null)
    }
    await ui.unmount()
  }
})

test('outside a repo the band says so', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/tmp/notes' }))
  on('session.repo', () => ({ value: null }))

  await $.session.start({ cwd: '/tmp/notes', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /非 git/ }))?.text).toContain('非 git 目录')
  await ui.unmount()
})

// 所属主体来自配置项 entities：路径或 origin 地址里含字样就显示名字，不分大小写；写错的项不算（放在前面，不过滤的话会先被它们匹配上）
test('the owner label comes from the entities option', { options: { entities: ['no-equals-sign', '=nameless', 'other=', 'ACME=Acme Inc.'] } }, async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/code/shop' }))
  on('session.repo', () => ({ value: { root: '/code/shop', remote: 'git@github.com:acme/shop.git', internal: false, name: null } }))
  on('process.run', (_, e) => ({
    value: e.argv[1] === 'rev-parse'
      ? { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/code/shop', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Acme/ }))?.text).toBe('Acme Inc. ·')
  await ui.unmount()
})

test('without the entities option no owner label is shown', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/code/shop' }))
  on('session.repo', () => ({ value: { root: '/code/shop', remote: 'git@github.com:acme/shop.git', internal: false, name: null } }))
  on('process.run', (_, e) => ({
    value: e.argv[1] === 'rev-parse'
      ? { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/code/shop', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: / ·$/ }))?.text ?? null).toBe(null)
  expect((await ui.find({ type: 'Text', text: /shop/ }))?.text).toBe('shop')
  await ui.unmount()
})

test('usage row: subscription label, session and last-turn cost, quotas, context', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  let usd = 0.1
  let fiveHour = 20
  let percent = 42
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/Volumes/Data/Coding' }))
  on('session.repo', () => ({ value: null }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 48588, percent },
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-26T12:00:00Z' },
        { kind: 'seven_day', percentUsed: 12 },
      ],
      cost: { usd },
    },
  }))
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 } as const
  await $.session.start({ cwd: '/Volumes/Data/Coding', surface: 'desktop', isInteractive: true })

  usd = 0.35
  fiveHour = 24.5
  await $.turn.complete(turn)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /API 等值/ }))?.text).toBe('API 等值')
    expect((await ui.find({ type: 'Text', text: '$0.35' }))?.text).toBe('$0.35')
    expect((await ui.find({ type: 'Text', text: '$0.25' }))?.text).toBe('$0.25')
    expect((await ui.find({ type: 'Text', text: '24.5%' }))?.text).toBe('24.5%')
    expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +4.5)')
    expect((await ui.find({ type: 'Text', text: '12%' }))?.text).toBe('12%')
    expect((await ui.find({ type: 'Text', text: '48,588' }))?.text).toBe('48,588')
    expect((await ui.find({ type: 'Text', text: '(42%)' }))?.text).toBe('(42%)')
    await ui.unmount()
  }

  // 子代理回合只刷新累计，不改“上轮”；额度过 80% 显示重置时间
  usd = 0.5
  fiveHour = 85
  percent = 86
  await $.turn.complete({ ...turn, agentId: 'a1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$0.50' }))?.text).toBe('$0.50')
  expect((await ui.find({ type: 'Text', text: '$0.25' }))?.text).toBe('$0.25')
  expect((await ui.find({ type: 'Text', text: /重置/ }))?.text).toBe('(会话期间 +65.0，2 小时后重置)')
  await ui.unmount()
  // 每项数据：终端以外放不下时备注整段换行；终端照旧
  expect(boxIn(await drawnOn($, BAND, 'desktop'), props => props.key === 'usd')?.flexWrap).toBe('wrap')
  expect(boxIn(await drawnOn($, BAND, 'terminal'), props => props.key === 'usd')?.flexWrap).toBe(undefined)
})

test('off a subscription there is no API label and no quota', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 5 }, rateLimits: [], cost: { usd: 2 } } }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /API 等值/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '$2.00' }))?.text).toBe('$2.00')
  await ui.unmount()
})

test('the toggle collapses to cost, quota and context, and expands back', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/shop' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, percent: 30 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10 }],
      cost: { usd: 0.4 },
    },
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x/shop', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'shop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '上轮' })).toBeDefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: 'shop' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '上轮' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /非 git/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: '$0.40' }))?.text).toBe('$0.40')
    expect((await ui.find({ type: 'Text', text: '10%' }))?.text).toBe('10%')

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: 'shop' })).toBeDefined()
    await ui.unmount()
  }
})

test('after the 5-hour window resets mid-session, the session delta counts the new window', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  // 引擎自己的那层：输入框上方原本什么都不画
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  let fiveHour = 40
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }], cost: { usd: 1 } },
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  fiveHour = 3
  await $.turn.complete({ answer: '', turnId: 't1', isAborted: false, reason: 'answer', durationMs: 1000 })
  fiveHour = 7
  await $.turn.complete({ answer: '', turnId: 't2', isAborted: false, reason: 'answer', durationMs: 1000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +7.0)')
  await ui.unmount()
})

test('a window reset is caught by its reset time even when the reading went up', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  let reading = { percentUsed: 30, resetsAt: '2026-10-26T10:00:00Z' }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', ...reading }], cost: { usd: 1 } },
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  reading = { percentUsed: 35, resetsAt: '2026-10-26T15:00:00Z' }
  await $.turn.complete({ answer: '', turnId: 't1', isAborted: false, reason: 'answer', durationMs: 1000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +35.0)')
  await ui.unmount()
})

test('after a reload, quotas and the last turn come back from the store until the engine reads them again', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 重载前那次存下的：账号额度（7 天那项已过重置时间，不再显示）和这个会话的上轮花费
  const store: Record<string, unknown> = {
    quotas: [
      { kind: 'five_hour', percentUsed: 24, resetsAt: '2026-10-26T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-26T09:00:00Z' },
    ],
    turns: { s1: { usdAtLastTurn: 2.1, lastTurnUsd: 0.69, quotaAtStart: { five_hour: 20 }, quotaResetsAt: { five_hour: '2026-10-26T12:00:00Z' }, at: 1 } },
  }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  // 刚重载：引擎还没有额度读数
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 15 }, rateLimits: [], cost: { usd: 2.41 } } }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /API 等值/ }))?.text).toBe('API 等值')
  expect((await ui.find({ type: 'Text', text: '24%' }))?.text).toBe('24%')
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '$0.69' }))?.text).toBe('$0.69')
  // “会话期间”接着重载前的起点算，不从 0 重来
  expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +4.0)')
  await ui.unmount()

  // 下一轮从重载前的起点算，不是从重载那一刻算
  await $.turn.complete({ answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 })
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: '$0.31' }))?.text).toBe('$0.31')
  await after.unmount()
  expect(Math.round((store['turn:s1'] as { lastTurnUsd: number }).lastTurnUsd * 100)).toBe(31)
})

test('a window the latest reply left out is filled in from the store, in its usual place', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const store: Record<string, unknown> = {
    quotas: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-26T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-30T12:00:00Z' },
    ],
  }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's2' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  // 这次回复只带了 5 小时那项
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 26, resetsAt: '2026-10-26T12:00:00Z' }], cost: { usd: 1 } },
  }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '26%' }))?.text).toBe('26%')
  expect((await ui.find({ type: 'Text', text: '40%' }))?.text).toBe('40%')
  await ui.unmount()
  // 存储里 5 小时更新成最新值，7 天留着
  expect(store.quotas).toEqual([
    { kind: 'five_hour', percentUsed: 26, resetsAt: '2026-10-26T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-30T12:00:00Z' },
  ])
})

// 存储替身：几条存储相关的测试共用。onRead：读完某个键的一刻要做的事（模拟别的会话同时写）；
// isFailing：哪些键写不进去
function fakeStore(
  on: On,
  store: Record<string, unknown>,
  onRead?: (key: string) => void,
  isFailing?: (key: string) => boolean,
) {
  on('store.get', (_, e) => {
    const value = store[e.key]
    onRead?.(e.key)
    return { value }
  })
  on('store.set', (_, e) => {
    if (isFailing?.(e.key)) throw new Error('store write failed')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', (_, e) => {
    Reflect.deleteProperty(store, e.key)
    return { value: undefined }
  })
}

test('a session that never read a quota (an API key) does not borrow the account quotas from the store', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  fakeStore(on, { quotas: [{ kind: 'five_hour', percentUsed: 24, resetsAt: '2026-10-26T12:00:00Z' }] })
  on('session.id', () => ({ value: 'api-key' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 2 } } }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /API 等值/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '24%' })).toBeUndefined()
  await ui.unmount()
})

test('a new session starts its session delta from its own first reading, not the stored one', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 两小时前别的会话存下 24%，之后账号用到了 41%
  fakeStore(on, { quotas: [{ kind: 'five_hour', percentUsed: 24, resetsAt: '2026-10-26T12:00:00Z' }] })
  let reading: { kind: string; percentUsed: number; resetsAt: string }[] = []
  on('session.id', () => ({ value: 'fresh' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: reading, cost: { usd: 1 } } }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  reading = [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-26T12:00:00Z' }]
  await $.turn.complete({ answer: '', turnId: 't1', isAborted: false, reason: 'answer', durationMs: 1000 })
  reading = [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-26T12:00:00Z' }]
  await $.turn.complete({ answer: '', turnId: 't2', isAborted: false, reason: 'answer', durationMs: 1000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +1.0)')
  await ui.unmount()
})

test('a stored start above the current cost (after /clear) is dropped instead of showing a negative last turn', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  fakeStore(on, { turns: { s3: { usdAtLastTurn: 5, lastTurnUsd: 0.5, quotaAtStart: {}, quotaResetsAt: {}, at: 1 } } })
  on('session.id', () => ({ value: 's3' }))
  on('clock.now', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.3 } } }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$0.30' }))?.text).toBe('$0.30')
  expect(await ui.find({ type: 'Text', text: /^\$-/ })).toBeUndefined()
  await ui.unmount()
})

test('on desktop the record follows the desktop session id, so a rewind that changes the CLI id still finds it', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 回退前存下的记录按桌面会话 id 存；回退后 CLI 会话 id 换成了新的
  const store: Record<string, unknown> = {
    quotas: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-26T12:00:00Z' }],
    turns: { local_abc: { usdAtLastTurn: 8, lastTurnUsd: 1.41, quotaAtStart: { five_hour: 25 }, quotaResetsAt: { five_hour: '2026-10-26T12:00:00Z' }, at: 1 } },
  }
  fakeStore(on, store)
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? 'local_abc' : undefined }))
  on('session.id', () => ({ value: 'forked-cli-id' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 8.5 } } }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$1.41' }))?.text).toBe('$1.41')
  expect((await ui.find({ type: 'Text', text: /会话期间 \+/ }))?.text).toBe('(会话期间 +5.0)')
  await ui.unmount()

  // 下一轮从回退前的起点（$8）算，记录仍记在桌面会话 id 下
  await $.turn.complete({ answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 })
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: '$0.50' }))?.text).toBe('$0.50')
  await after.unmount()
  expect(Object.keys(store).filter(key => key.startsWith('turn:'))).toEqual(['turn:local_abc'])
})

test('a record saved under the CLI id before the switch to the desktop id is still found', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  fakeStore(on, { turns: { 'old-cli-id': { usdAtLastTurn: 2, lastTurnUsd: 0.69, quotaAtStart: {}, quotaResetsAt: {}, at: 1 } } })
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? 'local_new' : undefined }))
  on('session.id', () => ({ value: 'old-cli-id' }))
  on('clock.now', () => ({ value: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 2.2 } } }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$0.69' }))?.text).toBe('$0.69')
  await ui.unmount()
})

// 语言跟着 Claude Code 的 language 设置走
for (const [language, words] of [
  ['english', ['· feature/cart', ' · 2 uncommitted', 'API equiv.', 'Session', 'Last turn', '5h', '(+4.5 since start, resets in 2h)', 'Context']],
  ['chinese', ['· feature/cart', ' · 2 个文件未提交', 'API 等值', '本会话', '上轮', '5小时', '(会话期间 +4.5，2 小时后重置)', '上下文']],
] as const) {
  test(`with language set to ${language}, the band is in that language`, async ($, on) => {
    on('settings.read', () => ({ value: { language } }))
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    let usd = 0.1
    let fiveHour = 80
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/code/shop' }))
    on('session.repo', () => ({ value: { root: '/code/shop', remote: null, internal: false, name: null } }))
    on('process.run', (_, e) => ({
      value: e.argv[1] === 'rev-parse'
        ? { exitCode: 0, stdout: 'feature/cart\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('clock.now', () => ({ value: Date.parse('2026-10-26T10:00:00Z') }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { window: 200000, tokens: 48588, percent: 24 },
        rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-26T12:00:00Z' }],
        cost: { usd },
      },
    }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ cwd: '/code/shop', surface: 'desktop', isInteractive: true })
    usd = 0.35
    fiveHour = 84.5
    await $.turn.complete({ answer: '', turnId: 't', isAborted: false, reason: 'answer', durationMs: 1000 })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    for (const word of words) {
      expect((await ui.find({ type: 'Text', text: word }))?.text).toBe(word)
    }
    await ui.unmount()
  })
}

// test 的第二个参数现在也可以是选项，不能再从 test 的签名里取；直接取用例函数的第二个参数
type On = Parameters<TestBody>[1]
const NOW = Date.parse('2026-10-26T10:00:00Z')
const TURN = { answer: '', isAborted: false, reason: 'answer', durationMs: 1000 } as const

// 一个非仓库目录里的会话：用量由 usage() 给
function fakeSession(on: On, usage: () => unknown) {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/x' }))
  on('session.repo', () => ({ value: null }))
  on('session.id', () => ({ value: 'me' }))
  on('env.get', () => ({ value: undefined }))
  let usageCalls = 0
  on('session.usage', async () => {
    usageCalls++
    // 用例会故意给残缺、不合规的用量，看 repo-bar 能不能扛住，所以这里按引擎的类型硬转一下
    return { value: (await usage()) as SessionUsage }
  })
  return { usageCalls: () => usageCalls }
}
const usageOf = (rateLimits: unknown[], usd = 1) => ({ startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits, cost: { usd } })

test('a live reading past its reset time is not shown, and the store’s newer window fills in', async ($, on) => {
  // 空闲了 6 小时：引擎手里的 5 小时读数早过了重置时间；别的会话存下了新窗口的读数，7 天那项还有效
  const store: Record<string, unknown> = { quotas: [{ kind: 'five_hour', percentUsed: 5, resetsAt: '2026-10-26T14:00:00Z' }] }
  fakeStore(on, store)
  mock.clock(on, { now: NOW })
  fakeSession(on, () =>
    usageOf([
      { kind: 'five_hour', percentUsed: 88, resetsAt: '2026-10-26T06:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-30T12:00:00Z' },
    ]),
  )
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '88%' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '5%' }))?.text).toBe('5%')
  expect((await ui.find({ type: 'Text', text: '40%' }))?.text).toBe('40%')
  await ui.unmount()
  // 过期的读数也不写回存储
  expect(store.quotas).toEqual([
    { kind: 'five_hour', percentUsed: 5, resetsAt: '2026-10-26T14:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-30T12:00:00Z' },
  ])
})

test('with no newer reading anywhere, an expired window shows nothing', async ($, on) => {
  fakeStore(on, {})
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([{ kind: 'five_hour', percentUsed: 88, resetsAt: '2026-10-26T06:00:00Z' }]))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '88%' })).toBeUndefined()
  await ui.unmount()
})

test('an older live reading of the same window neither hides nor overwrites the newer stored one', async ($, on) => {
  // 本会话的读数是两小时前的 20%；别的会话刚读到同一窗口的 30%
  const store: Record<string, unknown> = { quotas: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-26T12:00:00Z' }] }
  fakeStore(on, store)
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([{ kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-26T12:00:00Z' }]))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '30%' }))?.text).toBe('30%')
  expect(await ui.find({ type: 'Text', text: '20%' })).toBeUndefined()
  await ui.unmount()
  expect(store.quotas).toEqual([{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-26T12:00:00Z' }])
})

test('each session saves under its own key, so another session saving at the same moment is not lost', async ($, on) => {
  const store: Record<string, unknown> = { turns: { other: { usdAtLastTurn: 1, lastTurnUsd: 0.5, quotaAtStart: {}, quotaResetsAt: {}, at: 1 } } }
  fakeStore(on, store, key => {
    // 读完的一刻，另一个会话也写了自己的记录
    if (key === 'turns') {
      store.turns = { ...(store.turns as object), racer: { usdAtLastTurn: 3, lastTurnUsd: 1, quotaAtStart: {}, quotaResetsAt: {}, at: 2 } }
    }
  })
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([], 2))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ ...TURN, turnId: 't' })

  const turns = store.turns as Record<string, unknown>
  expect(turns.other).toBeDefined()
  expect(turns.racer).toBeDefined()
  expect((store['turn:me'] as { usdAtLastTurn: number }).usdAtLastTurn).toBe(2)
})

test('a failed save of the session record is tried again on the next refresh', async ($, on) => {
  const store: Record<string, unknown> = {}
  const broken = { isOn: true }
  fakeStore(on, store, undefined, key => broken.isOn && key.startsWith('turn'))
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([], 2))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  expect(Object.keys(store).filter(key => key.startsWith('turn')).length).toBe(0)
  broken.isOn = false
  // 用量没变：同样的内容再存一次
  await $.session.measure({ ...usageOf([], 2), changed: ['cost'] } as never)
  await $.turn.complete({ ...TURN, agentId: 'sub', turnId: 't' })
  expect(Object.keys(store).filter(key => key.startsWith('turn')).length).toBe(1)
})

test('only the 20 most recent session records are kept', async ($, on) => {
  const store: Record<string, unknown> = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`turn:s${index}`, { usdAtLastTurn: 1, lastTurnUsd: null, quotaAtStart: {}, quotaResetsAt: {}, at: index + 1 }]),
  )
  fakeStore(on, store)
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([], 2))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const kept = Object.keys(store).filter(key => key.startsWith('turn:'))
  expect(kept.length).toBe(20)
  expect(kept.includes('turn:me')).toBe(true)
  expect(kept.includes('turn:s0')).toBe(false)
})

test('a failing state write after a Bash command leaves the tool result alone and the next refresh works', async ($, on) => {
  const broken = { isOn: false }
  on('state.set', (_, e: any, next: any) => {
    if (broken.isOn && e.key === 'place') throw new Error('state.set failed')
    return next(e)
  })
  let runs = 0
  on('tool.call', () => {
    runs++
    return { result: { stdout: 'ok' } }
  })
  fakeStore(on, {})
  mock.clock(on, { now: NOW })
  fakeSession(on, () => usageOf([], 2))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  broken.isOn = true
  const result = await $.tool.call({ tool: 'Bash', command: 'git checkout main' } as never)
  expect([runs, result]).toEqual([1, { result: { stdout: 'ok' } }])
  broken.isOn = false
  await $.turn.complete({ ...TURN, turnId: 't' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'x' }))?.text).toBe('x')
  await ui.unmount()
})

test('idle, the band reads usage rarely; during a turn every 15 seconds', async ($, on) => {
  fakeStore(on, {})
  const clock = mock.clock(on, { now: NOW })
  const { usageCalls } = fakeSession(on, () => usageOf([], 2))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const atStart = usageCalls()
  await clock.advance(60_000)
  expect(usageCalls() - atStart).toBe(0)

  await $.turn.start({ text: 'x', turnId: 't' })
  const atTurn = usageCalls()
  await clock.advance(30_000)
  expect(usageCalls() - atTurn).toBe(2)
  await $.turn.complete({ ...TURN, turnId: 't' })
})

test('usage the engine pushes (session.measure) shows without asking, and unchanged figures are not rewritten', async ($, on) => {
  let spendWrites = 0
  on('state.set', (_, e: any, next: any) => {
    if (e.key === 'spend') spendWrites++
    return next(e)
  })
  fakeStore(on, {})
  const clock = mock.clock(on, { now: NOW })
  const reading = { usd: 2 }
  const { usageCalls } = fakeSession(on, () => usageOf([], reading.usd))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const calls = usageCalls()
  reading.usd = 3.5
  await $.session.measure({ ...usageOf([], 3.5), changed: ['cost'] } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$3.50' }))?.text).toBe('$3.50')
  await ui.unmount()
  expect(usageCalls()).toBe(calls)

  const writes = spendWrites
  await $.session.measure({ ...usageOf([], 3.5), changed: ['context'] } as never)
  await clock.advance(5 * 60_000)
  expect(spendWrites).toBe(writes)
})

test('a usage read that never answers does not hold up the next refreshes', async ($, on) => {
  fakeStore(on, {})
  const clock = mock.clock(on, { now: NOW })
  const reading = { usd: 1, isHung: true }
  fakeSession(on, () => (reading.isHung ? new Promise(() => {}) : usageOf([], reading.usd)))
  const started = $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  await started
  reading.isHung = false
  reading.usd = 4.2
  await $.turn.complete({ ...TURN, turnId: 't' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '$4.20' }))?.text).toBe('$4.20')
  await ui.unmount()
})

// 输入框上方共用的左侧网格（五个 mod 的测试里逐字一致，repo-bar 的 grid-same.test.sh 会比对）：
// 从画出来的树里找图标列，即第一个设了数字宽度、父层设了 columnGap 的 Box；读它的宽度、收缩（shrink）、父层的间隔，
// 以及往上最近一层设了 paddingX 或 paddingLeft 的外壳：内边距是左右（x）还是只有左边（left）、多少，外边距，上下内边距，有没有边框
type GridSeen = { side: 'x' | 'left' | null; pad: unknown; marginX: unknown; padY: unknown; gap: unknown; icon: unknown; shrink: unknown; border: boolean }
type GridNode = { type?: string; props?: Record<string, unknown>; children?: unknown }
const GRID = {
  desktop: { side: 'x', pad: 0, marginX: 0, padY: null, gap: 0.75, icon: 3.3, shrink: 0, border: false },
  desktopCard: { side: 'x', pad: 0, marginX: -0.11, padY: 0, gap: 0.75, icon: 3.3, shrink: 0, border: true },
  terminal: { side: 'x', pad: 2, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: false },
  terminalCard: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: true },
  other: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: false },
  otherCard: { side: 'x', pad: 1, marginX: 0, padY: null, gap: 1, icon: 4, shrink: 0, border: true },
  // 会顶到右端的长文字另留的右端（textEnd）
  textEnd: { desktop: 1.3, terminal: 0, other: 0 },
} as const

function gridIn(node: unknown, chain: GridNode[] = []): GridSeen | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = gridIn(child, chain)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as GridNode
  const parent = chain[chain.length - 1]
  if (element.type === 'Box' && typeof element.props?.width === 'number' && parent?.props?.columnGap !== undefined) {
    const shell = [...chain].reverse().find(box => box.props?.paddingX !== undefined || box.props?.paddingLeft !== undefined)
    const props = shell?.props ?? {}
    return {
      side: props.paddingX !== undefined ? 'x' : props.paddingLeft !== undefined ? 'left' : null,
      pad: props.paddingX ?? props.paddingLeft,
      marginX: props.marginX ?? 0,
      padY: props.paddingY ?? null,
      gap: parent.props.columnGap,
      icon: element.props.width,
      shrink: element.props.flexShrink,
      border: props.borderStyle !== undefined,
    }
  }
  return gridIn(element.children, [...chain, element])
}

// 第一个满足条件的 Box 的属性；条件拿到属性和 Box 本身（要看里面的文字时用）
function boxIn(node: unknown, test: (props: Record<string, unknown>, box: GridNode) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = boxIn(child, test)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as GridNode
  if (element.type === 'Box' && test(element.props ?? {}, element)) return element.props ?? {}
  return boxIn(element.children, test)
}

async function drawnOn($: any, band: Record<string, unknown>, surface: string): Promise<unknown> {
  const ui = await $.ui.mount({ ...band, surface })
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}

async function gridOn($: any, band: Record<string, unknown>, surface: string): Promise<GridSeen | null> {
  return gridIn(await drawnOn($, band, surface))
}

test('the left grid lines up with the prompt box on desktop and is unchanged elsewhere; only a left padding, as before', async ($, on) => {
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/code/shop' }))
  on('session.repo', () => ({ value: { root: '/code/shop', remote: null, internal: false, name: null } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/code/shop', surface: 'desktop', isInteractive: true })

  expect(await gridOn($, BAND, 'desktop')).toEqual({ ...GRID.desktop, side: 'left' })
  expect(await gridOn($, BAND, 'terminal')).toEqual({ ...GRID.terminal, side: 'left' })
  expect(await gridOn($, BAND, 'vscode')).toEqual({ ...GRID.other, side: 'left' })
  expect(await gridOn($, BAND, 'mobile')).toEqual({ ...GRID.other, side: 'left' })
  // 窄宽度：终端以外，外层能收缩，分支那段和每项数据放不下时整段换行；终端照旧
  const desktop = await drawnOn($, BAND, 'desktop')
  expect(boxIn(desktop, props => props.flexWrap === 'wrap' && props.columnGap === 2)?.minWidth).toBe(0)
  expect(boxIn(desktop, props => props.key === 'place')).toEqual({ key: 'place', columnGap: 1, flexWrap: 'wrap', minWidth: 0 })
  const terminal = await drawnOn($, BAND, 'terminal')
  expect(boxIn(terminal, props => props.key === 'place')).toEqual({ key: 'place', columnGap: 1 })
  expect(boxIn(terminal, props => props.flexWrap === 'wrap' && props.columnGap === 2)?.minWidth).toBe(undefined)
  // 折行的数据：桌面右端留 textEnd，别处照旧不留
  const wrapEnd = async (surface: string) => boxIn(await drawnOn($, BAND, surface), props => props.flexWrap === 'wrap')?.paddingRight
  expect(await wrapEnd('desktop')).toBe(GRID.textEnd.desktop)
  expect(await wrapEnd('terminal')).toBe(GRID.textEnd.terminal)
  expect(await wrapEnd('vscode')).toBe(GRID.textEnd.other)
})
