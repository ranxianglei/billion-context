# REQ

用户合并 PR#259 后要求处理三个 PR(#257/#258/#259)评论中遗留的未处理小问题(non-blocking review notes)。

来源(评审评论):
1. #259 review note 1: `pipePluginJson`(非流式 plugin 路径)仍 verbatim 转发 — 与 compress loop JSON 分支(compressLoopResponsesJson 每轮 strip)存在 parity 缺口。Responses 客户端都用流,属防御性路径,但应补齐。
2. #259 review note 2: `rebuildEvent` 只替换首个 `data:` 行;多行 data 事件(真实上游不发,解析器容错)重建后会拼坏。
3. #259 review note 3: 流被切断(无 done 族事件)时 held tail 丢失 — 与 compress-loop adapter 相同暴露,但 plugin 管道可以做得更好。
4. #258 review minor: 非对象 content part 在 join 循环中被静默跳过 → `content: [42]` 会被算作空并丢弃;应视为 mixed 保留。
5. #259 review note 4: openai 协议 plugin 直通不剥标签 — 有意的 scope 决策(观察到的是 omp/Responses),保留。

## 验收
- 上述 1-4 修复,5 保持现状(决策记录在案)。
- 全量测试+typecheck+build 绿;新增回归测试锁住各行为。
