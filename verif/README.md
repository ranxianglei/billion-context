# verif — 对 kernel 决策核做"真代码求解器验证"的小模块

Issue #3848。目标:把受保护文件里的真实 TypeScript 逻辑翻译成 SMT 约束,
用求解器找违反缓存稳定不变量的反例;反例必须回放真代码复现才算数。

这不是"根据代码写证明",也不是"自己建模":被翻译的就是仓库里的源文件,
翻译器只是镜头,镜头歪了会被回放当场抓住(见下)。

## 部件

| 部件 | 文件 | 作用 |
|---|---|---|
| 子语言守卫 | `subset-guard.ts` + `guarded-files.ts` + `exceptions.ts` | 守卫清单内的文件只许写可翻译的语法;白名单外 → `tests/verif-subset-guard.test.ts` 红。例外必须显式登记,过期例外也红 |
| 符号执行器 | `symbolic.ts` | 真 TS AST → 符号值;分支用 ITE 值合并不枚举路径;本地函数内联(不换算子);跨文件 import 图解析 |
| SMT 项门面 | `terms.ts` | 自研 DAG Term(不走 z3-solver WASM——它 2GB 堆上限扛不住两轮公式);常量折叠;`smt2Of` 发射带 define-fun 共享的 SMT-LIB2 |
| 求解器桥 | `solve.ts` | 进程外求解,优先 cvc5(经 `VERIF_PYTHON` 指定的 python),回退 z3 二进制;可用 `VERIF_SOLVER_CMD` 覆盖 |
| 反例回放 | `replay.ts` | 求解器 witness 必须在真实 kernel 代码上复现;不复现 = 翻译器漂移/规格写错,是警报不是通过 |

## 运行

```bash
# 守卫 + 冒烟不需要求解器
node --import tsx --test tests/verif-subset-guard.test.ts tests/verif-symbolic-smoke.test.ts

# 求解器测试需要 cvc5(cvc5 优先,z3 WASM 只够冒烟级公式)
VERIF_PYTHON=/path/to/python-with-cvc5 node --import tsx --test tests/verif-bug*.test.ts tests/verif-generic-*.test.ts tests/verif-induction-*.test.ts
# 没有求解器的环境自动 skip,CI 不会红
```

## 测试布局(每一层证明什么)

