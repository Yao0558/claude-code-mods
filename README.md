# Claude Code mods

English · [简体中文](README.zh-CN.md)

A few Claude Code mods that add information and safeguards the Claude Code interface doesn't have. Each one installs on its own, and each speaks English and Simplified Chinese.

| Mod | What it does |
| --- | --- |
| [danger-guard](danger-guard/README.md) | Asks on a card before risky actions: lists what a delete would remove and moves it to the Trash by default, shows what a git command would lose, and asks before editing files outside the project. |
| [done-alert](done-alert/README.md) | When a long task ends, leaves a notice above the prompt (green when done, red on an error) and rings when you are there to hear it. |
| [repo-bar](repo-bar/README.md) | One row above the prompt: repo, branch and uncommitted files, plus session cost, plan quotas and context usage. |
| [run-status](run-status/README.md) | Shows in the status line under the prompt whether the tests, builds and type checks Claude ran passed. |
| [task-progress](task-progress/README.md) | Lists every session's running task with a progress bar, percentage and time left; click a name to jump to that session. |

## Requirements

- Claude Code with mod support, built and tested on 2.1.321.
- Tested on macOS only. Some features exist only on macOS; see each mod's Limits.

## Install

In Claude Code in a terminal, type (replace `repo-bar` with the mod you want):

```
/plugin install repo-bar --marketplace Yao0558/claude-code-mods
```

Or run `claude plugin install repo-bar --marketplace Yao0558/claude-code-mods` in a shell. The first time, it asks whether to add the marketplace: answer `y`. Pick the first scope (user), and every session started after that loads the mod, desktop app sessions included.

`/plugin` doesn't run in the desktop app's Code tab. There, click + next to the prompt box, choose Plugins, use Add marketplace with `Yao0558/claude-code-mods`, then Add plugin.

## Interface language

The interface text comes in English and Simplified Chinese, chosen in this order:

1. The `CLAUDE_MODS_LANG` environment variable: `en` or `zh`, shared by all the mods here.
2. Claude Code's `language` setting: anything that mentions Chinese gives Chinese; any other language gives English.
3. In desktop sessions on macOS, the Claude desktop app's own interface language.
4. The system language.
5. English.

To force one, add `"CLAUDE_MODS_LANG": "en"` to `env` in `~/.claude/settings.json`; sessions started after that use it. Switching the desktop app's interface language takes up to about a minute to show, with no need to restart the session; a card, notice or status line already on screen keeps the old language until it is next redrawn.

## Changing the code for yourself

Clone this repository and point `CLAUDE_CODE_PLUGIN_DIRS` at the mod folders you want in the `env` block of `~/.claude/settings.json` (separate several folders with `:`). Add `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` as well, and running desktop sessions reload after you edit the code.

Tests: `claude plugin test <mod folder>`. The shell scripts danger-guard runs are also tested on real files with `zsh danger-guard/tests/scripts.zsh` (macOS only).

Code comments are in Chinese.

## License

[MIT](LICENSE) © Lu Shiyao; each mod folder also has its own copy.
