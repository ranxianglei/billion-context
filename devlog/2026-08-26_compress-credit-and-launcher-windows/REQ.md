# 需求：omp 连续两次注入/两次压缩 + 81% 统计口径错误

用户报告（omp --resume 会话）：
1. 02:56:35 INJECT 81% → 压缩 33k；02:57:41 又 INJECT 85% → 又压缩 3k —— 同一逻辑回合理应只压一次。
2. 第一次 81% 本身就是错的：真实窗口 262144（omp models.yml 声明 + SGLang 实测收 234k），代理用了 95232 分母（内置表 /^qwen/i → 128000 − max_output 32768）→ 全会话在 29% 真实用量时被当成 81% 过早压缩。

用户拍板："a 和 c 修复吧 尽量不要用户配置"（B=用户侧 providers 配置声明窗口，被否决）。

## 修复 A：compress credit
- 压缩后的 re-request 有意重发未折叠历史（前缀缓存友好，实测 96% 命中），其 usage 报告带的是压缩前尺寸 → 覆盖 lastInputTokens → 下一请求 nudge 重判陈旧值 → 重复注入。
- 修复：applyRanges 成功后立即 net + 记 credit；所有 usage 记录器（loop recordUsage / plugin applyUsageSample / 非流式 JSON）net credit；下一请求 processTurn（折叠真正落地处）清零。真超限时照常触发；累计计费 inputTokens 保持原始值。

## 修复 C：launcher 窗口上报
- launcher 重写客户端配置时本来就读到每模型 contextWindow：pi models.json、omp models.yml、opencode models.<id>.limit、codex model+model_context_window。
- 通过 BILI_LAUNCHER_MODEL_WINDOWS（JSON）传给拉起的代理；代理 native 链插入（plugin report > launcher > registry > routes/table）。
- 零用户配置；只有 launcher 设这个 env（无头伪造风险面不存在）。
