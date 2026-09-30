# Message identity: content hashes as the cross-turn join key

Design record for how billion-context identifies an individual message across
turns, and why identity is derived from message **content** rather than an
id assigned at ingress and persisted by the host. Written after the #1496
review; sibling document to `SESSION-IDENTITY.md` (which settles the same
question at session granularity). Implementation anchors:
`acp-kernel/src/wire/message-id.ts` (`deriveMessageId`),
`acp-kernel/src/refs.ts` (`assignRefs`), `acp-kernel/src/prune.ts`
(`isCovered`/`baseIdOf`).

## The question is the join key, not the id

"Assign a per-message auto-increment id at ingress" is not a proposal the
system lacks — it is what the kernel already does. Every inbound message gets
an `mNNNNN` ref from a session-scoped, monotonically increasing, never-reused
ledger (repo AGENTS.md: *Kernel Contract — message ids are never reused*).

The real question is what happens on turn N+1, when a stateless host
re-serializes the whole array from its **private** storage: what key do we use
to re-pin the ledger onto the new array? Position/order is falsified by
production evidence (below). The only key that is stable across all five hosts
and all four protocol lanes is the message's **content bytes**:

```
wire bytes  --sha256-->  h_<sha16>  --byRaw join-->  mNNNNN (ledger ref)
```

`deriveMessageId` hashes `role | contentType | toolCallId | toolName | text`;
`assignRefs` then attaches the ref first-wins (`if (map.byRaw[message.id])
continue`). The hash does not *replace* the auto-increment id — it is the
**join** that lets the id be re-attached.

## Handled ≠ authored ≠ stored

The tempting inference "every message passes through us, so we can stamp an id
on it, so 100% coverage" conflates three different properties. Verified per
host:

