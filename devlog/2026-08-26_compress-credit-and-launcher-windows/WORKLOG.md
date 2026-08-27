# 工作日志

1. 诊断（见 REQ）：双压缩 = re-request usage 陈旧覆盖；81% = 分母 95232 错。
2. Fix A：session.stats +compressCreditTokens（内存态）；stream.ts applyRanges 累加+立即 net；loop/core.ts recordUsage、plugin.ts applyUsageSample、server.ts 非流式 JSON 三记录器 net；server.ts 三个 prepare 在 processTurn 后清零；persist.ts 恢复时置 0。
   - 坑：TS ?? 链中间插非可空类型会把后续 undefined 分支折叠（native 链报 TS2322）→ 用带 `number | undefined` 注解的 launcherContextWindow() 包一层。
3. Fix C：client-config.ts +ModelWindow/toModelWindow；PiProvider/OmpProvider/OpencodeProvider +models；parseOmpYaml 状态机扩 dashIndent（真实文件 dash 行缩进 6 > models 行 4，首版 `===` 匹配不上 → 空结果，真机验证抓出）；baseUrl 与 models 同级用 `<=` 捕获；parseCodexToml 捕 model+model_context_window；readOpencodeConfig 捕 limit；collectModelWindows 同 id 取最大窗口。launcher.ts LaunchOptions.modelWindows → env；runLaunch 两处调用接线。server.ts parseLauncherModelWindows（导出纯函数）+ native 链插入。
4. 测试：tests/model-windows.test.ts（9 项：omp YAML 三形态/codex/pi/opencode/collect 碰撞/launcher env 解析）；tests/compress-credit.test.ts（成功压缩 netting + 失败压缩零 credit）；launcher.test.ts +1（proxy spawn env 含窗口 JSON，真实 omp models.yml 形态）。628/628 + typecheck + build 绿。
5. e2e：dist + BILI_LAUNCHER_MODEL_WINDOWS='{"test-model-x":262144}' + mock 上游 + max_tokens 32768 → 日志分母 229376（= 262144−32768），修复前会是 95232。
6. 教训：TS `??` 链类型折叠；YAML 缩进状态机必须真机文件验证；dist 服务测试必带 --no-auto-update。
