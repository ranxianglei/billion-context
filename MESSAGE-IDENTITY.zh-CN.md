# 消息身份:为什么 content-hash 是跨轮 join key

设计记录,定案 #1496 提出的问题:**消息身份能否用入口显式自增 id 取代
content-derived hash?** 结论:不能——消息身份保持 content-derived;而且这个问题的
本质是 **join key**,不是 id。本文是 SESSION-IDENTITY.md(会话粒度身份)的消息粒度
姊妹篇。实现锚点:内核 `deriveMessageId`(入站时从消息字节铸造 raw id)、
`session.state.messageRefs`(`byRaw`:hash → ref,`byRef`:ref → hash)、
`src/server.ts` 的入站对齐、`src/session.ts` 的漂移检测(`foldCoverage`、
`detectUnannouncedHistoryRewrite`)。

## 原则:问题在 join key,不在 id

ref 账本(`mNNNNN`)**本身**就是会话内自增、永不复用的显式 id——内核契约,见
AGENTS.md §2「Kernel Contract: Message Ids Are Never Reused」。所以 #1496 真正的
问题不是「去哪拿一个稳定 id」,而是:**第 N+1 轮,拿什么把持久化账本重新钉回宿主
刚重新序列化的消息数组?**

第 N+1 轮,宿主从自己的私有存储重新序列化完整历史;bili 看到的是一段新字节序列,
永远看不到数组的「出生」。持久账本与入站数组之间的 join,必须跑在双方都持有的 key
上。内容字节是唯一在所有支持宿主 × wire lane(#1496 逐一核查过五个宿主——codex、
claude-code、pi、omp、hermes——跨四条 lane:anthropic chat、openai chat、responses、
google)都稳定的 key。因此 raw id 是内容哈希(内核从消息字节铸造的 `h_<sha16>`),
`byRaw` 映射 hash → ref:**hash 层不是另一种身份,而是每轮把自增账本重新钉回入站
数组的 join。**

两条推论从 SESSION-IDENTITY.md 继承:

- **逐字节精确是承重契约。** id 由消息的精确字节导出;任何一个字节变化都会得到不同
  的 id。这是契约,不是缺陷。
