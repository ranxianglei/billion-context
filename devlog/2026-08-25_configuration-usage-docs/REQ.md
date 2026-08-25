# 需求

用户合并 PR #231（README 对齐中文版）后指出：README 删掉了大量细节用法，要求把这些细节转移到 CONFIGURATION.md / CONFIGURATION.zh-CN.md（中英文同步），并补上 `--help` 有而文档缺的内容。

- 素材：`git diff 7d958b1..master -- README*.md` 的被删行（插件模式、MITM 手动设置、逐客户端 baseURL 示例、launcher 表格、Codex subagents、sessions/export 等）。
- 事实核对：launcher 表格按当前 src/launcher.ts 重写（claude 走 ANTHROPIC_BASE_URL 而非 cert-MITM；pi 未装插件自动 -e；hermes 无 MITM；omp/opencode 隔离配置）——旧 README 表格已过时的部分不再照搬。
- 环境变量表补齐 17 行（ACP_SESSION_HEADER/ACP_REASONING_KEEP/ACP_LOG_FILE/ACP_DUMP_SSE/BILI_UPSTREAM_PROXY/BILI_PERSIST*/BILI_MAX_SESSIONS/BILI_SESSIONS_DIR/BILLION_CONTEXT_PROXY/BILLION_CONTEXT_PLUGIN/BILI_LAUNCHER_PLUGIN/BILI_LAUNCHER_DIRECT/BILI_CLAUDE_UPSTREAM；zh 侧另补 BILI_REPLAY_*）。
