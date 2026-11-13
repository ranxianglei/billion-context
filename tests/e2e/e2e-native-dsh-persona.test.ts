// E2E: REAL `dsh` — the #2241/#2791 regression families, on the native lane.
//
// A model switch mid-conversation must NOT fork the main lane off the raw
// conversation key (#2241): dsh rebuilds its main system per model, so the
// persona fingerprint (db21309d: "a different system forks onto <id>|sub:<fp>")
// fired on EVERY /model switch — the main turn landed on a fresh `|sub:`
// session, compression refs renumbered from zero, and the folding state was
// lost for the rest of the session. The fix (PR #2247) keys persona forking
// on prefix-affinity CONTINUITY: a system change whose history byte-exactly
// continues the raw key's chain MIGRATES the anchor (same conversation);
// history-discontinuous requests still fork.
//
// Two scenarios, both with a real dsh headless client and zero tokens:
//
//   A. model switch — turn 1 (model A) then the profile's default model is
//      flipped and turn 2 continues the SAME dsh session (--session-id), so
//      dsh recomposes its main system — the exact incident trigger. Accept:
//      one stable conversation id, a real model switch on the wire, a
//      continued history, and exactly ONE persisted bili session under the
//      RAW key (no `|sub:` sibling, requests >= 2, refs accumulated).
//      The title-generation side request dsh fires on turn 1 rides the same
//      conversation id — it must stay a harmless side lane (never steals the
//      raw key, never mints a persisted `|sub:` of its own).
//
//   C. PROTOCOL switch (#2791) — same shape as A but the profile flips to a
//      provider on a DIFFERENT wire (api anthropic-messages instead of
//      openai-completions): turn 1 (openai) logs a bulky tagged ledger and
//      runs one bash round; turn 2 (openai, same session) asks for a
//      scripted compress that folds the ledger; turn 3 (anthropic wire,
//      same session) asks a plain follow-up. Accept: one conversation id
//      across BOTH wires, the anthropic request inherits the full history,
//      exactly ONE model-emitted compress (a forked anonymous session would
//      re-fold from scratch — #2791's silent symptom), and the fold's block
//      survives on the ONE persisted session under the raw key.
//
//   B. auto-review (blocked, see gatedB below) — with
//      @deepseek-ai/dsh-experimental-auto-review enabled and a task that runs
//      a bash tool call, dsh fires its reviewer request under the SAME
//      conversation id: fixed REVIEW_POLICY system, one fresh
//      flattened-transcript user message (history-discontinuous by design,
//      #1916/#1307/#1314). Accept: the review request reaches the wire, the
//      reviewer decision JSON round-trips, the tool actually executes, and —
//      the regression pin — the review STILL forks onto its own `|sub:`
//      session while the main lane keeps riding the raw key (refs never
//      reset). An over-aggressive migration would collapse the review into
//      the main session and fail this scenario. Until a headless surface to
//      arm the Auto preset exists, that pin lives in
//      tests/dsh-persona-continuity.test.ts (review e2e, both wires).
//
// Gated by ACP_TEST_E2E_DSH_NATIVE=1 (needs a real `dsh` >= 0.2.0-rc.2 with
// --session-id + `npm run build`; the profile loads dist/agent/dsh-native.js).
// Scenario A fails on pre-fix master with the `|sub:` fork — that is the
// regression it pins; scenario B pins the isolation the fix must preserve.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const DSH_BIN = process.env.E2E_DSH_BIN ?? "dsh";
const GATE = process.env.ACP_TEST_E2E_DSH_NATIVE === "1";
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TMO = 180_000;
const FAKE_PORT = 18931;

function dshAvailable(): boolean {
    const r = spawnSync(DSH_BIN, ["--version"], { timeout: 15_000 });
    return r.status === 0;
}

function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("BILI") || key.startsWith("BILLION_CONTEXT") || key.startsWith("ACP_") || key.startsWith("DSH_") || key.startsWith("ZCODE")) delete env[key];
    }
    for (const key of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_TEST_CONTEXT", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) delete env[key];
    return env;
}

type FakeMessage = { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string } }[]; tool_call_id?: string };

