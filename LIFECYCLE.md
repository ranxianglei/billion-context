# LIFECYCLE.md — 过渡开关台账 · 退役模块盘点 · 卫生记录

> 与 CONFIGURATION.md 的分工：CONFIGURATION 记录每个旋钮**今天做什么**；本台账记录哪些旋钮是**临时的**（盖子 / kill-switch / 实验性 opt-in，带解除条件），以及哪些模块在退役路径上。
> 建立于 #3249（陈年件清理）。纪律：**只立账不删**——删除逐项由 owner 拍板。
>
> **CI 强制**：`scripts/lifecycle-ledger-guard.mjs`（workflow job `lifecycle-ledger-guard`）会检查 `src/` 里读到的每一个 `BILI_*` 环境变量是否都出现在本文件——**台账外的新变量直接 fail**；台账里有但代码已不读的条目只给 notice（动态生成名、未落 master 的分支变量属正常滞后）。

## 规则

1. `src/` 中读取的每个 `BILI_*` 环境变量必须在本文件出现（§1 或 §2）——CI 强制。
2. §1 = 过渡开关：有明确解除条件的盖子 / kill-switch / 实验。字段：引入 / 引入原因 / 解除条件 / 状态。
3. §2 = 常设面：按类列出，一行一个（名称 / 类别 / 一句话用途），无解除条件预期。
4. 新增过渡开关：先在 §1 立账（含解除条件），再落码；CI 保证不漏。
5. 共享 `BILI_` 前缀但**不是环境变量**的标识符列在 §3，避免混淆。

---

## 1. 过渡开关台账（盖子 / kill-switch / 实验）

