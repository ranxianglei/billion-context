# Client session identity: who carries a session id, how subagents behave, what to stamp

> **Supersedes** the per-client *session-id* conclusions in `docs/identity-channels.md` §2
> (the 2026-11-07 #5825 map: "content-hash fallback IS the optimum — closed", "NO wire identity
> signal", "needs one measurement run"). That doc's **message-id HARVEST** wiring (§1 seam,
> §3 trust boundaries, §4 change checklist) remains operative — only its per-client *session*
> rows are outdated.
>
> Date: 2026-11-22. Method: source-first (cloned repos, unpacked npm bundles, installed
> binaries), binary-second. Full per-client file:line evidence: `research/batch-open-1.md`,
> `batch-subagent.md`, `batch-closed-1.md`, `batch-nosignal.md`, `batch-unverified.md`
> (scratch), and `group2-get-id.md` / `group3-share-alt.md` (both complete, source-verified).

## 1. The model (owner ruling 2026-11-22)

Two separate things, kept apart on purpose:

- **Identity (the session id)** = what the *client* stamps. bili trusts it **verbatim** — no
  content-guessing forks. This is the server-side gate `trustStampedId`
  (`src/rollout.ts`), **on by default** (GA, #7439). The four content-forecasting `|sub:` forks in
  `src/session-resolve.ts` (derived-aux / persona-by-content / two derived-task) ride the stamped
  id verbatim; the ONE survivor is the #5095 claude-code lane-token tail
  (`<id>|sub:t:<token>`), which is *client-declared*, not guessed.
- **Purpose (which side-task: compaction / title / subagent / memory)** = **server-derived** from
  each client's own signals (`x-grok-turn-idx`, `x-zcode-query-source`, `x-compaction`, `task_id`,
  `agent-id`, …). The `x-bili-plugin-purpose` header is a **bonus** for the few clients that *can*
  stamp it per-request (dsh/pi/opencode in-process; codex via config `http_headers`).

> **Why purpose stays server-side:** nearly every client extension point is **static**
> (session/provider/process-scoped) — none has a per-request header hook. So a static stamp can at
> best declare the `"conversation"` sentinel, which bili normalizes back to *absent*
> (`src/server/handle.ts:1320`). Per-task purpose needs a per-request hook (rare) or server-side
> derivation (the norm).

## 2. Global constraint (affects every verdict)

`x-bili-plugin-purpose` is honored **only together with** the `x-bili-plugin` agent marker
(`src/plugin.ts:236-241` `pluginPurposeHeader()`). Without the marker, the purpose header is
ignored. This is intentional: honoring purpose on an un-announced client would let it opt its
traffic out of classification.

## 3. 第一类 — have a stable session id

### (a) subagents have DISTINCT ids → adopted / directly wired

| client | session id | subagent model | in bili today? | to finish |
|---|---|---|---|---|
| **opencode** | `x-opencode-session-id` (= own `session.id`; parent as `x-opencode-parent-session-id`) | distinct per agent/fork | IN ROSTER `src/session-id.ts:99` | none — recognized; `trustStampedId` covers it |
| **codex** | `thread-id` (+`x-codex-turn-metadata` `thread_source`) | distinct (each spawned thread its own `thread-id`) | **HANDLED** `codexTurnIdentity()` `src/session-id.ts:473`; server keys it directly | none (modern ≥0.147); older builds fall to instructions fingerprint |
| **goose** | `agent-session-id` (= sqlite `sessions.id`) | distinct (`summon` spawns a new session) | IN ROSTER | none |
| **CodeBuddy** | `X-Conversation-ID` (persisted conv id, restart-stable) | distinct (`setupSubAgentSession`, own scope) | IN ROSTER | none |
| **zcode** | `x-session-id` (`subagent_agent_` prefix stripped pre-wire) | subagent distinct; **memory worker shares** parent id → already split server-side to `\|aux:zcode-memory:<query>` | IN ROSTER + `zcodeMemoryConversation()` `src/session-id.ts:110` | none |
| **jcode** | body `prompt_cache_key` (**Responses wire only**) | n/a (single wire id) | **PROMOTED** `preferPromptCacheKeyIdentity()` `src/session-id.ts:409` | none on Responses; anthropic/openrouter wires have no id → still content-fallback there |
| **dsh / pi** | in-process plugin mints canonical ids | distinct | WIRED (in-process) | none — **full** (also the reference for purpose stamping) |
| **zed** | body `thread_id` (cloud `POST /completions`; OpenAI-subscribed path sends `session-id`+`thread-id` headers) | distinct (own thread id + `parent_thread_id`) | **NOT READ** — but `bili zed` cert-MITM already intercepts zed traffic (`src/cli.ts:96`) | **new wire** (scoped, `research/zed-scope.md`): zed's `/completions` is a non-standard envelope bili does not decode today (protocol=null → verbatim passthrough, **no** session at all). Needs an envelope classifier + `zed-wire.ts` unwrap/rewrap codec + provider→protocol dispatch; ~550-900 ln, one focused PR. Bonus: the OpenAI-subscribed path already sends `session-id`+`thread-id` headers (~10-ln roster add, independent). |