// Deterministic streaming-capable chat upstream with the scripted behaviors
// both scenarios need. Reply selection per request body:
//   - REVIEW_POLICY system          -> reviewer decision JSON (allow, low)
//   - title-generator system        -> a one-line title
//   - a tool result in history      -> final assistant text
//   - the workspace task            -> a bash tool_call (echo ZX7-back)
//   - otherwise                     -> ok-N
// Every stamped request is recorded to a JSONL oracle (conversation id,
// model, message count, system head).
// #2791 cross-protocol lane: fold oracle markers embedded in the scripted
// compress summary and the bulky filler. The summary text deliberately does
// NOT contain the filler marker, so hasSummary/hasFiller stay independent.
// >=50 chars: the kernel rejects fold summaries shorter than that
// ("Summary too short ... The summary must capture the compressed range's
// key information").
const SUMMARY_MARK = "e2e fold: persona scripted compress round over the grain-ledger filler turn";
const FILLER_MARK = "GRAIN-LEDGER-UNIT-7X";

function startFakeUpstream(reqLog: string): Promise<http.Server> {
    let n = 0;
    const refsOf = (s: string): string[] => [...s.matchAll(/\x3cacp\s[^>]*?\x3e(m\d{5})\x3c\/acp\x3e/g)].map((x) => x[1]);
    const server = http.createServer((req, res) => {
        const pathOnly = (req.url ?? "/").split("?")[0];
        if (req.method === "GET" && pathOnly.endsWith("/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", data: [
                { id: "fake-a", object: "model" },
                { id: "fake-b", object: "model" },
                { id: "fake-ant-a", object: "model" },
            ] }));
            return;
        }
        if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
            let raw = "";
            req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
            req.on("end", () => {
                try {
                    const body = JSON.parse(raw) as { messages?: FakeMessage[]; model?: string; stream?: boolean };
                    const messages = body.messages ?? [];
                    const sysMsg = messages.find((m) => m?.role === "system");
                    const sysText = typeof sysMsg?.content === "string" ? sysMsg.content
                        : Array.isArray(sysMsg?.content) ? sysMsg.content.map((p) => (p as { text?: string })?.text ?? "").join("")
                        : "";
                    const flat = (m: FakeMessage): string => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                    const isChainCarrier = (txt: string): boolean => /^\s*\x3cbili-chain\s[\s\S]*\/\x3e\s*$/.test(txt);
                    const users = messages.filter((m) => m?.role === "user");
                    const realUserTexts = users.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).filter((txt) => !isChainCarrier(txt));
                    const lastUserText = realUserTexts.length > 0 ? realUserTexts[realUserTexts.length - 1] : "";
                    const wantsCompress = realUserTexts.some((txt) => /请调用compress/.test(txt));
                    // "a compress result is already in history" — a plain bash
                    // tool_result must NOT suppress a later scripted compress.
                    const toolNames = new Map<string, string>(messages.flatMap((m) => (m?.tool_calls ?? []).map((tc) => [tc.id as string, tc.function?.name as string])));
                    const hasCompressResult = messages.some((m) => m?.role === "tool" && toolNames.get(m.tool_call_id as string) === "compress");
                    const compressToolCall = (): { id: string; type: "function"; function: { name: string; arguments: string } } => {
                        // Refs must come from the NON-SYSTEM messages only —
                        // the kernel system prompt embeds example acp tags whose
                        // refs are unknown to the session (compress would fail
                        // with "every ref is unknown to this session").
                        const refs = refsOf(JSON.stringify(messages.filter((m) => m?.role !== "system")));
                        return { id: `call_${n}`, type: "function", function: { name: "compress", arguments: JSON.stringify(refs.length === 0 ? {} : { content: [{ startId: refs[0], endId: refs[0], summary: SUMMARY_MARK }] }) } };
                    };

                    let content = `ok-${++n}`;
                    let toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] | undefined;
                    let compressCalled = false;
                    if (/^REVIEW_POLICY/.test(sysText)) {
                        content = `{"risk":"low","decision":"allow"}`;
                    } else if (/Create a concise title/i.test(sysText)) {
                        content = "Workspace Setup";
                    } else if (wantsCompress && !hasCompressResult) {
                        toolCalls = [compressToolCall()];
                        compressCalled = true;
                    } else if (messages.some((m) => m?.role === "tool")) {
                        content = "done: the output was ZX7-back";
                    } else if (messages.some((m) => m?.role === "user" && /codeword|run the command/i.test(flat(m)))) {
                        toolCalls = [{ id: `call_${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo ZX7-back" }) } }];
                    }
                    const emitRow = (fields: Record<string, unknown>): void => {
                        try { fs.appendFileSync(reqLog, JSON.stringify(fields) + "\n"); } catch { /* best-effort */ }
                    };
                    emitRow({
                        conv: req.headers["x-bili-plugin-conversation"] ?? null,
                        plugin: req.headers["x-bili-plugin"] ?? null,
                        model: body.model ?? null,
                        wire: "openai",
                        nmsgs: messages.length,
                        sysLen: sysText.length,
                        sysHead: sysText.slice(0, 80),
                        hasToolResult: messages.some((m) => m?.role === "tool"),
                        tagCount: refsOf(raw).length,
                        hasSummary: raw.includes(SUMMARY_MARK),
                        hasFiller: raw.includes(FILLER_MARK),
                        compressCalled: compressCalled || (toolCalls?.some((tc) => tc.function.name === "compress") ?? false),
                    });

                    const id = `chatcmpl-${n}`;
                    const model = body.model ?? "fake-a";
                    const finish = toolCalls ? "tool_calls" : "stop";
                    const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
                    if (body.stream) {
                        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                        if (toolCalls) {
                            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) }, finish_reason: null }] })}\n\n`);
                        } else {
                            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
                            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
                        }
                        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    } else {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({
                            id, object: "chat.completion", model,
                            choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
                            usage,
                        }));
                    }
                } catch (e) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: String(e) } }));
                }
            });
            return;
        }
        if (req.method === "POST" && pathOnly.endsWith("/count_tokens")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ input_tokens: 100 }));
            return;
        }
        if (req.method === "POST" && pathOnly.endsWith("/messages")) {
            // anthropic-messages wire (#2791): same logical conversation,
            // structurally different render (top-level system, content
            // blocks, tool_use objects, tool_result inside user turns).
            // Reply selection mirrors the openai lane; rows carry the same
            // fold-oracle fields plus wire: "anthropic".
            let raw = "";
            req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
            req.on("end", () => {
                try {
                    const body = JSON.parse(raw) as { model?: string; system?: string | { text?: string }[]; messages?: { role?: string; content?: unknown }[]; stream?: boolean };
                    const sysText = typeof body.system === "string" ? body.system
                        : Array.isArray(body.system) ? body.system.map((p) => p?.text ?? "").join("")
                        : "";
                    const blocksOf = (m: { content?: unknown }): { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }[] =>
                        Array.isArray(m.content) ? m.content as { type?: string; text?: string }[]
                            : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
                    const messages = body.messages ?? [];
                    const isChainCarrierA = (txt: string): boolean => /^\s*\x3cbili-chain\s[\s\S]*\/\x3e\s*$/.test(txt);
                    const userTexts = messages.filter((m) => m?.role === "user").map((m) => blocksOf(m).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")).filter((txt) => !isChainCarrierA(txt));
                    const lastUserText = userTexts.length > 0 ? userTexts[userTexts.length - 1] : "";
                    const hasToolResult = messages.some((m) => blocksOf(m).some((b) => b?.type === "tool_result"));
                    const wantsCompress = /请调用compress/.test(lastUserText);

                    let content = `ok-${++n}`;
                    let toolUse: { id: string; name: string; input: Record<string, unknown> } | undefined;
                    if (/Create a concise title/i.test(sysText)) {
                        content = "Workspace Setup";
                    } else if (wantsCompress && !hasToolResult) {
                        const refs = refsOf(JSON.stringify(messages.filter((m) => m?.role !== "system")));
                        toolUse = { id: `toolu_${n}`, name: "compress", input: refs.length === 0 ? {} : { content: [{ startId: refs[0], endId: refs[0], summary: SUMMARY_MARK }] } };
                    } else if (hasToolResult) {
                        content = "done: the output was ZX7-back";
                    }
                    try {
                        fs.appendFileSync(reqLog, JSON.stringify({
                            conv: req.headers["x-bili-plugin-conversation"] ?? null,
                            plugin: req.headers["x-bili-plugin"] ?? null,
                            model: body.model ?? null,
                            wire: "anthropic",
                            nmsgs: messages.length,
                            sysLen: sysText.length,
                            sysHead: sysText.slice(0, 80),
                            hasToolResult,
                            tagCount: refsOf(raw).length,
                            hasSummary: raw.includes(SUMMARY_MARK),
                            hasFiller: raw.includes(FILLER_MARK),
                            compressCalled: toolUse?.name === "compress",
                        }) + "\n");
                    } catch { /* best-effort */ }

                    const model = body.model ?? "fake-ant-a";
                    const usage = { input_tokens: 100, output_tokens: 5 };
                    if (body.stream) {
                        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                        const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                        ev("message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model, usage: { input_tokens: 100, output_tokens: 1 } } });
                        ev("content_block_start", { type: "content_block_start", index: 0, content_block: toolUse ? { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} } : { type: "text", text: "" } });
                        if (toolUse) {
                            ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) } });
                        } else {
                            ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } });
                        }
                        ev("content_block_stop", { type: "content_block_stop", index: 0 });
                        ev("message_delta", { type: "message_delta", delta: { stop_reason: toolUse ? "tool_use" : "end_turn" }, usage });
                        ev("message_stop", { type: "message_stop" });
                        res.end();
                    } else {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({
                            id: `msg_${n}`, type: "message", role: "assistant", model,
                            content: toolUse ? [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }] : [{ type: "text", text: content }],
                            stop_reason: toolUse ? "tool_use" : "end_turn",
                            usage,
                        }));
                    }
                } catch (e) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: String(e) } }));
                }
            });
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        if (req.method === "POST") console.error(`[persona-fake] 404 ${req.method} ${req.url}`);
        res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    return new Promise((resolve) => server.listen(FAKE_PORT, "127.0.0.1", () => resolve(server)));
}