| 开关 | 引入 | 引入原因 | 解除条件 | 状态（2026-10-15） |
|------|------|----------|----------|--------------------|
| `BILI_ANTHROPIC_THREADS_INJECT` | #2888（未合入 master 的开放 PR，分支 `2026-10-12_claude-global-scope-narrow-gate`） | #2884 CC 全局作用域直通 bug 的临时盖子：threads lane 默认逐字节直通；`=1` 才启用完整注入 | #2926 S5：真实 CC 主会话抓包证明注入后上游 200 + SQLite 统一 rebuild-fold 落地 | 未落 master（PR #2888 open）；生命周期跟踪于 #2926 |
| `BILI_STREAM_STALL_MS` | #1706 时代的流停滞检测 | #1706 事故（陈年 400ms 误报）后由 #1714 退役；现在只读它来发一条警告（src/server.ts:594） | 已无生产意义——连警告读一起删 | 已退役（只读告警）；整体移除候选 |
| `BILI_SESSION_WARM_MAX` | #2803 bounded startup | 限制 boot 时预热会话数（master 当前默认 8，src/knobs.ts:230） | 在途 PR #3194 把默认翻成 0 → 本变量退化为纯 opt-back；合入后观察 dogfood 数据再决定去留 | 在用（master 默认 8）；决策等 #3194 合入后的数据 |
| `BILI_STORAGE_UNIFIED` | #2671 存储统一重建 | dry-run 转正开关 legacy/shadow/full（当前默认 shadow，JSON 仍是唯一事实源） | shadow 跑稳后转正拍板（full 成为默认）；届时一并决定「legacy 显式值还要不要支持」 | 在用（默认 shadow）；未转正 |
| `BILI_STORAGE_JSON_WRITER` | #2960 Phase 3 | full 模式下的 JSON writer 关闭开关（回滚通路；仅 full 模式生效，默认 on） | 与 storage.unified 转正绑定：unified 定案后退役 | 在用（仅 full 生效） |
| `BILI_ROLLOUT_`（前缀家族；现成员 `BILI_ROLLOUT_SIMHASH_V2`、`BILI_ROLLOUT_FOLD_GUARD`） | src/rollout.ts 灰度机制 | 每功能灰度 kill-switch：env > config `rollout.features.<name>`（true/false/percent 简写，#3062）> 确定性分桶（sha256(salt\nid)%10000）> off | 单个功能灰度完成并稳定后，从 rollout 表移除该功能，其 env 随之失去意义 | 机制常设；单个成员轮换 |
| `BILI_FOLD_RECONCILE` | #1921 | fold 对账模式 off/warn/repair（默认 repair；非法值只告警不致命，src/fold-reconcile.ts:384） | 增量车道 #3248 落地后评估 legacy 对账路径去留 | 在用（默认 repair）；与 #3248 联动 |
| `BILI_RECLAIM_FETCH_PATCH` | #1158 | escape hatch：`=0` 保留经典直装 fetch patch 路径 | fetch-chain patch 成为既定行为后退役 | 默认开（`=0` 回退经典路径） |
| `BILI_CODEX_STATE_MODE` | #2222 | codex state-db 策略逃生口(auto/shared/legacy;auto=二进制认 CODEX_SQLITE_HOME 就 shared 否则 legacy;shared 遇旧二进制降级并告警) | codex 状态策略稳定后随 #2222 收尾 | 默认 auto |
| `BILI_CODEX_COMPACT` | #3008 | codex compaction 拦截 kill-switch（intercept/pass）；intercept 覆盖显式与内联 auto-compact（SUMMARIZATION_PROMPT 识别） | intercept-by-default 站稳后评估 pass 模式是否还有人需要 | 默认 intercept |
| `BILI_CODEX_STATE_MODE` | #2222/#3321 | codex 状态库策略逃生舱：`auto`（默认，二进制支持 CODEX_SQLITE_HOME 则 shared，否则 legacy）/ `legacy`（始终旧拷贝路径）/ `shared`（请求 shared，二进制太旧时降级 legacy 并告警）；非法值告警后按 auto（src/launcher.ts:3674） | shared/auto 策略站稳（#3321 并发车道落地后观察）后评估去留 | 在用（默认 auto） |
| `BILI_SQLITE_AUTO_DOWNLOAD` | #2833 | sqlite 引擎自下载开关（严格 1/0 > 文件 > 默认 true；被拒时仍用缓存副本） | —（转正为常设安全阀则移 §2） | 在用（默认 true） |
| `BILI_NATIVE_ATTACH_EXTERNAL` | #1322/#1335 | 外部 attach opt-in：默认拒绝 attach 到会长命于会话的实例（拒绝文案见 launcher.ts:3561） | —（长期安全姿态则移 §2） | opt-in（默认 false） |
| `BILI_LAUNCHER_DIRECT` | launcher direct-URL 模式 | `=1` 进入直通 URL 模式：LLM 流量不过代理 ⇒ 无压缩（只有 bili MCP 调用可用）；默认 MITM | —（两种模式都是正式入口则移 §2） | opt-in（`=1`） |
| `BILI_LAUNCHER_PLUGIN` | launcher plugin 车道 | `=0` kill switch 回 wire 注入工具；`=1` 强制 plugin 车道；缺省自动 | plugin 车道成为唯一车道后退役 kill switch | 默认 auto |
| `BILI_RESIGN` / `BILI_RESIGN_PASSTHROUGH` / `BILI_RESIGN_BENEFIT` / `BILI_CODEARTS_REF` | #1884 / #2090 | 签名上游重签特性族：`=0` 整族下线（回到 #1884 前重写行为）；passthrough 是「此链路不带压缩」的显式确认通道 | 特性族定型后各成员转 §2 | 特性族在用（`=0` 可整族下线） |
| `BILI_FAKE_COMPLETION_RETRIES` | fake-completion fallback | 假完成重试（opt-in，默认 0 = 禁用） | fallback 机制定型后转 §2 | opt-in |
| `BILI_NO_CACHE_CONTROL` | compat | 历史 no-cache-control 怪癖保留（knobs.ts:458 明言 "Historical quirk preserved in the env"） | 兼容窗口结束后退役 | 默认 off |
| `BILI_STREAM_ERROR_SHAPE` | compat | 给无法带内上报错误的 SDK 的流错误形状兼容 | 兼容保留（长期） | 常设兼容旋钮 |
| `BILI_SUBAGENT_SPLIT` | #970 | subagent 拆分（默认 on） | 成为既定行为后移 §2 | 默认 ON（`=0` 退出） |
| `BILI_RESUME_INHERITANCE` | resume inheritance | resume 继承行为（默认 on） | 同上 | 默认 ON（`=0` 退出） |
| `BILI_AFFINITY_SIMHASH` | #2265 | simhash adoption kill-switch（`=0` 禁用） | adoption 成为既定行为后移 §2 | 默认 ON |
| `BILI_CHAIN_CONTENT` | chain 识别 | chain 内容检测（#1683 背景；默认 off，文件可开） | 实验结论出来转正或删 | 默认 off |
| `BILI_CHAIN_STAMP` | egress stamp | stripped-middlebox 场景的出口戳（默认 off） | 同上 | 默认 off |
| `BILI_STABLE_SYSTEM_ANCHOR` | stable-system-anchor 实验 | 每会话 system 锚点实验（默认 OFF） | 稳定性评估后转正或删 | opt-in（默认 OFF） |
| `BILI_FORK_ADOPTION` | fork-adoption 特性 | fork 继承实验（opt-in；禁用时提示从零开始，fork-adoption.ts:300） | 稳定后转正或退役 | opt-in（默认 off） |
| `BILI_ALLOW_DSH_COMPACTION` | dsh compaction | dsh compaction opt-in（env 语义同 BILI_PERSIST 家族） | 转正后移 §2 | opt-in（`=1`） |
| `BILI_SNAPSHOT_SHADOW` | #3756 | snapshot-render 影子观测：每个 armed turn 计算快照视图但**不使用**（出站仍走 legacy 路径），与实际发送对比记 per-session 计数（面板 + `snapshot-shadow` 诊断话题）——render 引擎在 rollout 翻转前用真实流量证明健康（dry-run-then-flip，同存储 #2815 shadow→#3818 full 纪律） | render 车道转正（rollout 100% 且影子计数归稳）后退役 | 默认 on（render lane 本身 rollout 0%，纯观测） |
| `BILI_DSH_AUTHORED_COMPACTION` | #3733 | dsh 原生 compaction summarize 调用由 #1729 guard 拒绝改为**本地应答折叠快照**（零出账；dsh 记 checkpoint、会话文件收缩） | adoption 后按 #2028 模式转 file/web 开关，env 退役（file 键 `dsh.authoredCompaction` 已镜像） | 0.1.203 dogfood 站稳后默认 on；`=0` 回 #1729 拒绝路径 |
| `BILI_PI_INLINE` | #3278（#4669 默认翻转，#4687 收回） | pi inline 模式（需手动开启，默认保持旧行为，owner 禁改默认值）：不起 proxy 进程，fetch 链在 intercept 之下的一个环节把伪 origin 流量路由进进程内引擎（inline-engine.ts，跑同 startServer 的每请求管线）；`=1/on/yes/TRUE` 或 file 家 `"pi": {"inline": true}` 显式开启（显式开启压过 attach 目标）；`bili pi-inline` 一键车道预置该变量 | inline 车道稳定一个版本周期后转 §2 常设 | opt-in（不设置时 attach/spawn 行为与旧版完全一致） |
| `BILI_OPENCODE_INLINE` | #3278 opencode 移植（#4687） | opencode inline 模式（需手动开启，默认保持旧行为 spawn，owner 决定不改默认）：与 pi 同构——不起 proxy 进程，模型 URL 被 V2 route/intercept 改写成伪 origin 后由进程内引擎接住（bun 宿主已验：引擎 boot/dispatch 全绿）；`=1/on/yes/TRUE` 或 file 家 `"opencode": {"inline": true}` 显式开启（显式开启压过 attach 目标）；`bili opencode-inline` 一键车道 | 同 pi inline 车道节奏 | opt-in（不设置时 attach/spawn 行为与旧版完全一致） |
| `BILI_INLINE_DEBUG` | #4669 | 仅 inline 车道：引擎 stderr 日志腿默认静默（stderr 是 pi 的交互终端，日志会挤掉输入框；默认只写 bili.log），设 1 恢复 stderr 输出用于排查 | 随 inline 车道（#3278）走 | 排查逃生口 |
| 测试钩子：`BILI_DSH_RECOVERY_INTERVAL_MS` / `BILI_DSH_RETRY_INTERVAL_MS` / `BILI_MODEL_INFO_RETRY_MS` | #2082 等 | 缩短测试/运维节奏（dsh-native.ts；NODE_TEST_CONTEXT 感知，避免生产误缩） | 永久测试设施，随宿主代码走 | 测试钩子 |

