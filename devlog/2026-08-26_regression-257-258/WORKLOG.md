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
