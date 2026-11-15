# WORKLOG — Google 原生 wire 命名空间 model id 旁路

- 日期:2026-11-03
- 分支:`2026-11-03_google-namespaced-model-path`
- 基线版本:0.1.208(报告人运行版本;0.1.212 同样未修)

## 根因

两处 model 解析把 `<model>` 限定为「不含 `/`」:

| 位置 | 旧 | 新 |
|---|---|---|
| `src/agent/native-intercept.ts` `MODEL_API_SUFFIX` | `models\/[^/:?]+:` | `models\/[^:?]+:` |
| `src/server.ts` `googleModelFromPath` | `\/models\/([^/:?]+):` | `\/models\/([^:?]+):` |

omp 的 `google-generative-ai` provider 把 provider 前缀写进路径(`/v1beta/models/antigravity/gemini-3.8-flash:streamGenerateContent`)。客户端侧判 false → `installNativeFetchIntercept` 的 `if (!isModelApiUrl(url)) return send(input, init)` 直接放行到上游,代理整段旁路:无 `processTurn`、无窗口解析、无压缩、无 conversation 注册(`acp_status` 报 `unknown plugin conversation`)。

## 现场证据(0.1.208)

- 会话 `01a19f5e-7b02-7519-854c-2f63bc914120`:全程 `antigravity/gemini-3.8-flash`,`~/.local/state/billion-context/bili.log` 零条该会话记录;
- 末轮 `usage: input=684938, cacheRead=0` —— 685k token 上下文从未折叠;
- 同一台机器上 `codex/gpt-6.1-terra`(`/v1/responses`)全程正常:有 `processTurn`/`[acp-usage]`。

## 验证

1. 单测(新增,双向):

```
node --import tsx --test tests/native-intercept.test.ts tests/vertex.test.ts
ℹ tests 84 / pass 84 / fail 0
```

新增断言覆盖:`models/<ns>/<id>:<method>` 三种方法 + `?alt=sse` 均判 true;`/v1beta/models` 列表、`:predict`、无方法后缀仍判 false;`googleModelFromPath` 返回完整 `antigravity/gemini-3.8-flash`、`group/hard`;含一条真实路由断言(请求改写成 `${origin}/bili/<url>`,不是直连)。

2. 回归:

```
node --import tsx --test tests/adapter-google.test.ts tests/lane-decisions-matrix.test.ts
ℹ tests 111 / pass 111 / fail 0
```

3. `npx tsc --noEmit -p tsconfig.json` 干净(kernel 与 pi-subagents 先 `npm run build`)。

4. 现场端到端(打补丁后的 0.1.208 dist + 真实上游网关):

- `omp -p --model=magpie/antigravity/gemini-3.8-flash` → `bili.log` 出现 `forward POST → …/v1beta/models/antigravity/gemini-3.8-flash:streamGenerateContent`、`nudge idle: usage=2% (21399/1048576) … model=antigravity/gemini-3.8-flash`;
- 同会话内 `acp_status` 返回真实面板(`BILLED INPUT: 21411 tok`),不再是 `404 unknown plugin conversation`;
- `GET /__bili/plugin/status?conversationId=…` 返回 `"model":"antigravity/gemini-3.8-flash"`。

## 影响面

- 只放宽字符类,不放宽方法集:`v1internal` 控制面、`:predict`、discovery 列表的直连行为不变;
- 无 wire 变更、无配置面变更、无 env 变更。

## 教训

「model 在 URL 路径」这一族(Google 原生 / Vertex)在两个模块里各写一遍正则,收窄条件写死在字符类里;任何「id 里出现分隔符」的宿主(网关路由、provider 前缀)都会被静默判成非模型流量,且失败模式是完全静默的(直连上游仍能工作,只是没有压缩)。回归测试因此必须包含**路由断言**,不能只测谓词。
