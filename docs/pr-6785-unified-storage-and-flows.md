# PR #6785 in depth: unified-storage tables / implementation logic / data flow / switches

> Scope: `2026-11-15_msgid-snapshot-unified` @ `39941c816` (base `origin/master` `b10c1a0d4`).
> 134 files, +13740/−367. This is the **review-grade** full walkthrough of this PR: four parts (table structure / implementation logic / data flow / switches) plus measured validation and this round's findings and fixes. All line numbers refer to source at head.

---

## 0. What this PR actually is (one sentence + five blocks)

It turns the two O(full) paths — "recompute the outbound view from scratch every turn" and "re-dedupe the full inbound body every turn" — into **msgid-anchored sparse incremental structures**: an op-log materialized table on the outbound side (discussion #7398), watermark delta ingest on the inbound side (pre-existing #3133, this PR adds the parse layer), an incremental pin channel for identity (#7064 §8), and a full-resend watermark + delta tail slice on the fast path (#5403/#5418 + this PR). Five blocks:

| Block | Proposal / origin | Switch (default) |
|---|---|---|
| ~~① Snapshot base v2~~ (fold journal + egress-snapshot + scope-rev) | #5874 v2 / #7064 slimming | **RETIRED by this PR** (bc51c9445, 7439 ruling): the plane never shipped — replaced wholesale by the round-2 op log (`egress_state`/`egress_flow`, KDD #23); its stage-0 identity ledger (L1 world / pf pin) stays, but `storage.snapBase.*` is GONE from the config surface — a leftover `snapBase` key in your config is a dead key (ignored) |
| ② Outbound op-log (egress_state/egress_flow + rebuild-serve + server authority) | Discussion #7398/#7439 | `egressPlane` (0) — ONE switch for the whole new path |
| ③ Full-resend watermark + delta tail slice | #5403/#5418 + this PR | `pluginFullResendWatermark` (5) / `pluginDeltaResend` (0) |
| ④ Incremental msgid pin (tail-ids tail form) | #7064 §8 | `pluginMsgIdIncremental` (**100**, on by default from this PR) |
| ⑤ Server-side canonical history GA | #4491 | `pluginLaneServerHistory` (**100**, flipped 0→100 by this PR) |

---

## 1. Table structure (unified storage, SQLite, schema v12)

### 1.1 Migration mechanism (schema.ts)

- `STORAGE_SCHEMA_VERSION = 12` (schema.ts:105; this PR bumps it from 11).
- v12 is **probe-first** (checks for table existence instead of gating on the version number): sibling branch #5855 had already landed the pf-plane tables into shared databases as "v12/v13" (field case 2026-11-08: user_version 13, pf tables present, l1_world absent), and a version gate would skip those databases.
- All new tables are **additive**: an old build opening a new file ignores the extra tables; a new build opening an old file probes and adds what is missing.
- Per-database pragma at open (auto_vacuum=INCREMENTAL must be first): `journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON, journal_size_limit=8MiB`.

### 1.2 The 8 tables added by this PR (all DDL in schema.ts)

**l1_world** (schema.ts:377-391, `SNAPBASE_DDL_V12`) — the stage-0 identity ledger: host raw session id → proxy ledger identity + one-round arming + element-level world cursor + R3 breaker.

```
sess_raw TEXT PRIMARY KEY,        -- raw session id as written by the host
ledger_id TEXT NOT NULL,          -- resolved ledger session_id
witness_probe TEXT NOT NULL,      -- witness probe at first sight (identity evidence)
issued_at INTEGER NOT NULL, armed_at INTEGER,
tail_json TEXT,   -- LAST 512 host ids of the previous round's array (JSON string[])
head_json TEXT,   -- first 32
count INTEGER,    -- full array length
max_pos INTEGER,  -- append-only position frontier
r3_latched_at INTEGER  -- #6181 M3 persistent R3 breaker latch (NULL = not latched)
+ idx_l1_ledger ON l1_world(ledger_id)   -- serves deleteSession by ledger_id
```

(Shape after the #7064 slimming: the original whole `envelope_json` blob was DROPPED, demoted to "tail-512 / head-32 window + count + max_pos" — identity gate demoted to bookkeeping cursor; the middle of the array is no longer visible.)

**fold_journal** (schema.ts:413-427) — append-only fold-decision journal:

```
session_id TEXT NOT NULL, jseq INTEGER NOT NULL,
kind TEXT NOT NULL DEFAULT 'fold' CHECK (kind IN ('fold')),
block_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
input_hash TEXT NOT NULL,   -- sha256 over messages[ start_seq..end_seq ] (ALL generations, incl. retired)
created_at INTEGER NOT NULL,
PRIMARY KEY (session_id, jseq),
UNIQUE (session_id, block_id)  -- idempotent re-ingest; a replaced block keeps its first fold row
```

UNPIN is **not stored** — it is derived at read time from three conditions (block no longer active / a live row exists in the range / an id inside the range becomes live again past end_seq). The `covered_ids` column existed during development and was DROPPED by migration in the #7064 slimming (schema.ts:573-576).

**egress_snapshot** (schema.ts:441-453) — the cut-materialized outbound prefix **cache** (latest row wins, older rows trimmed in the same transaction):

```
session_id TEXT NOT NULL, snap_seq INTEGER NOT NULL,
watermark INTEGER NOT NULL,    -- max live seq of the pin set at cut time = hash scope
input_hash TEXT NOT NULL,      -- sha256 over LIVE rows seq <= watermark
prefix_ref TEXT,               -- CAS ref of the derived prefix JSON (NULL = hash pin only)
last_stable_id TEXT NOT NULL,  -- msgid at the stitch point
created_at INTEGER NOT NULL,
scope_rev INTEGER,             -- egress_scope_rev value at cut time (NULL = pre-upgrade row)
PRIMARY KEY (session_id, snap_seq)
```

(`ids_json` was DROPPED by migration; `scope_rev` was ADDed for the upgrade.)

**egress_scope_rev** (schema.ts:459-464) — per-session message-change revision for O(1) reader trust:

```
session_id TEXT PRIMARY KEY, rev INTEGER NOT NULL
```

Any write that can change the input_hash (retire/unretire, content_hash edit, hard delete, archive restore, backfilling an old seq) bypasses and bumps it; pure tail appends do not (seqs are monotonic ⇒ always outside every watermark).

**orphan_blocks** (schema.ts:475-483, #6785 step 7) — reaped block content moved to a table (out of the `sessions.orphans_json` blob):

```
session_id TEXT NOT NULL, block_id TEXT NOT NULL,
one_json TEXT, full_json TEXT NOT NULL,
PRIMARY KEY (session_id, block_id)
```

**state_fields** (schema.ts:491-498, #6785 step 8) — the unbounded kstate fields moved to rows:

```
session_id TEXT NOT NULL, field TEXT NOT NULL, value_json TEXT NOT NULL,
PRIMARY KEY (session_id, field)
```

The field set is **frozen** at slim.ts `ROW_BACKED_KSTATE_FIELDS` (9 fields: tokenSnapshot, tsStamps, lastPassIds, hiddenOrphanRefs, sweptOrphanCallIds, renderDeferredRefs, viewLatches, absorbed, rules); `tests/issue5874-state-fields` pins it.

**egress_state / egress_flow** (schema.ts:508-530, discussion #7398) — the outbound conversation op-log, two structurally identical tables:

```
session_id TEXT NOT NULL, log_seq INTEGER NOT NULL,
row_type TEXT NOT NULL CHECK (row_type IN ('B','I','D','U')),
msgid TEXT,          -- NULL for B/D; required for I/U
payload TEXT NOT NULL,
created_at INTEGER NOT NULL,
PRIMARY KEY (session_id, log_seq)
+ idx_egress_state_msgid(session_id, msgid)
+ idx_egress_flow_msgid (session_id, msgid)
```

- `egress_state` = serving reads + compaction physically trims below the watermark;
- `egress_flow` = append-only, **never deleted** (any historical log_seq can be rebuilt; rollback is based on this table, not on client resends).

Row payload contracts (egress-state.ts):
- `I`: `{"after": msgid|null, "ref", "tokens", "type", "content_hash", "role"?, "cas_ref"?}`
- `D`: `{"start": msgid, "end": msgid}` (closed interval; anchored to MSGIDS, not positions — "positions drift with other ops, msgids do not", KDD#11)
- `U`: `{"content_hash", "role"?, "cas_ref"?}` (the msgid column IS the target)
- `B`: `{"entries": EgressViewRow[], "watermark": seq}` (entries use CAMEL keys `contentHash/casRef`, unlike the snake keys of I/U)

`EgressViewRow` = `{msgid, ref, tokens, type, contentHash, role?, casRef?}`; `casRef` = the key in the unified content CAS of that message's **FINAL core JSON** (after reasoning-drop / image rescale, before outbound conversion).

### 1.3 Key columns on pre-existing tables (as they relate to this report)

- `messages` (schema.ts:181-195): PK (session_id, seq), UNIQUE (session_id, msg_id, content_hash), v8 added `identity` (cross-save join key) + `retired_at` (tombstone; no hard deletes in steady state), v10 added `ts`.
- `content` CAS (schema.ts:173-179): `hash PK, byte_len, refcount, algo='sha256', bytes BLOB` — one store for all bytes (messages, block summaries, media, CCR, egress prefixes, egress core JSONs), refcounted.
- `ccr_entries` (schema.ts:254-264): **this PR adds `orig_hash`** (+ index) — the byHash half moves into the CAS.
- `conversations` (schema.ts:273-281): **this PR adds `idx_conversations_session(session_id)`** — stage-0 reverse-looks-up the binding by session_id every turn; the PK cannot serve that.
- `blocks` (197-214), `dead_refs` (216-223), `refs` (229-237), `checkpoints` (239-252), `session_ext` (291-298), `kv_store` (303-310), `message_media` (315-320), `sessions` (148-171, the semantics of `kstate_json/ccr_json` changed via slim, DDL untouched).

### 1.4 MySQL parity (mysql.ts +274)

Ported: `orphan_blocks`, `state_fields`, `ccr_entries.orig_hash` (+ index, probe migration, archive/restore/cascade).
**Not ported**: `l1_world / fold_journal / egress_snapshot / egress_scope_rev / egress_state / egress_flow` — the snapshot/egress planes are **SQLite-lane only** (shadow.ts `egressOpLogSync()` returns null on the network backend; the recorder skips the whole turn).

---

## 2. Implementation logic (per module)

### 2.1 slim.ts (new, 185 lines) — CCR slimming + kstate row split

- `sessions.ccr_json` holds only the slim envelope `{version:1, ccrSlim:1, byRef:{key:{hash}}, orphanByHash?}` (slim.ts:20-48); `ccr_entries` rows hold the two CAS halves: `content_hash` = the entry JSON, `orig_hash` = the original text behind the entry.
- **null-orig contract**: a row with `orig_hash=NULL` ⇒ the whole store falls back to the file lane (hydrate returns null, never a partial byHash); `""` (empty-string hash) = a legitimately empty original (fork receipt stub); a missing byHash entry must land as null, never `""`.
- kstate: `splitKstate` moves the 9 frozen fields out of `kstate_json` into `state_fields` (slim.ts:155-185); readers apply rows over columns, writers upsert on change and delete the row when the value goes undefined.
- The steady-ingest skip check is upgraded to require all of `ord && content_hash && orig_hash` to match.

### 2.2 snap.ts (new, 493 lines) — the stage-0 identity ledger (decides identity only; no compression, no byte serving)

- `snapL1Record` → `hit|echo|arm|wait|issue|red` (snap.ts:80-114): new row issues; a different `ledger_id` = **red hard conflict, nothing is written** (R3 domain; the caller stays legacy); armed + probe match = echo; armed + mismatch = hit; not-armed + match → arm (one-round arming); otherwise wait.
- World cursor: `snapL1WindowRead/Upert` (snap.ts:138-165) read/write l1_world's tail/head/count/max_pos (window widths `WORLD_TAIL_K=512` / `WORLD_HEAD_K=32`, identity.ts:29/32).
- R3 latch: `snapR3LatchWrite` (snap.ts:179-191) UPSERTs a placeholder row (a first fault may precede any snapL1Record); latched sessions never re-arm.
- `foldInputHash` (snap.ts:252-268): sha256 over `[start_seq,end_seq]` in **ALL generations** (no retired filter — the fold's own ingest retires the covered rows in the same transaction, so a live-only aggregation at fold time would be empty), line format `${seq}\u0000${msg_id}\u0000${content_hash}\n`.
- `foldUnpins` (snap.ts:326-370): the single UNPIN predicate (the three conditions, see §1.2).
- Egress cut reads: `egressInputHash` (407-424, live-only, scope = watermark), `egressScopeRev`/`bumpEgressScopeRev` (430-450), `egressLatestRow` (477-486).

### 2.3 egress-state.ts (new, 365 lines) — the op-log engine (pure functions, testable)

- `diffEgressView` (153-204): the spine = the longest subsequence of `next`'s msgids that appears **in ascending order** in `prev` (two-pointer scan); a spine row whose contentHash changed ⇒ `U`; a prev row off the spine ⇒ emit the maximal contiguous `D` span in prev order; a next row off the spine ⇒ emit `I`s in next order (anchor = previous row); **a move = D+I, there is no M op**; op order D→U→I; invariant `replay(prev, diff(prev,next)) === next`.
- `nextLogSeq` is taken from **flow** (state is physically trimmed by compaction; flow is the superset).
- `egressStateAt(db, sid, x)` (264-274): replay flow up to `log_seq <= x` = rebuild at any historical point (rollback).
- `egressStateCompact` (278-292): the replay result is written as one `B` row (both tables) + physical delete of state rows below the watermark (flow untouched).
- Any anchor/endpoint/duplicate/malformed violation ⇒ throws `EgressStateCorruptError` (36-42) ⇒ the caller **degrades the whole session to legacy**, never a fuzzy fallback.

### 2.4 egress-record.ts (new, 102 lines) — per-turn recording (seg 3)

- `buildEgressViewRows`: the first row is system (`msgid="system:"+hash32`, `casRef=CAS(system text)` — **byte-stability IS the cache anchor**); one row per message, `contentHash=rowHash([id,role,contentType,text])`, `casRef=CAS(final core JSON)` (since head commit `39941c816` the tool-row sidecars (toolCallId/toolName) ride the body into the CAS, so serve no longer excludes tool rows). Ephemeral rows (nudge, sysNotes) are excluded by design (KDD#7).
- `recordEgressTurn`: prev = session cache or one-time hydrate; diff; append only if there are ops; **compact only when the batch contains a D (fold shape)**.
- Fix this round: unchanged rows **reuse** the prev `casRef` instead of putContent-ing again (previously every row's refcount grew +1 per turn with no matching release; the only release point was session cleanup — see §5).

### 2.5 egress-serve.ts (new, 65 lines) — rebuild-from-log + real swap (seg 4b)

`rebuildOutboundFromLog(view, store)`: skips the system row (the system block is ALWAYS live-built — the prefix-cache anchor discipline); a missing `casRef` (pre-seg4 row) or missing CAS body ⇒ returns null (**whole turn** stays legacy); the body must parse to an object with id/role and a legal role; then it runs the **exact same** chain as legacy, `hardenOpenaiAssistantContent(coreToOpenai(systemToUser(msgs)))` ⇒ byte-identical by construction.

### 2.6 Inbound: watermark delta ingest (pre-existing #3133; this PR did not change its core)

- Decision point `shadow.ts:679-703` (`ingestDelta`): `ingestWatermark` (sessions.last_ingested_seq + persisted tailSeqs, store.ts:2329) → boundary probe (:2403) → #3919 head id probe (:2418) → `planIngestDelta` → `ingestSession(delta)`; any null/false hop ⇒ the exact full path.
- `planIngestDelta` (ingest.ts:311-405) returns null when: pluginSnapshot non-empty / decompositionLog (#3301 import) / no watermark / `tail.length===trustedLen && !hasRawTail` (an equal-length tail is only a legal empty delta on the raw lineage — #2960 ⑤ fold re-renders may reorder) / **`tail.length < trustedLen` (the wire shrank = a fold happened ⇒ full)** / boundary or head probe mismatch.
- The new-messages loop serializes + hashes ONLY the new ones (`O(N)`), placeholder seqs `watermark+1+i`.
- Store-side guards `store.ts:1229-1281` (inside BEGIN IMMEDIATE): boundary **re-verified inside the transaction** (1231-1232); each new message is probed by `(session_id,msg_id,identity)` — any existing row ⇒ full path (1239-1247; #4390 identity is position-independent and retired counts as existing); renumbering `probe.maxSeq+1+i` (1253); tailSeqs prefix consistency (1256-1268). **A stale/external watermark costs at most one redundant full write; it never writes wrong rows.**

### 2.7 Parse layer: parse-defer (new in this PR)

- `fastpath-scan.ts`: `scanMessagesSpans` scans the raw body to extract messages-element spans (no parse); `synthesizeTopLevel` rebuilds the top-level object with `messages: null` as the "deferred" marker (null, not `[]` — `Array.isArray([])=true` would break the MISS re-parse path, and the relay guard passes null through).
- The `handle.ts` gate: openai-shaped + pf protocol stamp + body ≥ 1MiB ⇒ deferred; HIT turns skip the whole-body parse; only MISS re-parses once from the text in prepare-openai.

### 2.8 Fast path: watermark + delta arm (fastpath.ts / handle.ts)

- **Full-resend watermark** (#5418, rollout 5%): the response stamps `x-bili-pf-seq` (the messages element count, measured by a zero-allocation structural scan); the client echoes `x-bili-pf-count` + `x-bili-pf-tail-ids` (width `T − stampT + 1`, first slot = anchor, `?` placeholders); a HIT = previous round's canonical cores + only the tail window newly parsed (skips whole-body parse/conversion/pin-stash — the #5403 OOM producer).
- **Delta arm** (this PR, `pluginDeltaResend` 0): the client's body.messages carries ONLY the L new elements; the server rebuilds the view from the pinned prefix cores + the small slice. Any failing claim (count/body/tail-width mismatch, broken anchor chain after known ids, rollout off) ⇒ 400 `pf_delta_reanchor` + `x-bili-msgid-mode: full`; the client sends the full form that same turn — **one-round convergence, never a silent misread**; a delta miss NEVER falls through to legacy parse (treating the tail as the whole history = session destruction).
- Mismatch semantics (fastpath.ts:296-304): `stamp > T` = "ahead" (the wire shrank = a compression happened) ⇒ clear mode, full re-anchor next turn; `stamp === T` = "no-progress".
- **Bug A fix** (b4bbaaef): the HIT head check excludes the id field — after pinning, ledger rows carry host UUIDs while the fresh side carries content-hash ids, so per-slot comparison was guaranteed to false-negative.
- **Bug B fix** (2c3bdd10): a HIT turn's snapshot render produced ~2 rows ⇒ short rawTail ⇒ completeLog ⇒ sweep retired all prefix rows ⇒ the ledger drained ⇒ pin degraded every turn. Fix: on HIT set `session.lastMessagesFolded=true`.
- **Bug C fix** (9efbf8b7): new ledger rows on HIT turns carried h_ ids instead of host UUIDs (pinned rows only cover the window) ⇒ tail width perpetually off by one ⇒ full/incremental alternation forever. Fix: on HIT turns restamp `ledgerWindow` from the `s0.pinned` tail before snapshotMessages.

### 2.9 Incremental msgid pin (#7064 §8, default 100)

Steady turns declare ids via the bounded `x-bili-pf-tail-ids` (anchor + new, ≤2048 ids, `?` placeholders) or a short body id array; the server **re-stamps the prefix from ledger live rows** (ingest INSERT OR IGNORE on (session_id,seq) — a position's msg_id is written once). Acceptance rule (finalized 2026-11-19): the declared tail span [T-L,T-1] must be **row-by-row equal** to the ledger's overlap span; any drifted row ⇒ degrade to full, never 400; overlong sessions (>2048) pin fine with truncated tail lists (longer overlap = stronger proof). Snapshot rounds (empty ledger / post-fold re-anchor) send the full form; full form takes priority. The response stamps `x-bili-msgid-mode: incremental|full` (cleared on any 4xx; same learning point as pf-seq, pfLearnStamp). Mismatches self-heal in one round.

### 2.10 Admin surface

New loopback routes `GET /__bili/snapshot/r3-latches` / `POST /__bili/snapshot/r3-unlatch` (admin.ts +56).

---

## 3. Data flow (the complete path of one request)

### 3.1 Steady turn (+N new messages, pf HIT) — both incrementals active

```
Client POST /bili/http://<upstream>/chat/completions
  body: full messages (watermark full arm) OR only the L tail elements (delta arm)
  + biliMsgIds (full form) OR x-bili-pf-tail-ids tail form
  + x-bili-pf-count / x-bili-pf-seq (once learned)
  → [handle] readBody (155MB-class) → pf protocol scan (fastpath-scan, zero parse)
  → [fastpath] HIT (stamp advanced + anchor chain intact): skip whole-body parse/convert/pin-stash
  → [prepare-openai] rebuild view = pinned prefix cores + tail-window parse (delta arm)
     ├─ egressPlane ON: recordEgressTurn (sparse I ops, a few KB)
     │   → rebuildOutboundFromLog (op log + CAS) → swap into outbound bytes
     └─ OFF: legacy kernel view → coreToOpenai chain
  → [ingest] shadow.ingestDelta: watermark + boundary + head probe → planIngestDelta
     serializes/hashes only the N new rows → rows appended at watermark+1.. (watermark written in the same tx)
  → outbound: render-refs tags + nudge (per-turn ephemeral, never persisted) → upstream
  → response: x-bili-pf-seq (new T) + x-bili-msgid-mode: incremental
```

**New storage per turn = the new messages' CAS bytes + one I op (a few KB).** Outbound rebuild is O(tail) in steady state.

### 3.2 Fold turn (client wire shrank / server-side fold landed)

```
Fold tx: blocks insert/update + covered rows retired (same tx) + one fold_journal row
  (input_hash = all-generation aggregate over the range; egress_scope_rev bumped by the retire)
→ Next turn inbound: wire shrank ⇒ planIngestDelta null ⇒ the exact full path
  (full parse + INSERT OR IGNORE dedupe + retire ledger + watermark reset)
→ Outbound: the egress view shows -D (range) + +I (summary row) ⇒ batch contains D ⇒ compact B row
  (B = the full view row list; design-declared ≈8MB @ 100k rows; CAS bytes not copied, pointers only)
→ pf protocol: stamp > T "ahead" ⇒ clear mode ⇒ full form re-anchor this turn ⇒ incremental again next
```

**The cost is concentrated on the fold turn** (measured ~0.5–0.8s); steady turns return to O(tail). This is the designed cadence (fold = re-anchor turn), not a gap.

### 3.3 Anomaly / degradation paths (all "whole turn legacy, never guess")

| Trigger | Action |
|---|---|
| pf stamp missing/regressed/broken anchor chain | whole turn full parse + full path, restamp |
| delta claim fails | 400 pf_delta_reanchor + msgid-mode: full (one-round convergence) |
| any row in the tail-form ids vs ledger overlap drifts | degrade to full signal, re-anchor next turn (D1 family, never reject) |
| l1 red (ledger_id conflict) | write nothing, stay legacy, R3 domain handles it |
| EgressStateCorruptError (15 violation classes) | stop recording/serving for the session, whole turn legacy |
| serve rebuild missing casRef/CAS body/unknown role | whole turn legacy (4a shadow comparison keeps measuring) |
| stale watermark/external write | in-tx probe fails ⇒ exact full path, one redundant write |

### 3.4 Lifecycle (delete/archive cascade)

`deleteSession` (store.ts:~2586): messages/media/blocks/**fold_journal/egress_snapshot/egress_scope_rev/orphan_blocks/state_fields** + dead_refs/refs/ccr_entries/conversations/session_ext/sessions + l1_world (by ledger_id) + CAS release and scoped collection.
`archiveSession`: same (minus l1_world); the JSONL export is appended **before** COMMIT, state flips to archived.
**Fixed this round**: both now also sweep `egress_state/egress_flow` (previously leaked ⇒ op-log rows were permanently orphaned, the "storage only grows" p1 class; their CAS-referenced halves are released with them, while message bytes stay held by the messages rows).

---

## 4. Switch ledger

### 4.1 rollout.features (src/rollout.ts; env `BILI_ROLLOUT_<KEY UPPERCASE_UNDERSCORE>`)

| Key | Default | Change in this PR | Effect | Rollback |
|---|---|---|---|---|
| `pluginLaneServerHistory` | **100** | 0→100 (GA, owner ruling 2026-11-13) | ⑤ server-side canonical: biliMsgIds row pinning + /__bili/plugin/render + incremental-lane serverHistory announcement | env=0 |
| `pluginMsgIdIncremental` | **100** | new, on | ④ tail-form id declaration, ledger re-stamps prefix | env=0 |
| `pluginFullResendWatermark` | 5 | (existing 5% rollout) | ③ watermark fast path | env=0 |
| `pluginDeltaResend` | 0 | new, off | ③ delta tail-slice arm; 0 = 400 on delta requests, client converges to full in one round | born in rollback state |
| `egressPlane` | 0 | new, off | ② the WHOLE new path under one switch: sparse-op recording (all four lanes) + serve-from-log (byte-identical swap) + server authority for pinned plugin lanes (rulings #7439 3/5); off = legacy chain, zero rows, byte-identical to pre-feature. Replaces the retired `egressOpLog`/`egressServeLog` pair | born in rollback state |

**No new static env vars, no new CLI flags** (rollout env names are derived dynamically from key names; the docs-coverage CI exempts dynamic names in both directions — which is also why `pluginMsgIdIncremental` went undocumented until now; the yaml entry was added this round).

### 4.2 Config objects

| Key | Default | Effect |
|---|---|---|
| ~~`storage.snapBase.*`~~ | — | **RETIRED by this PR** (bc51c9445) — removed from config.ts/knobs.ts; a leftover key is ignored | `network.ingestBodyBytes` | 32MiB | inbound body cap (the measured 155MB scenario needs 1GiB; env `BILI_INGEST_BODY_BYTES` takes priority) |

### 4.3 Response/request headers (protocol surface)

`x-bili-pf-seq` (bili→client, element-count stamp), `x-bili-msgid-mode: incremental|full` (cleared on any 4xx), `x-bili-pf-delta: 1` (client→bili, hop header, stripped before upstream forward, headers.ts:40), `x-bili-pf-tail-ids` (client→bili, ≤8KB budget; over budget the header is omitted — the body full form is NOT suppressed).

---

## 5. Measured validation (ideal-model incremental bench) and this round's fixes

### 5.1 Bench method (perf/, 2026-11-21)

Construction = the user scenario's plugin shape: client history grows from 1 message (pure append-only); the fake ideal model injects a compress tool call every ~300 refs of growth (≈50k tokens), folding the oldest span and keeping 1800 refs (≈300k-token live tail) — **the client applies folds host-side** (plugin semantics: the model initiates, the client executes), so the wire stays at the live view (1800–2100 messages, 0.7–0.8MB request body, outbound 200–253k tokens) while `cum` counts cumulative created messages (to 100k). Arms: master (`b10c1a0d4`, no pf) / PR full arm / PR delta arm. All arms share fake calibration and driver (node:http `connection: close` — bili closes the connection after each turn by design, #1982). **Note: every run in this batch was with the egress plane OFF** (the #7398 arm is untested, see §5.4); the 155MB raw-wire shape (a host that never folds) is not covered by this batch.

### 5.2 Measured (RUN1 batch=500 all three arms 210 turns; RUN2 batch=100 only the PR full arm reached g943≈94k — the master arm was aborted by a mis-killed proxy, the delta arm never launched)

**RUN2, PR full arm, by cumulative scale** (wire constant ~720–840KB, outbound 200–253k tokens, a fold every ~3 turns):

| Cumulative created | 10k | 30k | 50k | 70k | 90k | 94k (non-fold turn) |
|---|---|---|---|---|---|---|
| PR full | 526ms | 501ms | 1170ms | 1346ms | 1650–1737ms | 1821ms |

**RUN1 @ 100k cumulative, steady 10-turn segment** (wire 720KB, view 1801 rows, folding stopped):

| Arm | Steady range | Notes |
|---|---|---|
| master full | 1312–1624ms (p50 ~1338) | pf=null (no watermark) |
| PR full | 1613–2322ms (last 1613) | pf=1804, mode=incremental |
| PR delta (invalid arm) | 1891–2849ms | config lacked `pluginDeltaResend` ⇒ x-bili-pf-delta ignored = full + dead header |

**Honest conclusions**:
1. At view-shaped wire (~750KB), per-turn cost rises linearly with the **cumulative ledger size** (10k→0.5s, 94k→1.8s), independent of wire size — the cost sits in the inbound ingest/scan domain of 94k messages rows + 309 fold_journal rows (the slow-ingest log names #5744; WAL 33MB/ingest), not in this PR's structure.
2. The "<1s per turn" target is met up to ~30k scale (501ms) and crossed at 50k (1170ms).
3. Static replay (comp1200k: 781 rows / 1.2MB view, no ledger accumulation) measured the delta arm at 32–62ms vs ~91ms full — the structural ceiling (pure wire-bound) is far below the growing runs; the gap = accumulated-ledger cost, the next profiling target (see §5.4).
4. The delta arm has no valid data in the growing scenario (needs a rerun against a proxy with `pluginDeltaResend:true`).

### 5.3 Findings and fixes this round (minor issues fixed directly, shipped with this report)

1. **[p1 storage-only-grows] deleteSession/archiveSession missed egress_state/egress_flow** ⇒ op-log rows + their CAS references permanently orphaned. Fix: store.ts `deleteEgressOps` + both cascade call sites.
2. **[p1 storage-only-grows] buildEgressViewRows putContent-ed every unchanged row every turn** (CAS refcount +1 per row per turn, no matching release) ⇒ the content store of any egress-keyed session grew without bound. Fix: unchanged rows reuse the prev casRef (missing ones backfilled, changed rows re-put).
3. **[docs] `docs/proposals/snapshot-compression-foundation/`** described the RETIRED v1 four-table plane (snap_rows/snap_log/snap_ckpt were dropped before merge; the title still claimed "DDL landed in #5901") — contradicts the current v12 shape ⇒ **removed entirely**.
4. **[docs] `docs/storage-relations.{en,zh}.svg`** was missing 5 new tables, the fold_journal card still listed the dropped covered_ids, the egress_snapshot card still listed ids_json, and the ⑦ cascade card was inaccurate ⇒ **removed**, superseded by this report.
5. **[docs] rollout.yaml three stale entries**: pluginLaneServerHistory default "0 (off)" (code is 100), egressServeLog described as "seg 4a LOG ONLY never swaps" (4b really swaps), missing pluginMsgIdIncremental entry ⇒ all corrected/completed, docs regenerated.
6. **[comment] rollout.ts egressServeLog comment** — "(AND egressOpLog is on)" and "tool rows in v1" both stale ⇒ corrected.
7. **[switch] the egress keys collapsed to ONE** (owner ruling 2026-11-21): the `egressOpLog` + `egressServeLog` pair was retired and replaced by a single `egressPlane` rollout key — on = the complete new path (record + serve + server authority, all four lanes), off = legacy chain byte-identical to pre-feature. Both old keys never shipped (default 0, born in rollback state), so there is no migration.

### 5.4 Left for follow-up (out of scope for this PR)

- **Minimal validation with the egress keys ON** (pending): 155MB raw wire (host never folds) + egressPlane real serve ⇒ the full scenario with 300k-token outbound, checking the "few-KB new storage per turn" red line per turn (WAL diff) — this is the #7398 acceptance line; this batch did not cover it.
- Profiling the accumulated-ledger cost of 1.1–1.8s per turn at 50k+ cumulative scale (the slow-ingest #5744 domain; includes the fold-turn retire+re-anchor, the fold-crossing gate over 309 fold_journal rows, kernel scans).
- A valid delta-arm rerun in the growing scenario (with `pluginDeltaResend:true`).
- The compact B row ≈8MB @ 100k rows vs the "few-KB per turn" red line: a design-declared exception (#7398 §5); to hold the red line strictly, the B row could become a "range reference + anti-forgery fingerprint" (the #7064 l1_world demotion idea), at the cost of losing the state table's self-contained replay closure — needs an owner ruling.
- After an archive restore the egress op-log restarts empty (the next turn re-appends the full +I view — correct, but one full batch).

## 6. Round 2 — ruling 7439-2 (KDD #23): the op log as sole canonical, lazy projection, window re-anchor (2026-11-22)

> Round-2 work landed on the same branch after the §1–§5 snapshot. Where this section and earlier sections conflict, THIS section wins.

### 6.1 R-A: canonical message numbering (op_seq / log_seq)

- Both egress tables carry TWO keys: `op_seq` (PK, per-table append-only row cursor — the recovery/truncation key) and `log_seq` (canonical message number, **I rows only**; D/U/B rows are NULL). `log_seq` is session-scoped and **never re-issued** (kernel id contract); every I row's `log_seq` = the canonical index of that turn's new row in the live view, stamped at record time — numbering no longer derives from position or from the messages table.
- `recoverEgressBase` is bounded (the state table is physically compacted); a row-less session bootstraps via a fresh B op; a pinned session with rows but **no healthy point hard-fails the turn** (ruling 7439-5: 500 + `x-bili-egress: unreadable` + `{type:'egress_flow_unreadable'}` via `EgressAuthorityRejectError` — the lane catch no longer swallows it; the session never truncates its own corrupt rows and never re-bootstraps from client bytes).
- R-B: fork = `egressFork` whole-table op-log copy (self-fork throws; empty parent no-ops).

### 6.2 B: in-txn window re-anchor delta (#7474 — the 2s-floor root cause)

Root cause of the pre-fix growing-session latency (ep3 ON 5697 ms/turn @ 100k): the pf-watermark lane persists ONLY the ~56-element tail window every HIT turn (`lastMessagesFolded`), while `planIngestDelta` was built for strict-append turns — its equal-len/shrink/boundary-id gates structurally rejected a sliding window, so nearly EVERY turn fell to the full path: `remapPlanToAbsolute` = SELECT **all** ~100k session rows + identity→seq map rebuild + per-row byte repair. Writes were never the cost; the READ was O(total ledger).

Fix: `planIngestReanchor` + the `ingestSession` re-anchor txn branch. Per window row, ONE indexed `(session_id, msg_id, identity)` probe: existing rows **keep their seq** (identity-stability invariant; byte-hash + retired_at checks), new rows land at `MAX(seq)+1`, #6947 ref backfill; `anchored === 0` or a stored-`tail_json` mismatch → the branch declines and the full path runs UNCHANGED. O(window) point lookups ≈ ms; the full path remains the universal fallback.

### 6.3 P2b/P2b-ext: the egress-on session's messages projection goes LAZY (KDD #23)

For sessions with `metadata.egressAuthority === true` (and `egressPlane` on):

- **No per-turn unified ingest**: `ingestRowsNow` and the debounced unified legs early-return — the `messages` table is demoted to a **lazy projection** for these sessions (rebuilt one-time O(n) on plane rollback / web read / replica restore). Boot after restart still comes from the op log (`recoverEgressBase`), not from the projection.
- **Pin channel reads the op log**: the KDD #21/#21 pin ledger (tail-overlap / live-id re-stamp) for egress-on sessions resolves from `egress_flow` I rows (msgid + log_seq) instead of the messages ledger (`snapPinLiveIds` shim). Wire unchanged.
- **Envelope frozen at bootstrap** (`d28d9ff3a`): no per-turn read+rewrite of the 15.5MB growing session JSON (kernel refs are never pruned — messageRefs 10MB + tsStamps 5.5MB at 100k); the frozen route must keep the resident fields unthinned (`9183ea817`, #4788 D2) or the pinned turn 502s.
- **Verification**: the egress probe (flow vs client sample) is the SOLE drift verifier for egress-on sessions — `BatchedViewVerification` is off for them (`13b9baae2`): the client-vs-canonical leg would only measure the known server-wins divergence (ruling 7439-5) and re-latch drift forever.
- Flow-corruption semantics: HARD FAIL, no projection fallback for outbound — flow and messages die together anyway (flow independence, ruling 7439-2 §2).

### 6.4 Post-fix measured (100k cumulative, folded shape view ~1800–2100, 8-turn steady, same box/dist per pair)

| run | arm | build | steady p50 / max | total |
|---|---|---|---|---|
| ep3 | ON pre-fix | a33d02184 | 5697 / 6298 ms | 3273 s |
| ep5f | OFF pre-fix | a33d02184 | 2301 / 2946 ms | 1124 s |
| ep8d | OFF post-B | fb88bc2af | 1954 / 2735 ms | 1067 s |
| ep10 | ON post-fix | fb88bc2af | 1327 / 1374 ms | 676 s |
| ep18 / ep20 | ON merged | dbf4b140b | 730 / 761 · **638 / 655 ms** | 462 / 456 s |
| ep22 | OFF merged | dbf4b140b | 2016 / 2957 ms | 1070 s |

**Acceptance `<1s` @ 10w cumulative met by the ON arm (638 ms p50, 9× faster than pre-fix); ON is now faster than the same-build OFF arm.** ep20 DB: no JSON envelope, messages table 0 rows for the egress-on session, egress_flow 1 row/turn, state 25 rows bounded, WAL capped at 8 MiB (journal_size_limit). The OFF-arm floor (~2s) is the pre-PR #5744 family (per-turn full read+rewrite of the growing JSON envelope + 244MB DB fsync) — out of scope per the single-switch ruling. The ep14c-era 2.2GB WAL anomaly was a pre-WAL-cap build; post-cap builds hold 8 MiB.

### 6.5 Resident perf gate (ruling: e2e bench ×3, ≤+20% over baseline)

`tests/egress-bench.test.ts` (gate `ACP_TEST_EG_BENCH=1`; dedicated CI lane `.github/workflows/ci-e2e-egbench.yml` on master): hermetic in-process proxy (port 0, temp XDG), 30k-row growing pinned session with host-side folds + the pf watermark channel, median-of-3 steady p50/max within +20% of `tests/e2e/bench/egress-bench.baseline.json` (calibration 201/300 ms; missing baseline prints CALIBRATION and passes). Pins per-turn cost to O(live-window): a regression back to a full-table path goes red. The 100k growing-run matrix above stays as the deep-dive reference; the bench is the resident guard.
