# billion-context

Universal context-compression proxy for AI coding agents.

`billion-context` sits between **any** agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. Any agent that can set a base URL works out of the box — **zero per-agent adapter code**.

## Why

Long coding sessions blow up context. Each provider charges per token, and once you pass the context window the session degrades or dies. `billion-context` compresses consumed conversation into layered summaries so you can run a single session for days — billions of tokens through one context window.

Unlike a host's built-in summarizer, compression here is **incremental, reversible, and prefix-cache friendly**: summaries are written in small ranges, can be decompressed on demand, and the cache prefix stays intact.

## How it works

```
Agent (Claude Code / Codex / Cursor / Aider ...)
        │  you point the agent's base URL at the proxy
        ▼
┌─────────────────┐
│  billion-context│   1. parse the request (Anthropic or OpenAI shape)
│     proxy       │   2. run acp-kernel compression on the conversation
│                 │   3. inject a `compress` tool + compression philosophy
│                 │   4. forward to the real model API
│                 │   5. rewrite the streaming response
└─────────────────┘
        │
        ▼
   real model API (Anthropic / OpenAI / compatible)
```

The proxy injects four context-management tools (`compress`, `decompress`, `search_context`, `acp_status`) into the conversation. The model calls `compress` when the conversation grows, and the proxy executes it server-side — the compressed ranges are folded into the conversation history before the next turn.

## Install

```bash
npm install -g billion-context
```

## Usage

Start the proxy (defaults to port 8787, upstream inferred from your API key):

```bash
bili-proxy
# or: billion-context
```

Point your agent at the proxy.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=sk-ant-...
claude
```

### Codex / any OpenAI-compatible agent

```bash
export OPENAI_BASE_URL=http://localhost:8787/v1
export OPENAI_API_KEY=sk-...
codex
```

### Cursor / Aider / others

Set the base URL / API endpoint to `http://localhost:8787` (Anthropic) or `http://localhost:8787/v1` (OpenAI) in the agent's settings.

## Configuration

All config is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Proxy listen port |
| `HOST` | `127.0.0.1` | Proxy listen host |
| `UPSTREAM` | *(from API key)* | Upstream model API URL |
| `MODEL_CONTEXT_LIMIT` | `200000` | Context window for compression triggering |
| `ACP_DEBUG` | `0` | Set `1` to enable debug logging |
| `ACP_LOG_FILE` | `stderr` | Log file path |
| `ACP_PASSTHROUGH` | `0` | Set `1` to forward without compression (for debugging) |

### Multiple upstreams

Route to different providers by API key:

```bash
ACP_ROUTES='{"sk-ant-key1":{"upstream":"https://api.anthropic.com","apiKey":"real-key"},"sk-openai-key2":{"upstream":"https://api.openai.com","apiKey":"real-key2"}}'
```

The agent authenticates with the route key; the proxy swaps in the real key and forwards to that route's upstream.

## Status

Early. Protocol handling and compression work against mock tests (67 passing). Real-model integration testing is the next milestone. Expect rough edges.

See [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) for the pi-extension mode (in-process, tighter integration, the reference implementation).

## License

MIT
