# DESIGN — I3 出站配对不变量(#4862 第 1 层:纯检测)

## 机制

在 `judgeInboundOutbound`(`src/invariant-judge.ts`)追加第三条不变量 I3:遍历 exit cores,按方向配对——

- 每个 `tool-call` 必须有同 id 的 `tool-result` 在其后(upstream 方向契约:anthropic 要求 tool_result 跟随 tool_use;openai 要求 role:"tool" 跟在声明它的 assistant 之后);
- 每个 `tool-result` 必须有同 id 的 `tool-call` 在其前。

配对行走与 kernel 守卫完全同构(`kernel/src/prune.ts` stripOrphanedToolResults / stripOrphanedToolCalls,#3046):precedence-only——一个 call 可应答任意多个同 id result、反之亦然(Agent Teams `name:index` id 复用),集合语义、不数多重度。

新增 ViolationKind:`unpaired-tool-call` / `unpaired-tool-result`。I3 是 exit 内部校验,与折叠切分无关(折叠区不再豁免协议结构),legacy / render-lane / main / loop 四种模式全跑同一检查。

## 归因(「谁的错」charter)——两层护栏

1. **逐 id 跳过**:exit 中断配对的 id 若在 entry 侧本来就是断的(宿主自己发来的半对),不计 bili;
2. **体量护栏(#2821 交互)**:宿主自己发来的半对在投影时被重铸 id(exit id ∉ entry),逐 id 无法与「bili 拆断了一对后被重铸」区分。体量仲裁:bili 只对 exit 未应答 call 数**超出** entry 未应答 call 数的部分负责。超出才告警,且只告 id ∉ entry 断集的那部分。CCR 占位替换(#4186 G2)、截断孪生(G3)、crush 都保留 id,天然不误报。

## 豁免(与 kernel 对齐)

- compress 在途调用豁免(bare `compress` + MCP 方言 `mcp__bili__compress`,lockstep `isMcpBiliCompress` src/config.ts):其结果由 hideConsumedCompressCalls 管理,不走配对——镜像 `kernel/src/prune.ts` stripOrphanedToolCalls 的豁免。result 侧不豁免(同 kernel)。
- 判官内联该谓词(不 import config.ts)以保持叶子模块:纯、无 I/O。

## 不变式

- 零出站字节改动、零拦截(advisory 层,catch 后静默),`maybeRunInvariantJudge` / `maybeJudgeContinuity` 接线点不变;
- 判官只新增告警语义,不改 I1/I2 任何行为——现有 46 个判官测试(invariant-judge.test.ts 30 + e2e + #4241 render 基准)全部原样绿。

## 测试(tests/issue4862-invariant-judge-unpaired.test.ts,12 例)

NEG(有牙齿):折叠吃掉 result 半侧→unpaired-tool-call;折叠吃掉 call 半侧→unpaired-tool-result;render-lane 渲染前缀含断对→仍红;id 重铸洗白→仍红。
POS(不误报):宿主自发半对回显→clean;孤立重铸 call 压在孤立宿主 call 上(#2821 形状,体量护栏)→clean;compress 在途(bare+MCP 方言)→clean;整对折叠(kernel adjustBoundariesForToolPairs 对齐)→clean;同 id 复用 precedence→clean。
Wired:真 anthropic body 主车道断对→红 lane=main;配对→绿;loop 连续性车道第 2+ 轮丢半侧→红 lane=loop。

## 后续(第 2 层,单独决策)

真正拦 400 需要出口修复(剥孤儿半侧,镜像 prune 守卫纪律;或 anthropic 邻接楔入上提,把 #766 tool-pair-order 扩到 anthropic 语义)——wire 变更属 §7.4 人工层,等本层红线在真实流量确认命中形状。
