# WORKLOG — PR#257 + PR#258 联合回归

## 2026-08-26

### 合并

- 分支 `2026-08-26_regression-257-258` 自 master `5982720`
- merge #257（4ca494e）+ merge #258（7f33f9e）——**零冲突**（#257 改 agent/pi.ts + plugin-agent.test.ts + CONFIGURATION；#258 改 loop/adapter-responses.ts + server.ts prepareResponses + 新测试文件；CHANGELOG [Unreleased] 两分支各插一条，合并后无重复）
- 预检：typecheck ✓ / **636/636**（632+4 新增）/ build ✓

### e2e 布置

- `/tmp/reg-e2e/`：隔离 `PI_CODING_AGENT_DIR`（models.yml 指向 mock）、`BILI_SESSIONS_DIR` 隔离
- mock.py（tmux regmock, 127.0.0.1:19941）：**内容路由**（不用轮次计数——第一次尝试用轮次计数翻车：omp 的 title 请求抢走了 turn 1 脚本）：
  - 无 tools → title 请求 → 纯文本标题
  - 有 tools 且 input 无 `function_call_output` → 主回合 1 → **空白 text("\n\n") 块 + function_call(acp_status)** 混合回合（一次制造摊平空消息 + 原生工具调用两个验证条件）
  - 有 `function_call_output` → 最终文本 `REG-E2E-OK-2`
  - 每请求记录 tools 名单 + input 条目形态（含每 text 部件字数 / WS 标记）
- 跑法：`node dist/index.js --no-auto-update --port 19942 omp -p "status please"`（launcher 自起代理，实际用了 37349）

### e2e 结果（一次运行四点全中）

| 验证点 | 证据 |
|---|---|
| #257 原生工具进主回合 | 主回合 tools = omp 内置 11 + `compress,decompress,search_context,acp_status` **单份**（mock log turn 2） |
| #257 identity 绑定 | 两轮主回合均 `injectTool=false (plugin mode: wire injection suppressed)`（首请求即绑定） |
| #257 原生工具真执行 | `[plugin] tool acp_status executed via plugin (285 chars)`——模型调 acp_status → omp 校验 → forwardTool → /__bili/plugin/tool → 内核真实裁决 |
| #258 空白消息丢弃 | 回合 2 请求 omp 回放摊平条目 → `dropped 1 whitespace-only message item(s) before projection (flattened-turn artifact)` → mock turn 3 input 只剩 `[developer, user, function_call, function_call_output]`，**无空白 message item** |

- 交互零污染：隔离 PI_CODING_AGENT_DIR + launcher 临时 overlay；exit 0，输出 `REG-E2E-OK-2`

### 收尾

- 清理 tmux regmock/regproxy + `/tmp/reg-e2e`
- push 分支 → PR（联合回归，同 #250 模式；#257/#258 各留 supersede 评论）

### 教训

- mock 路由**按请求内容**（有无 tools / 有无 function_call_output），不要按轮次计数——omp 的 title 请求（无 tools）会抢走第一轮脚本
- omp headless 单次 `-p` 运行天然多轮：主回合工具调用 → omp 执行 → 回放 function_call+output 即第二轮请求，足够验证 #258

### 补漏（review 发现，合并后追加）

- 上面的本地 merge 只拉进了两个 PR 的**初始 commit**（f5342f3 / 7e7fbb1），漏掉了各自 review 期间推上的修复：
  - `2a1bd22`（#257 分支）：identity register 失败后重试——不修则 register 失败会把整个 session 钉死在 wire 模式（ACP 工具双份）
  - `21fa531`（#258 分支）：CHANGELOG 重复的 `### Fixes` 标题
- 补两个 merge（零冲突）：`a05cba5`（merge #257 head）+ `cffc5d5`（merge #258 head）
- 重跑预检：typecheck ✓ / **636/636** / build ✓（dist/index.js 2.48 MB，dist/agent/omp.js 11.79 KB）
- e2e 结论对新树仍成立：2a1bd22 只改 register **失败**路径（e2e 走的是首请求即绑定成功的 happy path，终态一致）；21fa531 纯 docs

## Follow-up: plugin-mode passthrough tag-echo strip (same day)

User reported a NEW omp session (post-#257 testing) filling with fake render tags
(`<acp tokens="247" type="text">m00042</acp>`, same ref, tokens counting down) and the
model never quoting the requested text. First diagnosis blamed an old Aug-24 proxy
process — WRONG (user challenged it; the session was on the fresh bili-omp proxy).
Real root cause: `server.ts` plugin-mode branch pipes the upstream Responses stream
VERBATIM (`pipeThroughWithUsage`), and the tag-echo stripper (#206) only exists in the
compress-loop stream path — bringing omp into plugin mode (#257) bypassed the output-side
strip, so fake tags flowed back verbatim, omp flattened them into session items, replay
amplified them, and #258's ingress drop could not save mixed (tag+prose) messages.

Fix (on this regression branch):
- `src/loop/tag-echo-filter.ts`: `TagEchoFilter` gains `pending(): boolean`.
- `src/plugin.ts`: new `pipePluginResponsesWithStrip(stream, res, session, log?)` —
  event-level passthrough that filters `output_text.delta` through the same
  `createTagEchoFilter` state machine (fast path when no tag and nothing pending),
  flushes held tail as a delta before done-family events, strips full-text fields of
  done events, keeps every other event byte-identical; samples usage from
  `ev.response.usage`.
- `src/server.ts`: plugin-mode branch uses the new pipe for protocol "responses".

Verification: tests/plugin-passthrough-tag-strip.test.ts 4/4 (single-event strip,
split-across-deltas strip + tail flush with item_id, byte-identical passthrough for
clean events, done-payload strip); full suite 640/640; typecheck; build. Real omp e2e
(isolate PI_CODING_AGENT_DIR + full lifecycle mock): proxy log shows
`injectTool=false (plugin mode)` + `[tag-echo] stripped ... (plugin passthrough)` and
omp receives `Here:  ECHO-DONE` — tag gone, prose intact. (First e2e attempt failed
with "stream closed before terminal event" — mock lacked output_item.added/
content_part events; pi-ai Responses parser needs the full lifecycle chain.)

Also fixed a duplicated `### Fixes` header in [Unreleased] (merge artifact from #258's
CHANGELOG edit) while adding the entry.

User recovery: kill the pre-fix proxy; next `bili omp` spawns a fresh one with the strip.
Poisoned session (01a03dcb) is unrecoverable — start a new session.
