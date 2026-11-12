# run-status

[English](README.md) · 简体中文

Claude 跑的测试、构建、类型检查过没过，直接显示在输入框下方的状态行里，不用去翻工具输出。

```text
… 测试中：npm test
✓ 测试通过（12s）：npm test
✗ 检查失败（4s）：tsc --noEmit
… 测试中（后台）：pytest
⏱ 构建超时（120s），已转到后台：cargo build
```

## 要点

- 认得出常见的测试、构建和代码检查：`npm`/`pnpm`/`yarn`/`bun` 的 `test`、`lint`、`build` 这类脚本，`pytest`、`jest`、`vitest`、`go test`、`cargo`、`make`、`tsc`、`eslint` 等。
- 只在结果确实属于这次检查时才报：像 `npm test | tail` 这样，退出码来自别的命令的，不报。
- 转到后台的检查会跟到结束；收到完成通知之前，不会报“通过”。
- 命令里像密钥的部分先打码再显示。
- 最后一条结果出来 10 分钟后，状态行清空。

桌面 App 里，状态行在输入框下方、模型名左边，前面带 mod 的名字；终端里是输入框下方 mod 自己的那一行。

## 安装

```
/plugin install run-status --marketplace Yao0558/claude-code-mods
```

版本要求、其它装法、界面语言、改代码自己用和测试，见[仓库首页](../README.zh-CN.md)。

## 详细规则

<details>
<summary>哪些算检查</summary>

- 包管理器脚本：`npm`、`pnpm`、`yarn`、`bun` 里名为 `test`、`test:unit`、`lint`、`typecheck`、`check`、`format:check`、`build:prod`、`compile` 这类的脚本，包括 workspace 和 `--filter` 的写法。
- 测试运行器：`vitest`、`jest`、`pytest`/`py.test`、`phpunit`、`rspec`、`mocha`、`ava`、`unittest`、`nose2`。
- 工具子命令：`go test|build|vet`、`cargo test|nextest|build|check|clippy`（以及 `fmt --check`）、`swift test|build`、`dotnet test|build`、`mix test|compile`、`deno test|check|lint|task`。
- `make`/`gmake` 的目标（`test`、`check` 算测试，`lint`、`typecheck` 算检查，不写目标、`build`、`all` 算构建）、`gradle`/`gradlew` 的任务、`mvn`/`mvnw` 的目标、`xcodebuild` 的动作。
- 代码检查和类型检查：`tsc`、`eslint`、`mypy`、`pyright`、`ruff`、`biome`、`swiftlint`，以及检查模式下的 `prettier`/`black`。只改写文件的（`prettier --write`）不报。
- 外面套了一层的也认得出：`npx`、`bunx`、`pnpx`、`uvx`、`<包管理器> exec`/`dlx`、`uv`/`poetry`/`pipenv`/`pdm`/`hatch run`、`python -m`，以及 `sudo`、`env`、`time`、`nice`、`timeout`、`xargs` 这类前缀。只打印版本、帮助的（`--version`、`--help`）不算。

</details>

<details>
<summary>什么时候报、怎么显示</summary>

- 检查必须是整条命令的最后一段，前面用 `&&`、`;` 或换行连着（`cd app && npm test`）。`npm test | tail`、`npm test || true`、`npm test; echo done` 的退出码来自别的命令，不报。
- 转到后台的检查（一开始就放到后台、超时被转过去、你按了 Ctrl+B）先显示“（后台）”或“超时，已转到后台”，等 Claude Code 发来完成通知再换成真实结果。被停掉的不留结果，2 小时没等到通知就放弃；同一条检查重跑时以新的为准。子代理放到后台的不跟。
- 你拒绝或打断的，不留结果。
- 并行跑的几条检查分开跟踪，其余的显示为 `（另 N 项）`。失败会一直留着，直到同一条检查（`cd … &&` 后面那段）再跑一次，或者被它结束之后才开始的同类检查取代；并行的另一条通过了，不会把它盖掉。
- 用时只算执行本身，不含等你点“允许”的时间（Claude Code 报了执行时长时；通常都会报）；后台跑的从调用开始算到收到通知。
- 只显示检查那一段：开头的 `cd … &&`、`VAR=value` 不显示。打码的包括：`--token=…`、`--api-key` 这类名字后面的值、口令、带 `user:pass@` 的 URL、常见服务的令牌前缀、很长的随机字符串。

</details>

## 限制

- 只看 Bash 工具跑的命令。别的工具跑的、你在另一个终端里自己跑的，都不管。
- 认不出的工具不报，也不去猜。
- Windows 的 `npm.cmd`、`gradlew.bat` 这类命令名认不出来。
- 状态行里的命令最多显示 40 个字符。

## 许可

[MIT](LICENSE) © Lu Shiyao
