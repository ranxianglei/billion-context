# Identity-channel wiring (#5825)

One page for the cross-client "stable conversation + message id" wiring: who
carries identity into bili, where it is consumed, and what every new lane must
do. The design law (owner ruling 2026-11-07): **every client lane wires INTO
one unified consume seam — no use site ever reads client storage itself.**
AGENTS.md KDD #18 is the normative statement; this page is the map.

## 1. The seam

Per request, at ONE point (`src/server/handle.ts`, after conversation identity
resolution, before resolve) the identity registry is snapshotted:

```
stamped inbound ids (body fields / turn envelope)   ──▶  same consumer path ◀── harvested ids
                                                            (msgid-pin validation →
                                                             #5719 attribution rung →
                                                             pin/row pipeline on
                                                             anthropic wire)
```

- **Stamped lane** (dsh et al.): hosts mint canonical ids (`acp_summary_*`),
  stamp body fields or the `/__bili/plugin/turn` envelope; protocol-stripped
  before egress.
- **Harvest lane** (this wiring): loopback requests from clients whose local
  store carries stable per-message ids are matched through self-contained
  adapters; anything undecidable degrades the WHOLE turn to the pre-wiring
  path — never a partial mapping, never a silent re-key.

Harvest gates (all must hold per request): rollout
`pluginLaneServerHistory` ON × env `BILI_IDENTITY_HARVEST` non-empty (`all` or
comma source list; unset = OFF, fully inert) × request source address
loopback-only × adapter join key matches.

## 2. Lane table (from the #5825 per-client investigation)

| Client | Session key | Message ids | Adapter | Status |
|---|---|---|---|---|
| claude-code | `x-claude-code-session-id` (+transcript filename) | transcript `.jsonl` rows `uuid`; sidechain + summary rows excluded | `src/identity-claude.ts` | WIRED (anthropic wire: full path incl row pinning) |
| codebuddy | `x-conversation-id` (= transcript filename, restart-stable, measured 2.181.0) | JSONL rows `id`+`parentId`; system/draft rows excluded | `src/identity-codebuddy.ts` | WIRED (openai wire: attribution rung); recognition merged into `conversationHeaderSource` low-trust tier |
| mcode / mavis | `x-mavis-session-id` (`mvs_…`, already recognized #1050) | runtime-state.sqlite `local_runtime_message_rows.msg_id` | `src/identity-mcode.ts` | WIRED (sqlite exemplar; per-turn read probe, open→query→close) |
| opencode V1 | `x-opencode-session-id` | `opencode-msgids` harvest (pre-existing) | unchanged | live |
| opencode V2 | `x-opencode-session-id` (default headers) | context-hook session messages; ids OPTIONAL on variants → whole-turn-degrade kept | — | follow-up PR (needs transform-hook depth + live verification) |
| crush / qwen / gemini-cli / goose / hermes / antigravity / qoder / copilot | per-client keys | sqlite uuid PKs / jsonl uuids (proven stable per issue comments) | — | follow-up adapters, same registry (layouts confirmed in #5825 threads; ship after the core proves out under rollout observation) |
| zcode / iflow | `x-zcode-*` attribution set / lowercase `session-id`,`conversation-id` (recognized) | no proven per-message wire half yet | — | needs one logged-in measurement run before adapting |
| grok-shell / kiro | recognized | no usable per-msg entity on the model wire (source-proven) | n/a | session half only — closed with closure note |
| aider / jcode / kimi | none stable | none usable | n/a | content-hash fallback IS the optimum — closed |
| codex | session known | item.id is provider-namespace; self-minted ids rejected twice in prod (#242/#1474) | n/a | deferred pending #5643 ruling |
| trae / amp | — | — | n/a | blocked: no artifact obtainable externally |

## 3. Trust boundaries

- Harvested ids are **server-derived evidence**, equal-trust to stamped ids
  once admitted (same canonical validator, same rung semantics) — because
  they come from a LOCAL file/sqlite of the SAME client that sent the
  request, on LOOPBACK only. Remote-sourced requests can never harvest.
- Each adapter validates its own layout assumptions inside its snapshot;
  shared discipline lives in the core (count parity vs `expectedLen`,
  boundary role spot-check up to 4 positions where both sides expose roles,
  canonical msgid validation, per-source warn-once degradation).
- Consumers stay client-agnostic: nothing downstream of the seam mentions a
  client name.

## 4. Change checklist

New harvest lane: add `src/identity-<client>.ts` (self-contained; node builtins
only) → register in `src/identity-sources.ts` → add fixture test in
`tests/identity-harvest.test.ts` → add a row to §2 above + AGENTS.md status.
Do NOT: read client storage anywhere outside the registry, bypass the gates,
or let one lane carry a partial mapping past an undecidable turn.
