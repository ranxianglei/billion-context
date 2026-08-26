# 回归测试 PR#246 + PR#248（本地合并验证）

## 用户请求

> 这两个都做个回归测试吧 最好本地合并后做 看是否互相影响 然后提交agents做个双review

两个 PR 各自 CI 全绿，但都动了 launcher/插件/文档的相邻区域，合并后需验证互不干扰。

## 回归内容

- 分支 `2026-08-26_regression-246-248`（本地，自 master 48f65c9）
- 依次 merge PR#246（dsh）与 PR#248（omp）
- 冲突仅 CONFIGURATION.md / CONFIGURATION.zh-CN.md 各一处（"install 必要性"段落两 PR 都改过）；解法：以 omp 侧 pi/omp `-e` 措辞为基，补回 dsh `--patch` 条目与 omp 工具面限制说明
- 预检：typecheck ✅，616/616 tests ✅（首轮 e2e-responses-chat-relay 计时断言 flaky，复跑过），build ✅

## e2e 结果（dist，mock 上游）

### dsh（PR#246 侧）

- mock: /tmp/mock-sse.py（chat SSE）19811/19812
- `DSH_HOME` 隔离 + settings llm-deepseek.baseURL → mock + `DEEPSEEK_API_KEY=dummy`
- `bili dsh --profile headless`：请求过代理、上游收到的 tools 含 wire ACP 4 工具（compress/decompress/search_context/acp_status）、`~/.dsh-bili/.bili-acp.patch.yml` 生成正确、退出 0
- 踩坑：mock 进程被 kill 后 dsh 收到 502（预期）；DEEPSEEK_API_KEY 缺失时 dsh 拒发（需 dummy）

### omp（PR#248 侧）

- mock: /tmp/mock-resp.py（Responses SSE，19814）——omp 走 /v1/responses，chat 格式 mock 不适用
- 隔离 `PI_CODING_AGENT_DIR=/tmp/omp-reg/agent`（注意：launcher 的 omp overlay = `$PI_CODING_AGENT_DIR-bili`，自定义 env 会被继承）
- 第一轮 `-p`：argv 含 `-e dist/agent/omp.js`（4/4 次运行都注入）；RAW dump：`prompt_cache_key=01a03bd7-…`（= omp 会话 id）、tools 含 wire ACP 4 工具
- 第二轮 `-c` 续聊 + **全新代理进程（19821）**：复用同一 proxy session `[d8a7b23542856a71]` —— pck 身份 + 持久化跨进程连续性验证通过
- 真实 `~/.omp/agent/config.yml` md5 前后一致（df68a91a…），零 extensions 写入；隔离 config.yml 亦未被 bili 改动

### 交叉影响

- launcher.ts 两 PR 都改：合并无冲突（不同分支区域：dsh 的 prepareDshHome/writeDshAcpPatch vs omp 的 -e 注入）
- plugin-install.ts 仅 #248 动（ompPluginLoadedFrom），#246 未触碰
- 唯一交叠 = 两份 CONFIGURATION 文档段落，已手工合并

## 结论

合并后无回归，两 PR 互补无冲突。建议合并顺序随意（GitHub 无冲突），合并后出 v0.1.55。
