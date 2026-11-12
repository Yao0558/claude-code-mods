# Claude Code mods

[English](README.md) · 简体中文

几个 Claude Code mod，补上 Claude Code 界面里没有的信息和保护。每个单独安装，界面中英双语。

| mod | 做什么 |
| --- | --- |
| [danger-guard](danger-guard/README.zh-CN.md) | 危险操作前在卡片上问你：删除先列清单、默认移到废纸篓；git 操作先算出会丢什么；改项目外的文件先确认。 |
| [done-alert](done-alert/README.zh-CN.md) | 长任务跑完，在输入框上方留一条提示（完成绿色、出错红色），你在跟前时响一声。 |
| [repo-bar](repo-bar/README.zh-CN.md) | 输入框上方一行：仓库、分支、未提交的文件数，以及本会话花费、套餐额度和上下文占用。 |
| [run-status](run-status/README.zh-CN.md) | Claude 跑的测试、构建、类型检查过没过，显示在输入框下方的状态行。 |
| [task-progress](task-progress/README.zh-CN.md) | 列出所有会话正在跑的任务：进度条、百分比、剩余时间，点名字跳到那个会话。 |

## 要求

- 支持 mod 的 Claude Code，在 2.1.321 上开发和测试。
- 只在 macOS 上测过。有些功能只在 macOS 上有，见各 mod 的“限制”。

## 安装

在终端里的 Claude Code 输入（`repo-bar` 换成要装的 mod）：

```
/plugin install repo-bar --marketplace Yao0558/claude-code-mods
```

也可以在 shell 里运行 `claude plugin install repo-bar --marketplace Yao0558/claude-code-mods`。第一次会问要不要添加这个插件市场，回答 `y`；范围选第一项（用户），之后开的每个会话都会加载它，桌面 App 的会话也一样。

桌面 App 的 Code 页里不能输入 `/plugin`：点输入框旁的 +，选 Plugins，用 Add marketplace 填 `Yao0558/claude-code-mods`，再 Add plugin。

## 界面语言

界面文字有简体中文和英文两套，按这个顺序决定：

1. 环境变量 `CLAUDE_MODS_LANG`：写 `zh` 或 `en`，这里所有 mod 共用。
2. Claude Code 的 `language` 设置：提到中文就用中文，写了别的语言就用英文。
3. macOS 上的桌面会话：Claude 桌面 App 自己的界面语言。
4. 系统语言。
5. 都没有就用英文。

要强制指定一种，在 `~/.claude/settings.json` 的 `env` 里加 `"CLAUDE_MODS_LANG": "zh"`，新开的会话起生效。在桌面 App 里切换界面语言，最多约一分钟生效，不用重开会话；已经显示出来的卡片、提示、状态行，要等它下次刷新才换语言。

## 改代码自己用

克隆这个仓库，在 `~/.claude/settings.json` 的 `env` 里把 `CLAUDE_CODE_PLUGIN_DIRS` 指向要用的 mod 目录（多个目录用 `:` 分隔）；再加 `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"`，改了代码后正在运行的桌面会话会自动重载。

测试：`claude plugin test <mod 目录>`。danger-guard 实际执行的 shell 脚本另用真文件测：`zsh danger-guard/tests/scripts.zsh`（只能在 macOS 上跑）。

代码注释是中文。

## 许可

[MIT](LICENSE) © Lu Shiyao，每个 mod 目录里也各有一份。
