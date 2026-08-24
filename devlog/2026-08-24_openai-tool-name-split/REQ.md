# REQ: OpenAI SSE tool-name splitting fix

## Source

Found live while validating the hermes launcher (#223): a reviewer session
running under `bili hermes` against SGLang kept dying with
`hermes: Unknown tool '' → Max retries (3) exceeded → Stopping as partial`
while the proxy logged `acp-loop round 1: 0 call(s)`.

## Problem

SGLang/vLLM stream a tool-call name across multiple deltas (name in the
first fragment, empty names after). The per-chunk proxy-vs-real decision
from the #205 passthrough fix buffered the name fragment, then an
empty-name continuation flipped the stream into passthrough mode, and the
finish-time flush was skipped — the client received the call WITHOUT its
name and the compress loop never saw it either.

## Requirements

1. A split-name PROXY tool call (e.g. `compress`) must be intercepted
   server-side exactly like a single-fragment call; nothing may leak to
   the client.
2. A split-name REAL tool call must reach the client with its full name,
   the upstream response id, and the original chunk order.
3. Mixed rounds (proxy + real calls in one turn): proxy calls executed
   server-side; the replay must contain only the real fragments.
4. No duplicated finish/[DONE] after a verbatim replay.
5. Regression tests for all of the above.
