# WORKLOG

- 分支 `2026-08-26_plugin-passthrough-polish`(自 master 159e82b,#259 已合并)。
- `src/plugin.ts`:
  - `pipePluginJson` 尾部新增 responses 分支:body 含 render tag 时 `stripResponsesText` 后重新序列化返回;openai 协议与无标签 body 保持 byte-identical。与 compress-loop JSON 分支(compressLoopResponsesJson 每轮 strip)对齐。
  - `rebuildEvent` 加固:替换首个 `data:` 行后,后续 `data:` 行全部丢弃(多行 data 载荷折叠为单行重建,避免两条 JSON 拼接)。
  - `pipePluginResponsesWithStrip` 读循环结束后:若响应未销毁,flush held tail 为最终 delta(流被切断时不丢 prose)。
- `src/loop/adapter-responses.ts` `dropWhitespaceResponsesMessages`:非对象 content part(如 `content: [42]`)从"静默跳过"改为 mixed → 整条 item 保留(空判不可知时不删)。
- 测试:
  - `tests/plugin-passthrough-tag-strip.test.ts` +4:流切断 flush tail / 多行 data 折叠 / pipePluginJson responses strip / pipePluginJson openai+无标签 byte-identical。坑:测试 payload 里 tag 的引号必须 JSON 转义(`\"`),否则 payload 本身非法 JSON,走了 verbatim 回退路径假失败;makeRes.end 需记录内容。
  - `tests/responses-empty-messages.test.ts` +1:malformed part → item 保留。
- 验证: typecheck ✓ 646/646 ✓ build ✓。
- note 4(openai 协议不剥)保持现状:观察到的 tag-echo 循环全部是 omp/Responses;扩大范围等出现真实案例。