interface Oracle { conv: string | null; plugin: string | null; model: string | null; wire?: "openai" | "anthropic"; nmsgs: number; sysLen: number; sysHead: string; hasToolResult: boolean; tagCount?: number; hasSummary?: boolean; hasFiller?: boolean; compressCalled?: boolean }

function readOracle(reqLog: string): Oracle[] {
    if (!fs.existsSync(reqLog)) return [];
    return fs.readFileSync(reqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Oracle);
}

interface Rig {
    env: NodeJS.ProcessEnv;
    cwd: string;
    reqLog: string;
    outDir: string;
    setDefaultModel: (provider: string, model: string, withAutoReview: boolean) => void;
    stopAndFlush: () => Promise<void>;
    persistedSessions: () => { state: string; data: string };
    cleanup: () => void;
}

function buildRig(tag: string, withAutoReview: boolean): Rig {
    const outDir = path.join(REPO_ROOT, "tmp", `e2e-dsh-persona-${tag}-${process.pid}`);
    fs.mkdirSync(outDir, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-dsh-persona-${tag}-`));
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const dshHome = path.join(root, "dsh");
    const xdg = { config: path.join(root, "config"), cache: path.join(root, "cache"), state: path.join(root, "state"), data: path.join(root, "data") };
    const cwd = path.join(root, "cwd");
    for (const d of [home, tmp, dshHome, cwd, ...Object.values(xdg)]) fs.mkdirSync(d, { recursive: true });
    const reqLog = path.join(outDir, "oracle.jsonl");

    const profileDir = path.join(dshHome, "profiles", "headless");
    const pkgDir = path.join(profileDir, "node_modules", "billion-context");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(pkgDir, "package.json"));
    fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(pkgDir, "dist"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "dsh.bundle.patch.yml"), path.join(pkgDir, "dsh.bundle.patch.yml"));
    const biliVersion = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
        name: `e2e-dsh-persona-${tag}`,
        private: true,
        dependencies: { "billion-context": biliVersion },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"], patchReload: "startup" } },
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n");
    fs.writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    // Two models; flipping the default between turns makes dsh recompose its
    // main system — the exact #2241 trigger. Model B also carries a different
    // context window so the two system texts are guaranteed apart.
    // fake-ant speaks the anthropic-messages wire against the same fake
    // upstream — the #2791 cross-protocol switch lane.
    const patchYml = (provider: string, model: string, autoReview: boolean): string => [
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        "      fake:",
        "        displayName: Fake Upstream",
        "        apiKeyEnv: E2E_FAKE_KEY",
        "        api: openai-completions",
        `        baseURL: http://127.0.0.1:${FAKE_PORT}/v1`,
        "        models:",
        "          - id: fake-a",
        "            name: Model Alpha",
        "            contextWindow: 60000",
        "            maxTokens: 4096",
        "          - id: fake-b",
        "            name: Model Beta",
        "            contextWindow: 32000",
        "            maxTokens: 4096",
        "      fake-ant:",
        "        displayName: Fake Anthropic Upstream",
        "        apiKeyEnv: E2E_FAKE_KEY",
        "        api: anthropic-messages",
        `        baseURL: http://127.0.0.1:${FAKE_PORT}`,
        "        models:",
        "          - id: fake-ant-a",
        "            name: Model Ant Alpha",
        "            contextWindow: 60000",
        "            maxTokens: 4096",
        "- id: agent-default-model",
        "  config:",
        `    provider: ${provider}`,
        `    model: ${model}`,
        ...(autoReview ? ["- id: auto-review"] : []),
        "",
    ].join("\n");
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), patchYml("fake", "fake-a", withAutoReview));
    fs.mkdirSync(path.join(xdg.config, "billion-context"), { recursive: true });
    // preserveRecentTokens + preserveRecentMessages = 0 — mirrors what
    // preflight relaxes under overflow (#330): the rig's scripted turns are
    // short, so the kernel's default protected zone (last 5 messages + most
    // recent user message) would otherwise pin EVERY ref and the scripted
    // compress could never fold ("Range is entirely within the protected
    // zone"). Zeroing them is established product behavior, not a hack.
    fs.writeFileSync(path.join(xdg.config, "billion-context", "billion-context.json"),
        JSON.stringify({ providers: {}, compress: { preserveRecentTokens: 0, preserveRecentMessages: 0 } }, null, 2) + "\n");

    const env: NodeJS.ProcessEnv = {
        ...cleanEnv(),
        HOME: home,
        TMPDIR: tmp,
        DSH_HOME: dshHome,
        XDG_CONFIG_HOME: xdg.config,
        XDG_CACHE_HOME: xdg.cache,
        XDG_STATE_HOME: xdg.state,
        XDG_DATA_HOME: xdg.data,
        E2E_FAKE_KEY: "e2e-fake-key",
        DSH_TELEMETRY_MODE: "DISABLED",
        LANG: "C.UTF-8",
        // #1158/#1187 coexistence: a dead proxy policy must not leak in; the
        // loopback NO_PROXY keeps fixture traffic direct.
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "127.0.0.1,localhost",
    };

    const stopAndFlush = async (): Promise<void> => {
        const instancesDir = path.join(xdg.state, "billion-context", "instances");
        try {
            for (const f of fs.readdirSync(instancesDir)) {
                try {
                    const rec = JSON.parse(fs.readFileSync(path.join(instancesDir, f), "utf8")) as { pid?: number };
                    if (typeof rec.pid === "number" && rec.pid > 0) { try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ } }
                } catch { /* unreadable record */ }
            }
        } catch { /* no instances dir */ }
        await new Promise((r) => setTimeout(r, 1500));
    };

    const readDir = (sessionsRoot: string): { id: string; requests: number | null; refs: number; blocks: number }[] => {
        const found: { id: string; requests: number | null; refs: number; blocks: number }[] = [];
        if (!fs.existsSync(sessionsRoot)) return found;
        const walk = (d: string): void => {
            for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, f.name);
                if (f.isDirectory()) walk(p);
                else if (f.name.endsWith(".json")) {
                    try {
                        const j = JSON.parse(fs.readFileSync(p, "utf8")) as { payload?: { id?: string; stats?: { requests?: number }; state?: { messageRefs?: { byRaw?: Record<string, unknown> }; blocks?: Record<string, unknown> } } };
                        const inner = j.payload;
                        // Skip (don't abort the walk on) non-envelope .json
                        // sidecars — e.g. index.db.chk — so one stray file can't
                        // blind the whole directory scan.
                        if (inner?.id) {
                            found.push({
                                id: String(inner.id),
                                requests: inner.stats?.requests ?? null,
                                refs: Object.keys(inner.state?.messageRefs?.byRaw ?? {}).length,
                                blocks: Object.keys(inner.state?.blocks ?? {}).length,
                            });
                        }
                    } catch { /* skip unreadable */ }
                }
            }
        };
        walk(sessionsRoot);
        return found;
    };

    return {
        env, cwd, reqLog, outDir,
        setDefaultModel: (provider, model, autoReview) => fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), patchYml(provider, model, autoReview)),
        stopAndFlush,
        persistedSessions: () => ({
            state: JSON.stringify(readDir(path.join(xdg.state, "billion-context", "sessions"))),
            data: JSON.stringify(readDir(path.join(xdg.data, "billion-context", "sessions"))),
        }),
        cleanup: () => { if (process.env.E2E_KEEP_ARTIFACTS === "1") return; try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ } },
    };
}

