# REQ #4580 — Claude Code 子代理的 bili 调用路由到错误会话

- **Issue**: #4580（P1）
- **现象**: Claude Code 的 Task 子代理与本线程共用同一个 MCP shim 进程。shim 在启动时抓的是父会话的 session id（env 绑定），子代理的模型流量实际走的是代理里另一条 lane，但它的 `mcp__bili__compress` 等调用全部按父会话路由 —— 子代理压缩的是**父会话**（refs 全部 unknown / 误折），或撞上 #2024/#4168 的 witness 409 永久失败。
- **触发条件**: Claude Code（任意近版本）+ Task 子代理 + MCP 模式 bili。Claude Code ≥2.1.308 起每次 tools/call 自带 `_meta["claudecode/toolUseId"]`，使本修复可行。
- **验收**:
  1. 子代理的 compress 调用路由到子代理自己的 lane（witness 记录侧可证）。
  2. 未知/缺失 id 完全回退旧行为（fail-closed 语义不变）。
  3. 父线程调用行为不变（id 映射回父 lane，与 env 绑定一致）。
  4. shim 全局绑定不被子代理调用污染。