## 2. 常设面全量登记表（src/ 实际读取的其余 BILI_* 环境变量）

### 2.1 宿主 opt-out（per-host kill switch；另有全局 `BILLION_CONTEXT_PLUGIN=0`）

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_NATIVE_CLAUDE` / `BILI_NATIVE_DSH` / `BILI_NATIVE_KIMI` / `BILI_NATIVE_OMP` / `BILI_NATIVE_OPENCODE` / `BILI_NATIVE_PI` / `BILI_NATIVE_ZCODE` | 对应宿主 native 车道 `=0` 整体退出（bootstrap 各文件入口判断） |
| `BILI_NATIVE_ATTACH_POLICY` | native attach 策略（env > 文件 native.attachPolicy） |

### 2.2 内部 spawn 通道（launcher→子进程，非用户面）

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_LAUNCH_TOKEN` | launch 令牌（spawn 时注入；日志中脱敏） |
| `BILI_PARENT_PID` | owner-pid 看门狗（会话生命周期归属） |
| `BILI_STRICT_PORT` | `=1` claude SessionStart hook 退出端口重试（#964） |
| `BILI_OPENCODE_ACP_SPEC` | 剥离版 ACP spec 临时配置**文件路径**提示 |
| `BILI_LAUNCHER_LANE` | lane 身份戳（attach 时比对归属） |
| `BILI_LAUNCHER_MODEL_WINDOWS` / `BILI_LAUNCHER_MODEL_MAX_OUTPUTS` | 模型窗口/输出上限 JSON，传给子进程对齐 nudge 分母与输出预留 |
| `BILI_INHERITED_HTTP_PROXY` / `BILI_INHERITED_HTTPS_PROXY` / `BILI_INHERITED_ALL_PROXY` / `BILI_INHERITED_NO_PROXY` | 继承调用方代理设置转发给 proxy 子进程 |
| `BILI_MITM_HOSTS` / `BILI_MITM_DOMAINS` | MITM 主机/域名单传给子进程 |
| `BILI_NON_HTTP_PROVIDERS` | #1392 非 http(s) baseUrl provider 白名单传递 |
| `BILI_PROVIDER_REWRITES` | #535 provider 改写 manifest JSON（存在即关 zcode native） |
| `BILI_UPGRADE_REPLACEMENT` | #3044 self-restart 替换进程交接标记（UPGRADE_REPLACEMENT_ENV） |

