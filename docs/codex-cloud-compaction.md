# Codex cloud compaction ↔ ACP history generations

> Two compactions share one conversation: the Codex backend replaces history with
> an encrypted checkpoint, and bili compresses the same history with ACP. This
> page records how the two stay consistent, and what survives the boundary.

## The boundary is announced, never guessed

`dsh-codex-subscription` validates a replayed OpenAI `compaction` item and then
stamps the next model request with a checkpoint identity:

| Header | Meaning |
|---|---|
| `x-bili-codex-checkpoint` | checkpoint id (the encrypted payload's digest) |
| `x-bili-codex-checkpoint-seq` | ordering of the checkpoint in this conversation |
| `x-bili-codex-checkpoint-state` | `fresh` (first announcement) or `reuse` |
| `x-bili-codex-checkpoint-covered` | how many history entries the checkpoint replaced |
| `x-bili-codex-checkpoint-digest` | digest of the carried items |

bili (`src/codex-checkpoint.ts`) treats a *new identity* — new id, or a higher
`seq` — as the authoritative remote boundary; `fresh`/`reuse` is informational
only. Timing is inherent: a checkpoint is produced in a response and can only be
announced on the next request, so a `reuse` announcement must be able to open a
boundary that a lost `fresh` announcement never opened. Any `x-bili-plugin:
codex` or `dsh` envelope is accepted as the lane; the checkpoint header is the
strong signal, the historical text/structure heuristics remain the fallback for
clients that cannot announce.

The headers are proxy-internal: they are listed in `UPSTREAM_HOP_HEADERS`, so
they are stripped from both HTTP and WebSocket upstream egress.

## What happens at the boundary

1. `closeHistoryGeneration()` snapshots the live compression state — blocks,
   block contents, the ref map, the raw messages and a frozen slice of the CCR
   store — as a read-only **generation** (`<session-base>.history-generations.json`,
   same codec/encryption as the content store, fsynced, 0600).
2. Only after the sidecar write succeeds is the metadata index
   (`metadata.historyGenerations`) written, so a crash between the two recovers:
   `historyGenerationsOf()` re-reads the sidecar and repairs the index.
3. The live state is reset, but the ref floor and `state.nextBlockId` are pinned
   above every archived value: old `mNNNNN` and `bN` are never re-issued onto
   different content.
4. A compact navigation note (generation numbers, ref spans, how they closed)
   is injected as developer text; no archived payload is re-sent to the model.

If the generation cannot be persisted (and persistence is on), the boundary is
**not** rebased: live state stays intact and the next request retries. When
persistence is off, the generation lives in a bounded process-local map for the
life of the session.

## Reading the past

- `decompress` restores archived blocks (whole or `startId`/`endId` ranges)
  read-only; it never reactivates a block or marks the session dirty.
- `search_context` searches live blocks and every closed generation (summaries,
  archived raw messages, archived originals), labelling hits `bN (T1, generation G)`.
- The retrieve tool resolves refs whose original now lives only in a generation.
- Archives that predate generations honestly report that they are unrecoverable.

## Enablement and verification

bili needs no new configuration. In DSH, set the Codex subscription provider's
`compactionMode` to `cloud`; `dsh` mode never produces remote checkpoints.

```bash
# bili
npm run build
# codex plugin
cd ~/dsh-codex-subscription && pnpm run build
# real-credential check (reads ~/.codex/auth.json, prints no tokens)
node --import ./tests/preload-test-env.mjs --import tsx \
  tests/manual/real-cloud-compaction.e2e.mjs
```

Targeted automation: `tests/history-generations.test.ts` (generations, refs,
restart, tool calls), `tests/codex-checkpoint-boundary.test.ts` (header truth
through the real request pipeline), `tests/compaction-archive.test.ts`.