| 测试 | 层 | 证明内容 |
|---|---|---|
| `verif-subset-guard` | 守卫 | 守护文件仍在可翻译子语言内 + 负控制(塞进 async/node:fs 会红) |
| `verif-symbolic-smoke` | 引擎保真 | indexToRef 界内 UNSAT / 界外 witness 回放 / 错误规格被拒(翻译保真) |
| `verif-bug3691-oscillation` | 定向不变量 | 紧急截断在门限处可触发(SAT+witness)且门限下不可触发(UNSAT);两轮回放展示同一重发历史出站字节翻转 |
| `verif-bug3769-orphan-window` | 定向不变量 | 只增不删的历史里"可见的必须保持可见"被孤儿窗口破坏;窗口调大后稳定 |
| `verif-bug3676-wire-reorder` | 定向不变量 | openai wire 重建 [file,text]→[text,file] 部件重排(SAT + 真代码回放) |
| `verif-bug3805-durable-ref-migration` | 定向不变量 | 保护解除时 BLOCKED→数字引用迁移给已发送字节中途加标签;非 durable 追加稳定(UNSAT) |
| `verif-generic-append-stability` | **任意输入** | 消息全符号化、唯一不变量"只增不删的字节稳定":Q1 SAT(#3805 形状泛化重现)、Q2 SAT(**求解器自己发现的新 bug #3945**:id 撞车重打标,零保护解除)、Q3 UNSAT(排除两个已知形状后界内无第三种) |
| `verif-induction-append-stability` | **归纳判官** | 任意消息数的 append-only 稳定性:前缀抽象成一个符号绑定,归纳步 UNSAT(id 不重复时任何前缀状态都动不了);撤掉约束 SAT = #3945;真代码随机抽查 60 轮 |
| `verif-wire-responses-stability` | 回放判官(无求解器) | responses 编码三件套(responsesToCore/coreToResponses/patchResponsesInput):verbatim 往返(钉住 #4150 文本前邻丢图)、折叠局部性、patch 幂等、Easy-stamp 一致性(#3837 计数维度)、追加局部性、#3642 部分幸存、文本编辑局部性 |
| `verif-adapter-wire-stability` | 回放判官(无求解器) | 三个 adapter 的 buildRequest 出站重建:已完成轮次字节跨轮稳定(P1/P3,轮合并感知——开轮可长,完成轮不可动)、幂等+输入不可变、notes 只动尾部、工具轮全量保全。#1637/#1876/#2499 的字节前缀性质推广到三家并钉住 |
| `verif-view-latch-discipline` | **锁存纪律判官**(#3989) | 安静轮 latch 字节逐字回放(Q1 UNSAT)+ 新鲜消息直通不受污染(Q2 UNSAT,任意 pre/post/latch 文本)+ 真代码行为矩阵(quiet 回放 / 到达锁存 / 折叠重置 / 稳态零churn) |
| `verif-conflict-watch` / `verif-snapshot-render` / `verif-wire-anthropic-roundtrip` / `verif-wire-google-rebuild-stability` | 定向不变量 | conflict-watch 降落门限纪律(#2709/#3806 形状,边界 749/1000 vs 750/1000);snapshot-render 尾保真(发现 **#4052**:新消息与已压缩消息同文本被整条丢弃,钉为翻转断言);anthropic 同类对序+载荷保真;google 重建 append-only 稳定 |
| `verif-responses-ingress` | 定向不变量(#3837 家族) | 入站三件套(normalize→sanitize→drop,真实管线顺序)幂等/规范化/局部性全部 UNSAT + 各阶段可达性 SAT + 60 轮随机回放锚 |
| `verif-tag-echo-filter` | **回放性质判官(无求解器)** | tag-echo-filter 真实代码上的流式分块等价 / strip 幂等 / 单调不增 / 干净保全 / 残留对偶 + 逐 issue 控制(#644/#1720/#1760/#1881/#2023/#2862/#717/#2405)。**发现 #4106(strip 不幂等:marker 门控序)与 #4107(流式输出依赖分块,两种形状)——均钉为已坏控制,修复后翻转(#4107 形状 2 已由 #4170 关闭并翻转为恒等钉;形状 1 仍钉)**。strip 链的 lookaround+\p{So} 正则与流式 re.exec 循环在翻译子语言之外,故此判官用真实代码回放性质而非求解器 |

## 无作弊规则(写新 harness 前必读)

1. **只调真入口函数**:harness 通过 `translateFunction` 编译仓库里的真实
   文件,不复制逻辑、不复述算法。
2. **不变量必须是通用性质**(幂等/单调/append-only 稳定…),绝不在 bug
   行号附近写断言。允许手工挑选的只有"场景脚本"(输入的形状),因为宿主
   行为是开放集。
3. **反例必须回放真代码**:witness 代入真实函数,行为不符 = 引擎 bug,
   修引擎,绝不放宽断言。
4. **port 是公开接缝**:token 计数器、isProtected 这类真实可注入参数用
   `portImpls` 提供符号实现;但本地函数名和 import 的真实函数**永远优先于
   port**,防止用 port 偷换真实逻辑。
5. **负控制必须有**:每个 SAT 证明配一个"已知修好/排除后 UNSAT"的对照,
   证明判官不是永真式。

## 建模决定(诚实清单)

- 数字 = Real(有理数);整数性用 `IsInt` 约束,不静默取整。
- 求解不可判定的角落**降级并登记**,不假装:降级项会出现在
  `exec().degradations`,harness 断言空列表才能立案。
- 动态正则(ownTagRe)按"锚定前缀"过近似:前缀不匹配 → 精确 false;
  匹配 → 未解释函数 + 降级标记(仅可达时)。
- `String(n)` / `toFixed` 等确定性渲染 = 未解释函数(同名同参同值),
  保证跨轮稳定;witness 回放仍然落在真代码上。
- 循环展开 K(默认 8)、数组槽位 N(默认 8):**有界模型检测**。要"任意
  消息数"不用加 N —— 用归纳判官(`verif-induction-*`)。
- 模块级常量从源文件真实收集,不手抄。
- 幻影臂已修(历史教训,保留记录):①符号键读扇出第一层曾用
  iteVal——obj/arr 与 null 中性值合并时 nullUnder 丢失,`o?.[k]` 键未命中
  也会交出条目值(假真值+字段幻读),现改 iteStrict+member 读nullUnder门;
  ②mergeVal 数组单臂槽位曾走 undef-loses 折叠,分支值无条件可达,现改
  guardedNeutral 携带分支守卫。

## 已发现的 bug(求解器自动 + 回放确认)

- #3691 紧急截断震荡(harness 定向找到;回放顺带发现截断结果比原文长 → #3935)
- #3769 失败压缩轮换的孤儿窗口
- #3676 openai wire 重建重排
- #3805 durable 引用迁移重打标
- **#3945 重复 id 重打标 —— 通用输入 harness 在任意输入下自己发现的新形状**
- **#4052 快照渲染丢最新消息 —— snapshot-render 判官(修复 #4057 已合并,钉翻转)**
- **#4106 标签清理不幂等 / #4107 流式输出依赖分块 —— tag-echo-filter 回放判官自己发现**(种子 0x7ea4c0de,输入由标签文法生成)

## 扩展

- 加守护文件:改 `guarded-files.ts`,先确认翻译器支持其语法(守卫会告诉你
  缺什么),例外登记 `exceptions.ts`。
- 加不变量:新 harness 文件,遵守上面的无作弊规则;SAT → 回放 → 真 bug
  开 issue + 回归钉;UNSAT → 界内证无,写清楚界。
- 从有界到无界:归纳判官模板 = 前缀抽象 + 单步 UNSAT + 已知例外 SAT +
  真代码随机锚点。
