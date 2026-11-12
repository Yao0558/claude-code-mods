#!/bin/bash
# 输入框上方共用的左侧网格要在五个 mod 里逐字一致：各 mod 的 hooks/register.tsx 里从“输入框上方几个 mod 共用的左侧网格”
# 到 edgesOf 结束那一段，以及各 mod 测试里从“输入框上方共用的左侧网格（五个 mod 的测试里逐字一致”到 gridOn 结束那一段。
# 改了一份漏了别的、或哪份的这一段被删掉，这里就不过。仓库里没有的 mod（如公开仓库只发了其中几个、或只装了 repo-bar）跳过不比；
# 在场的不到两个就没得比，直接算过。check.sh 会用 /bin/bash 跑本文件，退出码 0 算过。兼容 macOS 自带的 /bin/bash 3.2。
set -u

mods="$(cd "$(dirname "$0")/../.." && pwd)"
names="repo-bar task-progress done-alert retro-watch upgrade-check"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 从含 $2 的那行起，截到第 $3 个只有“}”的行为止
cut_block() {
  awk -v start="$2" -v ends="$3" 'index($0, start) { on = 1 } on { print } on && $0 == "}" { n++; if (n == ends) exit }' "$1"
}

compare() {
  local label="$1" marker="$2" ends="$3" pattern="$4" first="" first_sum="" name file sum count=0
  for name in $names; do
    [ -d "$mods/$name" ] || continue
    count=$((count + 1))
    # 每个 mod 正好一个文件带这一段
    file=$(find "$mods/$name" -path "$mods/$name/.claude-plugin" -prune -o -path "$mods/$name/$pattern" -exec grep -l -F -- "$marker" {} + 2>/dev/null)
    [ -n "$file" ] || fail "$name：$pattern 里没有$label"
    [ "$(printf '%s\n' "$file" | wc -l | tr -d ' ')" = 1 ] || fail "$name：不止一个文件带$label：$file"
    [ -n "$(cut_block "$file" "$marker" "$ends")" ] || fail "$name：$file 里没有$label"
    sum=$(cut_block "$file" "$marker" "$ends" | shasum | cut -c1-40)
    if [ -z "$first" ]; then
      first="$name"
      first_sum="$sum"
    elif [ "$sum" != "$first_sum" ]; then
      fail "$label：$name 和 $first 不一致"
    fi
  done
  if [ "$count" -lt 2 ]; then
    echo "ok：$label 只有 $count 份，不用比"
  else
    echo "ok：$label $count 份一致"
  fi
}

compare "网格块" "// 输入框上方几个 mod 共用的左侧网格" 2 "hooks/register.tsx"
compare "测试辅助段" "// 输入框上方共用的左侧网格（五个 mod 的测试里逐字一致" 4 "tests/*.test.ts*"