### (b) subagents SHARE the parent session id → 第三类 (below)

`mcode`, `qoder`, `claude-code`, `copilot`, `kiro` (plus `grok` aux / `omp` forks — see 第三类 notes).

## 4. 第二类 — no session id (source re-verify; must at least land one)

The #5825 map closed these as "content-hash fallback IS the optimum — closed". Source verification
**overturns that**: every one can land a stable per-session id, and **three of four need zero client
code change** (see `research/group2-get-id.md`, verified 2026-11-22 against current HEAD).

| client | id source (verified) | minimal mechanism | per-session? | code change? | conf |
|---|---|---|---|---|---|
| **gemini-cli** | **user-mintable**: `--session <id>` + `createSessionId()` (`session.ts:9`) | env `GEMINI_CLI_CUSTOM_HEADERS` = the 3 bili headers, value aligned to `--session $S` | **yes** — the client's *own* id (persisted, `--resume $S`) | **none** | high |
| **crush** | internal `uuid.New()` per session (`session.go:107`) | `extra_headers: {"x-bili-plugin-conversation":"$BILI_SESSION_ID"}` + wrapper `BILI_SESSION_ID=$(uuidgen)` — **header values now shell-expand** (`config.go:114-120`) | yes (TUI + `crush run`); no for the shared `crush server` daemon | **none** (daemon needs a hook) | high |
| **aider** | **no id anywhere** (only a machine analytics uuid; `models.py:985`) | `--model-settings-file` with `extra_params.extra_headers`; wrapper mints a uuid per launch | yes (no resume → per-launch = per-session) | **none** | high |
| **kimi** | internal id exists but `--session` is resume-only; nothing on the wire (`catalog-service.ts:420`) | env `KIMI_CODE_CUSTOM_HEADERS` static (per process) | **process-scoped only** (concurrent sessions collide) | none per-process; ~10-20 ln upstream for true per-session | high |

