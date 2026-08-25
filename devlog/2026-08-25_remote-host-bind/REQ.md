# Issue #240: support host 0.0.0.0 (remote access)

Model: qwen3.8-27b (vllm)

## Request

https://github.com/ranxianglei/billion-context/issues/240 — user sets
`host: 0.0.0.0` and wants to connect to bili from a *remote* machine (like a
headroom proxy server). Investigation found the HTTP side already worked;
the blocker was the loopback-only CONNECT gate in the MITM proxy (#77).

## Root cause

`src/mitm.ts` setupMitm rejected every CONNECT whose client socket was
non-loopback — a hard 403 regardless of bind. With `--host 0.0.0.0` the HTTP
endpoints (`/bili/`, health) were already reachable remotely (verified live);
only CONNECT (MITM mode) refused.

## Fix

- `src/mitm.ts`: `setupMitm(..., allowRemoteClients = false)`.
  - Remote client + `allowRemoteClients=false` → 403 (old #77 behavior).
  - Remote client + allowed + **whitelisted** model host → normal MITM path.
  - Remote client + allowed + **non-whitelisted** host → 403 (never an open
    TCP relay; blind tunnels stay loopback-only).
- `src/server.ts`: computes `allowRemoteConnect` from the bind host
  (`0.0.0.0` / `::` / non-loopback ⇒ true) and passes it through. Loopback
  binds keep the strict gate — no behavior change for the default case.
- Startup log: honest `0.0.0.0` display instead of masquerading as
  `localhost`, plus a `[security]` warn on non-loopback binds (no auth,
  management endpoints stay loopback-only).

## Verification

- `tests/mitm.test.ts` #77 test rewritten as "remote CONNECT policy
  (#77, #240)": strict server → 403; allowed server → 200 for
  api.anthropic.com, 403 for example.com (ran on real LAN addr, not skipped).
- Full suite 593/593, typecheck, build green.
- Live e2e (dist, `--host 0.0.0.0 --port 18788`, client via 192.168.10.157):
  health 200; CONNECT api.anthropic.com → "TLS terminated locally" (client
  alert 48 = it didn't trust our CA, expected); CONNECT example.com →
  "rejected: remote client ... tunneling non-whitelisted host".