- **hash 同时是变更探测器。** id 是字节的函数:客户端一旦 edit/rewrite/fork 历史
  (#1148/#1102/#1247),id 就变、join 就断,系统**从断口本身**检测到漂移:
  `foldCoverage` presence 检查(#1195)、`detectUnannouncedHistoryRewrite`(#1001)、
  fork adoption(#629 一族)。换成显式分配的 id 会悄悄丢掉这个信号——同样的 id、
  不同的字节、没有警报。

## 经手 ≠ 执笔 ≠ 存储

立场 A 的核心错误(#1496)是混淆了两个数组:出站数组(bili 压缩后发给上游的——
bili 执笔)和入站数组(宿主发给 bili 的——宿主执笔)。**join 跑在入站数组上**,而
在这个数组上执笔权在宿主手里:

1. 客户端维护自有会话存储,**每轮从自己的存储重新序列化**完整历史;
2. bili 做 wire → core 转换(内核现场从字节推导 content-hash id),与持久化
   `byRaw` 账本对齐;
3. bili 打在入站消息上的任何标记只活在本次请求的内存里,**从不写回客户端存储**。
   下一轮客户端照发它自己的原始副本,无标记。

逐宿主核查(五个支持宿主全部满足「自有存储 + 每轮重新序列化」):

| 宿主 | 模式 | 自有存储 | 我们打的标记能往返吗 |
|---|---|---|---|
| codex | proxy · responses | rollout 文件 | 只回传它自己存的——#242 证明它把 `input[].id` 存进 rollout 并回传,而上游对 ours 直接 400 |
| claude-code | proxy · anthropic | JSONL transcript | 否 |
| pi | plugin | 自有会话 | 仅 bili 自铸的工具结果 / marker |
| omp | plugin | 自有会话 | 同上 |
| hermes | plugin | 自有会话 | 同上 |

plugin 模式是立场 A 唯一部分成立的角落:agent 自己执行 `compress`,工具调用与结果
活在 agent 自己的历史里,bili 在那里铸造的字节确实往返。但这并不消除对外来消息
(user 文本、非 bili 工具结果——流量的大头)的 join 需求。B 在所有支持宿主上一致
成立;plugin 模式是有界例外,不是反例。

## 没有任何 lane 存在可写的 id 字段

显式 id 需要某条 lane 提供消息级 id 字段,且同时满足:(a) 上游接受任意值;
(b) 宿主存回并回放。**没有 lane 两者兼备:**

- **anthropic chat / openai chat**:根本没有消息级 id 字段(只有服务商铸造的
  `tool_use` / `tool_call` id)。无可写之处。
- **Responses `input[].id`**:字段存在,但属**服务商命名空间**——上游做形状校验 +
  回放配对:
  - #242:bili 铸 `msg-proxy-2-<54 字符上游 id>` = 66 字符 > 64 字符上限;Codex
    Desktop 把它存进 rollout 并回传;此后上游每轮 400("string too long … maximum
    length 64")。会话永久卡死,直到 #243 改用 `hashId()` 重映射(共 28 字符)+
    入口修复。
  - #1475:入口改写服务商 opaque id(`rs_*` reasoning、`fc_*` function_call)导致
    Copilot 400(`Expected an ID that begins with 'rs'`);reasoning id ↔
    `encrypted_content` 有回放配对,改名即破坏身份。修复只能收窄到 bili 自己的
    `msg-proxy-*` 前缀——`sanitizeResponsesInputIds`(src/loop/adapter-responses.ts)
    删除这些 id(改为整条消息回放)、把超长外部 id 缩短为 `msg-fix-<hash>`,其余
    原样通过。
  - 教训:即便某宿主确实存回并回传了 id(#242 证明往返会发生),上游形状校验仍让
    该字段无法当自由身份戳用。**「字段存在」≠「可写」。**
- **google**:同一服务商命名空间模式。
- 把 id 嵌进内容字节则直接违反 wire fidelity(#1039 不变量——转发的字节保持
  byte-exact)。

## 单条字节稳定,数组前缀不稳定

立场 A 的第二条前提——「前缀永不变,顺序本身就是稳定判据」——在生产中不成立:

- **fold 缩短数组**:bili 自己的折叠把覆盖段替换为 summary carrier;
- **宿主自压缩改写历史**:#1001 `detectUnannouncedHistoryRewrite`(opencode 切模型
  时静默改写历史);`REWRITE_MIN_INCOMING_TOTAL = 10` 守卫区分真改写与 stub 侧请求
  (#1075);
- **fork / regenerate / edit 改早期字节**:#1148/#1102 分支重放、#1247 同位置改写;
- **侧请求发短数组**:#1307。

真正成立的公理更弱:**单条消息在其存活期内字节不可变**。这恰好就是 content-hash
需要的全部公理——不多不少。

### 失败模式不对称

这是决定性论据。两个 join 候选的失败方式截然不同:

- **位置 join 失败 → 认错(misattribution)**。ref 和压缩块挂到错误的消息上——静默
  数据损坏。#1307 事故(163/163)即生产实例;其原始的计数守卫(≤2)正是纯顺序
  启发式,失败了。
- **hash join 失败 → 认不出(non-recognition)**。消息只是没被识别为已知;代价是一
  次 raw 重发 + ladder 重启——自愈的性能损失,永不损坏数据。

最坏情况只是「变慢」的机制,永远胜过最坏情况是「悄悄出错」的机制。

## hash 公理自身的 bug,是靠保留 hash 修掉的

content-derived id 有一个固有属性:同字节 ⇒ 同 id。#1476 恰好撞上它——重发的 user
消息与其早期实例撞号。修复没有退回位置 id,而是在 hash 基座之上**叠加实例判别**:
kernel #459 给撞号实例重铸后缀(持久的 `_1/_2` 维度——内核实例耐久性契约),#463
加入 `lastPassIds` 回声判别。实例耐久性与「id 从哪种基座派生」正交。

值得记录的反直觉点:撞号的是一条 USER 消息——恰恰是**无法携带持久入口自增 id**
的那一类(user 执笔、客户端存储;bili 从未见过它的出生)。换显式 id,user/外来消息
仍只能退回 content-hash。

## Tag 是派生视图,不是身份

渲染 tag——包裹每个消息 ref(`mNNNNN`)并携带 `tokens=` / `type=` 属性的 `acp`
XML 标记——是账本在可见文本上的投影:出站渲染、入站剥离、重复渲染幂等。tag-echo
事故(#206、#14、#673)证明「标记进入存储」这条通道真实存在但很脏:模型在可见输出
里模仿 tag(包括拼错名字,#673),客户端回放被回声的 tag,模仿不断放大。修复放在
出站侧——src/loop/tag-echo-filter.ts 只从模型散文里剥离 tag 形状的片段,工具调用
参数保持 byte-exact 转发(#1039 不变量)。如果 tag 是身份,剥离它就会摧毁身份;
恰恰因为可以安全剥离,才说明它是视图而非载体。

## strict-echo reasoning:唯一的上游强制内容往返

某些上游(DeepSeek thinking mode,#684;历史 #762/#1479/#1482)要求 reasoning
内容与 tool call 配对往返,否则拒绝请求——这是强制特定内容字节跨轮原样保留的
mandate。这是唯一一条上游要求内容往返的 lane,处理方式始终是**可修复的形状约束,
绝不当身份**:`isStrictReasoningEcho` 按 session/upstream/model 门控
(src/strict-echo.ts),`normalizeStrictEchoReasoning` 修复拆散轮次的签名,兜底策略
是整体丢弃 reasoning 而不半留(`reasoning-pair-violated` 警告,src/server.ts)。
身份机制既不读取也不依赖这些字节。

## 未来规则

若将来出现真正稳定的客户端消息 id——某个上游接受**且**宿主存回的协议字段(见上文
lane 核查)——它至多作为**附加提示**参与(join 消歧、加速采纳、便于调试),**永不取代
hash 基座**。这与 SESSION-IDENTITY.md 的未来方向一致:客户端信号缩小搜索范围,
逐字节哈希仍是 ground truth。任何提议更换基座的方案,必须先回答本文定案的四个
问题:入站数组谁执笔、哪条 lane 承载 id、失败模式是什么、user 执笔的消息怎么办。

相关:SESSION-IDENTITY.md(会话粒度)· #1496(本文定案的设计复核)· #1476 /
kernel #459 / kernel #463(撞号 + 实例判别)· #242 / #1475(Responses id
命名空间)· #1307(顺序启发式失败)· #206 / #14 / #673(tag echo)· #684(strict
echo)· #1039(wire fidelity)。
