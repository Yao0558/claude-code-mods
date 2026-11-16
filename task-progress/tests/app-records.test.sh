#!/bin/bash
# 桌面 App 的会话记录还是 task-progress 认得的样子。
# 会话刚开时还没有显示端（别的会话开出来、你还没点开的就是这样），task-progress 靠这份记录认出“这是桌面 App 的会话”，
# 才写进度（2026-11-15 加）。记录不是对外接口：App 升级改了目录或字段名，这类会话会悄悄不出进度，而 progress.test.tsx
# 用的是假环境，照样通过。所以这里查本机真实的记录：用 register.tsx 里同一个目录、同一条 grep，按会话 id 找回记录，
# 再核对 sessionId、cliSessionId 两个字段。本机没装桌面 App（目录不存在）或还没有会话记录时跳过，算过。
# check.sh 会用 /bin/bash 跑本文件，退出码 0 算过。兼容 macOS 自带的 /bin/bash 3.2；读 JSON 用系统自带的 osascript。
# 自测时可以用 TP_APP_SESSIONS 指向别的目录。
set -u

mod="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 目录取 register.tsx 里的常量，两边不会各写各的
rel=$(sed -n "s/^const APP_SESSIONS = '\(.*\)'$/\1/p" "$mod/hooks/register.tsx")
[ -n "$rel" ] || fail "register.tsx 里找不到 APP_SESSIONS 常量（改了写法就同步改这里）"
dir="${TP_APP_SESSIONS:-$HOME/$rel}"

if [ ! -d "$dir" ]; then
  echo "跳过：没有 $dir（本机没装桌面 App）"
  exit 0
fi

# 最近改过的 20 份记录（App 的记录在 <账号>/<组织>/ 下面）
records=$(find "$dir" -name 'local_*.json' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -20)
if [ -z "$records" ]; then
  echo "跳过：$dir 下还没有会话记录"
  exit 0
fi

# 用系统自带的 JavaScript（osascript）按 JSON 读字段：plutil 读不了带 \u0000 这类转义的记录；读不了或不是字符串就输出空
field() {
  osascript -l JavaScript -e 'ObjC.import("Foundation")
function run(argv) {
  try {
    const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js
    const value = JSON.parse(text)[argv[1]]
    return typeof value === "string" ? value : ""
  } catch (e) {
    return ""
  }
}' "$1" "$2" 2>/dev/null
}

checked=0
while IFS= read -r file; do
  sid=$(field "$file" sessionId)
  [ -n "$sid" ] || fail "$file 没有 sessionId 字段：App 改了会话记录的格式，task-progress 的 findIdentity 要跟着改"
  [ "$(basename "$file" .json)" = "$sid" ] || fail "$file 的 sessionId 是 $sid，和文件名对不上"
  echo "$sid" | grep -Eq '^local_[A-Za-z0-9-]{1,64}$' || fail "$file 的 sessionId 不是 local_ 开头：register.tsx 的 LOCAL_ID 要跟着改"
  cli=$(field "$file" cliSessionId)
  # 从没跑起来过的会话没有 cliSessionId，不算错
  [ -n "$cli" ] || continue
  # 和 findIdentity 同一条命令：按会话 id 搜得到这份记录
  grep -rl --include='local_*.json' "$cli" "$dir" 2>/dev/null | grep -qxF "$file" ||
    fail "用 grep 按 cliSessionId $cli 找不到 $file：findIdentity 的查法要跟着改"
  checked=$((checked + 1))
done <<EOF
$records
EOF

[ "$checked" -gt 0 ] || fail "最近 20 份会话记录都没有 cliSessionId 字段：App 可能改了字段名，task-progress 的 findIdentity 要跟着改"
echo "通过：最近 $checked 份带会话 id 的记录格式没变"
