// 交给 shell 跑的几段脚本。单独放一个文件，只写常量（不带类型），
// tests/scripts.zsh 用 osascript 的 JavaScript 读出它们，在临时目录里真的跑一遍

// 展开 rm 的参数之前先设好：没匹配到的通配符展开成空（不报错，也不原样留下），
// 不用 CDPATH（不然 cd 会去到别处还打印路径）。按 Bash 工具用的那个 shell 选
export const EXPAND_PRELUDE = {
  zsh: 'setopt nullglob; unset CDPATH; ',
  bash: 'shopt -s nullglob; unset CDPATH; ',
}

// 第一个参数是模式：full 统计文件数、大小和 git 状态；quick 只判断是不是系统关键目录。
// 每个目标输出 7 个字段：类型、文件数、KB、git 状态、绝对路径、原写法、符号链接指向哪里，每个字段后面跟一个 NUL。
// 用 NUL 分隔，文件名里有制表符或换行也不会错位（不然卡片显示的和真正删的可能不是同一个）。
// 路径按真实位置算（cd -P / pwd -P）：借符号链接绕到系统目录也认得出来；系统关键目录不分大小写先判出来，不去统计里面的文件。
// git 状态：repo 整个仓库；history 是 .git 本身；internal 是 .git 里面的文件；lock 是 .git 里的 *.lock（git 中断后留下的锁）
export const INSPECT_SCRIPT = `
mode=$1; shift
emit() { printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' "$@"; }
# 是不是正好在某个目录下一级（/Users/某人、/Volumes/某个盘）；zsh 和 bash 的 case 写法一样
top() { case "$1" in "$2"/*/*) return 1 ;; "$2"/?*) return 0 ;; esac; return 1; }
home_lc=$(printf '%s' "$HOME" | tr '[:upper:]' '[:lower:]')
for given in "$@"; do
  p=$given; q=\${p%/}; [ -z "$q" ] && q=/; target=
  if [ -L "$q" ]; then t=link; p=$q; target=$(readlink -- "$q"); elif [ -d "$p" ]; then t=dir; elif [ -e "$p" ]; then t=file; else t=missing; fi
  if [ "$t" = missing ]; then emit missing 0 0 none "$p" "$given" ""; continue; fi
  parent=$(cd -P -- "$(dirname -- "$p")" && pwd -P) || exit 4
  if [ "$t" = dir ]; then abs=$(cd -P -- "$p" && pwd -P) || exit 4; else abs=$(printf '%s/%s' "$parent" "$(basename -- "$p")"); fi
  # 经符号链接到根目录时 pwd 可能给出 //Applications：多个斜杠合成一个
  abs=$(printf '%s' "$abs" | tr -s /)
  [ "$abs" != / ] && abs=\${abs%/}
  lc=$(printf '%s' "$abs" | tr '[:upper:]' '[:lower:]')
  case "$lc" in
    /|"$home_lc"|"$home_lc/library"|"$home_lc/documents"|"$home_lc/desktop"|/users|/system|/system/library|/system/volumes|/system/volumes/data|/applications|/library|/volumes|/private|/private/var|/private/etc|/private/tmp|/usr|/usr/local|/opt|/opt/homebrew|/bin|/sbin|/etc|/var|/tmp|/cores)
      emit critical 0 0 none "$abs" "$given" "$target"; continue ;;
  esac
  if top "$lc" /users || top "$lc" /volumes || top "$lc" /system/volumes/data/users || top "$lc" /system/volumes/data; then emit critical 0 0 none "$abs" "$given" "$target"; continue; fi
  if [ "$mode" = quick ]; then emit "$t" 0 0 none "$abs" "$given" "$target"; continue; fi
  n=1
  [ "$t" = dir ] && n=$(find "$abs" -type f 2>/dev/null | head -n 100001 | wc -l | tr -d ' ')
  s=$(du -sk "$abs" 2>/dev/null | cut -f1)
  g=none
  gd=$parent; [ "$t" = dir ] && gd=$abs
  case "$lc" in
    */.git) g=history ;;
    */.git/*.lock) if [ "$t" = file ]; then g=lock; else g=internal; fi ;;
    */.git/*) g=internal ;;
    *)
      if [ "$t" = dir ] && [ -e "$abs/.git" ]; then
        g=repo
      elif [ "$(git -C "$gd" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
        tracked=$(git -C "$gd" ls-files -- "$abs" 2>/dev/null | head -1)
        dirty=$(git -C "$gd" status --porcelain --ignored --untracked-files=all -- "$abs" 2>/dev/null | head -1)
        if [ -n "$tracked" ] && [ -z "$dirty" ]; then g=clean; elif [ -n "$tracked" ]; then g=dirty; fi
      fi ;;
  esac
  emit "$t" "$n" "\${s:-0}" "$g" "$abs" "$given" "$target"
done
`

// 输出两行：文件的真实路径（文件本身和上级目录的符号链接都解开）、它属于哪个目录（所在 git 仓库的根，不在仓库里就是上级目录）。
// 新文件和新目录往上找到存在的那一层再解开；中间有坏掉的符号链接、链接绕圈、目录进不去，就以非零退出，由调用方当成“算不出来”
export const OWNER_SCRIPT = `unset CDPATH
p=$1; i=0
while [ -L "$p" ]; do
  [ "$i" -ge 40 ] && exit 4
  t=$(readlink -- "$p") || exit 4
  case "$t" in /*) p=$t ;; *) p=$(dirname -- "$p")/$t ;; esac
  i=$((i + 1))
done
d=$(dirname -- "$p"); rest=$(basename -- "$p")
while [ ! -d "$d" ]; do
  [ -L "$d" ] && exit 5
  rest=$(basename -- "$d")/$rest; d=$(dirname -- "$d")
done
real=$(cd -P -- "$d" && pwd -P) || exit 6
real=\${real%/}
printf '%s/%s\\n' "$real" "$rest"
git -C "\${real:-/}" rev-parse --show-toplevel 2>/dev/null || printf '%s\\n' "\${real:-/}"`

// 命令会在哪个目录跑：依次 cd 进每一级（~ 已经换成主目录）。目录作为参数传进去，不拼进脚本，里面有什么字符都不会被当成命令执行
export const WHERE_SCRIPT = 'unset CDPATH; for d in "$@"; do cd -P -- "$d" || exit 3; done; pwd -P'
