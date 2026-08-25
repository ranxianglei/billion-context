# WORKLOG — remote host bind (#240)

Model: qwen3.8-27b (vllm)

1. Reproduced live: `--host 0.0.0.0` — `/bili/` + health already reachable
   via LAN IP; CONNECT (MITM) hard-403 for non-loopback clients (#77 gate in
   src/mitm.ts). `/__bili/` 403 for remote is intentional (DNS-rebinding
   guard) and stays.
2. Implemented `allowRemoteClients` (5th param of setupMitm); server.ts
   derives it from the bind host. Remote CONNECT allowed only for
   whitelisted model hosts — no open relay.
3. Rewrote tests/mitm.test.ts #77 test into the 3-way policy matrix
   (strict 403 / allowed+whitelisted 200 / allowed+other 403). 14/14 in
   file, 593/593 total, typecheck + build clean.
4. Dist e2e on LAN IP confirmed all three paths + `[security]` warn + honest
   `0.0.0.0` log display.
5. Docs: README(.zh-CN).md new "Remote agents (`--host`)" section (also
   resolves the dangling "see host note below" pointer); CONFIGURATION(.zh-CN).md
   `host` entry extended with the remote-CONNECT policy.

## Follow-ups

- Incident during testing: a repo-dist test server (0.1.52) auto-updated
  itself to 0.1.53 and rewrote the repo's package.json (findInstallDir
  resolved to the repo itself). Lesson: always `--no-auto-update` when
  running dist servers from the repo. Restored via git checkout.
