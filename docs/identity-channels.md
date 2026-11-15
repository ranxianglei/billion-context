# Identity-channel wiring (#5825)

One page for the cross-client "stable conversation + message id" wiring: who
carries identity into bili, where it is consumed, and what every new lane must
do. The design law (owner ruling 2026-11-07): **every client lane wires INTO
one unified consume seam — no use site ever reads client storage itself.**
AGENTS.md KDD #18 is the normative statement; this page is the map.
Companion page (the *determination* side — what bili decides once the ids
arrive): `docs/session-identity-resolution.md`.

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
- **Stamped header lane** (opencode V2): the extension's http-request hook
  reads THIS turn's own structured messages (no race) and sets
  `x-bili-msg-ids` on its outbound request headers; any variant with an id it
  cannot prove poisons the WHOLE list. Handle consumes body field > header >
  harvest in that precedence; both prepares strip the internal field
  unconditionally before egress.
- **Harvest lane** (this wiring): loopback requests from clients whose local
  store carries stable per-message ids are matched through self-contained
  adapters; anything undecidable degrades the WHOLE turn to the pre-wiring
  path — never a partial mapping, never a silent re-key.

Harvest gates (all must hold per request): (env `BILI_IDENTITY_HARVEST`
non-empty (`all` or comma source list) OR rollout
`identityChannelHarvest` ON — either enabler suffices, both default OFF,
overrider of the unrelated `pluginLaneServerHistory`) × request source
address loopback-only × adapter join key matches. Row PINNING of admitted ids
(additionally on both wires since the openai-parity step) stays gated by
`pluginLaneServerHistory`; attribution-rung evidence does not need it.
Admitted ids ride the FULL pipeline on BOTH wires: #5719 attribution rung,
and — while `pluginLaneServerHistory` is on — pin/storage-row linking
(`prepare-anthropic` + `prepare-openai`, watermark-fastpath turns excluded:
a hit view is a shorter window and would mismatch by construction).

## 2. Lane table (from the #5825 per-client investigation)

| Client | Session key | Message ids | Adapter | Status |
|---|---|---|---|---|
| claude-code | `x-claude-code-session-id` (+transcript filename) | transcript `.jsonl` rows `uuid`; sidechain + summary rows excluded | `src/identity-claude.ts` | WIRED (anthropic wire: full path incl row pinning) |
| codebuddy | `x-conversation-id` (= transcript filename, restart-stable, measured 2.181.0) | JSONL rows `id`+`parentId`; system/draft rows excluded | `src/identity-codebuddy.ts` | WIRED (openai wire: attribution rung); recognition merged into `conversationHeaderSource` low-trust tier |
| mcode / mavis | `x-mavis-session-id` (`mvs_…`, already recognized #1050) | runtime-state.sqlite `local_runtime_message_rows.msg_id` | `src/identity-mcode.ts` | WIRED (sqlite exemplar; per-turn read probe, open→query→close) |
| goose | `agent-session-id` (= sqlite sessions.id, restart-stable; BYOK/custom-provider paths included; user-overridden name degrades this lane only) | sessions.db `messages.message_id` (`msg_<uuidv4>`, never reused); ORDER BY created_timestamp,id; compaction re-parents ⇒ post-compaction turn degrades whole-turn, self-heals next turn | `src/identity-goose.ts` | WIRED |
| qwen-code | `x-opencode-session` via user customHeaders `${session_id}` (official BYOK doc example name = one bili already recognizes; other chosen names degrade until recognized) | `<QWEN_HOME>\|~/.qwen/projects/<cwd>/chats/<sid>.jsonl` git-log rows `uuid`; sidechain files + compaction checkpoints + rewind records degrade whole-turn safely | `src/identity-qwen.ts` | WIRED (join is USER opt-in — see status caveat) |
| opencode V1 | `x-opencode-session-id` | `opencode-msgids` harvest (pre-existing) | unchanged | live |
| opencode V2 | `x-bili-msg-ids` (own hook sets it on every model request from that turn's structured messages) | same-event read — zero capture race; union-variant id optionality ⇒ ANY missing id drops the whole stamp | `src/agent/opencode-v2-msgids.ts` (+ handle consume, both-wire strip+pin) | WIRED (stamped header lane) |
| crush | join keys are XXH3 hex digests of the session UUID and the store is PROJECT-local (proxy cannot enumerate client cwds) | sqlite uuid PKs proven stable | — | closure memo: needs a client-side xxh3 join value or a documented data-dir convention before adapting |
| gemini-cli | closest identity is install-level (`installationId`, per-machine not per-session; telemetry-toggle dependent) | transcript uuids exist but have no stable per-session wire key | — | closure memo until a per-session wire key exists |
| hermes-agent | NO wire identity signal at all (branding headers only) despite a strong sqlite schema | id AUTOINCREMENT + active/compacted cols | — | closure memo: nothing to join on without a client change |
| iflow | had wireable session headers + claude-style JSONL | dual id-space ambiguity (wire getSessionId vs `session-<hash>` filenames) | — | closure memo: product sunset (repo README shutdown notice; npm final release) — not worth the surface |
| antigravity / qoder / copilot | per-client keys (antigravity has NONE on the wire) | transcript layouts partly proven (#5825 threads) | — | needs one logged-in measurement run before adapting |
| zcode | `x-zcode-*` attribution set (recognized for the memory aux-lane today) | no proven per-message wire half yet | — | needs one logged-in measurement run before adapting |
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
