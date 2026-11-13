# billion-context Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**
>
> **How to read this:** the rules and invariants below are loaded every session and are the operative contract. Long procedures, file listings, and test/release/git mechanics live in [`reference/`](reference/) and are **not** auto-loaded — follow the inline `→ reference/…` pointers when you hit that task; don't guess at a procedure, open the file. The Key Design Decisions (KDD) below carry each entry's **operative consequence**; the full mechanism text (Tier B entries) lives verbatim in [reference/design-decisions.md](reference/design-decisions.md) — KDD numbering is stable and public, the ledger there is append-only.

## 1. Project Overview

**billion-context** is an npm package (`bili` CLI) — a context-compression proxy for AI agents. It sits between an agent client and an upstream LLM provider, injecting acp-kernel's compression pipeline to manage context growth.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling; inlines the in-repo kernel `kernel/`) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | the in-repo compression kernel (`kernel/`, npm name `acp-kernel`, bundled inline at build time) + a small set of lazy external deps: `zod` (exact `4.6.7`, only `dist/agent/opencode-native.js` V1 tools), `mysql2` (opt-in network storage backend, `await import` at backend open), `jimp` (image processing, #3516) — the main entry `dist/index.js` stays dependency-free |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `billion-context` |
| CLI | `bili` / `bili-proxy` |
| GitHub | https://github.com/ranxianglei/billion-context |
| License | MIT |

## 2. Architecture

### Module Map

The full file-by-file map lives in [reference/architecture.md](reference/architecture.md) — it drifts as modules land, so **regenerate it when you add/remove a source file; don't trust a stale copy** (CI lane `architecture-docs` enforces full `src/` coverage, #5924). Orientation at a glance: `src/server.ts` + `src/server/` (handle / prepare-* / relay / lane-decisions / snapshot-render / threads-lane / fastpath / admin) + `src/loop/**` (core + wire adapters) is the request pipeline; `src/update.ts` is the load-bearing self-updater; `src/persist.ts` + `src/session-id.ts` own persistence/identity; `src/storage/` is the unified storage layer (SQLite by default, opt-in MySQL backend); `tests/e2e/` holds the real-client regression suites; the compression engine itself lives in-repo under `kernel/` (the acp-kernel source, #2092).

### Key Design Decisions

Tier A entries are every-session rules and stay in full below. Tier B entries carry their operative consequence inline; full text → [reference/design-decisions.md](reference/design-decisions.md) (same number).