### 2.3 网络调优（#2030 迁移家族：env > 文件 network.* > 默认）

| 变量 | 默认 |
|------|------|
| `BILI_UPSTREAM_TIMEOUT_MS` | 720000（12 min） |
| `BILI_REQUEST_WATCHDOG_MS` | 2× upstream timeout |
| `BILI_KEEP_ALIVE_TIMEOUT_MS` | 5000 |
| `BILI_CLIENT_ERROR_BACKSTOP_MS` | 30000 |
| `BILI_EXPOSURE_LOG_INTERVAL_MS` | 3600000（0 禁用，垃圾值回落 3600000） |
| `BILI_MAX_SHRINK_PER_COMPRESS` | unset（不做收缩引导） |
| `BILI_REPLAY_RETRY_MAX` / `BILI_REPLAY_RETRY_BASE_MS` | 3 / 1500 |
| `BILI_THROTTLE_429` / `BILI_THROTTLE_429_MAX_CONSECUTIVE` / `BILI_THROTTLE_429_BASE_DELAY_MS` / `BILI_THROTTLE_429_MAX_DELAY_MS` | true / 5 / 2000 / 30000（#4204 出站 429 治理器：同一 origin+凭据连续上游 429 后本地 hold、零出站，退避×抖动、尊重 Retry-After；达上限转终局 424（不在各 SDK 重试集合内），每窗口一次探测自动恢复，任何非 429 响应即清除；`false` 恢复旧的总是转发行为） |
| `BILI_STREAM_KEEPALIVE_MS` | 15000（0 禁用 hold） |
| `BILI_PREFLIGHT_HOLD_MS` | 30000 |
| `BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS` | 300000 |
| `BILI_POST_RESPONSE_LINGER_MS` | 5000（#1982，曾为纯 env） |
| `BILI_PROXY_KEEPALIVE_MAX_MS` | 55000（0 = 一次性连接） |
| `BILI_CCR_RETRIEVAL_TTL_MS` | 600000 |
| `BILI_DECOMPRESS_TMP_CAP` | 50 |
| `BILI_PUBLIC_SNAPSHOT_CAP_BYTES` | 100 MiB（#2017；0 完全禁用留存） |
| `BILI_MITM_HANDSHAKE_TIMEOUT_MS` | 10000 |
| `BILI_CHAIN_MAX_FUTURE_SKEW_MS` / `BILI_CHAIN_RECENT_WINDOW_MS` | chain-checkpoint 内部默认值 |
| `BILI_CA_FILE` | network.caFile，默认无——附加 PEM 根证书与内置根 **MERGE**（企业 MITM/DLP 重签上游证书被拒 SELF_SIGNED_CERT_IN_CHAIN 时，#3776；不替换内置根） |
| `BILI_RECEIVE_BODY_BYTES` / `BILI_DECODED_BODY_BYTES` | network.receive/decodedBodyBytes，5 GiB / 10 GiB——单请求入站/解码后内存上限（#3128：曾硬编码 100 MiB，多 GB 单请求被 reset） |
| `BILI_OUTBOUND_BODY_BYTES` | network.outboundBodyBytes，5 GiB——重建后转发上游的硬上限（#3128） |
| `BILI_WS_OUTBOUND_BYTES` | network.wsOutboundBytes，10 MiB——WS 车道出站软预算：超限先把旧的非保护图归档/降采样再发送（#3701：网关对大帧 close 1009；0 关闭预发送削减；HTTP 车道不受影响） |
| `BILI_HTTP_OUTBOUND_BYTES` | network.httpOutboundBytes，10 MiB——普通/代理/pi 原生 HTTP 中继车道出站软预算：超限先把旧的非保护图归档/降采样再发送（#3909：图片密集会话按字节/像素解码 CPU 被上游拒收、token 折叠不触发；仅在无受管传输时生效，受管 HTTP/dsh-inline 从不裁减 #3701 Finding 1；0 关闭） |
| `BILI_CACHE_KEEPALIVE`（#3376） | unset（false；同 `cacheKeepalive.enabled` 层级 env 覆盖） |
| `BILI_CACHE_KEEPALIVE_ASSUME_TTL` | unset（从 body cache_control 断点探测） |
| `BILI_CACHE_KEEPALIVE_TTL_FACTOR` | 0.9 |
| `BILI_CACHE_KEEPALIVE_MAX_DURATION_MS` | 86400000（24h） |
| `BILI_CACHE_KEEPALIVE_MAX_PINGS` | 4 |
| `BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS` | unset（false） |
| `BILI_CACHE_KEEPALIVE_INTERVAL_MS` | unset（按 TTL 层推导） |

