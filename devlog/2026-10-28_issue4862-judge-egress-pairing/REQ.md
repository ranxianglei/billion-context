# REQ — issue #4862 残余缺口:出站判官对断配对 tool_use/tool_result 判 clean 放行

- 日期:2026-10-28
- Issue:#4862(claude 子代理 400 线,三件套之一)
- 关联:PR #4774(根修:子代理不再共享 session id)只消除了主触发源;owner 在 #4769 评论明确划界「第二面 = invariant judge 给 clean verdict、破损配对照样出网,是出口校验缺口,不在 #4774 范围内,归 #4862 单独补」。

## 问题

`src/invariant-judge.ts` 的判官只定义了两条不变量:

- I1(无折叠):入站每条 stable 消息按序出现在出站,合法差异仅尾部追加+具名豁免;
- I2(折叠):所有差异局限在 `[earliest-fold-start, end)`,冻结前缀字节不变。

两条都是 entry↔exit 的连续性对账,**没有任何一条对 exit 自身做协议结构校验**。#4862 的实际形状:折叠/渲染把一对 tool_use/tool_result 拆断、只送出半侧 → 差异全部落在折叠区 → I2 判合法 → clean fold verdict(`src/invariant-judge.ts` debug 行)→ 上游 400。这正是日志里最容易被误读成「bili 没问题」的行(owner 原话)。

## 需求

1. 出口校验名副其实:协议结构破损的出站体**永远不允许读成 clean**,与差异是否局限在折叠区无关;
2. 归因保持「谁的错」职责:宿主自己发来的断对不是 bili 的错,不告警;
3. kernel 守卫豁免对齐:compress 在途调用(结果由 hideConsumedCompressCalls 管理)不告警;
4. 纯检测、零拦截、零出站字节改动,受既有 `diagnostics.invariantJudge` 旋钮控制;
5. 模式无关:legacy 全量、render-lane tail(#4241)、主车道、loop 第 2+ 轮一视同仁;
6. #3617 门纪律:正负测试行双向齐全。

## 非目标(明确划界)

- 不修「真正拦住 400」的出口修复(剥孤儿半侧/上提楔入项)——那是 wire/message-shape 变更,属人工审核层,等第 1 层判官红线在真实流量确认命中形状后单独决策。