| Host | Re-serializes from private storage each turn | Can our stamped id round-trip? |
|---|---|---|
| codex (Responses) | yes (rollout file; environment_context items rotate) | **partially** — response-side items only (#242) |
| claude-code (anthropic chat) | yes (session JSONL) | no channel |
| pi (chat, MITM/plugin) | yes (`convertToLlm()` rebuilds arrays; message model has no id field) | no channel |
| omp | yes (pi-family plugin) | no channel |
| hermes plugin | yes (own store, `pre_api_request` hook) | no channel |

Coverage must be measured at the **re-join point**, not at ingress.

## Lane survey: where could an id even live?

| Lane | Message-level id field | Verdict |
|---|---|---|
| anthropic chat | none (only `tool_use.id`/`tool_use_id` pairing keys) | no candidate |
| openai chat | none (only `tool_calls[].id`) | no candidate |
| google | none (only `functionCall`/`functionResponse` pairing ids) | no candidate |
| responses | `input[].id` exists | **provider namespace**: #242 — our 66-char id exceeded the 64-char cap, 400 every turn; #1474/#1475 — Copilot requires `rs`-prefixed shapes; healing is now confined to our own `msg-proxy-*` namespace |

Three of four lanes have no field at all; the one that does has rejected
locally-minted ids twice in production. Ingress deletes replayed `msg-proxy-*`
ids (`src/loop/adapter-responses.ts:62-68`) precisely because they are
per-round artifacts, not identities.

## What "original bytes never change" actually means

The claim is directionally right with one mandatory refinement: **bytes
authored by the user/assistant are stable; slots authored by the environment
rotate in place.** codex `environment_context` is rewritten every turn;
anonymous OpenAI harnesses rotate the inline system `messages[0]` (#1148);
nudge text is re-injected per turn (#728). This is why `SESSION-IDENTITY.md`
keeps environment out of identity and why #1148's fix peels the leading
system run out of the affinity hash.

The prefix is even less stable than the item: rolling-window truncation
(dsh-class clients, 20–30 items), forks and rollback replays (#1148, #1102),
one-message side requests (#1307: `ctx==1` → 163/163 compression failures,
`ctx>1` → 62/62 successes), in-place rewrites (#1247), and host-side
self-compression (codex `/compact`, claude-code `/compact`).

## Failure-mode asymmetry: misattribution vs non-recognition

- **Position/order join fails → misattribution.** A ref or compression block
  attaches to the *wrong* message; decompress returns wrong content; silent
  corruption that cannot self-heal. #1307's original ≤2 count guard was
  exactly this class of order heuristic failing.
- **Content-hash join fails → non-recognition.** The conversation forks into
  a fresh session and rebuilds a cold cache. A performance loss that
  self-heals (#286 fork semantics).

Axioms should be chosen by their cheaper failure mode.

## Known cost of the hash axiom — and how it was fixed

Same bytes ⇒ same identity has a cost face: #1476 — a user re-sends a short
text identical to already-folded content; the bare `h_` id re-derives;
`isCovered()` swallows the fresh message. Note the **direction of the fix**:
kernel #459 added instance renumbering (`_1/_2…`), and #463 added the
`lastPassIds` snapshot to discriminate post-fold **echoes** (id ∈ covered ∧ ∈
previous pass → keep id, prune swallows it) from genuinely **new instances**
(id ∈ covered ∧ ∉ previous pass → renumber to a free `_k`). The content hash
stays the base; only instance discrimination was layered on top. Even the
hash axiom's own bugs are repaired by *keeping* the hash, not by retreating
to positional ids.

## The partial round-trip channel that exists — and why it is not identity

#242 is double-edged evidence. It proves a real store-and-replay channel
exists (codex persists our response-side `msg-proxy-*` ids into the rollout
and replays them). It also proves the channel is unusable as identity:
coverage is response-side items only (user-side items carry no id field),
upstream constrains the namespace (64-char cap, `rs` prefix), and it exists on
one lane of four. Its current use — round-2 lifecycle consistency plus
ingress stripping — is the local optimum.

## Tags are derived views, not stored identity

The `<acp:mNNNNN…>` tags are printed at **egress** (toward the model) from the
ref map and stripped at **ingress** from host-replayed bytes;
`renderMessage()` removes the message's own stale tag before re-rendering
(idempotent), while foreign tags survive as content. Identity never rides the
round-trip: same bytes → same hash → same ref → same tag, every pass.

The tag-echo incidents (#206/#295, #14, #673) are the empirical proof of why
this must stay so. Models sometimes imitate the rendered markup in visible
prose; hosts store those bytes verbatim and replay them; the imitation
amplifies (one stored message accumulated 77 echoed tags + ~3,300 blank lines
— #14; a typo'd tag name `acip` became a turn's entire visible text — #673).
The marker-into-storage channel is real but **dirty**: it typo-es, it
amplifies, it namespaces badly. Any marker-as-identity scheme would stake
identity on that channel. The design treats leaked markers as strippable
noise (`src/loop/tag-echo-filter.ts`, prose only — tool-call arguments are
never stripped, #1039) and re-derives identity from bytes.

## The one place upstream demands round-trip: strict-echo reasoning

DeepSeek-class gateways require the client to pass back the reasoning items
the gateway itself emitted ("the reasoning content from the previous turn must
be passed back in thinking mode"). This is the only mandated content
round-trip in the fleet, and bili's handling shows the pattern: it is treated
as a **repairable shape constraint**, not identity — #762 injected blank
`reasoning_content` on the chat wire, #1479/#1482 extend the repair to the
Responses wire and to loop retry paths, all gated on `isStrictReasoningEcho`
(learned 400 flag or deepseek origin/model) so non-thinking sessions stay
byte-identical. Identity bookkeeping is never involved.

## Rejected alternatives

| Direction | Why rejected |
|---|---|
| Ingress-assigned ids carried by host storage | No carrier field on 3/4 lanes; provider namespace rejections on the 4th (#242, #1475); coverage measured at re-join, not ingress (per-host table above). |
| Position/sequence as join key | Prefix instability is documented across six incident classes (#1148, #1102, #1307, #1247, host `/compact`, our own fold); failure mode is silent misattribution. |
| Near-match tolerance on content | Byte-exactness is load-bearing (same argument as `SESSION-IDENTITY.md`); fuzzy joins misattribute silently on decompress. |
| Promote `msg-proxy-*` to identity | Single lane, response-side coverage only, amplification-prone channel (tag-echo evidence), upstream namespace constraints. |
| Marker-as-identity (tags persisted by hosts) | The tag-echo incidents show the channel corrupts what it carries; current design already strips it at both ends. |

## Future direction

If a future host or lane offers a genuinely stable client-side message id,
it may be adopted **only as an additional join hint** — never as a replacement
for the content-hash base. Until then: bytes are the anchor, hashes are the
join, mNNNNN is the ledger, tags are the view.

Related: #1496 (this document's prompt), `SESSION-IDENTITY.md` (session
granularity), #1476 + kernel #459/#463 (echo discrimination), #242/#1475
(Responses id constraints), #206/#673 (tag echo), #1479/#1482 (strict-echo
repair), #1039 (tool-call byte-exactness invariant).
