# 联合回归: #254 preflight + #264 type-less items

## Request

用户: "两个是否合并后在本地验证呢" — #254(#247 模型切换溢出 preflight 修复) 与 #264(omp type-less user items 修复) 合并后做本地联合回归, 确认互不破坏且 #247 场景修复生效。

## Worklog

- 分支 `2026-08-26_regression-254-264` 自 origin/master(82402f9, v0.1.56); 依序 merge `origin/2026-08-26_preflight-overflow-compress`(#254, +989/-48, 4 文件) 与 `origin/2026-08-26_responses-typeless-items`(#264, +91/-2) — **零冲突**。
- 预检: typecheck ✓; **652/652 全过** ✓; build ✓ (dist 2.49MB)。
- e2e(真实 omp 17.3.8 + mock 上游 /tmp/mswitch/mock.js:19981, LIMITS mock-big=100000/mock-small=24000):
  1. 隔离 PI_CODING_AGENT_DIR=/tmp/mswitch/agentA(models.yml 指 mock), 代理 19982(dist, --no-auto-update)。
  2. mock-big 累计 11 轮嵌入文档(est 44053)。
  3. 切 mock-small: 代理日志完整链路 —
     - `stamped type:"message" on 20 type-less input item(s)`(#264, 每轮都在, user 项进内核)
     - `context 44053 tokens exceeds model window 23744 (model=mock-small); preflight compressing before forward`(#254 触发)
     - `preflight compressed 4 range(s), ~21484 tokens saved (44053 → 22569) in 18ms; rebuilding payload`
     - mock verdict=pass(est 23007<24000), exit 0, 无 400
  4. 切换后追加一轮 est 23110 pass exit 0 — 会话稳定。
- 对照组(0.1.56 全局 bili)此前已复现 bug: 同场景 mock REJECT, 上游 400 原样回传, 会话卡死。

## Conclusion

两 PR 合并零冲突, 联合树 652/652 + e2e 决定性通过。#247(模型切换上下文满报错卡死)修复在 omp 真实链路验证有效; #264 是 omp 场景的前置必要(type-less 项不进内核则 preflight 无可压缩范围)。建议: 合并 #254 + #264 后发版。