1. **The in-repo kernel is bundled inline (Tier B)** — `kernel/` and `pi-subagents/` are `file:` devDependencies inlined by tsup, so every `dist/` entry stays dependency-free; the ONE exception is `zod` (exact `4.6.7`) — imported only by `dist/agent/opencode-native.js` (lazily), every other entry zod-free; unresolvable zod degrades the V1 plugin to plain proxy mode, never fails. Full text: design-decisions.md #1.
2. **Tags use XML format** — messages carry ACP tags like `<acp tokens="2" type="text">m00001</acp>` (an opening element with `tokens=`/`type=` attributes wrapping a ref id, closed by its end element). In **source files** these angle brackets MUST be written as hex escapes (`\x3c`, `\x3e`) to avoid tooling that strips well-formed tags.
3. **Auto-update (Tier B)** — registry check every 3 min by default (knobs `update.checkIntervalMs` / `BILI_UPDATE_CHECK_INTERVAL_MS`, #2030); first check per process ignores throttle. Plugin mode injects code into the HOST process: new code needs a host restart; a broken injection runs model traffic direct (uncompressed) until restart — visible via panel banner + `/__bili/status` `attribution` (#3581). Full text: design-decisions.md #3.
4. **Tee logger** — all proxy logs go through `src/logger.ts` (file + stderr). Do NOT use `console.error` in server-side modules — use `loggerLog()`.
5. **The kernel lives in-repo; determinism comes from git, not a registry pin (#2092) (Tier B)** — consumed via `"acp-kernel": "file:./kernel"`; a commit IS the pin. Any kernel source change MUST bump `version` in `kernel/package.json` (CI-enforced — see Kernel Boundary); `pi-subagents/` follows the same pattern. Full text: design-decisions.md #5.
6. **Single-writer plugin copies (#991)** — every bili presence has exactly ONE writer; mixing writers is what the guard forbids. The canonical statement is the Install-Lane & Update-Ownership Contract below.
7. **Two compression modes with different summary carriers** (CRITICAL — reason in BOTH, see §6):
   - **pluginMode** (the `x-bili-plugin` header / registered agent, e.g. `bili pi`): the ACP-native agent OWNS compression — it executes `compress` locally, the call+result live in its own re-sent history, and the wire summary carrier is the **tool call** (the proxy suppresses tool + nudge injection; the agent's view never renders the kernel's `acp_summary`).
   - **proxy mode** (plain client, no header): the proxy executes `compress` server-side; the tool call is ephemeral (never enters the client's history) and preflight blocks have none, so the carrier is the **`acp_summary` message** — the kernel renders it role `system`, but `systemToUser` (`src/util.ts`) re-voices it as a **`user` message** (leaving it at its anchor) so strict backends (SGLang: exactly one system at index 0, #377) accept it and the head system message stays byte-stable for the prefix cache.
   - The mode is decided per request and bound per session (`session.metadata.pluginAgent`, sticky, upgrade-only). See docs/technical-notes.md "Two compression modes".
8. **Nudge cadence is flat 50K by design (kernel contract)** — acp-kernel pins the growth interval at 50000 for every window size (`nudge.growthFloor == nudge.growthCap == 50000`; window-percentage scaling was deliberately removed — #379/#380 settled "growth-driven, no usage/count proxy gates"). Do NOT re-scale the interval with the context window or reintroduce percentage gates; a 1M-window session folding every 50K of growth is intended lean-context behavior. User escape hatch: `compress.nudgeGrowthTokens` (flattens `growthFloor`+`growthCap` to a fixed step) — big-window users who want a lazier cadence set it explicitly. Prompt wording is kernel-owned (`src/nudge-text.ts`).
9. **Persona hosts get id + system-hash session keys ("hash 不一样自动分裂") (Tier B)** — when a plugin host stamps the SAME conversation id on auxiliary personas, those requests MUST be keyed by `subagentNamespace(id, systemText)` → `<id>|sub:<fp>`, never overwriting the main session. The FIRST system seen under an id keeps the raw key (kernel anchor); an empty system is non-anchoring; SIDE REQUESTS never claim the anchor. This is an EVIDENCE-PERMITLIST (`dshPersonaFingerprintApplies`, same discipline as #1104/#1107): do NOT enable it wholesale; a new host joins only WITH traffic evidence. Forks record under their suffixed id (`personaForked` → `recordPluginSession`, #970). Full text: design-decisions.md #9.
10. **Thinking-family blocks are signature-verified — NEVER rewrite them (#1960)** — Anthropic `thinking`/`redacted_thinking` blocks and Gemini `thoughtSignature` parts are verified byte-for-byte when the latest assistant message is replayed ("thinking blocks ... cannot be modified"). The bytes the proxy forwards become the client's persisted history, and the bytes the loop accumulates become the re-request rebuild — BOTH must stay verbatim. Any transformation (tag/marker stripping, dedup, trimming, re-laying-out block order, dropping empty segments) desynchronizes text from signature and bricks the session: first on the in-turn re-request, then on every subsequent request via the client's echo. #1882 put a prose filter on the thinking channel and it was exactly this bug. Treat ANY future change touching thinking-family payloads as high-risk: it needs loop-level byte-equality tests (re-request body AND client-visible stream) on both signed wires, not just adapter-level ones. The prose filters (#206/#1881) are for the TEXT channel only.
11. **身份层级:msgid > 顺序 > hash (Tier B)** — 三层裁决：**(1) msgid 第一**——四条插件车道把宿主 msgid 作为私有信封字段上行，**只存在于宿主↔bili 之间，从不出现在模型线上**；msgid 有效时账本身份以它为准；全有全无——筛查失败/长度不符静默降级为内容 hash；账本主键仍是 (session_id, msg_id, content_hash) 三元组。**（2）无 msgid 时顺序是身份主载体**（fold-state reconcile 的 order-centric ladder）。**（3）hash 为辅助**——逐格硬门但**无全局否决权**：任何单维度 miss 不得级联成全量 unfold；id/指纹失配只作废该格、位置扫描在 MIN_RESYNC_RUN 连续同意后 resync；"never fuzzy similarity" 不变（hash 是逐格硬门）；"substrate destroyed" 判决只可计 resync 存活且过内容 pass 的 gap。Full text: design-decisions.md #11。
12. **资格判定与执行共用单一投影 (shared unit-projection judgment, #3236) (Tier B)** — whether a range is foldable has exactly ONE definition: `projectUnit` (`kernel/src/unit-projection.ts`), returning the projection OR the ready-to-throw fatal error. The apply side throws it byte-identically; recommend re-screens final merged units and demotes fatal units to gaps (no re-merge after filtering — anti-oscillation); `acp_status` flags rows additively (never drops). Judgment MUST run on the EXACT array class `applyCompression` executes on — hosts whose render view differs pass `applyView` / `StatusReportOptions.originalMessages`. Full text: design-decisions.md #12.
13. **出站历史渲染:快照即会话 (snapshot render — #3756, D-lane) (Tier B)** — 绑定 session id 且统一存储可读的会话，出站**前缀**由服务端正史渲染（消息身份 = 服务端行 `seq`）；尾巴保持客户端逐字。**任何失步（开关关/无活跃块/存储不可读/链不上）整轮回退 legacy——降级，不猜**；永不复活已覆盖行；观测（`reconcileFoldCoverage`）与渲染刻意分离。规则推论：凡讨论「覆盖 id 失配/destroyed 误诊/断缓存」类 bug，先问是否 D 车道——那类病理在 D 上结构性不存在。Full text: design-decisions.md #13.
14. **verif 模块:kernel 决策核的求解器验证 (#3848, PR #3853) (Tier B)** — `verif/` 把守护清单（`verif/guarded-files.ts` Tier A）的真实 TS 翻译成 SMT，cvc5/z3 找反例，反例必须回放真代码复现。**改守护清单文件：常规测试之外必须过 `tests/verif-subset-guard.test.ts`（秒级）+ 涉及的 `tests/verif-bug*`/`verif-generic-*`/`verif-induction-*`**（无求解器环境自动 skip）。新语法先让翻译器支持；例外登记 `verif/exceptions.ts`（过期即红）。教义：`verif/README.md`。Full text: design-decisions.md #14.
15. **全量重发水位快路径 (full-resend watermark — #5403/#5418, rollout `pluginFullResendWatermark` 5% 灰度) (Tier B)** — 服务端在成功响应盖 `x-bili-pf-seq`（messages 元素数，零分配结构扫描测出）；客户端回带 `x-bili-pf-count` + `x-bili-pf-tail-ids`（宿主 msgid；v4 下 K 取自**服务端账本**）。命中 = 上一轮 canonical cores + 仅尾窗 [K..T) 新解析（跳整包 parse/转换/钉存——#5403 OOM 生产者）。**任何疑点整轮走原封未动的 legacy 全量路径并重新盖戳**（客户端一轮收敛）；5 次连续可证实 miss ⇒ 熔断持有一小时。诚实边界：保元素数的前缀字节改写**不可检测**（§7.4 人工评审档）；多模态尾部入缓存后该段历史永久回 legacy 轮；pf-* 是协议头不是 hop 头（转发上游前剥，`UPSTREAM_HOP_HEADERS`）。与增量车道可同开、按请求形状分轨不双处理（anthropic wire→增量 divert；openai 形→水位）。Full text: design-decisions.md #15.
16. **Notice surface: one registry, three sources, B>A>S shadow (#5548) (Tier B)** — every web-UI banner flows through ONE loop consuming `mergedNotices()`: **S**=built-in (`src/notices.ts`, dead-key-guarded) / **A**=remote feed (`announcements/remote.json`, ~3-min poll, fail-open) / **B**=local files (`<config dir>/announcements/*.json`); equal ids shadow B>A>S. **Exactly ONE banner channel exists — no bespoke feed fetchers, dismissal stores, or inline banners.** Adding a builtin = `src/notices.ts` entry + en/zh i18n pair + registry-test row (+ config yaml seed + `gen-config-docs` when a knob ships). Dismissal receipts live in unified storage (`kv_store` namespace `notices`). Full text: design-decisions.md #16.
17. **消息身份公用设施 (sessionid+msgid) 生产/消费声明 (#5826) (Tier B)** — sessionid+msgid 是跨四车道的公用设施，**改任何一处前必须读懂生产与消费来源**（完整地图 `docs/msgid-infrastructure.md`）。生产：宿主铸稳定 UUID（`acp_summary_*` 为 kernel 保留命名空间，宿主 id 不得占用）；采集器只做拿到+初筛；四种传输载体**全部转发上游前剥除**。消费五方：统一存储 `messages.msg_id`（唯一 id 事实源）/ session-resolve 末档 #5719 / 结算 membership #4805 / 增量车道 #4491 / 水位尾连续性 v2-v4。校验规则**六份镜像副本**（宿主 bundle 禁 import server 模块的结构性约束）：`tests/msgid-rule-parity.test.ts` 钉死每份副本判决——**改任何一份规则必须先过该测试（有意分歧须显式重钉+写明理由）**。Full text: design-decisions.md #17.

### #18 — 身份信道接线：所有车道接进同一采集缝，消费者永不直读客户端存储 (#5825) (Tier B)

身份信号来源只有三类：**宿主写入**（msgid body 字段 / 信封 `msgIds` / pf 头）、**宿主盖戳头**（opencode V2 `x-bili-msg-ids`）、**自包含采集器**（`src/identity-harvest.ts` 注册表 + `src/identity-<client>.ts` 适配器；双门：env `BILI_IDENTITY_HARVEST` 或灰度键 `rollout.features.identityChannelHarvest`，均默认关 × 仅回环来源）。**消费者（#5719 归属档 / pin-行链路 / membership / 水位）只从统一缝取数**：handle 入口每请求按「body 字段 > 盖戳头 > 采集」取一次快照——绝不新增「逐调用点单独取数」。新车道 = 新适配器文件 + barrel 一行登记 + 文档一行；适配器自包含、整轮退化（任一环节不判定 ⇒ 该轮整体回退接线前路径，绝不做部分映射）。车道状态表与信任边界：docs/identity-channels.md；身份判定逻辑：docs/session-identity-resolution.md。Full text: design-decisions.md #18.

### Install-Lane & Update-Ownership Contract (#1196)

Every bili presence on a machine follows ONE contract — decide changes against it, not ad hoc:

1. **One writer per copy, chosen by the install SOURCE.** A copy installed through a host's own channel (dsh plugin market, opencode/pi managers, pnpm store) is owned by that host: bili NEVER writes it in place (#991, `hostManagedInstall`). `bili plugin install <agent>` only ever DRIVES the host's channel (e.g. `dsh plugin add`), never installs a second bili-owned copy beside it (#966).
2. **Every copy must have a LIVE update path** (the fix for the "frozen forever" bug class, #1196) — exactly one of: it IS the global install (self-updates in place) / it is a reference lane (omp/claude/codex/kimi/zcode/hermes — no copy, points at the global dist) / it lives in a host world (dsh profile bundle, opencode/pi tree — updated THROUGH the host's channel, by a global self-update AND, when no global ever runs, the copy's own periodic check `refreshDshProfileCopy`). Self-heal goes THROUGH the owner's sanctioned channel, never around it.
3. **Launchers give the one-copy experience** (`bili dsh` overlay mode loads the global dist, no persistent copy); market users get self-contained per-context copies. Both first-class; the two modes never mix for one lane (duplicate `bili-native` loader ids hard-fail dsh boot).
4. **Local pins stay manual.** `link:`/`file:` dev pins are never refreshed (`isRegistryDepSpec` gate).
5. **Transient drift is acceptable and bounded:** lanes converge to the registry version within one check cycle (~3 min) plus a host restart. Permanent divergence is a bug — file it under this contract.
6. **An in-place writer keeps ALL THREE LEDGERS in step (#3496):** the desktop dsh profile is the one copy bili owns outright; its self-heal swaps `node_modules/billion-context` directly, so it must ALSO move the profile manifest's declared spec AND the lockfile's recorded resolution in the same operation (`convergeDshLedger`, `src/dsh-ledger.ts`) — a writer that moves only the copy manufactures the wedge #3224 detects. Pre-existing drift converges on explicit demand only: `bili doctor --fix`.

Machine-global facilities stay SHARED across all copies (deliberately): `~/.local/state/billion-context/` (log + sessions, #394 multi-instance warning), `~/.cache/billion-context/` (update throttle + cross-process update lock), `~/.config/billion-context/` (providers/compress config).

### Kernel Contract: Message Ids Are Never Reused

The kernel (`acp-kernel`) guarantees, and billion-context RELIES on: within a session, a raw content-hash id and a ref number (`mNNNNN`) denote exactly one message forever — **never reused, never duplicated**, even after the message dies (edited/truncated/folded). The model can cite any number it has ever seen (summaries cite tags across turns), so a re-issued number silently misattributes on decompress. Consequences for this repo:

- Host code must NOT prune/repack `session.state.messageRefs` in ways that let a freed number be re-issued (kernel `assignRefsNode` computes its cursor as `highestUsedIndex(map)+1`, so shrinking the map can drop the cursor and re-issue numbers).
- Known residual: `applyCompactionArchive` (#421, `src/session.ts`) prunes `byRaw/byRef` to live raw ids on native-compaction boundaries — in practice the cursor does not drop; drop the prune once the kernel's ref-space widening (post-#191 direction) makes it unnecessary.
- The kernel source lives in `kernel/` (#2092) — see Kernel Boundary below.

## Kernel Boundary (in-repo acp-kernel, #2092)

The compression kernel lives IN THIS REPO under `kernel/` (migrated verbatim from ranxianglei/acp-kernel @ v0.0.101 on 2026-10-04; the old repo stays frozen until the move has settled). It keeps its own identity — npm name `acp-kernel`, own `version`, own unit suite (`kernel/tests/`), own build chain — and the host consumes it through `"acp-kernel": "file:./kernel"`. The merge exists to end cross-repo maintenance pain WITHOUT making the kernel easy to disturb. Enforced rules:

1. **Declare before you touch.** Every PR touching anything under `kernel/**` MUST declare `kernel-change: <reason>` in its body (CI job `kernel-guard` fails otherwise) AND needs owner approval BEFORE implementation, via a dedicated issue stating why the host side cannot solve the problem. Commits use the `kernel:` prefix. **Mechanical-bug exemption (owner policy 2026-11-06):** an obviously mechanical kernel bug (wrong literal, typo, provably-false guard) may be fixed directly WITHOUT the pre-approval issue, provided the fix adds a reproducing regression test, declares `kernel-change: <reason>`, and posts an in-thread report; the human-only review tier (rule 3) still gates the merge. All other kernel work keeps the full prior-approval flow.
2. **Version discipline (CI-enforced).** Any change under `kernel/src/**` (or `kernel/tsup.config.ts` / `kernel/tsconfig.json`) MUST bump `version` in `kernel/package.json`; a bump without such a change also fails.
3. **Human-only review, always.** ALL kernel changes sit at the same review tier as `src/update.ts` and security (§7.4): no auto-merge, ever.
4. **Behavior constants are golden-pinned.** `tests/golden/wire-contract/kernel.json` pins the behavior surface hosts silently depend on (`defaultConfig(100_000)` incl. flat-50K nudge constants, `defaultPrompts`, tool-name tables, wire markers). Regeneration requires stated justification in the PR; the ledger never shrinks (#1304).
5. **Two test layers, both must pass.** The kernel's own unit suite (`npm --prefix kernel test`) plus the bili suite/e2e as the integration layer — both green on the rebased head.
6. **Structural invariants stay human-gated:** zero runtime deps (no new dependency without owner sign-off), platform-agnostic core (no host API / file I/O / network), message-id immutability, wire-artifact format, lossless round-trip, protected-tool hard exclusion, canonical pipeline node ordering.

## Pi-Subagents Boundary (in-repo pi-lane component, #2384)

The pi sub-agent surface (`acp_delegate` tools) lives IN THIS REPO under `pi-subagents/` (migrated verbatim from ranxianglei/billion-context-pi-subagents on 2026-10-08; the old repo stays frozen until the move has settled — `pi-subagents/PROVENANCE.md`). Same consumption pattern as `kernel/` (`file:` devDependency, inlined by tsup). Enforced rules:

1. **Version discipline (CI-enforced).** Any change under `pi-subagents/src/**` (or its `tsup.config.ts` / `tsconfig.json`) MUST bump `version` in `pi-subagents/package.json`; a bump without such a change also fails (CI job `pi-subagents-guard`).
2. **Two test layers, both must pass.** `npm --prefix pi-subagents test` plus the bili suite/e2e — both green on the rebased head.
3. **Lighter gating than `kernel/` (deliberate).** No PR-body declaration, no human-only tier: this is a fast-moving pi-lane extension surface, not load-bearing core compression. If that assessment changes, tighten HERE first (add the gate, don't improvise it).
4. **Zero-runtime-dep contract preserved.** Its only runtime host import (`@earendil-works/pi-coding-agent`, for `CONFIG_DIR_NAME`) stays external, aliased to `src/agent/pi-host-stub.ts` in the bili bundle (#2186); its `typebox` peer is inlined by the component's OWN tsup build — no new runtime dependency ever reaches `dist/`.

## 3. Development Standards

### Build Commands

```bash
npm run build          # builds kernel/ + pi-subagents/ first, then tsup bundle (both inlined)
npm run typecheck      # tsc --noEmit --project tsconfig.json (src + tests; pre-hooks build kernel/ + pi-subagents/)
npm test               # node --import tsx --test tests/*.test.ts (bili suite; kernel suite: npm --prefix kernel test; pi-subagents suite: npm --prefix pi-subagents test) — LOCAL runs are for TARGETED files only; the FULL-suite verdict is the remote CI `test` lanes on the pushed head (§7.2)
```

### Local Testing & Install

Test against the REAL published artifact: `npm run build && npm install -g billion-context@latest && bili start --port 8787`. `npm install -g . --install-links` also works, but `--install-links` is REQUIRED on npm ≥ 9 (without it the global install is a SYMLINK to the dev tree — leaks edits and silently re-links on reinstall, #1225). Verify: `readlink $(npm root -g)/billion-context` — empty = real copy. Full recipe: [reference/testing.md](reference/testing.md).

### E2E Regression (real client through bili)

The `tests/e2e/` suites are the only coverage that exercises real client behavior (UA, wire quirks, retry loops):

- **Request-pipeline changes** (`src/server.ts`, `src/loop/**`, adapters, preflight/compact paths) → run the codex suite first (at least the 4-phase core, `ACP_TEST_E2E=1`; **never remove the gate**).
- **`src/update.ts` / `src/advisory.ts` / `src/plugin-install.ts`** → run the registry suite first (`ACP_TEST_REGISTRY=1`, hermetic verdaccio; the advisory-rollback suite shares its gate).
- The hermetic image-billing lane (`npm run test:e2e:image`) is ungated and always runs in CI; newer lanes carry their own skip gate in the test header (canary `ACP_TEST_CANARY=1`, OpenCode V2 WS `ACP_TEST_E2E_OC_WS=1`, …).

Exact env vars, phases, and the CI trigger file-list: [reference/testing.md](reference/testing.md).

### Gate Test Discipline — Negative Assertions (#3617)

Every gate (suppression / degradation / fallback / exemption) ships with **both directions** asserted: "triggers when it should" AND "does NOT trigger when it should not." A gate that lands with only the positive case is incomplete by definition — #3401 shipped that way and over-suppressed the dsh compress surface for two releases; #3600's shape had no row at all in the decision matrix, so the gate closed the whole surface silently while CI stayed green. Row-driven truth tables (`tests/lane-decisions-matrix.test.ts`) take each new tool-shape/profile as a positive+negative row pair; the decision functions in `src/server/lane-decisions.ts` carry doc comments pointing at their matrix file.

### Configuration Surface Discipline (owner-gated)

The config surface — every field of `~/.config/billion-context/billion-context.json`, every `BILI_*` env var, every CLI flag, mirrored across docs/configuration.md en/zh — is **owner-design territory**. Hard rules:

1. **Any change that adds, renames, or re-semantics a config field MUST report it explicitly** in the PR under a "config surface" heading: what is added/changed, why the existing surface cannot express it, which existing mechanisms were considered (providers table + its key species, the three-level `compress` hierarchy, env-var conventions, launcher↔extension channels), and the compat/migration story. A PR touching config without this section is incomplete by definition.
2. **Agents do NOT invent new config shapes on their own initiative.** A new section/field proposed merely because locally convenient — without mapping it onto the existing system — is rejected on principle: **don't even build it**. File the proposal (issue, with the mapping above) and wait.
3. **The only exception is explicit owner sign-off in the issue/PR thread, given BEFORE implementation**, recorded alongside the design rationale. "The agent thought it was a good idea" is never sufficient reason.

Canonical cautionary case (#1437 → #1469): a one-off `plugin.nonHttpProviders` section drafted alongside the existing `providers` table collided with the table's design and had to be reworked into `providers[<name>].compactionOptIn` — the first shape should never have existed.

### Environment Variable Discipline (#2030)

Env vars are a **scarce surface**: by default a new behavior knob becomes a config-file key resolved through `src/knobs.ts` (**env > file > default**) — not a new `process.env` read. Env-only is reserved for six categories (secrets, per-process spawn channels, host-side posture, path relocation, third-party conventions); every env var must be documented in docs/configuration.md en+zh ("document or don't ship"). Full category table, hard rules, and rationale: [reference/env-vars.md](reference/env-vars.md).

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any ACP-tag XML in source files (see KDD #2)
- **No `console.error` in server-side modules** — use `loggerLog(level, msg)` from `src/logger.ts`. Exceptions: `src/cli.ts` (user-facing CLI errors) and `src/index.ts` (pre-logger startup crash).

### Documentation Layout (owner ruling 2026-11-08, #5920)

- **One hub.** All design/config/protocol/identity docs live under `docs/`. The repo root keeps only four **core** entry files — `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CHANGELOG.md` (plus temporary redirect stubs per rule 5) — and recognized community-maintained README translations (`README.<locale>.md`, e.g. `README.ja.md`, approved 2026-11-09, #6000); the four core files stay locked. New non-translation docs go in `docs/`, never at the root.
- **Naming & language.** kebab-case English base name; bilingual (en + `<same>.zh-CN.md`) is the default (en/zh parity per §7.3). A single-language doc must state why in its `docs/index` entry.
- **Index.** Every new or moved doc must be listed in `docs/index.md` AND `docs/index.zh-CN.md` in the same PR.
- **Split with `reference/`.** `docs/` = decision/reviewer-facing reference material; `reference/` = AGENTS lazy-loaded construction procedures + the KDD full text ([design-decisions.md](reference/design-decisions.md)). New how-to procedures → `reference/` (+ AGENTS.md pointer); new concepts/decisions → `docs/`.
- **Moves/renames.** Leave a one-line redirect stub at the old path and a hygiene-ledger entry in `docs/lifecycle.md` §5 with an explicit removal condition (default: 1–2 releases).
- **Runtime doc references** (`package.json` `files`, CI diff paths, guard scripts, user-facing strings) use repo-root-relative paths and must be updated in the same PR as the move; a post-move repo-wide relative-link check must pass clean.
- **Diagrams.** Vector SVG is the default artifact and default display (owner ruling 2026-11-07); ship a PNG fallback alongside, referenced second. Diagrams live in the doc's `assets/` directory.
- **Architecture docs are LIVE (owner ruling 2026-11-08).** `docs/architecture.md` (+ `.zh-CN`) is the hub: overall diagram + module ledger; each module page lives in `docs/architecture/<module>.md` (+ `.zh-CN`) with its own diagram (svg first, png fallback). Any PR that adds/removes/renames a `src/` module OR changes a depicted data flow, table, lane, or wire path MUST update the affected page(s), diagram(s), hub ledger row, and the `reference/architecture.md` file map in the SAME PR. CI lane `architecture-docs` (`tools/check-architecture-docs.mjs`) enforces the mechanical parts; visual freshness rides on this rule + review.

## 4. Git Safety Rules (MANDATORY)

| Rule | Enforcement |
|------|-------------|
| **NEVER force-push to `master`** | Under no circumstances (GitHub branch protection also blocks it). |
| **NEVER merge PRs** | Human-only. If asked to merge, reply: "I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL]." |
| **NEVER run `npm publish`** | CI handles it on release-PR merge. Never manually — incl. `NPM_ALLOW_DANGEROUS=1` or `npm pack` workarounds. If asked, reply: "I can't publish to npm — releases publish automatically via CI. See §5." |
| **NEVER print the GitHub PAT** | Token stays in a shell variable only. |
| **Branch naming** | `YYYY-MM-DD_short-title`; releases: `*_release-v*` (bili) / `*_release-kernel-v*` (kernel, §5) |
| **NEVER modify `version` off release branches** | `"version"` touched ONLY on `*_release-v*` branches. Content commits must NEVER bump it. See Version Bumps below. |
| **NEVER cut a release without owner approval** | Release branches and release PRs are opened ONLY after the owner explicitly approves the release in-thread (「发版 vX」/「批准发布」). An Agent may **propose** a release but never pushes the branch or opens the PR itself. If asked, reply: "Releases need your go — approve in-thread and I'll cut the PR." (Owner rule 2026-10-12, #2910) |
| **NEVER ship a broadcast-to-all announcement** | An announcement record visible to every machine unconditionally is strictly forbidden — owner confirmation + explicit blast radius + audience restriction required (§ Remote Announcements). (Owner rule 2026-11-13, #6508/#6509) |

**Opening a PR** (no `gh` CLI): `git push origin HEAD` → token from `git credential fill` (shell var only, never print) → POST `/repos/ranxianglei/billion-context/pulls` with base `master`. Full token/curl recipe: [reference/git-pr.md](reference/git-pr.md). Merging stays human-only.

**External contributors' PRs — fix directly, don't replace.** Fixes go out as **additive commits to the contributor's PR branch**, whoever authored it (owner rule 小问题直接修, 2026-10-01). What stays off-limits is REPLACING the contribution: no rebase-and-replace with an Agent-owned PR, no closing a still-mergeable contribution in favor of a new one (#1765) — the contributor's commits, diff and authorship stay in the merged history. A deleted head branch does NOT kill an open PR (GitHub freezes `refs/pull/N/head`; check `mergeable`/`mergeStateStatus` first), and `BEHIND` is not a blocker. Mechanics: [reference/git-pr.md](reference/git-pr.md).

**Post-merge supplements** → a small follow-up PR whose body references the original PR number; never append to / rebase the merged PR. Verify a supplement is actually needed first (replaying the same commit on newer master is verification, not content).

### Remote Announcements (公告) — owner-gated, no broadcast-to-all (MANDATORY)

The remote announcement feed ([`announcements/remote.json`](announcements/remote.json), #5548) reaches **every running instance within ~3 minutes of a master merge** — it is a safety surface in the same class as merge/release, not a docs file. Rules (owner ruling 2026-11-13, #6508/#6509 — the dsh-live-compact entry shipped as an ungated broadcast, hit every machine, and had to be retracted):

1. **No broadcast-to-all（严格禁止对所有用户公告）.** A record visible to every machine unconditionally is strictly forbidden. Every record must be restricted to a defined audience — `versions` / `requiresScan` / time window, as applicable. If you cannot state a narrow audience, do not ship the record.
2. **Explicit owner confirmation for ANY announcement.** Adding, changing, or retracting any announcement record requires the owner's explicit confirmation in-thread BEFORE the PR is opened — same class as releases (§ Version Bumps). An Agent may **propose** announcement content and scope but never opens or pushes the announcement PR itself.
3. **The announcement PR must state the blast radius.** The body must spell out: (a) the audience (which client / version / install-state sees it); (b) version coverage — explicitly which OLDER versions ignore new gate fields (e.g. `requiresScan`) and therefore see the record unconditionally; (c) the display duration — when and by whom the record comes out of the feed (retraction PR vs. `until` window).
4. **Plugin-targeted announcements are disallowed in principle（原则上不允许针对某个插件的公告）.** Surfacing plugin conflicts belongs to the read-only conflict scan (#1206), which is inherently per-machine. Any plugin-targeted notice must be **trigger-based, not announcement-based**: a scan surface (CLI WARNING / session conflict ledger / `/__bili/stats` / interception-failure web banner), or — only when a persistent web notice is genuinely needed — a feed record carrying a `requiresScan` gate so delivery matches the stated audience. Precedent: the #5984 dsh-live-compact record, broadcast ungated, retracted 2026-11-13 (#6508/#6509).

### Issue & Problem Tracking (MANDATORY)

One issue = one scope; open a PR, never just push a branch; never bundle unrelated changes or mass whitespace/reformatting into a fix.

**Version-first triage (先定版本 — owner rule, 2026-10-12, #2847):** before ANY code-level analysis of a bug report, pin the reporter's bili (and, when relevant, kernel) version and read the code AT THAT TAG, not master. If the report doesn't state a version, the FIRST triage reply asks for it (startup log line / `bili --version` / `package.json` / ledger meta). Litmus test: "the mechanism should have caught this but didn't" ⇒ before suspecting a design gap, verify the mechanism even EXISTS in the reporter's build. (Origin #2847: a full triage day analyzed master while the reporter ran v0.1.192 — pure version lag mis-read as an open design gap.) When an Agent works an issue, deliverables are mandatory:

1. **Finished development → PR.** Open a PR referencing the CURRENT issue (`Closes #N`) and reply in-thread with the PR link. An issue is never "done" without a PR.
2. **Problems DISCOVERED while working** (bug / data-loss / security / architectural) → report in the current thread AND file a separate new issue (repro, impact, suggested fix) in the project the problem belongs to.
3. **Problems FIXED** → leave a trace: an issue recording the problem + how it was fixed; if shipped as a PR, the PR references its issue (`Fixes #N`). A bare PR without an issue is not acceptable — file the issue first, then link it.
4. **Minor problems → fix directly（小问题直接修）** (owner rule, 2026-10-01): small issues (typos, cosmetic defects, log-wording quirks, minor UX wrinkles) found while working — including during a PR review — are fixed RIGHT AWAY in the same branch, with a one-line note in the thread. Do NOT open separate issues for them, and do NOT leave them as "noted, not fixed". Applies to ANY branch, including external contributors' PR branches.

Split extra findings into their own issues/PRs rather than expanding this one's scope.

### Issue 分类与标签规则（triage 必做）

每个新 issue 在 triage 时打齐三组标签（**优先级 p1/p2/p3 必选其一** · 宿主车道 · 领域 `scope/*`），并在评论或讨论里注明主题类别（A–N）。**p1 = 可用性缺陷 + 缓存泄露类（stale cache 渗漏、cache ref 错误改写、上下文/存储只增不减），owner 修订 2026-10-19 两类一律 p1 不许降 p2**；其余分级口径、全量标签表、A–N 类别定义见 [reference/triage.md](reference/triage.md)。全量开放 issue 的分类总账维护在讨论区置顶：https://github.com/ranxianglei/billion-context/discussions/3913 （更新总账时直接编辑该讨论，不开新帖）。

### Version Bumps — One Version, One Commit, One Branch

`"version"` in `package.json` is the single source of truth for what gets published. Touched by the standard release flow ONLY (§5). Two hard rules:

1. **`version` changes ONLY on release branches** (`*_release-v*`). Feature/fix/refactor/docs commits leave it untouched — if you find yourself editing it on a content branch, **stop**, you're on the wrong branch.
2. **A release commit changes ONLY `version`** (+ `package-lock.json` if it drifts). Never bundle a bump into a content commit or content into a release commit. One bump = one isolated commit `release v{VERSION}`.

**Why load-bearing:** CI (`release.yml`) detects a release by matching branch name AND commit message; bundling breaks the trigger and causes 3-way conflicts on `package.json`. If asked to "just bump the version" inside a feature change, decline and route it through §5.

## 5. Release Workflow

Releases are fully automated via CI (`.github/workflows/release.yml`): the Agent prepares a release PR; merging it builds, tests, publishes to npm, tags, and creates a GitHub Release. Hard rules below; exact steps + internals in [reference/release.md](reference/release.md).

- **Owner-approved start (owner rule 2026-10-12, #2910):** an Agent runs the release flow ONLY after the owner explicitly approves the release in the trigger thread (「发版 vX」). Triage that ends at "fix stranded on master, users blocked" PROPOSES the release in the issue thread and stops — what ships and when belongs to the owner. (Origin: #2906 — a bot autonomously cut v0.1.196 (#2910) mid-triage; the decision to ship was never the bot's to make.)
- **Branch** `YYYY-MM-DD_release-v{VERSION}`; commit `release v{VERSION}` changing ONLY `version`. The Agent does steps 1–6 (sync master → branch → bump → **sync plugin manifest versions (#4449)** → **release-notes entry if severe (#1870)** → pre-flight typecheck+test+build → commit/push/open PR); HUMAN merges step 7; CI publishes step 8.
- **Plugin manifest versions sync on every release (#4449).** The four plugin manifests (`.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`, `plugins/codex/.codex-plugin/plugin.json`) carry `version` fields the Codex/Claude marketplaces use for UPDATE DETECTION — they must equal `package.json`. After the bump commit run `node scripts/sync-codex-plugin-version.mjs` and commit the result as its own `chore:` commit on the release branch. ALL THREE publish workflows run `--check` BEFORE tag/publish: drift = red release, nothing shipped — a bugfix carve-out head MUST also carry the synced manifests.
- **Release-notes entry (#1870, OPT-IN):** only SEVERE releases need an entry in `release-notes/package.json`; ordinary releases ship with NO entry (gates pass when absent, validate when present). A severe entry is its own commit in the SAME release PR; the one-click fast path needs it already on master. Full rules: [reference/release.md](reference/release.md) + `release-notes/README.md`.
- **Bugfix carve-out channel (#2011, PR-gated since #2851):** emergency hotfixes ship as a release PR whose head branch keeps the `bugfix-release/v{VERSION}-{slug}` marker (cut from the last released TAG, containing ONLY the fix + bump); merging publishes the PRE-MERGE PR-head tree, strictly excluding master's other unreleased work. Batch form: label an OPEN fix PR `backport` → a carry PR appears on the current patch lane. Mechanics and constraints: [reference/release.md](reference/release.md).
- **NEVER run `npm publish` manually** — CI does it (§4).
- **Kernel releases (separate artifact, #2092):** branch `YYYY-MM-DD_release-kernel-v{VERSION}`, commit `release kernel v{VERSION}` changing ONLY `kernel/package.json` version; merging runs `release-kernel.yml` (publish `acp-kernel`, tag `kernel-v{VERSION}` — separate namespace, bili tags stay bare `v*`). No release-notes entry required; the PR body serves as notes. The two branch patterns are mutually exclusive.
- **Changing `src/update.ts` (the updater itself) requires a NO-OP validation release FIRST** — a pure version bump proves the *existing* upgrade path is healthy end-to-end before the change ships. A broken updater bricks every future upgrade. Full protocol + rationale: [reference/release.md](reference/release.md).

## 6. Contributing

Before changes: (1) `npm run typecheck` clean, (2) `npm test` green, (3) understand the module dependency graph, (4) **consider BOTH compression modes** — any change touching the wire (message rebuild, system/developer handling, tool injection, `acp_summary` stripping, preflight, nudge) must be reasoned in BOTH plugin mode and proxy mode; correct-in-one-mode can break the other (#377 only manifested in proxy mode). See docs/technical-notes.md "Two compression modes" and the `pluginMode` comment in `src/server.ts`. (5) **Kernel changes follow the Kernel Boundary** — declaration marker, owner approval (mechanical-bug exemption per rule 1), version discipline, two-layer tests; the kernel is relatively stable by design, touch it only when necessary. (6) **`pi-subagents/` changes follow the Pi-Subagents Boundary** — version discipline + two-layer tests, lighter gating than `kernel/` (see that section).

Commit convention: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `release:`.

## 7. Review & Auto-Merge Discipline

> Distilled from a full-history review of AI auto-dev across billion-context / billion-context-pi / acp-kernel (#801). Goal: ~90% of bugfixes mergeable without rework, without drifting off direction. Evidence appendix (baseline data, per-issue provenance, second-round analysis): [docs/auto-merge-guardrails.md](docs/auto-merge-guardrails.md) — the authoritative OPERATIVE rule text stays here in §7.

### 7.1 Before You Start

- **Duplicate screening first.** Search open AND closed issues/PRs for the same fix before implementing; if one exists, link it — don't start parallel work.
- **One issue = one scope.** Split extra findings into separate issues/PRs; never bundle unrelated changes or mass whitespace/reformatting.
- **Open a PR, never just push a branch.** A bare branch is not a deliverable.

### 7.2 Review Discipline

- **Rebase to CURRENT master before claiming mergeable.** Verify against live master, not the PR's original base; after rebase run typecheck + build locally — the FULL-suite verdict comes from remote CI on the pushed head (next bullet). Stale base is the #1 cause of second-round rework (#425 Aug-31 base, #467 43 commits behind, #517).
- **Full regression = remote GitHub CI, not a local full-suite run.** The authoritative green/red is the GitHub Actions `test` lane on the pushed head (`scripts/run-ci-tests.mjs`: hermetic runner, pinned concurrency, ubuntu/windows × node 22/24 × shards). Workflow: TARGETED suites locally for the area touched → push → read the check runs. A local full-suite run is environment noise, not evidence (firewalled networks, port collisions with a running bili, cross-file interference) — never cite it as the merge verdict, and never chase a local failure before confirming it reproduces on CI or in that file run standalone.
- **Watch hot-file contention.** `src/server.ts`, the preflight paths, `src/persist.ts`, and the `src/agent/*` extension types are rewritten by many concurrent PRs — expect semantic (not textual) conflicts; coordinate/sequence, resolve by union of intent, then prove by running tests (#517↔#587, #571↔#558).
- **One linear commit, clean diff.** No diff-exploding rebases, no incidental whitespace re-alignment; every line relates to the PR's purpose (#571, #467).
- **Minor flaws found during review get fixed, not filed** (小问题直接修, §4): a small non-semantic flaw (typo, misaligned indent, log wording) becomes a one-line fix pushed to the PR branch immediately — on ANY PR branch, external contributors included.
- **Done = evidence, not "should work".** Double-review, then RUN the changed behavior and observe it; for context/wire fixes prefer a real e2e A/B against the issue repro over unit tests alone (#254).
- **Tests must be deterministic.** No environmental luck (assume no port range is free — Windows' ephemeral range 49152–65535 collides with fixed picks; request a port via `listen(0)` instead, #360).
- **AI-posted comments self-declare their model.** Any comment/reply/review an Agent posts on GitHub opens with `(ai: <provider>/<model-id>)` on the first line — provenance for the reader; a silent mix of models in one thread is unauditable. Applies to posted text only, not PR descriptions.

### 7.3 Correctness Guardrails

- **Availability over performance (可用性永远大于性能 — owner rule, 2026-10-14, #3128).** When a defect makes a capability UNAVAILABLE, restoring availability outranks everything — performance, memory, elegance. Ship the availability fix; track the performance cost as SEPARATE work. (Canonical case #3128: raising the 100 MiB body cap to 5 GiB is an availability decision; the in-RAM cost is separate streaming/spill work.)
- **Root cause, not symptom (疏, not 堵 — first principle for every fix).** A fix removes the mechanism that PRODUCES the defect; it never merely hides the defect's visible trace at whatever layer is cheapest to intercept. Name the producer of the offending bytes/behavior and fix it at the source or decision point — never by filtering payload in transit. Litmus test: "if the same root cause surfaced in a different shape tomorrow, would this fix still hold?" If not, it is a mask, and a mask is a latent bug. (Canonical failure #933→#1039: model-echoed tags were "fixed" by stripping tool-call arguments mid-stream; the mask itself became silent data corruption once users legitimately wrote tag-shaped payloads. When the true root cause is out of scope, fix the in-scope part, leave a boundary note, and do NOT compensate in the wrong layer.)
- **Never silently clobber or drop user config.** Any read-modify-write on user config needs a parse-state guard; reject malformed input loudly (HTTP 400/409) instead of merging into defaults or dropping fields. Whitelists must be complete (#155: a missing key silently erased custom compress prompts).
- **Sane defaults & fallbacks.** Fallback values must be reasonable (never a too-small value that thrashes); a static/fallback source must always lose to a fresher authoritative source when both are cheaply available (#282: window fallback 200K/min 100K, not 64K; the bundled registry snapshot must not outrank the live registry).
- **Prefer native stable identifiers.** Use a client's native stable session id when available (survives credential/model/provider switches); report clients that expose none; never build identity from derived hashes that drift on switch (#280). With snapshot-render (#3756) on, the session id + server transcript IS the outbound message identity — KDD #13 and docs/message-identity.md.
- **Wire fidelity (host-side duty).** Never alter upstream protocol shape beyond intended injection: preserve tool_call ids/ordering, SSE structure, and upstream invariants (e.g. `compaction_trigger` must remain the last input item, #283/#209). Reason in BOTH compression modes (§6).
  - *Tool-call arguments are user intent (#1039).* Any payload a host will EXECUTE or PERSIST — tool-call `arguments` in every wire shape — is forwarded **byte-exact**. NEVER filter, strip, or "clean" it, not even to remove model-echoed render tags: a shape-based filter cannot distinguish an echo from a literal the user genuinely wants written. Echoed tags surfacing in a host TUI is cosmetic noise — the fix belongs on the injection side (host renderTags policy, #933), never in the argument path. Tag-echo stripping applies to model PROSE only (see the invariant block atop `src/loop/tag-echo-filter.ts`).
  - *Kernel-owned split:* the FORMAT CONTRACT of the kernel-emitted ACP artifacts (KDD #2) and the **id-never-reused guarantee** belong to **acp-kernel**, not this repo (§2 Kernel Contract). This repo consumes them faithfully. Codifying the kernel-side spec is a change under `kernel/` — human-gated per the Kernel Boundary.
- **Symptom ≠ mechanism.** Before attributing a bug to bili's mechanism, verify against upstream logs — repeated-compression logs may be an upstream rate-limit retry illusion, not over-compression (#282).
- **Wire-constraint ledger only grows (#1304).** Every upstream rejection or validation constraint discovered in production or provider docs (e.g. #1299: Anthropic rejects top-level `oneOf`/`allOf`/`anyOf` in `tools[].input_schema`) becomes a PERMANENT entry in the wire-contract suite — the ledger (`WIRE_RULES` in `tests/wire-contract-fakes.ts`) + gates in `tests/wire-contract.test.ts` (provenance cited) + enforcement in the matching fake upstream — INSIDE THE FIXING PR. The ledger never shrinks without owner sign-off. Golden schema snapshots (`tests/golden/wire-contract/*.json`) change only via explicit regeneration (`scripts/update-wire-contract-goldens.ts`) with stated justification; a pin bump or tool-surface change tripping a gate is stop-the-line, not something to loosen.
- **Honest output.** Never emit misleading messages for degenerate states (#155: export claimed "original conversation" for a 0-block session).
- **Logs.** Mask secret values in all logs; separate trace/debug/info; keep debug-on by default during bug-convergence phases (#247).
- **Docs.** Keep zh/en in sync; place content where the actual reader will see it; mirror env-var references into docs/configuration.md, not just one README (#571).

### 7.4 Auto-Merge Gate (this repo only)

A bugfix may **auto-merge** only if ALL hold:

1. Single-module scoped fix; no architectural change.
2. A regression test reproduces the original bug and now passes.
3. Green **on the rebased head** (typecheck + build locally; full-suite green = the CI `test` lanes on the pushed head, §7.2).
4. No change to: config schema, persistence format/version, wire protocol / message shape, or any change under `kernel/`.
5. Pure `fix:` — no new capability surface (not feat/refactor).
6. Clean diff: no unrelated changes, no mass whitespace/reformat, no generated or lock-file churn.
7. References its issue via `Fixes #N`.
8. Does NOT touch load-bearing infra: `src/update.ts`, release workflow, CI publish, `kernel/` (any facet), message-ref/id logic, or security (MITM/CA/credentials).

**Must stay human** (any hit): wire/message-shape changes (both modes affected), config schema or persistence version, any `kernel/` change, `src/update.ts` (needs a no-op release first), identity/session-binding logic, feat/refactor/architecture, security-related, or any fallback/default-value change (a product decision).

> **Scope note:** auto-merge applies to THIS repo only. Kernel changes (anything under `kernel/`, including its version bumps and releases) remain manual/human.

### 7.5 Reviewer Focus — the "重灾区" (second-round zones)

Of 326 analyzed merged PRs, 26 (~7%) needed a second+ human review round. Two drivers dominate, and they are exactly where auto-merge is unsafe:

1. **Stale-base / concurrent-file churn** — long-lived branches drift from fast-moving master and collide with other PRs on hot files. Gate signals: branch freshness, and whether a touched file is being rewritten by another open PR.
2. **Incomplete first pass** — the initial fix addresses the reported symptom but misses an adjacent path/edge case, leaves promised work unfinished, or needs its approach reconsidered. Gate signal: does the fix cover ALL paths of the bug, not just the repro?

These map directly onto §7.2–7.3; a reviewer walks those bullets in order.
