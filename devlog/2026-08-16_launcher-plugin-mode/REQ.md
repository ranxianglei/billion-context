# REQ — launcher-first UX: native-plugin experience with zero persistent host config (#162)

## Request

Proxy 版在大多数场景下直接可用：launcher 把所有"需要碰宿主"的动作收敛为 spawn 参数，
用户只换一个启动命令（`bili claude` / `bili codex`），体验与本地插件版几乎无差别。
宿主配置文件零写入、已有插件零影响、卸载零残留。是 #161 plugin protocol 的
launcher 化延伸（plugin-in-launcher, 内外呼应）。

## Acceptance

- [x] `POST /__bili/plugin/register {conversationId, agent, identity}` — 会话预注册
- [x] 双绑定策略：identity（claude：每请求 x-claude-code-session-id === 注册 id，
      任意时序可绑）/ headless pending（codex spawn：下一个新会话消费）
- [x] `bili mcp` — MCP stdio 薄壳：manifest → 4 工具 → /tool 转发；
      CLAUDE_CODE_SESSION_ID / BILI_CONVERSATION_ID 双来源
- [x] `bili plugin-register <id>` — CLI 注册子命令（hook 兜底）
- [x] launcher 直连 URL 模式（claude/codex 默认，BILI_LAUNCHER_MITM=1 退回 MITM）
- [x] claude：ANTHROPIC_BASE_URL 直传 env + --mcp-config 临时 JSON（无 --settings、无 hooks）
- [x] codex：-c mcp_servers.bili.* 内联覆盖（实测 0.147 语法被接受）
- [x] 真机 e2e：claude 2.1.227 经 `bili claude` 启动，MCP 原生调用 acp_status，
      proxy 日志 `[plugin] tool acp_status executed via plugin`，宿主配置零写入

## Non-goals

- 不持久写宿主配置文件（只走 flag/env/临时文件）
- 不替代 omp native 模式