function dshRun(rig: Rig, args: string[], tag: string): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
        const child = spawn(DSH_BIN, ["--profile", "headless", ...args], { cwd: rig.cwd, env: rig.env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => { out += c.toString("utf8"); });
        child.stderr.on("data", (c) => { err += c.toString("utf8"); });
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, TMO);
        child.on("close", (code) => {
            clearTimeout(timer);
            try {
                fs.writeFileSync(path.join(rig.outDir, `persona-2241.${tag}.out`), out);
                fs.writeFileSync(path.join(rig.outDir, `persona-2241.${tag}.err`), err);
            } catch { /* artifacts best-effort */ }
            resolve({ code: code ?? -1, out, err });
        });
    });
}

function sessionIdOf(out: string): string | undefined {
    for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
            const ev = JSON.parse(line) as { type?: string; sessionId?: string };
            if (ev.type === "session" && typeof ev.sessionId === "string") return ev.sessionId;
        } catch { /* skip partial */ }
    }
    return undefined;
}

interface Session { id: string; requests: number | null; refs: number; blocks: number }

function allSessions(rig: Rig): Session[] {
    return [...JSON.parse(rig.persistedSessions().state) as Session[], ...JSON.parse(rig.persistedSessions().data) as Session[]];
}

const gated = { skip: (!GATE || !dshAvailable()) ? "set ACP_TEST_E2E_DSH_NATIVE=1 with a real dsh >= 0.2.0-rc.2" : false };

