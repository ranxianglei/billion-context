# Plugin Lanes(Lane P)— 真实宿主 CLI × 真实模型(中文版,英文版见 [README.md](./README.md))

这些车道用**真实的宿主 CLI**(dsh / pi / codex / claude-code / opencode)+ **真实模型**
驱动 billion-context 的两条激活路径,把 #3416 的盲区补上:老 gate 只测代理模式,
#3401 那类「插件会话里工具明明在、提示却被关」的回归在 gate 里全程绿灯。

## 两条激活路径

| 路径 | 宿主 | 机制 |
|------|------|------|
| native | dsh, pi, opencode(v1/v2) | 薄插件/原生扩展拦截宿主 fetch,盖 `x-bili-plugin` 头,**自起代理(port 0)**——外部绝不手动起代理 |
| prefix | codex, claude | 宿主配置指向 bili 代理的 `/bili/` URL 前缀(代理模式),代理由本脚本手动起 |

## 断言什么(wire 是真相源)

`upstream-recorder.mjs` 垫在 bili 和真模型之间,JSONL 记录每个请求体/响应;
所有断言直接从模型实际收到的东西上做——内部日志可以被抑制类 bug 骗过(#3401),
wire 骗不了:

- 上游有流量(请求真的到了模型)
- ACP 工具(compress/acp_status/…)真的出现在 wire 的 tools 里
- 插件 claim:会话文件 `payload.metadata.pluginAgent == "<agent>"`
- **nudge 硬断言**:wire 上必须出现 nudge 文本(不接受「日志里有 INJECT」——
  注入可能落在永不转发的 in-band 错误响应里,那是假绿)
- fold 触发(`acp-compress-obs] shrink N%`)
- 折叠前后暗号回忆(corpus 40 段,S07 早段/S40 末段 CODEWORDS 暗号)
- 无 `unknown tool` 空转

## dsh 协议矩阵(#3475)

dsh 的模型客户端 pi-ai 支持全部四种通用协议,dsh 车道因此从一门扩成四门——
同一套 headless 驱动,只换 cordis provider 的 `api` 与 baseURL 后缀,t1→t4
流程和断言不变:

| 车道 | pi-ai api | bili 前门 | 上游门要求 |
|------|-----------|----------|------------|
| `dsh`(原有) | openai-completions | `/v1/chat/completions` | chat completions |
| `dsh-responses` | openai-responses | `/v1/responses` | 真实 `/v1/responses`(404/映射 400 → env-blocked) |
| `dsh-anthropic` | anthropic-messages | `/v1/messages` | `/v1/messages`(claude 车道的交叉验证) |
| `dsh-google` | google-generative-ai | `/v1beta/models/<id>:streamGenerateContent` | `/v1beta` google 门 |
| `dsh-proxy` | openai-completions(**代理模式**) | `/bili/…/v1/chat/completions` | chat completions(经 `/bili/` 前缀) |

`dsh-proxy` 是同一宿主的**另一条激活路径**(owner 加项):profile **不装**
billion-context bundle(装了它的 fetch 拦截会盖 `x-bili-plugin` 头把车道翻回
插件模式),dsh 直连手动起的代理 `/bili/` URL——codex/claude 同款形状。与
native `dsh` 车道同脚本对照:#3177/#3401 类抑制只存在于插件路径,代理模式下
nudge/fold 必须以 acp_summary 载体正常上 wire;窗口真值 = bili.json(与所有
prefix 车道一致)。

每门新增 **wire 形状硬断言**:recorder 里该门的每个 POST 必须路径+顶层体字段
都是该协议形状(chat=`messages` / responses=`input` / anthropic=`system`+blocks /
google=`contents`),防止静默换线假绿;首个出站请求存
`<work>/<agent>/egress-sample.json` 作往返证据。

两个已知事实:

- **bili 出站不做 google→chat 翻译**——recorder 看到的正是 dsh 发出的 google
  形状(`:streamGenerateContent` + contents/parts)。google lane 只能在有真
  google 门的上游上满绿;要「必须 chat 出」则是给 bili 加出站翻译功能,单独立项。
- **blocked 降级规则**(两种 kind,脚本结尾打印 `ENV-BLOCKED`/`CLIENT-BLOCKED
  [lane] <原因>` 行):
  - **env**:上游门不健康——门上请求**全部** 4xx/5xx/连接错误且无回合完成
    (opencode2/#3461 原规矩),或**中途劣化**(前若干请求 200、后续被拒、流程
    未走完——自建服务 responses→chat 映射 bug 的典型形态,#3461 同族)。
    traffic + wire 形状仍是硬断言,turn 相关断言不计入 gate 成败。
  - **client**:客户端当前版本根本表达不了该 api(dsh ≤0.2.1-rc.1 的 cordis
    schema 只列 openai-completions/openai-responses/anthropic-messages 三门,
    google-generative-ai 在 pi-ai 库里有实现但 dsh 配置面没暴露)——零上游流量
    + 每回合死于 ValidationError。整条车道不计入 gate,客户端放出该协议后
    自动转正,脚本不用改。

不进默认 GATE_AGENTS 集,显式加入才跑:`GATE_AGENTS=dsh,dsh-responses,dsh-anthropic,dsh-google,dsh-proxy`。

## 车道流程

1. **t1 @ 大窗**:读 corpus,回显 S40 + S07 双暗号(双标记验证「真的读全了」——
   模型可能照指令分块读、也可能漏读中段,漏读会让后续 S07 回忆断言变成假红;
   此阶段 fold 必须不触发)
2. **窗口收缩**:改**宿主自己的**模型配置(dsh cordis / pi models.json /
   opencode.json limit / codex config.toml / claude 模型别名)——有效窗口经
   `x-bili-plugin-context-window` 头进 bili,native 代理的 zone 端口是粘滞的,
   每请求重读,不用杀代理
3. **t2 @ 中窗**:S07 回忆(intact)+ nudge wire 硬断言;中窗从 t1/t2 实际
   usage 自校准,目标 75-95% 压力带
4. **t3 @ 小窗**:"DONE"——preflight fold 必须开火
5. **t4**:S07 折后回忆

## 怎么跑

前置:node ≥ 20、各宿主 CLI 装好(dsh / pi / codex / claude / opencode)、
一个 OpenAI 兼容真模型端点、候选拿 `npm pack` 打出 tarball。

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=http://127.0.0.1:8199 \
MODEL1_MODEL=<model-id> \
GATE_AGENTS=dsh,pi,codex,opencode,claude \
node scripts/gate/plugin-lanes.mjs
```

- `GATE_AGENTS` 选车道子集;`GATE_TURN_TIMEOUT_MS`(默认 300000)、
  `GATE_BIG/MID/SMALL_WINDOW`、`PLUGIN_LANES_WORK`(工件目录,默认
  `./plugin-lanes/`)可调
- dsh 车道:`GATE_DSH_VERSION`(每车道自装 `@deepseek-ai/dsh@<v>`,默认
  latest——系统 dsh 可能太旧且全局 billion-context 会遮蔽候选 bundle)、
  `GATE_OUTPUT_TOKENS`(输出预算:bili.json 预留 + dsh cordis maxTokens,
  默认 4096;思考型模型吃光预算只出 reasoning 不出正文时调大)、
  `GATE_DSH_SMALL_WINDOW`(固定覆盖 t3 小窗;默认从 t2 末尾实际 payload
  推导——dsh 固定脚手架 ~18k tok,静态 24576 扣掉输出预留后连空会话都装不下)
- 每车道工件:`<work>/<agent>/turn-t{1..4}.txt`、`upstream.jsonl`、`bili.log`
  (dsh 家族另有 `egress-sample.json`)
- opencode2 车道不进默认集:transport websocket 直通 Responses-WS(HTTP-only
  上游握手必死)、transport http 依赖上游 /v1/responses 质量——见 #3461;
  车道仍断言 tools/claim/流量
- **红绿对照**(#3416 验收):master 构建(含 #3401 病)在本车道报
  nudge wire MISSING / log:ARMED-SUPPRESSED;含 #3403 的构建全绿

## 与仓库外 harness 的关系

车道脚本随仓库走(和被测代码同版本);容器化包装(Dockerfile、 verdaccio、
自建镜像、模型端点)在各自的 gate harness 仓库/机器上,不进本仓库。
远程 CI 默认不跑:`.github/workflows/ci-gate-plugins.yml` 仅 workflow_dispatch
手动触发,没有 push/PR 触发器。
