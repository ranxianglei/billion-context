# Session identity resolution (same client id, different conversations)

Design record for how billion-context decides **which conversation** a request
belongs to once its session id (client-minted conversation identifier) is known.
Companion pages: `SESSION-IDENTITY.md` (repo root — the *anonymous* lane: what to
do when the request carries no id at all), `MESSAGE-IDENTITY.md` (message-level
identity doctrine), and `docs/identity-channels.md` (who carries the ids into
bili in the first place). Normative statements: AGENTS.md KDD #11 (identity
hierarchy) and KDD #18 (channel wiring law).

## The two identifiers and their roles

- **Session id** (`rawId` in code). A stable string the client sends on every
  request (e.g. `x-claude-code-session-id`, `agent-session-id`,
  `x-conversation-id`). Recognition (`src/session-id.ts`) picks the value from an
  ordered candidate-name list — client-specific high-trust names before bare
  generics — and that string becomes the base key. It groups requests into a
  pile; it never says which conversation inside the pile.
- **Message ids** (host-minted per-message UUIDs, e.g. dsh's canonical stamps).
  Where present they are the arbiter between conversations that share one
  session id. Canonical shape rules live in `src/msgid-pin.ts` (length ≤512,
  reserved `acp_summary_` prefix rejected, control chars rejected); the parity
  pin `tests/msgid-rule-parity.test.ts` locks the hand-synced copies.

Both are bookkeeping between client and bili only: every internal field/header
(`biliMsgIds`, `x-bili-msg-ids`) is stripped before anything leaves the proxy
(`UPSTREAM_HOP_HEADERS`). Neither ever reaches the model endpoint.

## The resolution ladder (`src/session-resolve.ts`, `resolveSessionOrder`)

Under each session id, the resolver keeps a **skeleton**: message-kind sequence,
leading-fragment hashes, sha256 of the system/persona text ("" = non-anchoring),
and the declared model — debounced-persisted so restarts cannot rerun the
cold-start claim race (#3397). Every incoming request walks, in order:

1. **Dispatch lane token** (#5095): a per-dispatch token (claude subagents)
   claims its own deterministic key immediately — no corroboration needed.
2. **First sight under the id.** Main-shaped history claims the raw key.
   Tag-less shallow history (single user blob, no assistant turns) NEVER
   claims — it gets `<id>|sub:aux`; this is where the #1916
   review-steals-raw race dies without reading any prose.
3. **Byte-level continuation.** Prefix alignment plus trailing fragment
   verification. This is the fast path covering nearly every turn.
4. **Persona-text changed (same id, different system prompt).** Escape rungs,
   each demanding *verbatim* content evidence — "continuing history with a new
   prompt" vs "a stranger under the shared id":
   - head fragments replay verbatim (anchor migrated, #2241/#2250);
   - declared-model change corroborated by headers (#2601/#2817);
   - persisted prefix-chain continuity after restart (#2156/#2815);
   - ≥8 same-index agreement runs proving host-side edits of the same history
     (#4778, `CONTINUATION_MIN_RUN`);
   - shorter replay keeping a fragment-verified tail (#5686).
   Any rung passing → **re-anchor onto the raw key**. All failing →
   **derived-persona lane** `${sessionID}|sub:<fp16(personaText)>` — a
   deterministic suffix, so successive calls of the same persona always land on
   the same lane and the number of lanes does not grow with traffic.
5. **Same persona, diverged order.** Tail-aligned re-anchor (skeleton follows
   the living end); genuinely unaligned shape → derived-task lane
   `${sessionID}|sub:task:<skel8(kinds)>`.
6. **Last-resort message-id rung** (#5719, `tryMsgIdRescue`). Consulted only at
   the exits where every byte-level rung failed *because the byte evidence was
   destroyed in that same turn* (client compaction deleted rows while the
   volatile system-prompt field was rewritten — the #5719 incident). If ≥1
   incoming host id matches a row recorded under the session id's key in the
   unified store → same conversation, re-anchor. Zero overlap → confirms the
   fork. No ids on the request → fork proceeds exactly as pre-#5719.

Everything downstream (storage rows, fold blocks, watermark seeds, ledger seqs)
is keyed by the key the ladder returned — raw or suffixed — so two
conversations under one session id store, fold, and compress independently.

### Why the message-id rung is last, not first

The rule itself is unconditional: **session-id match + ≥1 overlapping message
id ⇒ same conversation**, no extra conditions (owner doctrine, implemented
exactly at `src/session-resolve.ts` `tryMsgIdRescue`). What is deliberate is its
position in the ladder. Recorded rationale (owner discussion 2026-11-07; ruling:
keep as-is):

1. **Semantic asymmetry.** *Zero* overlap is safe negative evidence; *positive*
   overlap does not prove "same conversation" for flows that legitimately share
   one session id while belonging to a different role (review/title/derived
   traffic embedding earlier history — incidents #150 fresh task, #1916
   auto-review, #4438 review riding the raw key through the full pipeline).
   Running the overlap verdict as a global first step would classify such
   requests as the main conversation before any structural check gets to
   separate them, and in stamped lanes — where the main flow re-sends ALL prior
   messages with their ids every turn, so overlap holds *by construction* —
   the multi-role split would be short-circuited permanently, turning every
   later rung into dead code. Correctness would then rest on upstream clients
   happening to omit ids, not on the judgment itself. Placed last, the same rule
   fires only where structural evidence already says "new conversation" AND the
   byte chain broke for a known benign reason — there, "some overlap" excludes
   every other explanation.
2. **Data locality.** The continuation check runs on the in-memory skeleton
   (populated by the previous request); the stored message-id set lives in the
   database. Putting the cheaper-to-compare but disk-backed check ahead of the
   memory-resident one adds a per-turn store read to the hot path.
3. **Availability.** Most lanes carry no message ids at all (un-stamped,
   un-wired); the rung simply does not exist for those requests.

## Switching layers (what merges vs what stays off)

| Layer | Mechanism | Default after merge |
|---|---|---|
| Session-id recognition (incl. new names `x-conversation-id`, `agent-session-id`) | ungated; value is client-supplied, used as a local key only, never forwarded | active for all installs |
| Message-id harvesting (proxy reads client-local transcripts/sqlite: claude-code, codebuddy, mcode, goose, qwen-code) | `env BILI_IDENTITY_HARVEST` **or** cohort `rollout.features.identityChannelHarvest` (either alone enables) × loopback source only | **off** everywhere until opted in |
| Row pinning (stamped/harvested ids written into stored-row identity, both wires) | pre-existing cohort `pluginLaneServerHistory` | 0% (unchanged) |
| Strip-before-upstream of internal id fields/headers | unconditional | neutral (fields were never supposed to leave) |

Full per-lane status table (wired / closure memo / deferred, with audit
reasons): `docs/identity-channels.md`.

## Trust boundaries and the degradation contract

- **Whole-turn degrade, never partial mispairing.** Any step failing (wrong row
  count, torn file, schema drift, validation reject, role spot-check mismatch)
  discards the ENTIRE candidate list for that turn and the request falls back
  to exactly the pre-wiring path. There is no mode that maps some messages and
  guesses the rest.
- **Loopback-only harvesting.** The registry refuses non-loopback sources even
  when enabled; the adapters assume a trusted local client.
- **Layout knowledge is source-audit grade.** Adapter expectations (tables,
  columns, ordering, which rows count) come from reading upstream source, not
  from measured installs — the reason harvesting ships behind opt-in switches.
- **Fork safety.** The only misassignment premise is two distinct conversations
  sharing long *verbatim* content under one session id; fragments are
  hash-grade, so this does not occur in practice. Documented corner: a shallow
  aux call can arrive first and race for an empty id; the main conversation
  then recovers or separates via the persisted-prefix-chain rungs — regression-
  pinned (first-sight claim rules, #316; #1916 aux branch).
- **Reachability caveat on the #5719 rung.** Whether review/aux dispatches ever
  ride stamped ids overlapping the parent's rows is conditional on host
  behavior not yet evidenced in production logs — tracked as a one-line trace
  log follow-up (PR #5826 review finding P1), deliberately NOT closed by guess.

## Change checklist

- New harvest lane: new `src/identity-<client>.ts` (self-contained, own
  storage-reader, joins ONLY on the recognized session id) + one registration
  line in `src/identity-sources.ts` + one row in both channel docs. Never read
  client storage from a use site (KDD #18).
- New recognized name: insert at the correct trust tier in
  `src/session-id.ts` client-specific-before-generic + precedence test.
- Any new internal id carrier must be added to `UPSTREAM_HOP_HEADERS` and to
  the parity-pinned validator surface (`tests/msgid-rule-parity.test.ts`).
