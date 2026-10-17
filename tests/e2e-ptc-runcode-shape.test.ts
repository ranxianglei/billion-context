import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

// #3617-F: the PTC shape end-to-end. PTC presets collapse EVERY tool into a
// single `run_code` omnibus, so a live PTC session's requests declare exactly
// one tool. Drive that exact shape through all four wire prepare chains and
// pin what the reachability gate must NOT do:
//   1. surface alive — the standing compress prompt and the armed nudge are
//      still injected (the #3600 regression read this shape as unreachable
//      and suppressed both all the way to the 100% window);
//   2. host tool table intact — in plugin mode the declared `run_code`
//      survives the outbound body exactly as sent (one entry, right name):
//      the gate must not strip it, and bili must not append its own tools to
//      a plugin-owned table;
//   3. proxy-mode control — bili DOES inject there, and the merge keeps
//      non-bili-owned names (#920): the client's `run_code` survives next to
//      bili's `compress` tool, so PTC-shaped input cannot starve the
//      injection either.
// Hermetic: per-wire fake upstream, no real model.

process.env.NODE_ENV = "test";

const root = mkdtempSync(join(tmpdir(), "bili-ptc-shape-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

type Wire = "anthropic" | "openai" | "responses" | "google";
type Mode = "plugin" | "proxy";

const STANDING_MARKER = "acp_status";

function wireTools(wire: Wire): unknown {
    if (wire === "openai") return [{ type: "function", function: { name: "run_code", description: "d", parameters: { type: "object", properties: {} } } }];
    if (wire === "google") return [{ functionDeclarations: [{ name: "run_code", description: "d", parameters: { type: "object", properties: {} } }] }];
    return [{ name: "run_code", description: "d", input_schema: { type: "object", properties: {} } }]; // anthropic + responses
}

// Same arming recipe as lane-decisions-matrix.test.ts: long compressible text
// outside the preserve zone + filler past preserveRecentMessages/Tokens.
function historyTexts(): string[] {
    const out: string[] = ["hello", "ok", "continue", "y".repeat(20_000)];
    for (let i = 1; i <= 12; i++) {
        out.push(`q${i} ` + "f".repeat(997));
        out.push(`a${i} ` + "e".repeat(997));
    }
    out.push("now summarize");
    return out;
}

async function harness(wire: Wire, mode: Mode) {
    // listen(0) retry: Windows runners occasionally land in an OS-reserved
    // range and emit "error" instead of "listening" (#3490 class).
    const listenWithRetry = async (server: http.Server) => {
        for (let attempt = 1; ; attempt++) {
            try {
                server.listen(0, "127.0.0.1");
                await once(server, "listening");
                return;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (attempt >= 5 || (code !== "EACCES" && code !== "EADDRINUSE")) throw err;
                await new Promise((r) => setTimeout(r, 25 * attempt));
            }
        }
    };
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    _setForTest({});
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            // Teach 50k input tokens against the 64k declared window (78%) so
            // the second turn arms the nudge deterministically.
            const bodies = {
                anthropic: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 50_000, output_tokens: 10 } },
                openai: { id: "chat_fixture", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 50_000, completion_tokens: 10 } },
                responses: { id: "resp_fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 50_000, output_tokens: 10 } },
                google: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50_000, candidatesTokenCount: 10 } },
            };
            res.end(JSON.stringify(bodies[wire]));
        });
    });
    await listenWithRetry(upstream);
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;

    const buildBody = (texts: string[]) => {
        const roles = texts.map((_, i) => (i % 2 === 0 ? "user" : "assistant"));
        if (wire === "google") {
            return {
                contents: texts.map((text, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text }] })),
                tools: wireTools("google"),
                generationConfig: { maxOutputTokens: 1024 },
            };
        }
        if (wire === "responses") {
            return {
                model: "model-test",
                input: texts.map((text, i) => ({ role: roles[i], content: [{ type: i % 2 === 0 ? "input_text" : "output_text", text }] })),
                tools: wireTools("responses"),
                max_output_tokens: 1024, stream: false,
            };
        }
        return {
            model: "model-test",
            messages: texts.map((text, i) => ({ role: roles[i], content: text })),
            tools: wireTools(wire),
            max_tokens: 64_000, stream: false,
        };
    };
    const endpoint = wire === "anthropic" ? "/v1/messages" : wire === "openai" ? "/v1/chat/completions" : wire === "responses" ? "/v1/responses" : "/v1beta/models/model-test:generateContent";
    const send = async (texts: string[]) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": `ptc-${mode}-${wire}`, ...(mode === "plugin" ? { "x-bili-plugin": "dsh" } : {}) },
            body: JSON.stringify(buildBody(texts)),
        });
        const bodyText = await r.text();
        assert.equal(r.status, 200, bodyText);
    };
    const close = async () => {
        store.cancelAll();
        proxy.close(); proxy.closeIdleConnections?.(); proxy.closeAllConnections?.();
        upstream.close(); upstream.closeIdleConnections?.(); upstream.closeAllConnections?.();
        await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    };
    return { send, forwarded, close };
}