test("real dsh #2241 A: a mid-session model switch keeps the raw conversation key (no |sub: fork; title side lane harmless)", gated, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "agent", "dsh-native.js")), "npm run build first — the profile loads dist/agent/dsh-native.js");
    const rig = buildRig("switch", false);
    const fake = await startFakeUpstream(rig.reqLog);
    t.after(() => { fake.close(); rig.cleanup(); });
    try {
        // ---- turn 1: model A claims the raw key (title side request fires too) ----
        const r1 = await dshRun(rig, ["--json", "We are setting up a workspace. Remember the codeword ZX7. Then reply with exactly: setup done."], "A-t1");
        assert.equal(r1.code, 0, `turn 1 dsh exit (${r1.err.slice(-300)})`);
        const sessionId = sessionIdOf(r1.out);
        assert.ok(sessionId, "turn 1 --json events expose the dsh session id");

        // ---- the model switch: same dsh session, recomposed main system ----
        rig.setDefaultModel("fake", "fake-b", false);
        const r2 = await dshRun(rig, ["--session-id", sessionId, "--json", "What was the codeword? Answer with the word only."], "A-t2");
        assert.equal(r2.code, 0, `turn 2 dsh exit (${r2.err.slice(-300)})`);

        // ---- oracle: one conversation, a real model switch, history grew ----
        const oracle = readOracle(rig.reqLog);
        const convs = new Set(oracle.map((o) => o.conv).filter(Boolean));
        assert.equal(convs.size, 1, "both turns stamped ONE conversation id");
        const conv = [...convs][0] as string;
        const turn1 = oracle.filter((o) => o.model === "fake-a");
        const turn2 = oracle.filter((o) => o.model === "fake-b");
        assert.ok(turn1.length >= 1, "turn 1 rode model fake-a");
        assert.ok(turn2.length >= 1, "turn 2 rode model fake-b — the switch reached the wire");
        assert.ok(Math.max(...turn2.map((o) => o.nmsgs)) > Math.max(...turn1.map((o) => o.nmsgs)), "turn 2 continues the SAME history (more messages on the wire)");
        // The title side request rides the same conversation id and must stay
        // harmless — never claims the raw key, never persists its own |sub:.
        assert.ok(oracle.some((o) => /Create a concise title/i.test(o.sysHead)), "dsh fired its title-generation side request under the same conversation id");

        // ---- acceptance: ONE session under the RAW key, no |sub: sibling ----
        await rig.stopAndFlush();
        const sessions = allSessions(rig).filter((s) => s.id === conv || s.id.startsWith(`${conv}|sub:`));
        const main = sessions.find((s) => s.id === conv);
        const forks = sessions.filter((s) => s.id.startsWith(`${conv}|sub:`));
        assert.equal(forks.length, 0, `#2241: the model switch must NOT fork the main lane (found ${forks.map((f) => f.id).join(", ")})`);
        assert.ok(main, "the raw conversation key persisted a session");
        assert.ok((main?.requests ?? 0) >= 2, `both turns rode the raw key (requests=${main?.requests})`);
        assert.ok((main?.refs ?? 0) >= 4, `refs accumulated across the switch (refs=${main?.refs})`);
    } finally {
        // keep artifacts on failure for the CI upload step
        if (t instanceof Error) { /* unreachable — t.after handles cleanup */ }
    }
});

