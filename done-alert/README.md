# done-alert

English · [简体中文](README.zh-CN.md)

Tells you when a long task is done: a notice right above the prompt with the task name and how long it took, green when it finished and red when it stopped on an error, plus a sound when you are there to hear it.

![The green done notice above the prompt](../images/done-alert.png)

*The notice in the screenshot is a preview made with `/done-alert-preview`.*

## Highlights

- Only turns with more than 60 seconds of actual work alert; time spent waiting for you (permission prompts, questions, plan approval) doesn't count.
- The notice stays until you send your next message or click **×**, so it is still there when you come back.
- In the desktop app it plays a sound while the app is in front; when the app is in the background, the app's own "task complete" notification takes over (turn it on in the app's notification settings).
- In the terminal it plays a sound (macOS only) and sends a notification through Claude Code's notification setting.
- To see it without waiting for a long task: `/done-alert-preview` for the done notice, `/done-alert-preview fail` for the error notice.

## Install

```
/plugin install done-alert --marketplace Yao0558/claude-code-mods
```

Requirements, other ways to install, the interface language, changing the code and tests: see the [repository README](../README.md).

## Details

<details>
<summary>When it alerts and what it shows</summary>

- Done: `✓ Task done: <task> · 4 min`. A turn that ended on an error or a refusal is red: `✗ Task stopped with an error`.
- The task name is the first line of the message that started the turn, at most 30 characters; for a slash command, the command and its arguments. Turns the system starts (a background task finishing, a reminder) keep the previous task name.
- Subagent turns and turns you interrupted don't alert.
- With other mods that show rows above the prompt (such as repo-bar and task-progress), each gets its own row and the notice sits closest to the prompt.

</details>

<details>
<summary>Sounds and notifications</summary>

- **Desktop app**: plays only while the Claude app is in front. In the background, the app's own "task complete" notification alerts you; turn it on in the app's notification settings.
- **Terminal**: plays the sound (macOS only; Linux and Windows terminals have no player) and sends a notification through Claude Code's notification setting (`preferredNotifChannel`), unless it is turned off.
- The two sounds in `sounds/` are original, synthesized from sine waves by `sounds/synth.py` and released under the same MIT license. Run `python3 sounds/synth.py` on macOS to regenerate them; edit it to change the sounds.

</details>

## Limits

- Whether the app is in front is checked with the macOS `lsappinfo` command; elsewhere the check can't run, so the mod assumes the app is in front and always plays the sound.
- In desktop sessions the mod sends no system notification of its own; in the background it relies on the app's notifications.
- The 60-second threshold and the 30-character task name are fixed and can't be configured; to change them, edit `MIN_MS` and `TASK_MAX` in `hooks/register.tsx`.
- Time spent on another mod's confirmation card (such as danger-guard's) that you cancel or let time out counts as work.

## License

[MIT](LICENSE) © Lu Shiyao
