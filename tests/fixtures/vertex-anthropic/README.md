# Vertex Anthropic wire fixture

Phase 0 of the Vertex port (`projects/billion-context-vertex-ai/`): the wire frozen before anything implements it. A test loads these files; nothing here is hand-invented where evidence was available.

| Artifact | Kind | Where it comes from |
| :- | :- | :- |
| `turn-streaming.body.json` | captured | the real client's streaming turn, byte-exact |
| `probe-nonstreaming.body.json` | captured | the real client's startup probe, byte-exact |
| `*.meta.json` | captured | method, path and headers as received, plus each body's SHA-256 |
| `response-message.json` | **doc-derived** | the non-streaming `Message` shape |
| `response-stream.sse` | **doc-derived** | the SSE event sequence |
| `manifest.json` | — | every artifact with kind, size, digest and source |

Requests were captured from `claude-cli/2.1.300 (external, sdk-cli)` by a throwaway loopback recorder (`projects/billion-context-vertex-ai/tools/dumb-recorder.mjs`) that logged bytes and answered with a canned reply. Regeneration steps and the full write-up: `projects/billion-context-vertex-ai/capture/FINDINGS.md`.

## What the captured halves establish

- **The model rides the path, never the body.** `…/models/{model}:rawPredict|streamRawPredict`; the body has no `model` key. Any model-keyed decision must read the path.
- **`anthropic_version: "vertex-2023-10-16"` is in the body**, and `anthropic-version: 2023-06-01` is in the headers. Both must survive the compression path.
- **The client appends `/projects/…` to `ANTHROPIC_VERTEX_BASE_URL` verbatim**, so the base URL must carry the `/v1` segment: Vertex serves `/v1/projects/…` and 404s the version-less form.
- **Bodies are stored as received.** The client emits compact JSON with raw UTF-8, which both Node and Python (with `ensure_ascii=False`) reproduce byte-for-byte — so the digests in `manifest.json`, not the formatting, are what prove the fixture still matches the capture. Python's default escaping does *not* reproduce it, which is why nothing here is regenerated from parsed JSON.
- **Three probes then a turn.** Every launch sends the same probe body (identical bytes) to three different model paths, then the streaming turn. The probe has `max_tokens: 1`, no tools, no `stream`; the turn has `stream: true`, tools, `thinking` and `max_tokens: 32000`.
- The `Authorization` bearer is a redacted placeholder (`Bearer <redacted:253 chars>`); the header is present so a fake can assert it. The token itself is a client-minted ADC OAuth token — bili never mints one on this lane.

## Why the responses are doc-derived

A live success call is behind this project's zero partner-model quota, so the response half comes from the documentation:

- Non-streaming `Message`: Google's `:rawPredict` response example — `id` with the Vertex-specific `msg_vrtx_` prefix, `type`, `role`, `model` echoed, `content[]`, `stop_reason`, `stop_sequence`, `usage.input_tokens` / `usage.output_tokens`.
- SSE: Anthropic's streaming event flow — `message_start` → `content_block_start` → `content_block_delta`* → `content_block_stop` → `message_delta` → `message_stop`, with `ping` anywhere in between; each event carries an SSE event name and a matching `type` in its data. New event types may be added, so a consumer must tolerate unknown ones.

**Documented disagreement, recorded rather than resolved:** Google's `:streamRawPredict` section prints a plain JSON `Message` as the response to a `"stream": true` request (`claude-2.1` in its example), while Anthropic documents SSE for streaming. Anthropic's is the shape the client expects — the recorder's six-event SSE transcript was accepted by the real client and printed its text — so this fixture follows Anthropic for the stream and Google for the unary body.

When the quota clears, both response artifacts get replaced by live bytes and this section shrinks to a line.
