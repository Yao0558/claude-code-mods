import { expect, test } from 'claude-code/testing'

const ASKS = [
  'rm -rf node_modules',
  'rm -fr build',
  'cd app && rm -r -f dist',
  'git push --force origin main',
  'git push -f',
  'git push origin +main',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git branch -D feature/x',
  'git checkout -- .',
  'psql -c "DROP TABLE users"',
  'find . -name "*.log" -delete',
  'terraform destroy',
  'npm publish',
]

const PASSES = [
  'ls -la',
  'rm build.log',
  'git push origin main',
  'git push --set-upstream origin feature',
  'git reset HEAD file.ts',
  'git checkout -b feature',
  'git checkout main',
  'npm test',
  'find . -name "*.ts"',
]

test('dangerous commands ask a person, ordinary ones keep the engine verdict', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  for (const command of ASKS) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })
    expect([command, verdict.decision]).toEqual([command, 'ask'])
  }
  for (const command of PASSES) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })
    expect([command, verdict.decision]).toEqual([command, 'allow'])
  }
})

test('secret files ask, ordinary files pass, an engine deny stands', async ($, on) => {
  on('tool.check', (_, e) =>
    (e.input as { file_path?: string }).file_path === '/x/blocked.ts' ? { decision: 'deny' } : { decision: 'allow' },
  )

  for (const file_path of ['/app/.env', '/app/.env.local', '/k/id_rsa', '/c/server.pem']) {
    expect((await $.tool.check({ tool: 'Edit', input: { file_path } })).decision).toBe('ask')
  }
  for (const file_path of ['/app/src/env.ts', '/app/.envrc.md', '/app/README.md', '/app/.env.example', '/app/.env.sample']) {
    expect((await $.tool.check({ tool: 'Write', input: { file_path } })).decision).toBe('allow')
  }
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: '/x/blocked.ts' } })).decision).toBe('deny')
})
