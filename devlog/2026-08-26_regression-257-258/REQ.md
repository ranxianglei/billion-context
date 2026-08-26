# REQ — PR#257 + PR#258 本地合并联合回归

## User request

用户：「俩合并到一起然后本地测试？」——把 #257（omp 原生插件模式）与 #258（Responses 空白消息丢弃）本地合并，验证互相不影响，交付联合回归 PR（同 #250 先例）。

## Acceptance

- 本地 merge 两分支（自 master 5982720）零冲突或合理解决
- typecheck + 全量测试 + build 绿
- 真机 e2e 同时命中两 PR 的行为
- 联合回归分支推送 + PR

## Outcome

见 WORKLOG.md——四点一次 e2e 全部命中，PR 已建。
