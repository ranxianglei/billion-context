// #2228: model-decided nudge timing — end-to-end through the real pipeline
// (OpenAI wire). When compress.nudgeModelDecided is on, an armed tier-1 nudge
// first sends a short side call over the cached prefix asking the model whether
// compressing NOW helps; a strict-JSON yes injects a directive with a
// program-finalized span, anything else injects nothing this round. Observable
// here: the upstream receives one extra tiny-budget request carrying the
// decision question, and the main forwarded payload either gains a
// [bili-compress-directive] trailing user message (yes) or stays bare (no /
// garbage / feature off keeps the legacy advisory byte-for-byte).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

// Same 29-message history as plugin-nudge-injection.test.ts: 50k/64k = 78%
// arms the OVER-LIMIT tier-1 nudge deterministically (not EMERGENCY, so it
// routes through the model-decided path when enabled).
function turn2Messages(): Record<string, unknown>[] {
    const longText = "y".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

interface ScenarioResult {
    mainLen: number;
    mainLastText: string;
    sideCalls: number;
    sideMaxTokens: number[];
    sideLastText: string[];
}

async function runScenario(sessionId: string, modelDecided: boolean, verdict: string | null): Promise<ScenarioResult> {
    const mains: unknown[][] = [];
    const sides: { maxTokens: unknown; lastText: string }[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
            const textOf = (m: Record<string, unknown>): string => (typeof m.content === "string" ? m.content : "");
            // The decision call is the only request with the tiny output budget
            // (default 200); the client's own requests carry max_tokens 64_000.
            if (typeof body.max_tokens === "number" && body.max_tokens <= 200) {
                sides.push({ maxTokens: body.max_tokens, lastText: textOf(messages[messages.length - 1] ?? {}) });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-decide",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: verdict ?? "Let me think about whether we should compress..." }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 50_000, completion_tokens: 10, total_tokens: 50_010 },
                }));
                return;
            }
            mains.push(messages);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: {
            injectTool: true,
            injectNudge: true,
            ...(modelDecided ? { nudgeModelDecided: true } : {}),
        },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages: turn2Messages() }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(mains.length, 2, "both main turns reached the upstream");
        const mainMsgs = (mains[1] ?? []) as Record<string, unknown>[];
        return {
            mainLen: mainMsgs.length,
            mainLastText: typeof mainMsgs[mainMsgs.length - 1]?.content === "string" ? (mainMsgs[mainMsgs.length - 1]!.content as string) : "",
            sideCalls: sides.length,
            sideMaxTokens: sides.map((s) => s.maxTokens as number),
            sideLastText: sides.map((s) => s.lastText),
        };
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("#2228: model says yes → directive injected with a program-finalized span", async () => {
    const out = await runScenario("decide-yes", true, '{"compress": true}');
    assert.equal(out.sideCalls, 1, "exactly one decision side call");
    assert.deepEqual(out.sideMaxTokens, [200], "decision call uses the tiny output budget");
    assert.ok(out.sideLastText[0]?.includes("[bili-compress-decision]"), "side call ends with the decision question");
    assert.equal(out.mainLen, 31, "directive takes the nudge slot (29 client + system + directive)");
    assert.ok(out.mainLastText.includes("[bili-compress-directive]"), "main payload carries the directive");
    assert.ok(out.mainLastText.includes("Compress NOW"));
    assert.match(out.mainLastText, /Target span: m\d{4,}\u2013m\d{4,}/);
});

test("#2228: model says no → nothing injected this round", async () => {
    const out = await runScenario("decide-no", true, '{"compress": false}');
    assert.equal(out.sideCalls, 1);
    assert.equal(out.mainLen, 30, "no directive, no legacy advisory — the veto stands");
    assert.ok(!out.mainLastText.includes("[bili-compress-directive]"));
});

test("#2228: unparseable answer → treated as failure, nothing injected", async () => {
    const out = await runScenario("decide-garbage", true, null);
    assert.equal(out.sideCalls, 1);
    assert.equal(out.mainLen, 30, "never force-compress on garbage data");
});

test("#2228 control: feature off → legacy advisory nudge unchanged, no side call", async () => {
    const out = await runScenario("decide-off", false, null);
    assert.equal(out.sideCalls, 0, "no decision call when the feature is off");
    assert.equal(out.mainLen, 31, "legacy advisory nudge still injected at 78% of 64k");
    assert.ok(!out.mainLastText.includes("[bili-compress-directive]"));
    assert.ok(!out.mainLastText.includes("[bili-compress-decision]"));
});
