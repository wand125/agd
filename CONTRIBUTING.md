# Contributing

Thanks for your interest in agd. This is a small, opinionated project — please open an issue
before starting anything large, so you don't spend time on something that won't be merged.

[日本語版はこちら](CONTRIBUTING.ja.md)

## Getting started

```bash
git clone https://github.com/wand125/agd.git
cd agd
bun install          # dev dependencies only (typescript + @types/bun)
bun run web/server.ts # http://localhost:8787
```

The server itself has **no runtime dependencies** — only Bun. Please keep it that way:
a new `dependencies` entry needs a good reason.

## Before you push

```bash
bun run check        # typecheck + tests
```

Both run in CI on every pull request.

## What is testable

`bun test` covers the pure logic only — transcript parsing, screen/prompt detection, tmux
output parsing. Everything else (iTerm2 Apple Events, tmux control, session discovery) needs
a real macOS session with live agents, so it is verified by hand.

That split matters when you add code: **if a bug can be expressed as "given this text, produce
that value", put it in a pure function under `web/` and add a test.** `web/screen.ts` exists
for exactly this reason.

## Manual verification

Behavior that touches terminals cannot be covered by CI. When you change any of it, say in the
PR what you actually ran. The paths that break most often:

- **Screen capture** — cards show live screens for both plain iTerm2 tabs and tmux panes
- **Sending input** — `/api/send` reaches the session and Enter commits it
- **Prompt buttons** — a permission prompt renders as buttons and answering works
- **Session lifecycle** — new / duplicate (`Ctrl+N`) / fork (`Ctrl+C`) / close (`:q`)
- **Remote sessions** — if you touch `web/remote.ts`, test against a real ssh + tmux host

A useful trap to know about: agd runs under launchd with a **minimal environment** — no `LANG`,
and a `PATH` trimmed to `/usr/bin:/bin:/usr/sbin:/sbin`. Tools behave differently there than in
your shell (tmux, for one, replaces tabs with `_` when no locale is set). Resolve external
binaries by absolute path, and don't rely on tabs as a delimiter. Testing only from an
interactive shell will not reproduce these.

## Code style

Match the surrounding code rather than reformatting it.

- **Comments are in Japanese** and explain *why*, not *what* — especially the non-obvious
  constraint a line is working around. Keep new comments in the same style
- 2-space indent, double quotes, semicolons
- No build step for the frontend: `web/public/*.js` is plain ES modules loaded directly by the
  browser. Shared helpers live in `core.js`, the desktop UI in `app.js`, the mobile UI in
  `mobile.js`
- The server is one file per concern (`server.ts`, `remote.ts`, `transcript.ts`, `screen.ts`,
  `search-worker.ts`). Anything heavy belongs off the main thread

## Security

agd can type into your terminals. Please read [SECURITY.md](SECURITY.md) before changing
anything about binding, authentication, or the API surface — and never report a vulnerability
in a public issue.
