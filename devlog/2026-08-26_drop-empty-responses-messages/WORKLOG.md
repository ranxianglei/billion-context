# WORKLOG — drop whitespace-only Responses message items

## 2026-08-26

### 诊断

1. **会话文件取证** `~/.omp/agent/sessions/-tmp/2026-08-26T10-35-43-161Z_01a03da3-....jsonl`：
   - 本地一条 assistant 消息 = content 块数组 `[thinking, text("\n\n"), toolCall(read), text("\n"), toolCall(read)]`
   - 全程 JSON，**不是按回车拆分**
2. **wire 层摊平**：Responses API `input` 是扁平条目列表（message / function_call / function_call_output 各自顶层），没有 anthropic 那种"一条消息内混排块"的表达 → omp 序列化时每个 text 块摊成独立 message item。空白 text 块（模型工具调用前的 `\n\n`）就成了独立空消息。协议必然，非 omp bug。
3. **pi 对照**（6 个真实会话）：anthropic wire 的 content 本来就是块数组，可原样放一条消息 → 162 处空白块全部在混合消息内部，**0 条独立空消息**。pi 不受影响。
4. **责任三层**：模型吐 `\n\n`（SGLang 习惯，正常）/ omp 摊平（协议必然）/ **bili 给 1-token 空白盖 42 字符标签+编号（唯一该修层）**。
5. **粘性发现**：请求 dump（`~/.local/state/billion-context/dumps/req-*-9d41f1d8aa9cd4f3.json`，8 份）验证纯 `trim()` 判空白 dropped=0 —— 上轮盖的标签已把空白变成 43 字符"非空"文本被 omp 原样回放 → 必须**剥标签后再判空白**。

### 修复

- `src/loop/adapter-responses.ts`：
  - `dropWhitespaceResponsesMessages(input): number` — 倒序遍历；`type === "message" || undefined`（omp user 条目无 type）+ role user/assistant + 纯文本 content（数组遇非 text/input_text/output_text 部件标记 mixed 保留）+ `stripRenderTags` 后 trim 为空 → splice
  - `RENDER_TAG_RE`（hex 转义源码铁律）+ `stripRenderTags()`：剥 `<acp ...>ref</acp>` 与自闭合形态；标签包真内容（如 `m00002` 实文）永不删
- `src/server.ts` `prepareResponses`：`sanitizeResponsesInputIds` 之后调用；dropped>0 打日志 `dropped N whitespace-only message item(s) before projection (flattened-turn artifact)`
- `tests/responses-empty-messages.test.ts` 4 测试：混合形态删 3 保 6 / 剥标签判空白（tag-over-nothing 删、tag-over-content 留）/ string content 与 developer/system 角色永不删 / 非数组容忍 + refusal 部件保留

### 验证

- 真实 dump 回放：8 份历史请求 dropped `0/0/2/2/3/3/4/2`——每请求剥 2-4 个空壳
- `632/632` tests + typecheck + build 全绿

### 决策

- **不并入 PR#257**（omp 原生插件，CI 绿等合并；文件零重叠，定位不同：#257 = 恢复原生模式，本修 = wire 模式上下文卫生，对所有未绑插件的 Responses 客户端长期有效——原生模式下首次请求（未绑定）仍会出现空消息，修复互补）
- 分支 `2026-08-26_drop-empty-responses-messages` 自 master `5982720`

### 教训

- dump 请求里"非空"的空白消息 = 标签粘性，判空必须先剥标签
- 源码内任何 `<acp>` XML 一律 `\x3c/\x3e` hex 转义（AGENTS.md 铁律）
