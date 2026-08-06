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

### Single provider

Start the proxy pointing at one upstream (simplest):

```bash
UPSTREAM=https://api.anthropic.com bili-proxy
```

Then point your agent at the proxy.

### Multiple providers (recommended)

See [Configuration](#configuration) below for how to route to multiple
providers by URL path — most users will want this.

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
| `UPSTREAM` | `https://api.anthropic.com` | Default upstream when no route matches |
| `ACP_PROVIDERS` | *(none)* | Path to a JSON file mapping provider names to root URLs (see below) |
| `ACP_COMPRESS_TOOL` | `1` | Set `0` to disable injecting the compress tool |
| `ACP_DEBUG` | `0` | Set `1` for verbose logging |
| `ACP_PASSTHROUGH` | `0` | Set `1` to forward without compression |

### Multiple upstreams (URL path routing)

Point any agent at the proxy using a provider name as a path segment. The
proxy strips the name and forwards to that provider's root URL. **API keys
are never stored in the proxy** — whatever key the agent sends is passed
through untouched to the upstream.

Create a providers file (e.g. `~/.bili/providers.json`):

```json
{
  "glm": "https://bigmodel.cn",
  "anthropic": "https://api.anthropic.com",
  "openai": "https://api.openai.com",
  "deepseek": "https://api.deepseek.com"
}
```

Then:

```bash
ACP_PROVIDERS=~/.bili/providers.json bili-proxy
```

Each agent only needs to change its base URL to include the provider name.
The proxy figures out the rest, including the right context window for each
model family (claude=200k, gpt-4o=128k, glm=128k, ...) via a built-in table.

#### Claude Code (Anthropic)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787/anthropic
export ANTHROPIC_API_KEY=sk-ant-...   # real key — passed through as-is
claude
```

#### Codex / any OpenAI-compatible agent (zhipu / openai / deepseek)

```bash
export OPENAI_BASE_URL=http://localhost:8787/v1/glm
export OPENAI_API_KEY=<your real glm key>   # passed through as-is
codex
```

The `/v1/glm` prefix tells the proxy to route to the `glm` provider; the
remaining `/v1/chat/completions` path is preserved. Set the key to the real
provider key — the proxy never reads or stores it.

### Notes on provider names

- Must start with a letter, contain only letters/digits/`-`/`_`.
- Reserved words (`v1`, `chat`, `completions`, `messages`, `models`, `api`)
  are rejected to avoid colliding with real API path segments.
- The provider name can appear anywhere in the path; the longest match wins.

## Status

Early. Protocol handling and compression work against mock tests (79 passing). Real-model integration testing is the next milestone. Expect rough edges.

See [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) for the pi-extension mode (in-process, tighter integration, the reference implementation).

## License

MIT
