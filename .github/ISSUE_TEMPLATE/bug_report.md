---
name: Bug report
about: Something in agd does not work
labels: bug
---

<!-- 日本語でも英語でも構いません / Japanese or English is fine. -->

**What happened / What you expected**

**Steps to reproduce**

**Environment**
- macOS version:
- Terminal: iTerm2 / tmux / both
- Bun version (`bun --version`):
- Agent: Claude Code / Codex CLI
- How agd was started: `agd web` / launchd / `agd.app`

<!--
If a session shows an empty screen or input does not arrive, note how agd was started.
Under launchd it runs with a minimal environment (no LANG, trimmed PATH), which behaves
differently from an interactive shell.
-->

**Server log** (`/tmp/agd-server.log` if you use the launchd service)
