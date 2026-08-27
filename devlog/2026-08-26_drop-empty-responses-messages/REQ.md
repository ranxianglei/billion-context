# REQ — drop whitespace-only Responses message items at ingress

## User request

用户在 omp `--resume 01a03da3-d8b9-7000-8637-5d82777129fe` 会话里看到大量 1-token 空消息（模型自己枚举消息列表时发现）。追问链：

1. 这些空消息哪来的？
2. 是我们（bili）动态插入导致的吗？
3. pi 里也会这样吗？是 SGLang 协议问题、客户端问题还是我们的问题？
4. 消息不是 JSON 的吗，难道按回车拆分了？
5. 和前面的 PR（#257 omp 原生插件）一起修吗？

## Acceptance

- 查明空消息来源与责任层
- 修复：空消息在进投影前被丢弃，不再被盖标签/编号
- 不影响带真实内容的消息（哪怕大部分是空白）
- 全量测试 + typecheck + build 绿
- 独立 PR（不与 #257 混）

## Outcome

- 根因：Responses wire 无混合 content 表达 → omp 把模型回合一回合 text 块摊平成独立 message item；模型（SGLang 习惯）工具调用前吐 `\n\n` → 独立空消息。bili 给 1-token 空白盖 42 字符 acp 标签 + 编号 → 10 倍膨胀 + ref 噪音 + 粘性（标签把空白变"非空"永久回放）。pi 不受影响（anthropic wire 块数组可原样放一条消息）。
- 修复：`dropWhitespaceResponsesMessages` 在 `prepareResponses` 投影前剥标签判空白并删除；标签包真内容永不删。