### 2.4 会话池 / GC / 持久化

| 变量 | 一句话用途 / 默认 |
|------|------------------|
| `BILI_MAX_SESSIONS` | sessions.max，默认 256 |
| `BILI_SESSION_GC` | 会话 GC 总开关（`=1/true/on` 启用，默认 off；启用后下面三个参数生效） |
| `BILI_SESSION_GC_INTERVAL_MS` / `BILI_SESSION_GC_MAX_AGE_DAYS` / `BILI_SESSION_GC_MAX_TOKENS` | 会话 GC 参数（默认 1h / 7d / 1M tokens） |
| `BILI_SESSION_RESIDENT_MAX_BYTES` | sessions.residentMaxBytes，512 MiB 软上限（#2803） |
| `BILI_SESSION_WARM_MAX_BYTES` | warm 解码字节上限，64 MiB（#2803） |
| `BILI_PERSIST` | `=0` 关闭持久化（ephemeral/test） |
| `BILI_PERSIST_DEBOUNCE_MS` | persist.debounceMs，500 |
| `BILI_PERSIST_EPERM_ALERT_THRESHOLD` / `BILI_PERSIST_EPERM_ALERT_REPEAT_MS` | EPERM 告警阈值 5 / 重复间隔 0（不限次） |
| `BILI_PERSIST_TAIL_TOKENS` | persist.tailTokens，16384（0 禁用消息持久化，#401） |
| `BILI_PERSIST_ZSTD` | `=1/true` 启用 zstd 压缩持久化（owner 决定 #1080，默认 off） |
| `BILI_SESSIONS_DIR` | 状态目录重定位 |
| `BILI_STORAGE_ARCHIVE_AFTER_DAYS` | storage.archiveAfterDays，默认 365 天——超龄会话由 gc 归档（export + tombstone + CAS 释放；0 关闭年龄清扫，#3901/#3463） |
| `BILI_STORAGE_QUICK_CHECK` | 默认开——index.db 开库在迁移前跑 PRAGMA quick_check 自检；失败=影子层隔离文件组（.corrupt-<ts>）+重建新库（JSON 信封为恢复源）；=0 跳过（超大库启动时间敏感场景，#4175） |
| `BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES` | storage.walJournalSizeLimitBytes——SQLite WAL 回收字节上限（#3250；垃圾/非正值落回文件/默认层，不让 typo 崩 boot） |
| `BILI_MYSQL_DSN` | storage.mysql.dsn——mysql 引擎连接串（env > 文件 > ""；空 = mysql 不可用走 sqlite，#3388/#3931） |

