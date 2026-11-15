# 真模型 gate — 容器 + 车道 + 配置驱动启动器(中文版,英文版见 [README.md](./README.md))

真模型发布 gate 的全部工具都在这一个目录里:Docker 镜像、车道脚本、配置驱动的
启动器。CI 跑其中它跑得动的子集(Lane P,`ci-gate-plugins.yml`);完整容器 gate
是给有真模型端点的操作者用的,每轮约 4-5 小时。

## 各车道证明什么

| 车道 | 名字 | 证明 | 驱动 |
|---|---|---|---|
| A | 压缩 | 真模型读 corpus → 会话中途窗口收缩 → **fold 开火**,暗号从折叠后上下文回忆,cache ≥50% 恢复 | dsh headless(pi 系 agent) |
| B | 模型切换 | 折叠后同会话切到**另一个上游/模型**:lineage 保留(或 fork+adopt),跨上游基线降级,暗号仍可回忆,新上游 cache ≥75% | dsh headless |
| U | registry | dsh 托管代理读 `update.registry`,拒绝原地自更新,「profile bundle up to date」 | `scripts/release-gate-local.mjs` |
| I | 安装 | `npm i -g <tarball> --install-links` = **真拷贝**(无 symlink 泄漏,#1225),CLI 报告候选版本 | `docker-lanes.mjs` |
| X | 自动更新 | 发一个假新版本的同 commit 构建 → `bili update` **装上了它**,CLI 落到新版本 | `docker-lanes.mjs` |
| P | 宿主车道 | 真实宿主 CLI(dsh/pi/opencode/codex/claude)走 bili **插件模式**:流量到上游、compress 工具在 wire 上活着、nudge 上 wire、fold 开火+暗号回忆(细节见下) | `plugin-lanes.mjs` |
| R | 重启 | 长会话先被压过上下文墙(默认 16384 token 小窗 ⇒ 有余量的 fold;更小的墙结构上不可行——折后稳态 ~20k tok,preflight 拒绝压不下的回合),真模型持续应答;然后反复 kill 且必须继续干活:**dsh**——自起的代理子进程经 kill -15 / kill -9 / 干净退出被杀,每次重生从磁盘恢复同一会话,出站远低于裸历史大小**且**高于裸问候地板(既压缩又非空),恰好一个活代理持有会话(无脑裂);**pi**——引擎内联在 pi CLI 里,kill 矩阵直接打在 pi 宿主进程身上。每次 kill 后重问近区标记词(证据行——折后逐字质量是 Lane A 的断言),上报 `cached_tokens` 时须恢复到先前 prompt token 的 ≥50% | `restart-lanes.mjs` |

## 密钥/端点契约

gate 在容器内**完全自足**(自己的 verdaccio 用内部端口、自己的 DSH_HOME/XDG、
自己的 scratch),所有机器相关事实——模型端点、API 密钥、npm registry、git
代理/镜像、测哪个 rev——都放在一个**你放在仓库外的本地 JSON 配置文件**里。
任何宿主相关内容(IP、端口、中继、账号、密钥)一律不得提交进本仓库;
`config.example.json` 只展示形状,值全是占位符。

## 怎么跑

前置:Docker(Linux host 网络或 Docker Desktop)、一个 OpenAI 兼容真模型端点
(Lane A)、可选第二个**不同**上游(Lane B;缺省则跳过)、一个本地配置文件。

```sh
# 1. 复制示例并填上你的端点 / 密钥 / rev
cp config.example.json ~/system/bili-gate.json   # 位置随意
# 2. 跑完整 gate(单轮 ≈ 4-5h,含真推理)
scripts/gate/bili-gate.sh --config ~/system/bili-gate.json --rev <分支或 tag>

# 常用参数
scripts/gate/bili-gate.sh --config ... --skip u,i,x        # 只跑 A/B/P/R
scripts/gate/bili-gate.sh --config ... --keep              # 全绿也保留 scratch
scripts/gate/bili-gate.sh --config ... --dry-run           # 只打印 docker 命令
```

配置键(除 `model1.baseUrl` / `model1.model` 外均可选):`model1.{baseUrl,
model,apiKey}`、`model2.{baseUrl,model,apiKey}`(Lane B)、`rev`、`skip`、
`sourceRepo`、`mirror`(容器 clone 的本地裸 git 镜像——容器零出站,且可走宿主
git 代理)、`gitProxy`、`npmRegistry`(构建依赖镜像;与容器内车道 registry
无关)、`turnTimeoutMs`、`agents`(Lane P 集合)、`agentsR`(Lane R 集合,默认
`dsh,pi`)、`r.{corpusTokens,window,capRatio,cacheRatio}`、`network`
(`host` | `bridge`;bridge 是 Docker Desktop 形态——把配置里的 URL 指向
`host.docker.internal`)、`outDir`、`keep`。

所有产物落 `outDir`(挂载为 `/work`):`gate-local.log`(A/B/U)、
`plugin-lanes.log`(+ `plugin-lanes/<agent>/…`)、`restart-lanes.log`、
`docker-lanes.log`、`verdaccio.log`、`gate-scratch/`。启动器先构建镜像;构建
失败时,除非本工作树的每个 `/gate-tools/*` 车道脚本与镜像内字节一致,否则拒绝
复用旧镜像(过期的车道逻辑绝不允许给发布判绿)。

## 镜像说明

- **带密钥 API 垫片**:`patch-gate.mjs` 在容器内对
  `scripts/release-gate-local.mjs` 做带守卫的补丁,让主车道可带 bearer key、
  探针把任何 HTTP 响应视为「活着」(带密钥网关的 401/404 不能中止车道)。
  仓库脚本与补丁器的守卫模式漂移时,构建步骤大声失败。
- **verdaccio 跑在容器里**(Lanes U/I/X):零宿主依赖、每 run 临时存储、内部端口
  不可能与宿主 registry 撞车。
- Lane P 的宿主 CLI 在镜像里固定为与仓库自身 CI 相同的版本(`ci-e2e-pi-ws` /
  `ci-e2e-codex-persona` / `ci-e2e-native-opencode`),gate 测的正是项目自己
  在测的界面。

---

# Plugin Lanes(Lane P)— 真实宿主 CLI × 真实模型

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
- 插件 claim:会话元数据 `pluginAgent == "<agent>"`——先读 `index.db`(纯
  SQLite 自 2026-11-13 起是存储默认),JSONL 信封扫描保留为旧候选的回退
- **nudge 硬断言**:wire 上必须出现 nudge 文本(不接受「日志里有 INJECT」——
  注入可能落在永不转发的 in-band 错误响应里,那是假绿)
- fold 触发(`acp-compress-obs] shrink N%`)
- 折叠前后暗号回忆(corpus 40 段,S07 早段/S40 末段 CODEWORDS 暗号)
- 无 `unknown tool` 空转

Lane R 从 recorder 的有上限响应体尾部读 `cached_tokens`(usage 在最后一个
chunk);敏感请求头落盘 JSONL 工件前会被掩掉。

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

## 单独跑 Lane P(不用容器)

前置:node ≥ 20、各宿主 CLI 装好(dsh / pi / codex / claude / opencode)、
一个 OpenAI 兼容真模型端点、候选拿 `npm pack` 打出 tarball。

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=<主模型 base url> \
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

## 与 CI 的关系

车道脚本随仓库走(和被测代码同版本);容器 gate 与远程 CI 车道
(`ci-gate-plugins.yml`,仅 workflow_dispatch 手动触发,无 push/PR 触发器)
跑的是**同一份候选 checkout 里的同一个脚本**。唯一留在仓库外的是携带机器
相关端点和密钥的本地配置文件(契约见上)。