**Ranking (least effort first):** gemini-cli (env flag + the client's own id) → crush (env var + static config) → aider (wrapper-minted uuid) → kimi (weakest: per-process stamp only; true per-session needs an upstream `PreModelRequest` hook).

All four wrappers send `x-bili-plugin` + `x-bili-plugin-conversation` (+ `x-bili-plugin-purpose`) together — the marker gate bili requires (`conversationHeaderSource`, `src/session-id.ts`).

## 5. 第三类 — have id, but subagents SHARE it (listed separately; source re-verify the alternate signal)

Source-verified per client (`research/group3-share-alt.md`, 2026-11-22). The "they share the
parent id, so they merge" premise holds for only **two** of the five — the other three have a
distinct id or a clean per-task signal:

| client | what source actually shows | on wire? | subagent-reliable? | bili consumes? | minimal change | conf |
|---|---|---|---|---|---|---|
| **mcode** 0.7.9 | **premise wrong** — a subagent rides a *fresh child* `X-Mavis-Session-Id` (minted per spawn) | header | yes (structural) | yes (roster :99) | **none — drop the shared-id premise** | high |
| **copilot** 1.0.114 | `X-Agent-Task-Id` / `X-Parent-Agent-Id` on the model wire (runtime.node) | header | yes (subagent ⇒ parent-id present) | no | roster: insert `x-agent-task-id` before `x-session-id` | med-high |
| **claude-code** 2.1.330 | new `x-claude-code-request-class` (main/subagent/workflow/compaction/auxiliary/side_reply), **off** under a 3rd-party base URL unless `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` | header | yes once env on; absent by default | no | launcher sets env=1; session-id.ts read+validate; handle.ts split `subagent\|…`→`\|sub:`/`\|aux:`; keep #5095 token as fallback | high (default-off empirical) |
| **qoder** 1.1.95 | body `metadata.task_id`/`business_type`/`sub_task` (agent_summary/webfetch_summary/hook_prompt) — **side tasks only**; plain Task subagents carry nothing but a fresh `X-Request-Set-Id` | body | no for plain subagents; yes-ish for side tasks | no (only `x-session-id`) | handle.ts qoder clause: sidecar `webfetch_summary\|hook_prompt\|agent_summary` as `\|aux:` (zcode pattern :109); plain subagents unfixable on the wire | high |
| **kiro** 3.5.0 | body `metadata` `kiro:agent_continuation_id` / `root_conversation_id` / `agent_mode` (RE'd `cfd()`) | body | unknown (conditional emission, unverified on 3.5.0) | no (kiro.ts:71-78 reads conversation_id only) | extend kiro.ts lineage reader + `\|sub:kiro` **after one live `bili kiro` capture** | med / low-med |

**Takeaway:** mcode → no work. copilot + claude-code → clean header additions (claude's needs
bili's launcher to set one env var — zero client patch). qoder → side tasks separable, plain
subagents not. kiro → one live capture before touching it.

Notes:
- **grok** — side-tasks (btw/compaction/title) share the main id but are **already** classified by
  the *absence* of `x-grok-turn-idx` (`src/server/handle.ts:1380` `grokAuxSidecar`). No new work
  needed; listed here for completeness, not a blocker.
- **omp** — `Task` subagents get their *own* `prompt_cache_key` (distinct), but forks/`//tan`
  deliberately **inherit** the parent key (cache-mirroring). Server-side: distinguish the inherited
  case via the body key + a turn heuristic.

## 6. Fix worklist (by effort, source-verified 2026-11-22)

**A. bili-side only (no client change):**
1. **no work** — opencode / codex / goose / CodeBuddy / zcode / dsh **and mcode** (already distinct
   on the wire; just turn on `trustStampedId`).
2. **add a header to the roster** — copilot (`x-agent-task-id` before `x-session-id`,
   `src/session-id.ts:99`).
3. **launcher env + roster header + split** — claude-code: launcher sets
   `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`; the split reads `x-claude-code-request-class`
   and acts only on `subagent` (force the `|sub:` agent split) and `main` (suppress it);
   `workflow`/`compaction`/`auxiliary`/`side_reply` are validated but fall through to the
   legacy system-prefix heuristic (keep #5095 token as fallback for non-bili-launched processes).
4. **consume body lineage** — qoder side-tasks (`metadata.task_id`/`business_type` → `|aux:`,
   zcode pattern), kiro (`kiro:root_conversation_id` after a live capture).
5. **server-side heuristic (no client fix exists)** — grok (turn-idx absence), omp (fork key mirror).

**B. client must stamp an id (第二类 + zed):**
6. **zero client code change** — gemini-cli (env + `--session <id>`), crush (env `$VAR` header),
   aider (wrapper-minted uuid via `--model-settings-file`).
7. **per-process stamp** (fine single-session) — kimi.
8. **new wire** — zed (envelope classifier + `zed-wire.ts` codec + dispatch; ~550-900 ln, one PR; scope report `research/zed-scope.md`). Bonus: OpenAI-subscribed zed sends `session-id`+`thread-id` headers (~10-ln roster add).

## 7. Rollout: GA-on (owner ruling 2026-11-22), residual risk accepted

`trustStampedId` is **on by default, no gradual rollout** — the stamped-id model is proven in
production (the #6880 dsh terminal state + the long-running client-session-id roster). The one
residual risk is a client whose subagent rides the *parent's* session id: with content-forking
retired, such subagent traffic merges into the parent. Per the 第三类 verification that applies to
only **qoder plain Task subagents** and **kiro** (unverified); the rest are handled:
- copilot + claude-code: bili consumes their per-task header (`x-agent-task-id`,
  `x-claude-code-request-class`), so their subagents key themselves apart.
- mcode / opencode / codex / goose / CodeBuddy / zcode / dsh / zed: subagent id is distinct on the
  wire — no merge.
- qoder plain Task subagents + kiro: accepted as a merge (owner ruling); kiro also awaits one live
  capture. Escape hatch stays available: `BILI_ROLLOUT_TRUST_STAMPED_ID=0` forces the legacy
  `|sub:` ladder for a debug session.

## 8. Status

- 第一类 (have id): 7/8 already wired into bili; **zed** = bounded new work (`bili zed` MITM
  intercepts the traffic; read body `thread_id` as the session key).
- 第二类 (no id): **DONE** (`research/group2-get-id.md`) — all 4 land a per-session id; gemini-cli /
  crush / aider need **zero** client code change; kimi is per-process only.
- 第三类 (share id): **DONE** (`research/group3-share-alt.md`) — mcode premise wrong (child ids
  distinct); copilot + claude-code have clean per-task headers; qoder side-tasks only; kiro needs
  one live `bili kiro` capture.
- zed: scoped as a **new wire** (~550-900 ln, one PR) — `research/zed-scope.md`. The `bili zed` MITM
  already intercepts the traffic; the gap is that bili does not decode zed's envelope (protocol=null),
  so a classifier + codec + dispatch are needed, not a simple body read.