### 2.5 诊断

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_DUMP_4XX` | `=1` 或 diagnostics.dump4xx：4xx 时落盘精确重放 body（#762/#276，默认 off） |
| `BILI_DUMP_4XX_MAX_BYTES` | dump 单文件上限，2 MiB（floor 1 KiB） |
| `BILI_DUMP_MAX_TOTAL_BYTES` | dump 总量上限，默认 off(null) |
| `BILI_DUMP_MAX_AGE_DAYS` | dump 年龄上限，默认 off(null) |
| `BILI_FAKE_BUF_CAP` | fake-completion 缓冲上限，16 MiB |
| `BILI_CONFLICT_SCAN` | thirdparty-scan 冲突扫描开关 |
| `BILI_INVARIANT_JUDGE` | diagnostics.invariantJudge，默认 on——I1/I2 出站不变量法官（L1 顾问：violation 只 warn、流量永不拦；`=0` 解除武装，#3938 decision ②） |

### 2.6 安全 / 运维通道

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_ENCRYPTION_KEY` | sidecar 加密密钥（hex/base64 恰好 32 字节，#708；设置期间 sidecar 拒绝打开明文） |
| `BILI_CONFIG_FILE` | `--config` 等价物 |
| `BILI_CLIENT_BIN` | native 可执行文件覆盖（probe 契约同 launcher） |
| `BILI_CONVERSATION_ID` | codex spawn 期会话注册（CLAUDE_CODE_SESSION_ID 优先） |
| `BILI_MCP_PROXY` | codex MCP shell 用的 proxy origin（含发现回退） |
| `BILI_MCP_DEFAULT_ORIGIN` | zcode MCP entry 默认 origin（http://127.0.0.1:8787） |
| `BILI_MCP_NO_ORPHAN_ADOPT` | `=1` 多宿主共享一个 proxy 时禁用孤儿 adopt |
| `BILI_MCP_NO_STALE_ADOPT` | `=1` 禁用 #4661 证据型过期绑定自动换绑（代理证明所绑会话近期无模型流量时 shim 换绑到活跃会话） |
| `BILI_UPSTREAM_PROXY` / `BILI_UPSTREAM_PROXY_MODE` | 上游出口代理及 manual/auto 模式（默认直连是有意设计，#346/#357） |
| `BILI_TUNNEL_ALLOWED_HOSTS` | 远端隧道允许清单（host / host:port） |
| `BILI_ZONE_PORT` | USER zone 基址覆盖（#1660） |
| `BILI_CLAUDE_NATIVE_PORT` / `BILI_ZCODE_PORT` | 显式 zone 端口覆盖（strict-port 语义，#1660） |
| `BILI_ATTACH_EVIDENCE_GRACE_MS` / `BILI_ATTACH_HEALTH_DEADLINE_MS` | native attach 证据宽限窗 / 健康截止窗 |
| `BILI_DSH_BIN` / `BILI_PI_BIN` | dsh / pi 可执行文件覆盖 |
| `BILI_PLUGIN_AGENT` | `--plugin` 目标 agent 选择（默认 claude） |
| `BILI_LOG_MASK_HOSTS` | 日志主机名掩码（默认开；`=0` 本地调试退出） |
| `BILI_ALLOW_PRIVATE_HTTP_PROVIDERS` | 私有 http provider 放行（CGNAT 100.64/10 恒拒） |
| `BILI_MITM` | MITM 功能总开关（env > 文件 mitm.enabled > 默认开；`=0` 整体关闭；与内部通道 `BILI_MITM_HOSTS`/`BILI_MITM_DOMAINS` 不同） |
| `BILI_CLAUDE_UPSTREAM` | direct-URL 模式下绕过预置 relay 的上游 URL（OAuth 订阅流量需 MITM 模式） |

