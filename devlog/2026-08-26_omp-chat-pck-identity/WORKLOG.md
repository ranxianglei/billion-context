# omp chat-completions: pck 身份 + /acp 修复

## Request

用户报告 (m08151): omp 会话 (GLM-5.3 via Zhipu LB, chat-completions 协议) 跑了很久, `/acp` 面板永远显示 "billion-context@0.1.56 — proxy connected, compression armed. No model request in this conversation yet; send one, then run /acp again." — 无任何数据。

## Root Cause (三层, 全部实锤)

1. **omp 的 chat-completions 请求不带任何会话标识** — dump 实锤 (`req-1787753647579`): body 只有 `[model, messages, stream, stream_options, store, tools, max_completion_tokens, reasoning_effort]`, 无 `prompt_cache_key`/`session`/`user`; 请求头也无任何 session header。
2. **bc 的 openai 路径会话键 = `hashId(首条 user 消息)`** (kernel `conversationSignalOpenai`: header ?? hashId(stringContent(firstUser))) — 与 omp 会话 uuid 永不相等 → `consumePluginRegisterFor(clientConv ?? conversation)` (插件 identity register 用 omp session uuid 作 key) 永不命中 → pluginMode 永不绑定 (日志: 131 请求全 wire 注入)。
3. **`recordPluginSession(pck)` 只在 `protocol === "responses"` 分支** — openai 会话从不记录 → `/acp` 按 uuid 查 status → 404 → PR#235 的 armed 兜底文案 (即用户看到的消息)。

## Fix

- `src/agent/pi.ts` — omp 插件 `before_provider_request` handler: omp 的该事件 handler 返回值**替换整个出站 payload** (omp `emitBeforeProviderRequest`: `onPayload` 链, `w !== undefined → f = w`, cli.js 实锤)。chat 形态 payload (`messages` 数组 + 无 `input` 数组 + 无 `max_tokens`(anthropic 排除) + 无原生 `prompt_cache_key`) 且 sid 有效时返回 `{...p, prompt_cache_key: sid}`。pi (agent==="pi") 不动 (有 before_provider_headers)。
- `src/server.ts` — openai 协议构造 `openaiIdentity = preferPromptCacheKeyIdentity({value: conversationSignalOpenai(...), source: convHeader?"header":"content-fingerprint", ...}, parsed)`, conversation/affinity/clientLabel 全走 identity (镜像 responses 路径); `recordPluginSession(pck)` 扩到 openai。

## Verification

- 单测: plugin-agent 25/25 (新增: chat payload 注入/responses 不动/anthropic 不动/无 sid 不动/pi 不动); 全量 653/653; typecheck; build。
- e2e (真 omp 17.3.8 + chat mock /tmp/pck-e2e, api: openai-completions — **坑: omp models.yml 的 api 值是 `openai-completions` 不是 `openai`**, 错值→"Unknown provider"且警告只在 `omp models` 里可见):
  - mock 收到的 chat payload 带 `prompt_cache_key: <omp uuid>` ✓
  - 会话文件落 `sessions/openai/` 单一 session ✓
  - 重启代理后 `GET /__bili/plugin/status?conversationId=<uuid>` → 200, `pluginAgent: "omp"`, panel 渲染 ✓
  - 决定性探针: POST register {probe, omp, identity:true} + 同 pck 请求 → mock 收到 `tools: []` — wire 注入被抑制, pluginMode 绑定 ✓
  - TUI 主回合 tools 含 4 ACP 工具 = omp 原生注册 (loadMode essential; 与 wire 注入名字相同, 靠探针区分绑定状态)
  - one-shot 单请求时 register 可能竞速落后于请求 (manifest 往返) — 该请求走 wire (压缩照常), TUI 长会话从请求 1-2 起绑定; 与 responses 路径既有行为一致。

## Notes

- openai 路径无 `injectTool=` 日志行 (只在 responses 路径 server.ts:1285) — 调试 openai pluginMode 用 mock 上游看 tools + 手工 register 探针。
- omp 标题子请求 (title request) 不带 pck (payload 无 messages 或不走同一路径) — 无妨, 主回合身份稳定即可。
