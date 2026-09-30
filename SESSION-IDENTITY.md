# Session identity for anonymous requests

Design record for how billion-context decides which session an **anonymous**
request (no `session_id` header or body field, no `prompt_cache_key`) belongs
to. Written as future reference after the tail-window reattach removal
(#1115). Implementation: `src/prefix-affinity.ts`; behavior tests:
`tests/truncation-fork.test.ts`, `tests/prefix-affinity.test.ts`.

## Principle: content is the only immutable anchor

Client-provided ids are honored verbatim. Partitioning sessions by anything the
client can rotate — credentials, relays, protocol translation — orphans state
exactly when the user keeps talking (the #286 lesson). For requests that carry
no id at all, the message content is the only stable thing both sides share, so
affinity is computed purely from the replayed history.

Two consequences follow:

- **Environment is out of identity.** System prompts, tool definitions, and
  model names never enter the hash. Summaries describe past turns under an
  earlier environment; including the environment would orphan every session
  whose harness rotates its prompt (common practice), defeating the mechanism.
- **Byte-exactness is load-bearing.** Message ids inside the kernel are
  content hashes and are never reused. Any near-match tolerance in this path
  would silently misattribute on decompress, so matching is always byte-exact.
  The only design freedom is *where* evidence may be sought — never *how much*.

## Full-prefix match — the only adoption path

Each tracked chain stores progressive hashes
`h_i = sha256(h_{i-1} || canon(msg_i))`. An incoming request matches when its
progressive hashes equal a stored chain's **head** for the longest strict
prefix (`via: "prefix"`). This is sound:

- Identity evidence is the entire shared head, anchored at position 0 — a
  different conversation cannot quote position 0 of yours without holding your
  actual opening turns.
- Divergence self-heals (fork semantics, #286): once a client edits or branches
  its history, the next request stops matching and mints a fresh session while
  the old chain keeps serving the unedited line. No explicit invalidation is
  needed.
- Safety: matching requires holding a byte-identical head, so folded state
  reveals nothing the requester does not already hold.

## Tail-window reattach — history and removal (#316 → #1072 → #1115)

### The problem it solved

A client that TRUNCATES its replayed history (drop-oldest, rolling window) no
longer matches from the head. Without reattach it would mint a fresh session on
every turn after the first truncation and never build a compression ladder.
Observed target class: dsh-style web clients retaining a rolling window of
20–30 items.

### The mechanism (removed)

The resolver slid the incoming's leading `w = min(8, depth)` per-item hashes
against **any mid-chain offset** of every tracked chain and adopted the stored
session on exactly one contiguous hit (`via: "tail-window"`).

### Why it was structurally weak

A mid-chain contiguous match is **symmetric evidence**: it cannot distinguish

- "same conversation, truncated replay" (the intended case) from
- "a different conversation quoting shared content" — templated tool outputs,
  standard file contents, stock error messages.

No attacker is required for the second case: parallel agents working the same
codebase produce identical mid-chain slices naturally (passive template
collision). And adoption was bidirectionally harmful either way:

- the adopter's rebuilt wire received the victim session's folded summary
  blocks (information leak across conversations);
- the adopter's new turns were recorded into the victim's session (context
  pollution for the real owner).

The interim mitigation (#1072) required the full 8-item window instead of 3,
closing sub-8 crafted windows — but a bigger threshold does not break the
symmetry: holding any 8 contiguous mid-chain items was still sufficient.

### Measurement before removal

Three days of production logs on this daemon's deployment (2026-09-19 →
2026-09-22), ~11.5k anonymous resolutions:

| Outcome | Count |
|---|---|
| full-prefix match | 9,367 |
| new session | 2,106 |
| fork lineage recorded | 142 |
| **tail-window reattach** | **0** |
| ambiguous multi-candidate tail hit | 0 |

Zero observed usage — including zero near-misses.

### Decision: drop mid-chain adoption entirely (direction 3 of #1115)

Truncated replays now fork into a fresh session (`via: "new"`). Cost accepted:
one raw resend plus a ladder restart — the same cost class instruction-drift
forks already accept (#1106). Two mitigations bound the loss:

- **Opt-in block adoption (#629)** carries compression blocks whose source
  messages remain fully present in the incoming replay (raw-id SET semantics,
  not prefix lineage).
- **Kernel reconciliation stays sound**: a truncated replay deactivates
  affected blocks gracefully, and a full replay revives them (pinned in
  `tests/truncation-fork.test.ts`).

The truncated-run scan survives in attribution form only: a NEW session whose
leading `TRUNCATION_LINEAGE_WINDOW = 8` run sits strictly inside (offset ≥ 1) a
tracked chain records `lineage: { reason: "truncated", parents }`; a shared
leading prefix (LCP ≥ `MIN_FORK_PREFIX = 3`) records `reason: "forked"` instead
and takes precedence. Lineage is logged and stored for UI/debug and **never
affects matching**.

## Rejected alternatives

| Direction | Why rejected |
|---|---|
| Suffix-anchored matching (match must end at the stored tail) | Works only when the client retains exactly the window length (K = 8). Documented rolling windows retain 20–30 items — the dominant legit case breaks. |
| Depth-scaled evidence (window must cover ≥ 50% of the stored chain) | A fixed 8-item window cannot cover half of any chain deeper than 16 items — kills long conversations, exactly the ones worth keeping. |
| Kernel-verified adoption (cross-check against the full kernel id chain) | Kernel ids are content hashes: the same symmetric evidence extended to greater depth. More precision, still no ownership proof; adds a session lookup to the anonymous hot path. |
| Tail-anchored longest-run + floor (dir 1+ variant) | Sound and preserves the feature. Declined *for now* because measured usage was zero; reconsider alongside a client-side identity signal rather than shipping speculative surface. |

## Three-layer identity framework

Continuity under mutation decomposes into three independent layers. The unit
of truth is the BLOCK, not the session — continuity is partial by
construction:

1. **Attach** — which stored chain a request belongs to. Evidence comes from
   what the client demonstrably holds; after #1115 only head-anchored
   full-prefix matches count.
2. **Block validity** — per-block, decided by the kernel from message-id
   PRESENCE (not position): covered messages missing ⇒ the block deactivates;
   they return ⇒ it revives. "Half a session" is the mechanical outcome of
   this layer, not a policy knob.
3. **Environment** — system prompt / tools / model are out of identity (see
   principle above). A changed environment changes future turns, not the truth
   of past summaries.

## Derived (child) sessions: lineage at birth (#1333, #1362)

When an agent spawns a child session — a subagent or fork that starts from an
empty history instead of resending the parent's conversation — that child
could not previously `decompress` or `search_context` content that was folded
away in the parent. Each lane now reports the lineage at birth: its identity
registration carries the parent's conversation id (`parentConversationId`),
and the proxy records a read-only link (`derivedFrom`) on the child session.
From then on:

- `decompress` / `search_context` fall back along the parent chain for
  content the child never saw itself (resident or on-disk parents,
  cycle-guarded, depth cap 8);
- nothing is copied into the child's state and the parent is never modified —
  fallback hits are read-only, so a child can never clobber what the parent
  still owns;
- if the parent is unknown to the proxy when the link is recorded, the child
  simply starts fresh.

| Lane | Parent signal |
|---|---|
| **pi** RLM inline spawn | `parentSession` in the session header (path to the parent session file, resolved to its session id) |
| **omp** fork / newSession | `parentSession` in the session header (bare session id or file path — both accepted) |
| **OpenCode V1** (native plugin) | SDK session info `parentID` (resolved once per session, cached) |
| **OpenCode V2** (native plugin) | `session.created` event `data.parentID` |

claude/codex/dsh need nothing here: they share one session id across
subagents or have no child-session concept at all.

## Future direction

The durable fix is a **client-side identity signal**: a stable
per-conversation id supplied by the client itself. Until clients provide one,
byte-exact head-anchored matching remains the safe floor, and any
reintroduction of suffix/mid-chain adoption must be justified against this
document's threat model first.

Related: #1148 (an OpenAI inline `messages[0]` system prompt bakes into
identity, asymmetric with other protocols — separate issue).
