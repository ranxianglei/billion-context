import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { PI_SUMMARIZER_SYSTEM_PREFIX } from "../src/server/side-request.ts";

// #3168: pi-claude-bridge routes Pi's /compact through a one-off Claude Code
// process (persistSession:false, tools:[], systemPrompt REPLACED by Pi's fixed
// SUMMARIZATION_SYSTEM_PROMPT). Pre-fix, no structural #388 check matched that
// shape, so it rode the full pipeline: bili injected its message tags and the
// compress tool (~2x body growth), the model called compress instead of writing
// the summary, and the proxy's own no-tool-call probe re-requested the turn —
// priming the tool call further — so the bridge saved a corrupted compaction
// summary. The fix recognizes the summarizer by its stable opening system clause
// and diverts it to the #388 verbatim passthrough (like dsh title-gen, #2503).
// These tests pin the positive diversion plus every veto: another system prompt,
// tools present, the sentence only in messages, explicit main intent.
const MODEL = "claude-sonnet-4-5"; // model-table default 200K (config.ts)
const PI_SUMMARIZER_SYSTEM = `${PI_SUMMARIZER_SYSTEM_PREFIX}. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const HISTORY = "[User]: fix the login bug\n\n[Assistant]: done";

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: string[];
    scripts: string[][];
    close(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const scripts: string[][] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            forwards.push(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
            call += 1;
            for (const line of script) {
                res.write(line);
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        forwards,
        scripts,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

function plainTextScript(): string[] {
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_pi_1", role: "assistant", usage: { input_tokens: 12 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "## Summary\nok" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

async function callSummarizer(rig: Rig, opts: { system?: unknown; omitSystem?: boolean; messages?: unknown[]; tools?: unknown[]; headers?: Record<string, string> }): Promise<{ status: number; raw: string }> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-acp-session": randomUUID(),
        ...(opts.headers ?? {}),
    };
    const resp = await fetch(url(rig), {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 8000,
            stream: true,
            ...(opts.omitSystem ? {} : { system: opts.system ?? [{ type: "text", text: PI_SUMMARIZER_SYSTEM }] }),
            messages: opts.messages ?? [{ role: "user", content: HISTORY }],
            ...(opts.tools ? { tools: opts.tools } : {}),
        }),
    });
    let raw = "";
    assert.ok(resp.body, "response had no body");
    for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
    return { status: resp.status, raw };
}

test("#3168 pi /compact summarizer (block-array system) rides the #388 passthrough untouched", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        const r = await callSummarizer(rig, {});
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        assert.match(r.raw, /## Summary/);
        assert.equal(rig.forwards.length, 1, `expected exactly ONE upstream forward (no loop re-request), got ${rig.forwards.length}`);
        const fwd = rig.forwards[0]!;
        assert.ok(!fwd.includes("\x3cacp"), "ACP tags leaked into the passthrough forward");
        const p = JSON.parse(fwd) as Record<string, unknown>;
        assert.equal(p.tools, undefined, "tools key must not be injected into the summarizer request");
        assert.ok(!fwd.includes('"compress"'), "compress tool leaked into the passthrough forward");
        assert.deepEqual(p.system, [{ type: "text", text: PI_SUMMARIZER_SYSTEM }], "top-level system must be forwarded verbatim");
        assert.deepEqual(p.messages, [{ role: "user", content: HISTORY }], "messages must be forwarded verbatim");
        assert.equal(p.max_tokens, 8000, "output budget must not be rewritten on the side lane");
    } finally {
        await rig.close();
    }
});

test("#3168 pi /compact summarizer (string-form system) rides the #388 passthrough untouched", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        const r = await callSummarizer(rig, { system: PI_SUMMARIZER_SYSTEM });
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        assert.equal(rig.forwards.length, 1, `expected exactly ONE upstream forward, got ${rig.forwards.length}`);
        const fwd = rig.forwards[0]!;
        assert.ok(!fwd.includes("\x3cacp"), "ACP tags leaked into the passthrough forward");
        const p = JSON.parse(fwd) as Record<string, unknown>;
        assert.equal(p.tools, undefined, "tools key must not be injected");
        assert.equal(p.system, PI_SUMMARIZER_SYSTEM, "string-form system must be forwarded verbatim");
    } finally {
        await rig.close();
    }
});

test("#3168 another system prompt keeps the full pipeline (tags + compress injection)", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        const r = await callSummarizer(rig, { system: [{ type: "text", text: "You are a helpful coding assistant." }] });
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        const fwd = rig.forwards[0]!;
        assert.ok(fwd.includes("\x3cacp"), "normal traffic lost its tag injection — the detector over-matched");
        assert.ok(fwd.includes('"compress"'), "normal traffic lost its compress tool injection");
    } finally {
        await rig.close();
    }
});

test("#3168 summarizer sentence with tools present vetoes the passthrough", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        const r = await callSummarizer(rig, {
            tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
        });
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        const fwd = rig.forwards[0]!;
        assert.ok(fwd.includes("\x3cacp"), "tool-carrying request must stay on the full pipeline");
        assert.ok(fwd.includes('"compress"'), "tool-carrying request must keep compress injection");
    } finally {
        await rig.close();
    }
});

test("#3168 summarizer sentence only in messages does NOT match (top-level system field is the evidence)", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        const r = await callSummarizer(rig, {
            system: [{ type: "text", text: "You are a test assistant." }],
            messages: [{ role: "user", content: `${PI_SUMMARIZER_SYSTEM}\nPlease summarize.` }],
        });
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        const fwd = rig.forwards[0]!;
        assert.ok(fwd.includes("\x3cacp"), "sentence-in-messages must not divert to the side lane");
    } finally {
        await rig.close();
    }
});

test("#3168 explicit main agent intent vetoes the passthrough", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(plainTextScript());
        // pluginRequestAgentHeader honors the persona id ONLY from an announced
        // plugin (both headers together, src/plugin.ts #1699).
        const r = await callSummarizer(rig, { headers: { "x-bili-plugin": "pi", "x-bili-plugin-agent": "main" } });
        assert.equal(r.status, 200, `status: ${r.raw.slice(0, 300)}`);
        const fwd = rig.forwards[0]!;
        assert.ok(fwd.includes("\x3cacp"), "explicit main intent must stay on the full pipeline");
    } finally {
        await rig.close();
    }
});
