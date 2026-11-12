#!/bin/zsh -f
# 用真的 shell 跑 hooks/scripts.ts 里的几段脚本（plugin test 的测试里起不了子进程，只能在这里跑）。
# 做法：osascript 的 JavaScript 读出 scripts.ts 里的常量写成文件，在临时目录里造好文件、仓库、符号链接，
# 再按 mod 调用它们的方式（同样的 shell、同样的参数）跑一遍，对照输出。
# 用法：zsh tests/scripts.zsh；全部通过退出码为 0
emulate -L zsh
setopt no_unset pipe_fail

here=${0:A:h}
root=${here:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/danger-guard-scripts.XXXXXX")
tmp=${tmp:A}
trap 'command rm -r -f -- "$tmp"' EXIT

osascript -l JavaScript - "$root/hooks/scripts.ts" "$tmp/script" <<'JS' >/dev/null
ObjC.import('Foundation')
function run(argv) {
  const source = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js
  const scripts = eval(`(() => { ${source.replace(/^export /gm, '')}; return { EXPAND_PRELUDE, INSPECT_SCRIPT, OWNER_SCRIPT, WHERE_SCRIPT } })()`)
  const write = (name, text) => $(text).writeToFileAtomicallyEncodingError(`${argv[1]}.${name}`, true, $.NSUTF8StringEncoding, null)
  write('prelude.zsh', scripts.EXPAND_PRELUDE.zsh)
  write('prelude.bash', scripts.EXPAND_PRELUDE.bash)
  write('inspect', scripts.INSPECT_SCRIPT)
  write('owner', scripts.OWNER_SCRIPT)
  write('where', scripts.WHERE_SCRIPT)
  return ''
}
JS

fails=0
check() {
  if [[ "$2" == "$3" ]]; then
    print -r -- "ok    $1"
  else
    print -r -- "FAIL  $1"
    print -r -- "      want: $2"
    print -r -- "      got:  $3"
    (( fails += 1 ))
  fi
}

# 和 deletion.ts 一样拼展开脚本：前置设置 + 每一级 cd + printf 每个词后跟 NUL；输出里的 NUL 换成 |，去掉第一个（$PWD）。
# （zsh 里 argv 是位置参数的别名，所以这里的命令数组叫 cmd）
expand_with() {
  local shell=$1 dir=$2 steps=$3 args=$4 prelude
  prelude=$(<"$tmp/script.prelude.${shell:t}")
  local -a cmd
  if [[ ${shell:t} == bash ]]; then cmd=($shell --noprofile --norc -c); else cmd=($shell -f -c); fi
  (cd -- "$dir" && BASH_ENV= $cmd "${prelude}${steps}printf '%s\\0' \"\$PWD\" ${args}" expand) | tr '\0' '|' | sed 's/^[^|]*|//'
}

# 和 deletion.ts 一样跑检查脚本；每条记录 7 个字段，这里只取 类型、git 状态、原写法、链接目标
inspect_with() {
  local shell=$1 dir=$2 mode=$3
  shift 3
  local -a cmd
  if [[ ${shell:t} == bash ]]; then cmd=($shell --noprofile --norc -c); else cmd=($shell -f -c); fi
  (cd -- "$dir" && BASH_ENV= $cmd "$(<$tmp/script.inspect)" inspect $mode "$@") | tr '\0' '\n' | paste - - - - - - - | awk -F'\t' '{ printf "%s %s %s %s;", $1, $4, $6, $7 }'
}

owner_of() {
  /bin/sh -c "$(<$tmp/script.owner)" owner "$1" | tr '\n' '|'
  print -rn -- "exit=${pipestatus[1]}"
}

# —— 1. 通配符按 zsh 展开：** 递归匹配；没匹配到时展开成空，而不是原样留下
mkdir -p $tmp/glob/a/node_modules $tmp/glob/b/c/node_modules $tmp/glob/.hidden
mkdir -p $tmp/cdpath/elsewhere
check 'zsh: **/node_modules matches every level' '-rf|a/node_modules|b/c/node_modules|' "$(expand_with /bin/zsh $tmp/glob '' '-rf **/node_modules')"
check 'bash 3.2 would only see one level (why the shell matters)' '-rf|a/node_modules|' "$(expand_with /bin/bash $tmp/glob '' '-rf **/node_modules')"
check 'zsh: a glob that matches nothing expands to nothing' '-rf|' "$(expand_with /bin/zsh $tmp/glob '' '-rf **/nothing-here')"
check 'zsh: quotes, braces and ~ expand as in the shell' "-r|a b|x1|x2|$HOME/q|" "$(expand_with /bin/zsh $tmp/glob '' '-r "a b" x{1,2} ~/q')"
check 'zsh: cd steps run before expanding' '-rf|c/node_modules|' "$(expand_with /bin/zsh $tmp/glob 'cd -- b || exit 3; ' '-rf */node_modules')"
check 'zsh: CDPATH is ignored, so cd cannot land somewhere else' '' "$(CDPATH=$tmp/cdpath expand_with /bin/zsh $tmp/glob 'cd -- elsewhere || exit 3; ' '-rf *' 2>/dev/null)"

# —— 2. 检查脚本：git 状态，.git 本身、.git 里的文件、锁文件，带斜杠的符号链接
repo=$tmp/repo
mkdir -p $repo $tmp/outside
git -C $repo init -q
print clean > $repo/clean.txt
print dirty > $repo/dirty.txt
git -C $repo add clean.txt dirty.txt
git -C $repo -c user.name=t -c user.email=t@t commit -qm init
print changed >> $repo/dirty.txt
print new > $repo/new.txt
: > $repo/.git/index.lock
ln -s $tmp/outside $repo/link
for shell in /bin/zsh /bin/bash; do
  check "${shell:t}: git states inside a repo" \
    "file clean clean.txt ;file dirty dirty.txt ;file none new.txt ;dir history .git ;file lock .git/index.lock ;file internal .git/HEAD ;link none link/ $tmp/outside;missing none missing.txt ;" \
    "$(inspect_with $shell $repo full clean.txt dirty.txt new.txt .git .git/index.lock .git/HEAD link/ missing.txt)"
done

# —— 3. 系统关键目录：不分大小写，借符号链接绕过去也认得出；里面的东西不算
home=$tmp/home
mkdir -p $home/Library/Caches $home/Documents $home/Desktop
ln -s /Applications $tmp/apps
for shell in /bin/zsh /bin/bash; do
  check "${shell:t}: home and its key folders are critical, things inside are not" \
    "critical none $home ;critical none $home/Library ;critical none ${home:h}/HOME/documents ;critical none $home/Desktop ;dir none $home/Library/Caches ;" \
    "$(HOME=$home inspect_with $shell $tmp quick $home $home/Library ${home:h}/HOME/documents $home/Desktop $home/Library/Caches)"
  # apps/. 经符号链接到了 /Applications 本身；apps/ 只是链接（只处理链接本身，见第 12 条）
  check "${shell:t}: system folders are critical, also through a symlink" \
    'critical none / ;critical none /usr/local ;critical none /System/Library ;critical none /Library ;critical none apps/. ;link none apps/ /Applications;' \
    "$(inspect_with $shell $tmp quick / /usr/local /System/Library /Library apps/. apps/)"
done
[[ -d /opt/homebrew ]] && check 'homebrew is critical' 'critical none /opt/homebrew ;' "$(inspect_with /bin/zsh $tmp quick /opt/homebrew)"

# —— 4. owner 脚本：文件本身是符号链接、上级目录还不存在、坏掉的链接、绕圈
proj=$tmp/proj
mkdir -p $proj
git -C $proj init -q
ln -s $tmp/outside/t.txt $proj/link.txt
ln -s $tmp/outside $proj/extdir
ln -s $tmp/nowhere $proj/dangling
ln -s $proj/loop-b $proj/loop-a
ln -s $proj/loop-a $proj/loop-b
check 'owner: the file itself is a symlink to outside' "$tmp/outside/t.txt|$tmp/outside|exit=0" "$(owner_of $proj/link.txt)"
check 'owner: a new file under a symlinked folder that does not exist yet' "$tmp/outside/newsub/x.txt|$tmp/outside|exit=0" "$(owner_of $proj/extdir/newsub/x.txt)"
check 'owner: a new file in the project belongs to the repo' "$proj/src/new.ts|$proj|exit=0" "$(owner_of $proj/src/new.ts)"
check 'owner: a dangling folder link cannot be worked out' 'exit=5' "$(owner_of $proj/dangling/x.txt)"
check 'owner: a symlink loop cannot be worked out' 'exit=4' "$(owner_of $proj/loop-a)"

# —— 5. where 脚本：依次 cd，给出真实路径
mkdir -p $repo/sub
check 'where: cd steps resolve to the real folder' "$repo/sub" "$(CDPATH=$tmp /bin/sh -c "$(<$tmp/script.where)" where $repo sub)"

print
if (( fails > 0 )); then
  print -r -- "$fails failed"
  exit 1
fi
print -r -- 'all passed'
