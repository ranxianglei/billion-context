// Nudge debug surface (gated by the existing debug switch — ACP_DEBUG / config
// debug): the prepare stage must mirror the EXACT nudge wire text it injects
// into the in-process bus (src/nudge-debug.ts); the pi lane turns each event
// into a transcript-only CustomEntry (src/agent/pi.ts — CustomEntry never
// enters LLM context). Gold assertion: the bus event text is BYTE-IDENTICAL
// to the trailing user message content the proxy actually sent upstream — the
// human in pi sees exactly what the model read, and nothing more.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { emitNudgeInjected, onNudgeInjected, _resetNudgeDebugForTest, type NudgeDebugEvent } from "../src/nudge-debug.ts";
import { debugEnabled } from "../src/knobs.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

// ---------- bus unit ----------

test("nudge-debug bus: emit reaches subscribers; unsubscribe works; a throwing listener is isolated", () => {
    _resetNudgeDebugForTest();
    const seen: NudgeDebugEvent[] = [];
    const off = onNudgeInjected((e) => seen.push(e));
    let afterThrow = false;
    const bad = onNudgeInjected(() => {
        throw new Error("boom");
    });
    const later = onNudgeInjected(() => {
        afterThrow = true;
    });
    const ev: NudgeDebugEvent = { sessionId: "s1", protocol: "anthropic", kind: "advisory", tier: null, reason: "r", text: "T", ts: 1 };
    emitNudgeInjected(ev);
    assert.deepEqual(seen, [ev]);
    assert.ok(afterThrow, "a throwing listener must not break later subscribers");
    off();
    emitNudgeInjected(ev);
    assert.equal(seen.length, 1, "unsubscribed listener must not fire");
    bad();
    later();
    _resetNudgeDebugForTest();
});

// ---------- knob (debugEnabled reuses the global debug switch) ----------

