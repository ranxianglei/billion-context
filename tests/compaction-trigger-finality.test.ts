import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// Issue #280 (round 2): Codex's native remote-compact request ends with a
// compaction_trigger item that the upstream requires to be the FINAL input
// item. Bili's compress nudge used to append a user message at the end of
// the input, landing after the trigger and failing the request with 400
// "The 'compaction_trigger' item must be the final input item." — breaking
// Codex's own pre-sampling compact. The nudge must be skipped when the
// final input item is a compaction_trigger; for normal requests the nudge
// must still be injected.

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// 7 messages × ~4400 chars (~1100 tokens each, ~7700 total). Above the
// kernel's 5000-token recent-tail protection so m00001/m00002 stay
// compressible (a tier-1 pending range for the nudge), but below the 10k
// window so preflight never fires.
function conversation() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 7; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

test("e2e #280r2 (Responses): trailing compaction_trigger stays final — nudge skipped; control keeps the nudge", async () => {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            // 9000/10000 = 90% usage arms the OVER-LIMIT nudge from turn 2 on.
            res.write(completed(9000));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
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
    const proxyPort = proxy.address().port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    const post = (input: unknown) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "trig-sess", instructions: "You are the test coding agent.", input }),
    });

    try {
        // Turn 1: fresh session, plain conversation. No nudge (usage 0%).
        const r1 = await post(conversation());
        assert.equal(r1.status, 200);
        await r1.text();
        const s = listSessions().find((x) => x.meta.label === "trig-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.stats.lastInputTokens, 9000, "usage report arms the nudge for the next turn");

        // Turn 2: Codex's native remote-compact request — the conversation
        // plus a trailing compaction_trigger. The nudge is armed (90% usage)
        // but MUST NOT be appended after the trigger.
        const r2 = await post([...conversation(), { type: "compaction_trigger" }]);
        assert.equal(r2.status, 200, "compact request forwards successfully");
        await r2.text();
        const compactForward = JSON.parse(bodies[bodies.length - 1]) as { input: { type: string }[] };
        const lastItem = compactForward.input[compactForward.input.length - 1];
        assert.equal(lastItem.type, "compaction_trigger", "compaction_trigger is the final input item");
        assert.ok(!bodies[bodies.length - 1].includes("Context limit reached"), "no nudge appended after the trigger");

        // Control: same armed session, normal trailing user message — the
        // nudge must still be injected.
        const r3 = await post([...conversation(), { type: "message", role: "user", content: "What should we do next?" }]);
        assert.equal(r3.status, 200);
        await r3.text();
        assert.ok(bodies[bodies.length - 1].includes("Context limit reached"), "nudge still injected on a normal request");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