### 2.7 更新器 / 公告

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_UPDATE_REGISTRY` | registry base URL 覆盖（完整 URL） |
| `BILI_UPDATE_CHECK_INTERVAL_MS` | update.checkIntervalMs 覆盖（#2030） |
| `BILI_ADVISORY_CHECK` | 公告检查开关（默认 ON；文件 advisoryCheck:false 退出） |
| `BILI_ADVISORY_URL` | 公告文档 URL 覆盖 |
| `BILI_RELEASE_NOTES_CHECK` | 发布说明检查（#1870，默认 ON） |
| `BILI_RELEASE_NOTES_URL` | 发布说明 URL 覆盖 |
| `BILI_UPDATE_POLICY_URL` | update.policyUrl——更新策略 URL 覆盖（**测试专用**：生产固定官方 repo，#3619 安全边界） |
| `BILI_UPDATE_STAGGER_MIN_MS` / `BILI_UPDATE_STAGGER_MAX_MS` | update.staggerMin/MaxDelayMs——升级错峰窗口（env 为裸 ms；file 层另收 "15m"/"1d12h" 人读时长；0/0 = 本机回立即升级旧行为；默认上限窗 48h，#3619） |

### 2.8 图像计费 / zcode 兼容

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_IMAGE_BILLING` | `=bytes` 走字节替代路线 |
| `BILI_IMAGE_TOKEN_CAP` | 单图成本上限 live-read（#1843 L3） |
| `BILI_ZCODE_ROUTE` | zcode 路由兼容逃生舱（`=none` / kill-switch → 降级路由） |
| `BILI_ZCODE_SIGNING_FIXED` | zcode 固定签名 |
| `BILI_IMAGE_RESCALE` / `BILI_IMAGE_RESCALE_MAX_DIM` | imageRescale（默认 on）/ rescale 最长边目标（默认 1600，floor 128，env-only）——出站图像降尺度：大图缩小发送、原件留本地会话存储（`0` 全尺寸透传，#3400 owner 决定） |

### 2.9 插件工具 guardrails / 压缩车道开关

| 变量 | 一句话用途 |
|------|-----------|
| `BILI_GUARDRAIL_BASH_TIMEOUT` | guardrails.bashTimeout，默认 60s——模型没写 timeout 时宿主侧注入 bash `timeout`（pi/omp host 进程读；0 = 不注入，#3066） |
| `BILI_GUARDRAIL_MAX_OUTPUT_BYTES` | guardrails.maxOutputBytes，默认 50KB——工具输出封顶（0 = 不封顶） |
| `BILI_GUARDRAIL_REPETITION` | guardrails.repetition，默认 on——相同调用循环熔断（warn 3 / abort 5） |
| `BILI_GUARDRAIL_TEXT_RUN_THRESHOLD` | guardrails.textRunThreshold，默认 200——输出端同字符连击熔断阈值（proxy 进程侧读，#3406 item 1；0 关闭） |
| `BILI_AUTO_MODE_FORGE` | autoModeForge.enabled，默认 on——auto-mode 分类判定本地 forge，零出账/计费（`=0` 恢复纯透传，留给付真实判定费的用户，#2740 owner 决定） |
| `BILI_DSH_CONTEXT_TAB` | dsh.contextTab 的 env 层（#4237）：`=0` 隐藏 DSH 顶栏「上下文」标签页（压缩及其余入口全部不受影响）；其他值强制开并覆盖文件层；缺省按文件层（默认 true）；下次页面加载 / dsh 重启生效 |
| `BILI_DSH_MAX_TESTED_VERSION` | dsh native lane「高于已测最高版」启动提示的上限（#4545）：从注入包上方最近的 node_modules/@deepseek-ai/dsh/package.json 读运行中的构建，**严格高于**上限才弹一条启动提示，建议先回滚；默认 0.2.0-rc.2（CI e2e 锚点），新版本验证通过后抬高；空串 = 关闭检查；只提示不拦截 |

## 3. 非环境变量的 BILI_* 标识符（勿与上表混淆）

以下共享 `BILI_` 前缀但是代码常量/工具表/错误码，不是环境变量，不在 CI 检查范围：

