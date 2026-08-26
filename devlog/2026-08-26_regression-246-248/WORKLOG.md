# WORKLOG — 回归 PR#246+PR#248

1. `git checkout -b 2026-08-26_regression-246-248`（自 master 48f65c9）
2. merge origin/2026-08-25_dsh-launcher（无冲突，71bcd9d）
3. merge origin/2026-08-25_omp-pck-identity：CONFIGURATION.md/.zh-CN.md 各 1 处冲突 → python 脚本以 omp 侧为基补回 dsh 措辞（0da4274）
4. 预检：typecheck ✅ / 616/616 ✅（e2e-responses-chat-relay:251 计时断言 flaky 一次，复跑 7/7）/ build 2.47MB ✅
5. dsh e2e：mock-sse 19811 → `node dist --port 198{13,16} dsh --profile headless`，wire 工具 4/4 注入，patch 文件生成，REG-OK，exit 0
   - 坑1：mock 被 kill → HTTP 502（上游死，预期行为）
   - 坑2：无 DEEPSEEK_API_KEY → dsh MISSING_CREDENTIAL，需 dummy
6. omp e2e：mock-resp.py（Responses SSE）19814；隔离 PI_CODING_AGENT_DIR=/tmp/omp-reg/agent + BILI_SESSIONS_DIR
   - 坑3：omp 走 /v1/responses，chat mock 会触发 omp 重试 10 次 STREAM_CLOSED —— 必须 Responses 格式 mock
   - 坑4：隔离目录无 config.yml → 默认模型解析到死 ollama 11435；需拷贝真实 config.yml（含 modelRoles）
   - 坑5：launcher omp overlay = `$PI_CODING_AGENT_DIR-bili`，自定义 home 会被继承而非忽略
   - 坑6：`rm` 掉已启动 mock 的日志文件 → fd 指向 unlinked inode，看不到日志（mock 本身正常）
   - 坑7：BILI_CLIENT_BIN 包装脚本里 omp 真实路径 = /home/dog/.bun/bin/omp（不是 ~/.local/bin）
7. 验证点：
   - -e 注入：argv log 4/4
   - wire 工具：RAW dump tools 数组含 compress/decompress/search_context/acp_status
   - pck：RAW dump prompt_cache_key = omp 会话 id = x-session-id
   - 跨进程连续性：第二轮 -c + 新代理进程复用同 session [d8a7b23542856a71]
   - 零落盘：真实 ~/.omp/agent/config.yml md5 不变（df68a91a…）；隔离 config.yml 无 bili 改动；真实 home 无 extensions 条目
8. 清理：kill mock-sse/mock-resp；删除本地临时目录保留 /tmp/omp-reg（复盘用）
9. 双 review：acp_delegate × 2（reviewer），每 PR 一份，diff 范围 master...各分支