test("real dsh #2791 C: a mid-session PROTOCOL switch (openai -> anthropic) keeps the session, conv, and fold", gated, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "agent", "dsh-native.js")), "npm run build first — the profile loads dist/agent/dsh-native.js");
    const rig = buildRig("xwire", false);
    const fake = await startFakeUpstream(rig.reqLog);
    t.after(() => { fake.close(); rig.cleanup(); });

    // ---- turn 1 (openai wire): bulky tagged ledger + one bash round ----
    // The bash round matters: with only the filler + dsh's operational notice
    // visible, EVERY ref sits inside the kernel's protected zone (last 5
    // messages + most recent user message) and the scripted compress would
    // fail with "Range is entirely within the protected zone". The bash
    // call/result pushes the filler far enough back to be foldable.
    const fillerBody = `${FILLER_MARK} grain ledger audit. ${"the grain transport network continued without measurable incident. ".repeat(500)}`;
    const r1 = await dshRun(rig, ["--json", `${fillerBody}\nFirst run the command to sample the ledger.`], "C-t1");
    assert.equal(r1.code, 0, `turn 1 dsh exit (${r1.err.slice(-300)})`);
    const sessionId = sessionIdOf(r1.out);
    assert.ok(sessionId, "turn 1 --json events expose the dsh session id");

    // ---- turn 2 (openai wire, same session): the scripted fold ----
    const r2 = await dshRun(rig, ["--session-id", sessionId, "--json", "The grain ledger above is bulky. 请调用compress to fold it, then reply: folded done."], "C-t2");
    assert.equal(r2.code, 0, `turn 2 dsh exit (${r2.err.slice(-300)})`);

    // ---- the PROTOCOL switch: same dsh session, anthropic-messages wire ----
    rig.setDefaultModel("fake-ant", "fake-ant-a", false);
    const r3 = await dshRun(rig, ["--session-id", sessionId, "--json", "The ledger was folded earlier. Reply with exactly: carried on."], "C-t3");
    assert.equal(r3.code, 0, `turn 3 dsh exit (${r3.err.slice(-2200)})`);

    // ---- oracle: one conversation across BOTH wires ----
    const oracle = readOracle(rig.reqLog);
    const convs = new Set(oracle.map((o) => o.conv).filter(Boolean));
    assert.equal(convs.size, 1, "requests across both wires stamped ONE conversation id");
    const conv = [...convs][0] as string;
    const openaiRows = oracle.filter((o) => o.wire !== "anthropic");
    const anthropicRows = oracle.filter((o) => o.wire === "anthropic");
    assert.ok(openaiRows.length >= 1, "turn 1 rode the openai wire");
    assert.ok(anthropicRows.length >= 1, `turn 2 rode the anthropic wire (got ${anthropicRows.length}/${oracle.length} rows)`);
    for (const o of anthropicRows) {
        assert.equal(o.model, "fake-ant-a", `anthropic-lane row must carry the switched model (got ${o.model})`);
        assert.equal(o.plugin, "dsh", "anthropic-lane row must stay plugin-stamped (x-bili-plugin)");
    }
    // Turn 3 inherited the conversation (a fork would arrive nearly empty).
    const firstAnth = anthropicRows.find((o) => o.nmsgs > 1);
    assert.ok(firstAnth && firstAnth.nmsgs >= 6, `first anthropic main request must inherit history (nmsgs=${firstAnth?.nmsgs})`);

    // Exactly ONE model-emitted compress across the whole scenario — a forked
    // anonymous session would re-fold from scratch on the switched wire
    // (#2791's silent symptom).
    const compressCalls = oracle.filter((o) => o.compressCalled === true);
    assert.equal(compressCalls.length, 1, `compress must be CALLED exactly once across the protocol switch (got ${compressCalls.length})`);

    // ---- acceptance: ONE session under the raw key, fold blocks on it ----
    await rig.stopAndFlush();
    const sessions = allSessions(rig).filter((s) => s.id === conv || s.id.startsWith(`${conv}|sub:`));
    const main = sessions.find((s) => s.id === conv);
    const forks = sessions.filter((s) => s.id.startsWith(`${conv}|sub:`));
    assert.equal(forks.length, 0, `#2791: the protocol switch must NOT fork the main lane (found ${forks.map((f) => f.id).join(", ")})`);
    assert.ok(main, "the raw conversation key persisted a session");
    assert.ok((main?.requests ?? 0) >= 2, `both turns rode the raw key (requests=${main?.requests})`);
    assert.ok((main?.blocks ?? 0) >= 1, `the fold survived the protocol switch (blocks=${main?.blocks})`);
});

