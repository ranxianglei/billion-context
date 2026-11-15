# REQ — Google 原生 wire:带命名空间的 model id 被判成「非模型请求」,整段流量静默旁路

- 日期:2026-11-03
- Issue:#5593
- 报告人环境:omp 18.16.0 + billion-context 0.1.208,模型 `magpie/antigravity/gemini-3.8-flash`(provider `api: google-generative-ai`)
- 关联形状:#2493(native fetch 拦截器认 Google 原生 wire)、#4256(v1internal 方法集只认三个模型方法)

## 问题

Google 原生 wire 的 model 在 URL 路径里:`POST /v1beta/models/<model>:(streamGenerateContent|generateContent|countTokens)`。两处解析都假设 `<model>` 不含 `/`:

- `src/agent/native-intercept.ts` `MODEL_API_SUFFIX` — 客户端侧 `isModelApiUrl`;
- `src/server.ts` `googleModelFromPath` — 代理侧取 model。

omp 的 `google-generative-ai` provider 把 provider 前缀一并写进路径(`/v1beta/models/antigravity/gemini-3.8-flash:streamGenerateContent`,网关路由形如 `/v1beta/models/group/hard:generateContent`),于是:

1. `isModelApiUrl` 判 false → `installNativeFetchIntercept` 走 `if (!isModelApiUrl(url)) return send(input, init)`,请求**直连上游**,从不经过 `/bili/` 代理;
2. 该会话因此没有 `processTurn`、没有窗口解析、没有压缩、没有 conversation 注册;`acp_status`/`acp_cache` 报 `404 unknown plugin conversation`;
3. 代理侧即便收到,`googleModelFromPath` 也返回 undefined,所有按 model 决定的窗口/阈值/摘要适配器失去依据。

现场证据(0.1.208):会话 `01a19f5e-7b02-7519-854c-2f63bc914120` 全程该模型,`bili.log` 零条该会话记录,末轮 `input=684938 / cacheRead=0`,上下文 685k token 未压缩。

## 需求

1. 带命名空间的 model id 判为模型请求并**经代理**:`models/<ns>/<id>:<method>` 与 `models/<id>:<method>` 等价;
2. 代理侧 `googleModelFromPath` 返回完整 id(`antigravity/gemini-3.8-flash`),不丢前缀;
3. 收窄面不变:`/v1beta/models` 列表、`:predict` 等无管线的 Google 方法、`/bili/` 已改写 URL 仍判 false,`v1internal` 控制面方法仍直连;
4. 不改 wire、不加配置项、不改 env 面:仅正文字符类收窄(`[^/:?]+` → `[^:?]+`);
5. #3617 门纪律:正负断言双向齐全,且含一条真实路由断言(请求确实改写成 `${origin}/bili/<url>`)。

## 非目标

- 外部摘要端点(`SummaryEndpoint` 用 `encodeURIComponent(model)` 拼路径)对带斜杠 id 的编码形状;
- Antigravity v1internal 的 model 解析(在 envelope,不在路径);
- 任何配置面新增。
