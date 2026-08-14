# Security Policy

[日本語版はこちら](SECURITY.ja.md)

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use [GitHub's private vulnerability reporting](https://github.com/wand125/agd/security/advisories/new)
instead. Include what an attacker can do, and the steps to reproduce it. This is a
personal project, so expect a reply in days rather than hours.

## Threat model

agd is a local tool that **can type into your terminal sessions**. Anyone who can reach the
HTTP server can send keystrokes to every agent you are running — which in practice means they
can run commands on your machine. Treat access to the port exactly like shell access.

This shapes the defaults:

- The server binds to **`127.0.0.1` only**. `AGD_BIND` can change that, but binding elsewhere
  **without `AGD_TOKEN` refuses to start**
- With `AGD_TOKEN` set, requests without the token get 401 — **including requests from
  localhost.** Loopback is deliberately not exempt: a reverse proxy such as `tailscale serve`
  also connects from `127.0.0.1`, so exempting it would make the token meaningless
- `AGD_READONLY=1` rejects every mutating endpoint, for a view-only deployment

## Exposing agd beyond localhost

If you need it from another device, put it on a private network (a tailnet) **and** set a
token. Do not port-forward it to the public internet.

```bash
AGD_TOKEN=$(openssl rand -hex 24) agd web
tailscale serve --bg --http=8787 http://127.0.0.1:8787
```

The token appears in the URL the first time (`?token=…`) and is stored in a cookie afterwards,
so it will be in your browser history — rotate it if that matters to you.

## Scope

In scope: authentication bypass, anything that lets a request reach a session it shouldn't,
command injection through session data (paths, titles, transcript contents), and token leaks
into logs or responses.

Out of scope: attacks that require you to already have local shell access as the same user
(the tool grants that by design), and anything about the security of Claude Code or Codex CLI
themselves — report those upstream.