// Scenario B is written and kept ready, but real-client auto-review cannot
// arm in headless TODAY (verified against dsh 0.2.0-rc.2 sources):
//   - the review gate is `permissionPresets.current(agent.session) !== "auto"
//     -> pass through` (dsh-experimental-auto-review apply());
//   - a headless session carries NO preset: agents.create({meta:{cwd}}) only
//     (dsh-headless run()), so the initial permission falls back to the
//     permission plugin's inferred default (workspace-write);
//   - the only Auto entry points are the web composer / "/permission auto"
//     (README.zh.md: "通用设置与未来会话默认值不提供 Auto"), the registry's
//     selectedDefault is deliberately not settable for Auto, and neither the
//     plugin nor dsh-permission-presets reads any process.env override;
//   - the profile settings.yaml legacy-import path does not settle within a
//     one-shot run (the document is never consumed/renamed).
// Until dsh exposes a headless surface (or adopts an event log we can seed
// through supported means), the review passthrough shape (#4438 superseded
// the #2241-era fork) is pinned by the harness e2e in
// tests/dsh-persona-continuity.test.ts (review e2e, both wires) and
// tests/issue4438-dsh-review-lane-isolation.test.ts.
// Flip this gate when that changes.
const gatedB = {
    skip: (!GATE || !dshAvailable())
        ? "set ACP_TEST_E2E_DSH_NATIVE=1 with a real dsh >= 0.2.0-rc.2"
        : process.env.ACP_TEST_E2E_DSH_AUTO_REVIEW === "1"
            ? false
            : "blocked: dsh 0.2.0-rc.2 exposes no headless surface to arm the Auto permission preset (web-UI /permission auto only) — set ACP_TEST_E2E_DSH_AUTO_REVIEW=1 to attempt anyway",
};

