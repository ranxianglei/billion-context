# DESIGN #4580 — tool_use id → lane 路由（三层）

## 机制

代理是模型输出的唯一通道：每个出站 tool_use 块流经时，代理**知道它属于哪条 lane**。Claude Code ≥2.1.308 在每次 MCP tools/call 上盖 `_meta["claudecode/toolUseId"]`（即那个 tool_use 块的 id）。两侧对上号：id 即 lane。

```
subagent 模型响应 --SSE--> 代理管道 settle: recordToolUseId("toolu_X", subLane)
host tools/call --_meta--> shim: body.toolCallId = "toolu_X"
shim POST -------> 代理路由: lookupToolUseIdSession("toolu_X") → subLane（host-stamped 权威）
```

## 三层改动

1. **记录**（src/tool-ring.ts 新增 id 环 + src/plugin.ts 三个 settle 点）
   - `recordToolUseId(id, sessionId)` / `lookupToolUseIdSession(id)`，TTL 10 分钟（与 witness 环一致），容量 1024，last-write-wins（host id 唯一，重记=重试）。
   - 记录点与 `recordToolWitness` 同路径：anthropic chat SSE（`seenToolCalls[].id`）、responses SSE（map key = `item.id`，跳过合成 `oi:N` 键）、非流式 JSON（anthropic `tool_use.id` / openai `tool_calls[].id` / responses `call_id`）。

2. **路由**（src/plugin.ts `handlePluginTool`）
   - 复用既有 body 字段 `toolCallId`（agent/shared.ts:380 原生路径已在发；plugin.ts:1923 已在验）。
   - 路由阶梯最前插入：id 环命中且 lane 存活 → `routedBy="native"`，直接路由（与 #2024 host-stamped 同权威等级），跳过 witness 冲突 409；日志 `[plugin] tool "...": routed by host call id (#4580) to "<lane>"`。
   - 环未命中（代理重启 / TTL 过期 / id 未流经）→ 旧阶梯原样，fail-closed 不变。

3. **shim**（src/mcp.ts）
   - `_meta["claudecode/toolUseId"]` 严格校验（非空字符串，trim；否则视为缺失），仅作为 `forwardTool` 新第 6 参 → `body.toolCallId`。
   - 不触碰 routeOverride、不触碰全局绑定、不置 nativeCaller（路由权威在代理侧判定）。

## 明确不做

- 不给 openai/google functionCall 无 id 的协议造假 id（记录点只在 id 真实存在时触发）。
- 不改 #4168 shim 自愈路径：id 环未命中时 409 语义原样保留。
- 不新增端点、不改 body schema（toolCallId 字段已存在）。

## 测试（tests/issue4580-claudecode-tooluseid-routing.test.ts，12 用例）

- 记录：4 条管道各 1 例 + 双 lane 分离 + TTL + 畸形 id。
- 路由：子代理调用命中子 lane + 日志断言；环 miss 回退旧行为；空/超长 toolCallId 400（与既有校验对齐）；无 id 时 witness 409 不受影响。
- shim：POST body 携带 toolCallId 且不误标 nativeCaller。
