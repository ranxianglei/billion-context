# WORKLOG — omp 原生插件模式

## 取证
- omp 源码(/home/dog/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent): ToolLoadMode="essential"|"discoverable"(pi-agent-core types.ts:717); defaultLoadModeForToolName(essential-tools.ts): declared 优先, 未声明仅内置名 pinned essential; tools.xdev 设置(默认 on)把 discoverable 工具挂 xd://。
- 探针实测(PI_CODING_AGENT_DIR 隔离 + mock /v1/responses 抓包): 默认注册的 probe_default 不进主回合 tools; 声明 essential 的 probe_essential 进 — 一锤定音。
- server.ts:765 consumePluginRegisterFor(clientConv ?? conversation) + plugin.ts registeredIds: identity register 通用可用, omp 的 x-session-id/pck = 会话 uuid 与注册键天然一致。

## 实现
- src/agent/pi.ts: ToolDefinition +loadMode?: string; manifestToTool +loadMode:"essential"; postIdentityRegister(fetch POST, AbortSignal.timeout(5000)); RegisterState +identityAt(sid 缓存防重复 POST); registerTools 成功路径 agent==="omp" 时注册(失败 retryAt 退避 10s); pi.on("before_provider_request") 重试驱动。
- tests/plugin-agent.test.ts: startFakeProxy +registers 捕获/+failRegister 选项; +4 测试(essential 声明、omp 身份注册一次/新会话重注册、pi 不注册、失败退避不轰端点)。24/24。

## e2e(隔离 PI_CODING_AGENT_DIR + tmux mock)
- 坑1: pkill -f 19921 匹配自身命令行把 shell 块自杀, heredoc 写入也被杀(盘上还是旧文件) — 改按 PID 杀 + write 工具重写。
- 坑2: pi-ai Responses 解析器从 data JSON 的 type 字段读事件类型, 只写 event: 行无效 → data 内加 type。
- 坑3: omp 参数校验: compress 需要 content 数组且每项含 startId/endId/summary(kernel validateEntry)。
- 最终链路证明: 主回合 tools 含 4 个原生 ACP 工具(单份, 无 wire 重复); 代理日志 injectTool=false (plugin mode: wire injection suppressed) 首请求即绑定; 模型调 compress(原生)→omp 校验→forwardTool→/__bili/plugin/tool→内核裁决回执(实测返回 "[Compression FAILED: ... does not exist in this session]" 证明走的是真实内核路径)→回放→下一轮 NATIVE-E2E-DONE exit 0。

## 文档
- CONFIGURATION(.zh-CN).md omp bullet 重写(essential + identity register); zh :596 删除过时"omp fork 隐藏扩展工具"备注。
- CHANGELOG Unreleased: 旧 omp -e 条目改写为最终形态(与本次变更同 section, 避免自相矛盾)。

## 验证
- typecheck ✓, 632/632 ✓, build ✓。分支 2026-08-26_omp-native-plugin-mode(自 origin/master 5982720, #252 已并入)。
