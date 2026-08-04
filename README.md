# agd — Agent Dashboard

A keyboard-driven (vim-style) dashboard for running many **Claude Code** and **Codex CLI** sessions in parallel on macOS.

[日本語版 README はこちら](README.ja.md)

![agd demo](docs/demo.gif)

*(demo recorded with the built-in `:mask` mode — layout and colors are real, text is scrambled. [Higher-quality video](docs/demo.mp4))*

agd discovers **existing sessions** — including ones you started in plain iTerm2 tabs or tmux panes — and gives you:

- **Live screen grid** — full-color terminal screens of every running session, updated every 2.5s, with pagination (no scrolling)
- **One-tap prompt responses** — permission prompts (`❯ 1. Yes` and cursor-style `❯ Yes`) are detected from the screen and rendered as buttons; answer with a click or the number keys
- **Send prompts from the browser** — per-card input with slash-command hints (Claude/Codex aware, custom commands included), Shift+Enter for multiline
- **Full transcripts** — conversation logs with collapsible thinking/tool-call entries, diff rendering for edits, subagent logs, incremental loading, cross-session search
- **Vim everywhere** — `hjkl` to move between session cards, `i` to type, `:q` to kill a session, `?` for the full keymap
- **AI one-line summaries** — each session gets an LLM-generated status line ("what is it doing / waiting for"), refreshed when work finishes or input is needed (runs via headless `claude -p` on haiku; rolling incremental prompts keep cost negligible; `:sum` to refresh manually)
- **Notifications** — browser and/or macOS notifications when a session needs input or finishes
- **Session lifecycle** — spawn new sessions (`n` palette with directory completion), duplicate (`Ctrl+N`), continue a conversation in a fresh session (`Ctrl+C`), resume past sessions, close (`:q`)

Everything works for sessions agd did not start — no wrapper process required.

## Requirements

- macOS with [iTerm2](https://iterm2.com) (tmux panes inside iTerm2 also supported)
- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) and/or [Codex CLI](https://developers.openai.com/codex/cli)
- Optional:
  - `python3` — full-color screen capture via the iTerm2 Python API (falls back to monochrome AppleScript without it)
  - `fzf` + `jq` — for the terminal picker (`agd` CLI)
  - `terminal-notifier` — click-to-jump macOS notifications

## Install

```bash
git clone https://github.com/wand125/agd.git
cd agd
ln -s "$PWD/bin/agd" ~/.local/bin/agd   # or anywhere on your PATH

# Optional: full-color screen capture (iTerm2 Python API)
cd web
python3 -m venv .venv
.venv/bin/pip install iterm2
```

For color capture, also enable the API in iTerm2: **Settings → General → Magic → Enable Python API**.

## Usage

```bash
agd web      # browser dashboard → http://localhost:8787
agd          # fzf picker: jump to / resume sessions from the terminal
agd list     # plain table of all sessions
agd watch    # auto-refreshing table
```

### Key bindings (dashboard)

Press `?` in the dashboard for the full list. Highlights:

| Key | Action |
|---|---|
| `h j k l` | move between session cards (crosses pages at the edges) |
| `i` / `Esc` | insert mode (focus the send box) / back to normal mode |
| `Enter` | confirm — send ⏎ to a session that is waiting for input |
| `1`–`9` | answer a detected permission prompt |
| `o` / `f` | open transcript view / focus the real terminal |
| `m` / `s` | send Shift+Tab (permission mode cycle) / Esc (interrupt) |
| `n` / `Ctrl+N` / `Ctrl+C` | new session palette / duplicate / continue conversation |
| `p`, `⇧HJKL` | pin session / reorder cards (swap left/down/up/right) |
| `t` / `/` / `:` | switch tab / filter & search logs / command line (`:q`, `:/clear`, …) |

## Desktop app (macOS)

```bash
bash scripts/install-macapp.sh
```

This registers the server as a login item (launchd) and creates `agd.app` — a **native WKWebView shell** (compiled on the spot with `swiftc`; falls back to a dedicated-profile Chromium app window if unavailable). The app is completely independent of your browser, so it never collides with browser automation, and clicking its Dock icon focuses the existing window. Set `AGD_PATH_STRIP` / `AGD_PORT` when running the script to bake them in. Note: in the native shell, use macOS notifications (the in-page browser-notification toggle is a no-op).

## Configuration

| Variable | Effect |
|---|---|
| `AGD_PORT` | dashboard port (default 8787) |
|  `AGD_PATH_STRIP` | path prefix to abbreviate as `…` in the UI (e.g. `~/projects`) |

macOS notifications are toggled from the dashboard header (stored in `~/.cache/agd/config.json`).

## How it works

- **Session discovery**: `claude agents --json` (official, includes state) + process scanning with `ps`/`lsof` matched against Codex rollout files
- **Screens**: iTerm2 Python API (per-cell styles → ANSI) or `tmux capture-pane -e`, with an AppleScript fallback
- **Input / keys**: `tmux send-keys` or iTerm2 AppleScript `write text` — multiline input is wrapped in bracketed paste
- **Transcripts**: incremental, byte-offset tail parsing of `~/.claude/projects/**.jsonl` and `~/.codex/sessions/**.jsonl`

The server binds to `127.0.0.1` only — it can type into your terminals, so never expose it to a network.

## License

[MIT](LICENSE)