`BILI_ACP_HANDLED__`（哨兵 Error 字符串）、`BILI_ACP_TOOLS_{ANTHROPIC,GOOGLE,OPENAI,RESPONSES}[_NO_RANGE]`、`BILI_ACP_READONLY_TOOLS_RESPONSES[_NO_RANGE]`、`BILI_DECOMPRESS_TOOL{,_OPENAI,_RESPONSES,_GOOGLE}`、`BILI_DECOMPRESS_IMG_{ANTHROPIC,GOOGLE,OPENAI,RESPONSES}`、`BILI_SEARCH_CONTEXT_TOOL{,_OPENAI,_RESPONSES,_GOOGLE}`（compress-tool.ts 工具表常量）、`BILI_DSH_PACKAGE`（="billion-context"）、`BILI_HOP_HEADER`（="x-bili-hop"）、`BILI_INJECTABLE_TOOL_NAMES`（Set）、`BILI_OVERLAY_BUSY`（错误码）、`BILI_PASSTHROUGH_HEADER`、`BILI_PLUGIN_BYPASS_HEADER`（="x-bili-plugin-bypass"）、`V2_BILI_TOOLS` / `BILI_TOOLS`（opencode-v2.ts）、`BILI_TOOL_NAMES`（Set，side-request.ts）、`MCP_BILI_TOOL_PREFIX`（="mcp__bili__"）、`BILI_TUNNEL_HEADER`（="x-bili-tunnel"）。

## 4. 退役模块盘点

| 模块 / 标记 | 现状 | 退役条件 | 跟踪 |
|-------------|------|----------|------|
| `src/persona-anchor.ts`（179 行） | 生产路径已迁 v2.2（session-resolve），但 **src/session-resolve.ts 自身仍 import 它**，另有 src/plugin.ts、src/server/side-request.ts 及 4 个测试套件（dsh-persona-continuity、issue2601-model-drift-absorption、issue2601-persona-fork-lineage、issue2944-neutral-skeleton）引用做断言 | #2989 孪生化完成后整文件删除（注意 session-resolve.ts 的依赖也要切掉） | #2989 |
| `src/fold-reconcile.ts` legacy 对账路径 | 在用（`BILI_FOLD_RECONCILE` 默认 repair，见 §1） | 增量车道 #3248 落地后评估去留 | #3248 |
| `TODO(#NNNN)` 标记 | 全仓（src/、kernel/src/、pi-subagents/src/）**零命中**——不存在 issue 编号型 TODO | — | 无需跟踪 |
| deprecated 标记 | 均为小项：① acp.json delegate 配置弃用（运行时警告"future release 移除"，prompt←delegatePrompt 改名，pi-subagents.ts:153/163、config.ts:1502）② config.ts:1713 某章节的 deprecated fallback（仅在章节缺失时读）③ `minCompressRangeChars` 是 `minCompressRange` 的弃用别名（compress-settings.ts:50/223）④ claude-native-bootstrap.ts:263 关于 ps/wmic 的系统 API 注释（非 bili 代码） | 各自随所属特性演进；无批量行动 | — |

## 5. 卫生记录

- **2026-10-15 远端分支卫生（#3249 执行）**：删除 origin 已合并远端分支 **1394 条**（1386 条 = 已合并 PR 的同仓 head 分支 + 8 条 = 完全并入 master 但无对应 PR 记录：`2026-08-08_release-v0.1.14`、`2026-09-26_opencode-zen-mitm`、`2026-09-30_responses-side-compaction`、`2026-10-04_plugin-fork-context-provenance`、`2026-10-13_lastmessages-tabling`、`chore/pages-enablement`、`fix/codex-custom-tool-call-text-protocol`、`revert-3189-pages-enablement`）。删除前核对：与 open PR head 交集为空。删除后 origin 剩 361 个 head（其中 128 条为 open PR 分支、201 条 closed-unmerged 且未并入 master、30 条无 PR 未并入 = 废弃工作，均不动）。另执行一次 `git worktree prune` 清掉失效 worktree 登记。
- **2026-10-20 台账补登（本 PR）**：#3249 落地本台账时 `src/` 实际读取数已比登记数多 22（#3955 mysql、guardrails、#3128 网络预算、#3400 图像缩放、#3619 错峰、#3733 dsh compaction、#3756 snapshot shadow 等），守卫上线即全线红（master run 均被后续 push 取消所以未暴露）。本次 22 条全部补登（3 条 §1 + 19 条 §2）。
- **机器侧纪律（owner 手工做过，记录备查，不做自动化）**：2026-10-15 手工清理 11 个陈年 bili 进程（全部零活跃连接才杀）/ /tmp 清 2.2GB / master-wt worktree 421MB / 20 个已合并本地分支 / index.db 旧归档。**杀进程保持人工**（需要人眼判断连接归属，自动化风险大于收益），每次大版本装机后人工过一遍。
