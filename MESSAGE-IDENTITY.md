# Message identity: content hashes as the cross-turn join key

Design record for how billion-context identifies an individual message across
turns, and why identity is derived from message **content** rather than an
id assigned at ingress and persisted by the host. Written after the #1496
review; sibling document to `SESSION-IDENTITY.md` (which settles the same
question at session granularity). Implementation anchors:
`acp-kernel/src/wire/message-id.ts` (`deriveMessageId`),
`acp-kernel/src/refs.ts` (`assignRefs`), `acp-kernel/src/prune.ts`
(`isCovered`/`baseIdOf`). #2480 later split the question in two: the
**kernel ledger** below stays content-hash, while the **fold-coverage
re-anchoring layer** (`src/fold-reconcile.ts`) became positional-with-a-
self-stored-canonical-copy — see “The fold-coverage layer goes positional”
below; nothing in this document's ledger contract changed.

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
| dsh | yes | **host-model id via side-channel** — `MessageBase.id` is stable across representation boundaries; the plugin reads it off the outgoing body and stamps `_bili_message_ids` when the host serializer includes it (#3464) |
| opencode | yes | **host-model id via side-channel** — `msg_…` ids, same mechanism (#3464) |

Coverage must be measured at the **re-join point**, not at ingress. The two
side-channel lanes above are the R1 adoption: the host's own storage id is
the join key, and bili never mints or rewrites it.

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

## Hosts must keep tool-call ids byte-stable within a conversation

The hash includes `toolCallId` as a factor, and the fold-reconcile layer
(`src/fold-reconcile.ts`, #1921) uses it as its primary claim key:
`tool_use.id` / `tool_call_id` are the only fields that are both
protocol-unique per conversation and survive client re-serialization
verbatim. That premise has one external dependency — the **host itself**
must not rewrite those ids when projecting one conversation onto another
provider. #2396 found a real violation: Prime (pi-family runtime) switched
one conversation from Codex to a custom Responses provider, and its
foreign-provider converter re-sanitized the stored composite ids —
`call_switch_seed|fc_0_0` serialized as `call_switch_seed` on the Codex
lane but went out as `call_switch_seed_fc_0_0` on the foreign lane, on both
sides of every pair. Both claim passes key on the id, so every folded tool
pair stopped matching: context billed at ~66,525 input tokens re-entered at
558,541/562,549 against a 500,000-token window.

Bili's response follows the failure-mode axiom above: it does NOT guess
old→new pairings (that would convert non-recognition into misattribution —
decompress returning wrong content under a plausible-looking id swap). It
detects the shape instead: a missing covered id whose normalized identity
WITHOUT the toolCallId matches an inbound twin carrying a different
toolCallId is counted as a rewrite suspect and named in the drift log
(#2396), while the originals honestly re-enter the wire unfolded. The
obligation belongs to hosts — see PLUGIN.md ("Obligations of a plugin",
item 5): canonicalize ids at the host boundary before the payload reaches
the proxy. The #2396 workaround (rewrite `call_id` + `call_output.call_id`
together from the authoritative stored history before proxy processing) is
the reference implementation of that duty.

#2480 later dissolved the detection-only stance for this class: the missing
piece was **host knowledge of what the bytes used to be**, and the
fold-coverage layer now keeps exactly that — a self-stored canonical copy
(see next section). Position supplies the pairing, the stored fingerprint
verifies it, so claiming across a host-rewritten id scheme is no longer a
guess. The drift log and the honest re-entry fallback both remain for the
cases the copy cannot cover (structural edits, beyond-window history).

## The fold-coverage layer goes positional (#2480)

The kernel ledger and the fold-coverage re-anchor answer different
questions:

- **Ledger join** (turn N+1, re-pin `mNNNNN` onto the re-serialized array):
  content hash, unchanged, per everything above.
- **Fold-coverage re-anchor** (which inbound messages are the ones my
  compression blocks already cover?): `src/fold-reconcile.ts` now answers
  this by **position plus a self-stored canonical copy**, ahead of the
toolCallId and normalized-content passes it already had.

Mechanics: every reconcile pass rolls `foldPositions` — per-position
`sha256-16` of `role | toolName | canonical text` (JSON-shaped text is
key-sorted and compacted; prose keeps raw bytes; `toolCallId` and the
`contentType` literal are excluded because they are exactly the tokens that
re-encode across codecs; **reasoning is fingerprinted on role alone** — the
responses adapter projects the provider item id as the core text, so hashing
it would break every pairing at the first reasoning message of a churn).
Pass 0 then aligns the churn region head-first and tail-first, claiming an
old covered id onto its new counterpart **only when the fingerprint matches
at the aligned position**; the first mismatch stops the scan, so mid-history
insertions and deletions honestly refuse to bridge. Sessions without a copy
(the entire installed base at upgrade time) pay nothing: the first steady
pass stores the copy, and the *next* drift is claimed positionally —
migration is free because "cannot be recognized" is itself a fresh sequence.

Why this does not contradict the position rejection below: raw position was
rejected because with no memory of the old bytes, a positional claim is a
**guess** and fails as misattribution. The copy converts the guess into a
verified equality at an aligned offset — the same axiom, one layer up:
fingerprint mismatch → honest non-recognition (unmatched, #1001/#1195
lanes), never a wrong claim. The verification matrix lives in
`tests/identity-proof.test.ts` (mechanism-level, judge-billed, after
`tests/cache-proof.test.ts`): 4 wires × 3 phases (fold settles → id-scheme+
serialization churn keeps coverage → mid-history edit honestly re-enters),
a reconcile-off control proving the churn re-bills without the layer, a
cross-wire client swap (anthropic → chat) retaining coverage end to end,
and a model-switch phase (#2636): the chat lane carries reasoning-bearing
assistant turns and image-bearing user turns, then replays the history onto
a differently-shaped model (reasoning inlined pair→merged, images
placeholdered) — coverage must survive the shape churn with the covered
thinking never re-entering, judged on the FIRST post-churn body (a fresh
server-side compress may re-fold a failed replay — the healed round-2 must
never stand in for the retention proof), plus its own reconcile-off control
proving this churn class re-bills without the layer.

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
| Position/sequence as join key | Prefix instability is documented across six incident classes (#1148, #1102, #1307, #1247, host `/compact`, our own fold); failure mode is silent misattribution. Still true for the **ledger join**; #2480 later adopted position **with a self-stored canonical copy** for the fold-coverage layer only, where per-position verification removes the guessing — see above. |
| Near-match tolerance on content | Byte-exactness is load-bearing (same argument as `SESSION-IDENTITY.md`); fuzzy joins misattribute silently on decompress. |
| Promote `msg-proxy-*` to identity | Single lane, response-side coverage only, amplification-prone channel (tag-echo evidence), upstream namespace constraints. |
| Marker-as-identity (tags persisted by hosts) | The tag-echo incidents show the channel corrupts what it carries; current design already strips it at both ends. |
| Implicit aliasing of host-rewritten tool-call ids | Pairing a missing covered id with an inbound twin that has identical content under a different toolCallId requires host knowledge; without it the claim is a guess and misattributes on decompress (#2396: Prime rewrote composite ids across a provider switch). Detection-only shipped; the fix belongs at the host boundary (PLUGIN.md obligation 5). #2480 update: Pass 0 now supplies that host knowledge (position + stored canonical fingerprint), so this class is claimed rather than only counted; PLUGIN.md obligation 5 stands for hosts that can canonicalize earlier. |

## Host-stable ids: the R1 channel (#3464, supersedes the old "future direction")

The old stance here — a host-stable id could at best be an *additional join
hint*, never a replacement for the content-hash base — is superseded by the
owner rulings on #2938 (hash demoted to second-class citizen; order-centric,
never fuzzy) and #3464 (R1 of the #2960 identity pipeline). Lanes whose host
model carries a stable per-message id (dsh `MessageBase.id`, opencode
`msg_…`) now ride it into bili through a **side-channel top-level body field**
(`_bili_message_ids`, index-aligned with `messages`; the wire protocols
themselves still offer no id field — the survey above stands). On stamped
lanes identity becomes exact set algebra instead of byte-hash guessing:

- **Storage** (`src/storage/schema.ts` v6): `messages.host_id`/`host_slot` +
  partial unique index `(session_id, host_id, host_slot)`. A row's key is the
  host id; the byte hash becomes the *content* column. Resending the same
  host message under drifted bytes refreshes the row in place (documented
  append-only exception, required so the DB view equals the in-memory tail
  byte-for-byte — #2960⑤ digest parity) instead of minting a twin row. Seq
  assignment prefers host-key continuity, so byte drift no longer churns the
  watermark.
- **Reconcile** (`src/fold-reconcile.ts`): Pass -1, before every heuristic
  pass — a covered id whose stored anchor carries a host id claims the unique
  inbound core with the same host id (k-th pairing within multi-core groups,
  role-gated). Heuristic passes (position/tool-call-id/twin/simhash/order
  bracket) remain the fallback for unstamped lanes and for cells whose anchor
  predates stamping. Unstamped lanes are bit-identical to before.
- **Fork** (`src/plugin.ts` fork snapshot): the response gains an additive,
  index-aligned `hostIds` array — the host-id → bili-ref map — outside every
  hash by construction, so branch-point comparison stays byte-based for old
  and new clients alike.

Adoption is per-lane and self-degrading: the plugin reads whatever ids the
host serializer actually puts in the outgoing body (passive read, no host-API
mutation), stamps only when the proxy advertises
`capabilities.hostMessageIds`, and degrades to the byte-id path whenever the
field is absent or malformed. Lanes whose host model has no message-level id
(pi, omp — see survey) stay on bytes until their hosts add one. Bytes remain
the universal fallback; host ids are the primary key where they exist.

Related: #1496 (this document's prompt), `SESSION-IDENTITY.md` (session
granularity), #1476 + kernel #459/#463 (echo discrimination), #242/#1475
(Responses id constraints), #206/#673 (tag echo), #1479/#1482 (strict-echo
repair), #1039 (tool-call byte-exactness invariant), #2396 (host-rewritten tool-call ids across a provider switch), #2480 (positional fold coverage;
`tests/identity-proof.test.ts` is its proof matrix), #2938 (host message-id
side-channel proposal; owner ruling: order-centric, hash second-class),
#3464 (R1 implementation of the host-id channel).
