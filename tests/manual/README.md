# Manual end-to-end checks

These scripts need real credentials and are never run by `npm test`.

## real-cloud-compaction.e2e.mjs

Proves the Codex Responses cloud-compaction checkpoint and Billion-Context
history generations work together against the real ChatGPT Codex backend:

1. a large first turn makes the backend compact and returns an encrypted
   `compaction` item, which the compaction bridge stores as a checkpoint;
2. an ACP fold creates a live block, then the next turn replays the checkpoint,
   so the proxy closes a read-only history generation and the model answers
   from the compacted context (no old history resent);
3. a second remote compaction closes another generation, an identical retry is
   deduplicated, and the archived block stays restorable via `decompress`.

It reads `~/.codex/auth.json` (real OAuth token) and defaults to `gpt-6-luna`.
Both paths are overridable: `BILI_CODEX_AUTH` for the credential file and
`BILI_CODEX_PLUGIN_DIR` for the `dsh-codex-subscription` checkout (defaults to
a sibling checkout). Run from the repository root:

```bash
node --import ./tests/preload-test-env.mjs --import tsx tests/manual/real-cloud-compaction.e2e.mjs
```