test("debugEnabled: ACP_DEBUG env wins; file `debug` tier; default off; only the literal 1 enables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-nudge-debug-cfg-"));
    const cfg = path.join(root, "config.jsonc");
    const savedEnv = process.env.ACP_DEBUG;
    const savedCfg = process.env.BILI_CONFIG_FILE;
    try {
        process.env.BILI_CONFIG_FILE = cfg;
        fs.writeFileSync(cfg, "{}");
        if (savedEnv !== undefined) process.env.ACP_DEBUG = savedEnv;
        else delete process.env.ACP_DEBUG;
        assert.equal(debugEnabled(), false, "default off");
        fs.writeFileSync(cfg, '{ "debug": true }');
        assert.equal(debugEnabled(), true, "file tier");
        process.env.ACP_DEBUG = "0";
        assert.equal(debugEnabled(), false, "env '0' beats file true");
        process.env.ACP_DEBUG = "true";
        assert.equal(debugEnabled(), false, "only literal '1' enables (matches Options.debug)");
        fs.writeFileSync(cfg, "{}");
        process.env.ACP_DEBUG = "1";
        assert.equal(debugEnabled(), true, "env '1' wins over file false");
    } finally {
        if (savedEnv === undefined) delete process.env.ACP_DEBUG;
        else process.env.ACP_DEBUG = savedEnv;
        if (savedCfg === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = savedCfg;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------- pi wiring gate (both directions, #3617 discipline) ----------

test("pi wiring: the bili-nudge entry renderer registers iff the debug switch is on", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-nudge-gate-"));
    const cfg = path.join(root, "config.jsonc");
    const savedEnv = process.env.ACP_DEBUG;
    const savedCfg = process.env.BILI_CONFIG_FILE;
    try {
        fs.writeFileSync(cfg, "{}");
        process.env.BILI_CONFIG_FILE = cfg;
        if (savedEnv !== undefined) process.env.ACP_DEBUG = savedEnv;
        else delete process.env.ACP_DEBUG;
        const makeStub = () => {
            const entryTypes: string[] = [];
            return {
                entryTypes,
                on: () => {},
                fire: () => undefined,
                fireAsync: async () => undefined,
                registerTool: () => {},
                registerCommand: () => {},
                registerProvider: () => {},
                registerMessageRenderer: () => {},
                registerEntryRenderer: (t: string) => { entryTypes.push(t); },
                appendEntry: () => {},
                getSessionName: () => "test",
            };
        };
        const off = makeStub();
        createBiliPlugin("pi")(off as never);
        assert.ok(!off.entryTypes.includes("bili-nudge"), "off by default");
        process.env.ACP_DEBUG = "0";
        const offExplicit = makeStub();
        createBiliPlugin("pi")(offExplicit as never);
        assert.ok(!offExplicit.entryTypes.includes("bili-nudge"), "env '0' keeps it off");
        process.env.ACP_DEBUG = "1";
        const on = makeStub();
        createBiliPlugin("pi")(on as never);
        assert.ok(on.entryTypes.includes("bili-nudge"), "registers when ACP_DEBUG=1");
    } finally {
        if (savedEnv === undefined) delete process.env.ACP_DEBUG;
        else process.env.ACP_DEBUG = savedEnv;
        if (savedCfg === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = savedCfg;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------- e2e: emitted text === the wire text actually sent upstream ----------

const WINDOW = 15_000;
const MODEL = "claude-test";
const SYSTEM = "You are a coding agent.";
const ARMED_INPUT_TOKENS = 13_500;

// 7 messages × ~4400 distinct chars → local estimate ≈51% of WINDOW (below the
// band) so turn 1 stays clean; the upstream-reported usage crosses the
// over-limit band (90%) so turn 2 injects the nudge.
function filler(seed: number, targetChars: number): string {
    const para = `Paragraph ${seed}: the ledger module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.max(1, Math.ceil(targetChars / para.length));
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
}

const ANTHROPIC_MESSAGES = (): Array<{ role: string; content: Array<{ type: string; text: string }> }> => {
    const out: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
    for (let i = 1; i <= 7; i++) {
        out.push({ role: i % 2 === 1 ? "user" : "assistant", content: [{ type: "text", text: `Turn ${i}: working session entry. ` + filler(i, 4400) }] });
    }
    return out;
};

const OPENAI_MESSAGES = (): Array<{ role: string; content: string }> =>
    ANTHROPIC_MESSAGES().map((m) => ({ role: m.role, content: m.content.map((b) => b.text).join("") }));

const anthropicSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const anthropicReply = (): string =>
    [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r", role: "assistant", usage: { input_tokens: ARMED_INPUT_TOKENS } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ack" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");

interface Harness {
    origin: string;
    upstreamUrl: string;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(wire: "anthropic" | "openai"): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            if (wire === "anthropic") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.end(anthropicReply());
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_r", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ack" }, finish_reason: "stop" }], usage: { prompt_tokens: ARMED_INPUT_TOKENS, completion_tokens: 3, total_tokens: ARMED_INPUT_TOKENS + 3 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: { ...defaultConfig(WINDOW), nudge: { ...defaultConfig(WINDOW).nudge, minPressureBenefitTokens: 0 } },
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

    return {
        origin,
        upstreamUrl,
        captured,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function textOf(content: string | Array<{ type?: string; text?: string }>): string {
    return typeof content === "string" ? content : content.map((b) => b.text ?? "").join("");
}

test("nudge-debug e2e (anthropic wire): bus event text is byte-identical to the injected trailing user message", async () => {
    const h = await startHarness("anthropic");
    const events: NudgeDebugEvent[] = [];
    const off = onNudgeInjected((e) => events.push(e));
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/messages`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages: ANTHROPIC_MESSAGES() }),
        });

        const r1 = await post("nudgedbg-anth-a");
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(events.length, 0, "turn 1 (under the band) injects no nudge");

        const r2 = await post("nudgedbg-anth-a");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(events.length, 1, "turn 2 (over limit) fires exactly one nudge event");
        const ev = events[0]!;
        assert.equal(ev.protocol, "anthropic");
        assert.equal(ev.kind, "advisory", "no decide config in this harness → legacy advisory arm");
        assert.equal(ev.text.length > 0, true, "event carries the verbatim wire text");

        const body = JSON.parse(h.captured[1]!) as { messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }> };
        const sent = ANTHROPIC_MESSAGES().length;
        assert.equal(body.messages.length, sent + 1, "exactly one nudge message appended");
        const last = body.messages[body.messages.length - 1]!;
        assert.equal(last.role, "user");
        assert.equal(ev.text, textOf(last.content), "bus event text === the exact bytes sent upstream");
    } finally {
        off();
        await h.close();
    }
});

test("nudge-debug e2e (openai wire): bus event text is byte-identical to the injected trailing user message", async () => {
    const h = await startHarness("openai");
    const events: NudgeDebugEvent[] = [];
    const off = onNudgeInjected((e) => events.push(e));
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: OPENAI_MESSAGES() }),
        });

        const r1 = await post("nudgedbg-openai-a");
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await post("nudgedbg-openai-a");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(events.length, 1, "turn 2 fires exactly one nudge event");
        const ev = events[0]!;
        assert.equal(ev.protocol, "openai");
        assert.equal(ev.kind, "advisory");

        type OMsg = { role: string; content: string | Array<{ type?: string; text?: string }> };
        const t1 = JSON.parse(h.captured[0]!) as { messages: OMsg[] };
        const t2 = JSON.parse(h.captured[1]!) as { messages: OMsg[] };
        // The openai lane injects its own lane message into `messages` on the
        // armed turn (see issue3910's non-vacuity guard), so compare against
        // the turn-1 count instead of an absolute +1.
        assert.equal(t2.messages.length, t1.messages.length + 1, "exactly one nudge message appended vs turn 1");
        const last = t2.messages[t2.messages.length - 1]!;
        assert.equal(last.role, "user");
        assert.equal(ev.text, textOf(last.content), "bus event text === the exact bytes sent upstream");
    } finally {
        off();
        await h.close();
    }
});
