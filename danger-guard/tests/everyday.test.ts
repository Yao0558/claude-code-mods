import { expect, test } from 'claude-code/testing'

// 平时常用、没有危险的写法：不能弹卡片，照常交给引擎判断
const EVERYDAY = [
  'C="/Users/me/Library/Application Support/Claude/claude-code/2.1.308/x/claude.app/Contents/MacOS/claude"; "$C" plugin test ~/.claude/mods/repo-bar',
  'S=/private/tmp/x; mkdir -p $S && cd $S && echo ok',
  "C=/opt/x/claude; cd ~/.claude/mods && for m in *; do printf '%-14s ' $m; \"$C\" plugin test $m 2>&1 | grep -E '^ [0-9]+ (pass|fail)' | tr '\\n' ' '; echo; done",
  "python3 -I - <<'EOF'\nimport pathlib\nprint(pathlib.Path('.').resolve())\nEOF",
  'ts=$(date +%H%M%S); echo $ts',
  "WID=$(swift -e 'print(1)' 2>/dev/null); echo \"wid=$WID\"; screencapture -x -o -l $WID /private/tmp/a.png && echo ok",
  'npm test 2>&1 | tail -5',
  'git status && git diff --stat',
  "find . -name '*.ts' | xargs wc -l | sort -n",
  'for f in a.json b.json; do echo "$f: $(cat $f)"; done | cut -c1-200',
  'diff <(sed -n 1,10p a.ts) <(sed -n 1,10p b.ts) && echo same',
  'ls -la ~/.claude/task-progress | head -15',
  'open "claude://code/continue?session=local_abc"; sleep 4; echo done',
  "grep -rn 'rm -rf' hooks/ | head",
]

test('everyday commands keep the engine verdict', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  for (const command of EVERYDAY) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })
    expect([command, verdict.decision]).toEqual([command, 'allow'])
  }
})

// 认不出变量是什么的，仍然要问：没赋过值、赋的值里还有变量、赋过两个不同的值、值本身就是危险命令
const UNKNOWN = [
  '"$C" -rf build',
  'C=$(which rm); "$C" -rf build',
  'C=ls; (C=rm); "$C" -rf build',
  'R=rm; "$R" -rf build',
]

test('a variable used as the command name still asks when its value is unknown or dangerous', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  for (const command of UNKNOWN) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })
    expect([command, verdict.decision]).toEqual([command, 'ask'])
  }
})
