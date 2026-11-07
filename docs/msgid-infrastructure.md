# Message-ID lane infrastructure: the sessionid+msgid production/consumption map

> Status: companion doc for the gap fix mandated by the #5826 release review (owner ruling 2026-11-07). Identity-ladder doctrine lives in MESSAGE-IDENTITY.md (kernel) and SESSION-IDENTITY.md (session side); this file does ONE job — explain where sessionid+msgid, the cross-lane public substrate, is produced, how it travels, who validates it (six copies), where it is pinned, its five consumers, and its declared trust boundaries. Read this before touching any of it.

## 1. What it is

The four plugin lanes (dsh / omp / opencode / pi) have their hosts stamp a stable UUID on every message (**msgid**), riding upstream with each request; bili pins message identity on it (survives rewrites/reordering/compaction). Server-side **sessionid** = the host conversation id (after persona-splitting rules it may carry a `|sub:<fp>` suffix, KDD #9). Together they are the first two dimensions of the ledger triple `(session_id, msg_id, content_hash)`: msgid fixes identity, content hash guards against mispairing (KDDs #11/#13 carry the ladder and snapshot-render doctrines; not repeated here).

## 2. Production (who creates ids)

| Layer | Content | Location |
|---|---|---|
| Host minting | Host assigns a stable per-message UUID within a conversation scope (no reuse after compaction); the `acp_summary_*` namespace belongs to kernel synthetic anchors — host ids must NOT claim it | dsh: `options.messages[].id`; pi/opencode/omp via their own host fields |
| dsh thin collectors | `hostMsgIdsOf` (all-or-nothing) + `pfSlotIdsOf` (per-slot variant, bad slots ride `?`) | src/agent/dsh-native.ts (~:1186/:1202) |
| pi parsers | `laneMsgIdsForWire` / `laneMsgIdsForOpenAiWire`; **call the canonical validator directly** (not a mirror); config-assembled leading system slot has no branch entry → synthetic `bili-ps-N` positional token | src/agent/pi.ts |
| opencode / omp | Reuse the same already-validated list (transform hook / `ompTurnMsgIds` fetch-layer alignment, anthropic-wire turns only) | src/agent/opencode-native.ts / omp lane |

Discipline: collectors only "obtain and pre-screen"; they hold NO identity-adjudication power — adjudication lives in §4 validators and §5 storage.

## 3. Transport shapes (how ids ride upstream)

Four carriers, **ALL stripped before forwarding to the model upstream** — the model wire still carries no message-level ids (#2821 doctrine):

1. **Envelope field** `biliMsgIds`: parallel array on full-resend model bodies, length-locked to messages, same lifecycle (stripped at ingress, src/server/prepare-anthropic.ts et al.).
2. **Incremental turn payload** `msgIds`: envelope on `POST /__bili/plugin/turn` (src/agent/incremental-client.ts); server re-stamps `biliMsgIds` (src/incremental-lane.ts).
3. **Watermark headers** `x-bili-pf-tail-ids` (v2-v4, #5403/#5418): window segment only = last anchor element + all elements added since K, percent-encoded per segment, comma-separated (commas inside ids travel as `%2C`, separators stay literal); sibling `x-bili-pf-count` count stamp. pf-* headers are **protocol headers, not hop headers**: stripped before upstream via `UPSTREAM_HOP_HEADERS`.
4. **Ledger-seq sibling** `biliLedgerSeqs` / `ledgerSeq` stamps (#4316 L3 PR2/3): 1-based positive-int parallel arrays, validated by `validateMsgSeqs`, same strict-validate-then-degrade lifecycle.

## 4. Validation copies (why six, and how they stay in sync)

Structural constraint: **injected host bundles run inside foreign runtimes and MUST NOT import server modules** (constraint comments at src/agent/dsh-native.ts ~:1177, src/agent/incremental-client.ts ~:227). Mirroring is therefore structural necessity, not laziness. The six copies and their screening faces:

| Copy | Location | Role | Strictness profile | Degrade direction |
|---|---|---|---|---|
| **canonical** `validateMsgIds` | src/msgid-pin.ts | Ingress gate (full resend + incremental turn gate) | Strict all-or-nothing + exact length; rejects: non-string/empty/too-long(>512)/reserved prefix/\s/\p{C}/duplicate | field dropped → turn falls back to content hash/id |
| lenient inbound variant `incomingMsgIdsOf` | src/msgid-pin.ts | #5719 last-resort-rung input | NO width contract, **NO dedupe gate**; control class = `\s`+C0/Del only (U+200B passes) | undefined → pre-#5719 path |
| dsh host mirrors | hostMsgIdsOf / pfSlotIdsOf (src/agent/dsh-native.ts) | host-side collection | all-or-nothing / per-slot `?`; full \p{C} class | turn falls back non-incremental / slot rides ? |
| incremental-client mirror `screenMsgIds` | src/agent/incremental-client.ts | pre-screen before riding the envelope | all-or-nothing boolean | "no field" fallback (avoids a 400 killing the whole request) |
| pf-channel inline screening | src/agent/pf-channel.ts (capture ~:99) | watermark id capture state machine | per-slot `?` + `MAX_IDS=2048` cap + failed resolution clears stored list | count-only mode |
| wire decode `parseTailIds` | src/server/fastpath.ts | server-side decode of the tail-ids header | all-segments voiding; as of the #5826 review enforces the FULL canonical reject set (reserved-prefix gate closed) | count-only this turn, no breaker credit |
| evidence-only lenient `collectRequestIds` | src/request-membership.ts | #4805 settlement membership probe input | SKIPS bad entries (does not void), NO control-char screen, falls back to resent toolCallIds | empty evidence → membership unresolved this cycle |

**Mechanical lock: `tests/msgid-rule-parity.test.ts`.** Every reject class is fed through every copy and the CURRENT verdict is asserted per copy. Deliberate divergences are pinned AS DIVERGENT (e.g. U+200B passing `incomingMsgIdsOf`/`collectRequestIds` — both are pure-evidence roles; such an id can never overlap a strictly-pinned stored id, so it cannot mis-anchor). Changing any copy's rules fails CI until you consciously re-pin the matrix with a rationale. "Keep in sync" comments are now CI-backed.

One-off closure from the review: `parseTailIds` alone lacked the reserved-prefix gate on the decode side; closed here. All production emitters pre-screened already, so this is defense-in-depth at the single server chokepoint, strictly more conservative (whole-list void → degrade), zero behavior surface.

## 5. Persistence single source of truth

The unified-store `messages.msg_id` column is the ONLY id truth: ingestion pins validated ids into rows (T5 ruling: no parallel ledger; skeleton rows carry no ids). Ledger primary key `(session_id, msg_id, content_hash)`; canonical rows key on **MSGID, not content hash** (#4491); fork clones preserve numbers (#4316 L3 PR3/3 `cloneSessionRows`).

## 6. Consumers (five; what question each one asks of the ids)

| Consumer | Location | Question answered | Id-usage boundary |
|---|---|---|---|
| ① storage-column identity | unified store `messages.msg_id` | join key for every settle/reconcile path | the single identity-space entry point; the other four's id evidence ultimately folds in here |
| ② session-resolve last-resort rung #5719 | tryMsgIdRescue (src/session-resolve.ts ~:324; fork-exit call sites ~:432/:481/:501) | after bytes/tag evidence was destroyed (compaction deleted cells, system rewrite deleted fragments), is this request the SAME session? | ANY id overlap under the same raw key ⇒ same session; NOTE: no LANE attribution (§7 boundary B) |
| ③ settlement membership probe #4805 | probeRequestMembership (src/request-membership.ts; call sites src/server/prepare-openai.ts:597, prepare-anthropic.ts:640; consumed cache-ledger.ts:1866) | was this id admitted by this session's ledger? needle = latest admitted id | **pure evidence — never enters the identity space**, never re-keys/forks; worst case one unsettled cycle, self-heals |
| ④ incremental-lane canonical rows #4491/#4834 | src/incremental-lane.ts (validateMsgIds :623, claim-reuse 400 :628, cache-control rekey :631-635; dsh-side burned-claim pre-screen ~:2584) | which canonical rows did this delta turn append? | claim semantics: re-sent claimed id = retry-storm signal, turn 400s |
| ⑤ watermark tail continuity v2-v4 #5403/#5418 | PF_TAIL_IDS_HEADER (src/server/fastpath.ts:48) | does the client's delta window still originate where the server seed says? | under v4 width self-consistency (len=T−K+1, re-verified server-side) the count echo degrades to diagnostic-only; ids prove WINDOW ORIGIN ONLY, never prefix integrity (owner ruling 2026-11-02; §7.4 blind spot stands, §7 boundary A) |

## 7. Trust boundaries (declared as part of the contract, not bugs)

- **A. §7.4 watermark blind spot:** prefix byte edits that keep element counts unchanged are undetectable. Human-review gate, never auto-merge; a multimodal tail entering cache permanently degrades that history to legacy turns.
- **B. #5719 last-resort rung lacks lane attribution:** "any id overlap ⇒ same session" does not distinguish main vs auxiliary lanes. If a host stamps overlapping ids onto persona/review side-dispatches (shared id space, or a review embedding parent-turn ids), the flow anchors onto the main session and `record()` overwrites the skeleton tag/model with the fork's own. Whether hosts actually do this is unprovable from the repo — conditional risk, disposition pending owner ruling (trace-log proposal in the #5826 comments). A naive tag-equality precondition is rejected: dsh rotates its system prompt per turn, so adjacent turns of the SAME lane differ, and the precondition would kill the rescue itself.
- **C. membership needle penetrable by aux embedding:** a side request embedding parent-turn ids can land the probe needle on a stale row → settlement unresolved that cycle (self-heals on the next main-scale resend). One lost cycle maximum under the evidence-only role; accepted.
- **D. host-minting premise:** ids stable and unique within conversation scope, never reused after compaction. Containment: a mispair pollutes at most the records under its own raw key, nothing beyond.

## 8. Change rules (checklist before touching any of it)

1. Add/change/remove any reject class → update ALL strict-family copies (`validateMsgIds`, `incomingMsgIdsOf`*, both dsh mirrors, `screenMsgIds`, pf-channel inline, `parseTailIds`) AND the matrix row in tests/msgid-rule-parity.test.ts, in one change. (*The leniency of `incomingMsgIdsOf`/`collectRequestIds` is intentional; changing it needs owner-level justification.)
2. New consumers register a row in §6 before writing code.
3. Host bundles must not import server modules (§4 structural constraint); new mirrors get their own row in the parity test.
4. Ids never reach upstream-visible bodies/headers (strip discipline, §3); pf-* headers keep protocol-header status.
5. Before discussing "id mismatch / destroyed misdiagnosis / cache broken" bugs, check the MESSAGE-IDENTITY.md ladder and §6 here to establish which consumer path the session takes.
