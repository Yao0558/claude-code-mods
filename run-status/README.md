# run-status

English · [简体中文](README.zh-CN.md)

Shows whether the tests, builds and type checks Claude just ran passed, right in the status line under the prompt, so you don't have to dig through tool output.

```text
… Testing: npm test
✓ Tests passed (12s): npm test
✗ Checks failed (4s): tsc --noEmit
… Testing in background: pytest
⏱ Build timed out (120s), moved to background: cargo build
```

## Highlights

- Recognizes common tests, builds and linters: `npm`/`pnpm`/`yarn`/`bun` scripts such as `test`, `lint` and `build`, plus `pytest`, `jest`, `vitest`, `go test`, `cargo`, `make`, `tsc`, `eslint` and more.
- Reports only when the result really belongs to the check: when the exit code comes from another command, as in `npm test | tail`, nothing is reported.
- Checks moved to the background are followed to the end, and never show as passed before their completion notification says so.
- Anything that looks like a secret in the command is masked before it is shown.
- The line clears 10 minutes after the last result.

In the desktop app the line sits under the prompt, to the left of the model name, after the mod's name. In the terminal it is the mod's own status row under the prompt.

## Install

```
/plugin install run-status --marketplace Yao0558/claude-code-mods
```

Requirements, other ways to install, the interface language, changing the code and tests: see the [repository README](../README.md).

## Details

<details>
<summary>What counts as a check</summary>

- Package scripts: `npm`, `pnpm`, `yarn` and `bun` scripts named like `test`, `test:unit`, `lint`, `typecheck`, `check`, `format:check`, `build:prod` or `compile`, including workspace and `--filter` forms.
- Test runners: `vitest`, `jest`, `pytest`/`py.test`, `phpunit`, `rspec`, `mocha`, `ava`, `unittest`, `nose2`.
- Tool subcommands: `go test|build|vet`, `cargo test|nextest|build|check|clippy` (and `fmt --check`), `swift test|build`, `dotnet test|build`, `mix test|compile`, `deno test|check|lint|task`.
- `make`/`gmake` targets (`test` and `check` count as tests, `lint` and `typecheck` as checks, no target, `build` or `all` as a build), `gradle`/`gradlew` tasks, `mvn`/`mvnw` goals, `xcodebuild` actions.
- Linters and type checkers: `tsc`, `eslint`, `mypy`, `pyright`, `ruff`, `biome`, `swiftlint`, and `prettier`/`black` in check mode. Runs that only rewrite files (`prettier --write`) aren't reported.
- Wrapped commands are recognized too: `npx`, `bunx`, `pnpx`, `uvx`, `<package manager> exec`/`dlx`, `uv`/`poetry`/`pipenv`/`pdm`/`hatch run`, `python -m`, and prefixes such as `sudo`, `env`, `time`, `nice`, `timeout`, `xargs`. Version and help runs (`--version`, `--help`) are ignored.

</details>

<details>
<summary>When it reports and what it shows</summary>

- The check has to be the last part of the command, joined by `&&`, `;` or a new line (`cd app && npm test`). `npm test | tail`, `npm test || true` and `npm test; echo done` take their exit code from something else, so they aren't reported.
- A check that goes to the background (started there, moved there on timeout, or by your Ctrl+B) shows `in background` or `timed out, moved to background` until Claude Code's completion notification arrives, then the real result. A stopped run leaves nothing, one with no notification after 2 hours is dropped, and when the same check runs again the newer run wins. Background runs started by subagents aren't followed.
- Runs you deny or interrupt leave nothing.
- Checks running in parallel are tracked separately, and the others show as `(+N more)`. A failure stays until the same check (the part after any `cd … &&`) runs again, or a check of the same kind that started after it finished replaces it; a parallel check that passes doesn't hide it.
- Durations count only execution, not the wait for you to approve the command, whenever Claude Code reports the execution time (it normally does); background runs count from the call until the notification arrives.
- Only the check itself is shown: a leading `cd … &&` or `VAR=value` is left out. Masked: values after `--token=…` and names like `--api-key`, passwords, URLs with `user:pass@`, common service token prefixes and long random strings.

</details>

## Limits

- Only commands run through the Bash tool are watched. Checks run by other tools, or by you in another terminal, are not.
- A tool it doesn't recognize isn't reported; it doesn't guess.
- Windows command names such as `npm.cmd` or `gradlew.bat` aren't recognized.
- The command shown is cut to 40 characters.

## License

[MIT](LICENSE) © Lu Shiyao