test("real dsh #2241/#4438 B: auto-review rides the stateless passthrough while the main lane keeps the raw key", gatedB, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "agent", "dsh-native.js")), "npm run build first — the profile loads dist/agent/dsh-native.js");
    const rig = buildRig("review", true);
    const fake = await startFakeUpstream(rig.reqLog);
    t.after(() => { fake.close(); rig.cleanup(); });

    // ---- one task that runs a bash tool call -> auto-review fires ----
    const r1 = await dshRun(rig, ["--json", "Run the command: echo ZX7-back, then report its output."], "B-t1");
    assert.equal(r1.code, 0, `task dsh exit (${r1.err.slice(-300)})`);

    const oracle = readOracle(rig.reqLog);
    const convs = new Set(oracle.map((o) => o.conv).filter(Boolean));
    assert.equal(convs.size, 1, "all requests stamped ONE conversation id");
    const conv = [...convs][0] as string;
    const reviews = oracle.filter((o) => /^REVIEW_POLICY/.test(o.sysHead));
    assert.ok(reviews.length >= 1, `the auto-review reviewer request reached the wire (${reviews.length})`);
    assert.equal(reviews[0]?.nmsgs, 1, "the review request carries ONE flattened-transcript user message (#1916 shape)");
    const mainTurns = oracle.filter((o) => !/^REVIEW_POLICY/.test(o.sysHead) && !/Create a concise title/i.test(o.sysHead) && o.nmsgs > 1);
    assert.ok(mainTurns.length >= 2, `the main agent loop ran its rounds (rounds=${mainTurns.length})`);
    assert.ok(oracle.some((o) => o.hasToolResult), "the tool result round-tripped (reviewer allowed the call)");

    // ---- acceptance: review minted nothing (#4438 stateless passthrough),
    // main stayed raw ----
    await rig.stopAndFlush();
    const sessions = allSessions(rig).filter((s) => s.id === conv || s.id.startsWith(`${conv}|sub:`));
    const main = sessions.find((s) => s.id === conv);
    const forks = sessions.filter((s) => s.id.startsWith(`${conv}|sub:`));
    assert.ok(main, "the main lane persisted under the RAW conversation key");
    assert.ok((main?.requests ?? 0) >= 2, `main rounds rode the raw key (requests=${main?.requests})`);
    assert.ok((main?.refs ?? 0) >= 3, `main refs never reset (refs=${main?.refs})`);
    assert.equal(forks.length, 0, `#4438: the review request rides the stateless passthrough — no |sub: session minted (forks=${JSON.stringify(forks.map((f) => f.id.slice(-12)))})`);
});
