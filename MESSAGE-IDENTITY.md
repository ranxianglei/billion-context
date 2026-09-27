# Message identity: why content hashes are the cross-turn join key

Design record settling the question posed in #1496: **can message identity be an
explicit ingress-assigned auto-increment id instead of a content-derived hash?**
Conclusion: no — message identity stays content-derived, and the question was
really about the *join key*, not the id. This is the message-granularity sibling
of SESSION-IDENTITY.md, which settles session-granularity identity. Implementation
anchors: kernel `deriveMessageId` (raw id minted from message bytes at ingress),
`session.state.messageRefs` (`byRaw`: hash → ref, `byRef`: ref → hash), ingress
alignment in `src/server.ts`, drift detection in `src/session.ts`
(`foldCoverage`, `detectUnannouncedHistoryRewrite`).

## Principle: the question is the join key, not the id

The ref ledger (`mNNNNN`) already IS a session-scoped auto-increment, never-reused
id — kernel contract, see AGENTS.md §2 "Kernel Contract: Message Ids Are Never
Reused". So #1496's real question is not "where do we get a stable id" but: at turn
N+1, what re-pins the persisted ledger onto the freshly re-serialized message array?

At turn N+1 the host re-serializes its entire history from its own private storage;
bili sees a new byte sequence, never the birth of the array. The join between the
persisted ledger and the incoming array must run on a key both sides hold. Content
bytes are the only such key stable across all supported hosts × wire lanes (the five
hosts surveyed in #1496 — codex, claude-code, pi, omp, hermes — over the four lanes:
anthropic chat, openai chat, responses, google). The raw id is therefore a content
hash (`h_<sha16>`, minted by the kernel from message bytes), and `byRaw` maps
hash → ref: **the hash layer is not an alternative identity, it is the per-turn join
that re-pins the incremental ledger onto the incoming array.**

Two consequences carry over from SESSION-IDENTITY.md:

- **Byte-exactness is load-bearing.** The id is derived from the exact bytes of the
  message; any byte change yields a different id. That is the contract, not a bug.