// Per-wire tool-name extraction from an OUTBOUND (forwarded) body: flat
// `name` (anthropic/responses), nested `function.name` (openai), one level
// deeper `functionDeclarations[].name` (google).
function outboundToolNames(wire: Wire, body: Record<string, unknown>): string[] {
    const tools = body["tools"];
    if (!Array.isArray(tools)) return [];
    if (wire === "openai") return (tools as { function?: { name?: string } }[]).map((t) => t.function?.name ?? "");
    if (wire === "google") return (tools as { functionDeclarations?: { name?: string }[] }[]).flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name ?? ""));
    return (tools as { name?: string }[]).map((t) => t.name ?? "");
}

interface ShapeOutcome {
    nudge: boolean;
    standingPrompt: boolean;
}

// Nudge = appended trailing USER message with long guidance (the client's own
// last turn is the short "now summarize"); standing prompt = leading
// system/instructions/systemInstruction carrying the full compress prompt
// (marker absent from the tags-only fallback). Same detection as the matrix.
function outcome(wire: Wire, body: Record<string, unknown>): ShapeOutcome {
    if (wire === "openai" || wire === "anthropic") {
        const msgs = (body["messages"] ?? []) as { role?: string; content?: unknown }[];
        const last = msgs[msgs.length - 1];
        const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        const nudge = last?.role === "user" && lastText.length > 200;
        let sys = "";
        if (wire === "openai") {
            const first = msgs[0] as { role?: string; content?: unknown } | undefined;
            sys = first?.role === "system" ? String(first.content ?? "") : "";
        } else {
            const s = body["system"];
            sys = typeof s === "string" ? s : JSON.stringify(s ?? "");
        }
        return { nudge, standingPrompt: sys.includes(STANDING_MARKER) };
    }
    if (wire === "responses") {
        const items = (body["input"] ?? []) as { role?: string; content?: unknown }[];
        const last = items[items.length - 1];
        const lastText = JSON.stringify(last?.content ?? "");
        const nudge = last?.role === "user" && lastText.length > 200;
        let instr = "";
        const raw = body["instructions"];
        if (typeof raw === "string") instr = raw;
        else if (Array.isArray(raw)) instr = raw.map(String).join("\n");
        const devItem = items.find((it) => (it as { type?: string }).type === "developer" || it.role === "developer" || it.role === "system");
        const devText = devItem ? JSON.stringify(devItem.content ?? "") : "";
        return { nudge, standingPrompt: instr.includes(STANDING_MARKER) || devText.includes(STANDING_MARKER) };
    }
    const contents = (body["contents"] ?? []) as { role?: string; parts?: { text?: string }[] }[];
    const last = contents[contents.length - 1];
    const nudge = last?.role === "user" && (last.parts?.map((p) => p.text ?? "").join("").length ?? 0) > 200;
    const si = body["systemInstruction"];
    const sys = typeof si === "string" ? si : JSON.stringify(si ?? "");
    return { nudge, standingPrompt: sys.includes(STANDING_MARKER) };
}

for (const wire of ["anthropic", "openai", "responses", "google"] as const) {
    test(`PTC shape [${wire}] plugin mode: run_code-only request keeps the surface alive and the host tool table intact (#3617-F)`, { timeout: 60_000 }, async () => {
        const h = await harness(wire, "plugin");
        try {
            await h.send(["hello"]);
            await h.send(historyTexts());
            assert.equal(h.forwarded.length, 2, "both turns forwarded");
            const body = h.forwarded[1]!;
            // Plugin mode owns nothing: the outbound table is EXACTLY the
            // host's — one run_code, nothing stripped by the gate, nothing
            // appended by bili.
            assert.deepEqual(outboundToolNames(wire, body), ["run_code"], "host tool table must pass through untouched in plugin mode");
            const got = outcome(wire, body);
            assert.deepEqual(got, { nudge: true, standingPrompt: true }, "surface must stay alive on the PTC shape (#3600)");
        } finally {
            await h.close();
        }
    });
    test(`PTC shape [${wire}] proxy control: run_code survives the merge and bili still injects its compress tool (#3617-F)`, { timeout: 60_000 }, async () => {
        const h = await harness(wire, "proxy");
        try {
            await h.send(["hello"]);
            await h.send(historyTexts());
            assert.equal(h.forwarded.length, 2, "both turns forwarded");
            const body = h.forwarded[1]!;
            const names = outboundToolNames(wire, body);
            // mergeOwnedTools drops only bili-OWNED names from the client
            // table (#920): the PTC declaration survives next to bili's own
            // injection — a gate regression that kills the injection would
            // drop `compress`, one that strips client tools would drop
            // `run_code`; both make this red.
            assert.ok(names.includes("run_code"), `client run_code lost in the merge: ${JSON.stringify(names)}`);
            assert.ok(names.includes("compress"), `bili compress tool not injected: ${JSON.stringify(names)}`);
            const got = outcome(wire, body);
            assert.deepEqual(got, { nudge: true, standingPrompt: true }, "proxy-mode surface is structural-on");
        } finally {
            await h.close();
        }
    });
}