- **The hash doubles as a change detector.** Because the id is a function of the
  bytes, the moment a client edits or rewrites history (fork/regenerate/edit —
  #1148/#1102/#1247) the ids change, the join breaks, and the system detects the
  drift *from the break itself*: `foldCoverage` presence checks (#1195),
  `detectUnannouncedHistoryRewrite` (#1001), fork adoption (#629 family). An explicit
  assigned id would silently lose this signal — same id, different bytes, no alarm.

## Handled ≠ authored ≠ stored

Position A's core error (#1496) was conflating two arrays: the egress array (what
bili sends upstream after compression — which bili authors) and the ingress array
(what the host sends bili — which the host authors). **The join runs on the ingress
array**, and on that array the host holds authorship:

1. The client keeps its own session storage and re-serializes the full history every
   turn.
2. bili converts wire → core (kernel derives content-hash ids from the bytes in
   transit) and aligns against the persisted `byRaw` ledger.
3. Anything bili marks onto an ingress message lives only in that request's memory —
   it is never written back into the client's storage. Next turn the client resends
   its own copy, unmarked.

Per-host survey (all five supported hosts are "own storage + re-serialize per turn"):

| Host | Mode | Own storage | Do our marks round-trip? |
|---|---|---|---|
| codex | proxy · responses | rollout files | only what codex itself stored — #242 proves it stores and replays its `input[].id`, and upstream 400'd on ours |
| claude-code | proxy · anthropic | JSONL transcript | no |
| pi | plugin | own sessions | only bili-minted tool results / markers |
| omp | plugin | own sessions | same |
| hermes | plugin | own sessions | same |

Plugin mode is the one corner where position A partially holds: the agent executes
`compress` itself, so the tool call + result live inside the agent's own history and
bili-minted bytes there genuinely round-trip. But that does not remove the join need
for foreign messages (user text, non-bili tool results) — the majority of traffic. B
holds uniformly across all supported hosts; plugin mode is a bounded exception, not
a counterexample.

## No writable id field exists on any lane

An explicit id needs a lane with a message-level id field that (a) upstream accepts
with arbitrary values AND (b) the host stores back and replays. No lane has both:

- **anthropic chat / openai chat**: no message-level id field at all (only
  provider-minted `tool_use` / `tool_call` ids). Nothing to write.
- **Responses `input[].id`**: the field exists but is provider-namespaced — shape
  validated and replay-paired by upstream:
  - #242: bili minted `msg-proxy-2-<54-char upstream id>` = 66 chars > the 64-char
    cap; Codex Desktop stored it in its rollout and replayed it; upstream 400'd on
    every subsequent turn ("string too long … maximum length 64"). Conversation
    permanently stuck until #243 remapped via `hashId()` (28 chars total) plus
    ingress healing.
  - #1475: renaming provider-opaque ids (`rs_*` reasoning, `fc_*` function_call) at
    ingress broke Copilot (`Expected an ID that begins with 'rs'`); reasoning id ↔
    `encrypted_content` replay pairing means rename = identity break. Healing had to
    be confined to bili's own `msg-proxy-*` prefix —
    `sanitizeResponsesInputIds` (src/loop/adapter-responses.ts) deletes those ids
    (replay the full message instead) and shortens over-long foreign ids to
    `msg-fix-<hash>`; anything else passes through untouched.
  - The lesson: even where a host demonstrably stores-and-replays ids (#242 proved
    the round trip happens), upstream shape validation makes the field unusable as a
    free-form identity stamp. **Field present ≠ writable.**
- **google**: same provider-namespace pattern.
- Embedding an id into content bytes would violate wire fidelity (the #1039
  invariant — forwarded bytes stay byte-exact).

## Single-message bytes stable, array prefix unstable

Position A's second premise — "prefixes never change, order is a stable criterion" —
is false in production:

- **folds shorten the array**: bili's own folds replace covered ranges with their
  summary carrier;
- **host self-compaction rewrites history**: #1001
  `detectUnannouncedHistoryRewrite` (opencode silently rewriting history on model
  switch); the `REWRITE_MIN_INCOMING_TOTAL = 10` guard distinguishes true rewrites
  from stub side requests (#1075);
- **fork / regenerate / edit mutate early bytes**: #1148/#1102 branch replays,
  #1247 same-position rewrite;
- **side requests send short arrays**: #1307.

What does hold is the weaker axiom: **single-message bytes are immutable while the
message lives**. That is exactly the axiom a content hash needs — nothing more.

### Failure-mode asymmetry

This is the decisive argument. The two join candidates fail differently:

- **position join fails → misattribution.** Refs and compressed blocks attach to the
  wrong message — silent corruption. The #1307 incident (163/163) is the production
  instance; its original count guard (≤2) was a pure positional heuristic, and it
  failed.
- **hash join fails → non-recognition.** The message simply isn't recognized as
  known; the cost is one raw resend + ladder restart — a self-healing performance
  loss, never corruption.

A mechanism whose worst case is "slower" beats one whose worst case is "silently
wrong", every time.

## The hash axiom's own bug was fixed by keeping the hash

Content-derived ids have one inherent property: same bytes ⇒ same id. #1476 hit
exactly that — a resent user message collided with its earlier instance. The fix did
not retreat to positional ids; it layered instance discrimination **on top of** the
hash base: kernel #459 renumbers colliding instances (persistent `_1/_2` suffix
dimension — a kernel instance-durability contract) and #463 added `lastPassIds` echo
discrimination. Instance durability is orthogonal to "which base do ids derive
from".

Counterpoint worth recording: the colliding message was a USER message — precisely
the class that cannot carry a persistent ingress-assigned id (user-authored,
client-stored; bili never sees it being born). Under explicit ids, user/foreign
messages would still fall back to content hashes anyway.

## Tags are derived views, not identity

Render tags (`<acp tokens=… type=…>mNNNNN</acp>`) are a projection of the ledger into
visible text: rendered at egress, stripped at ingress, idempotent under re-render.
The tag-echo incidents (#206, #14, #673) prove the marker-into-storage channel is
real but dirty: models imitate tags in visible output (including typo'd names,
#673), clients replay the echoed tags, and the imitation amplifies. The repair lives
on the egress side — src/loop/tag-echo-filter.ts strips tag-shaped spans from model
prose only, forwarding tool-call arguments byte-exact (#1039 invariant). If tags were
identity, stripping them would destroy identity; the fact that they can be stripped
safely is exactly why they are views, not carriers.

## strict-echo reasoning: the one upstream-mandated content round-trip

Some upstreams (DeepSeek thinking mode, #684; history #762/#1479/#1482) reject
requests unless reasoning content round-trips paired with tool calls — a mandate to
preserve specific content bytes verbatim across turns. This is the only lane where an
upstream requires content round-tripping, and it is handled as a **repairable shape
constraint, never as identity**: `isStrictReasoningEcho` gates per session/upstream/
model (src/strict-echo.ts), `normalizeStrictEchoReasoning` repairs split-turn
signatures, and the fallback drops reasoning wholesale rather than half-preserving it
(`reasoning-pair-violated` warning, src/server.ts). The identity machinery neither
reads nor depends on these bytes.

## Future rule

If a genuinely stable client-side message id ever appears — a protocol field that
upstream accepts AND hosts store back (see the lane survey above) — it may join as an
**additional hint** at best (disambiguation, faster adoption, debuggability). It
never replaces the hash base. This mirrors SESSION-IDENTITY.md's future direction:
client-side signals narrow the search; the byte-exact hash stays ground truth. Any
proposal to swap the base must first answer the four questions this document settles:
who authors the ingress array, which lane carries the id, what is the failure mode,
and what happens to user-authored messages.

Related: SESSION-IDENTITY.md (session granularity) · #1496 (design review settled
here) · #1476 / kernel #459 / kernel #463 (collision + instance discrimination) ·
#242 / #1475 (Responses id namespace) · #1307 (positional heuristic failure) ·
#206 / #14 / #673 (tag echo) · #684 (strict echo) · #1039 (wire fidelity).
