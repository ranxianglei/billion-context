import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

// #903: long sessions keep resending the full harness history to bili even
// when the folded context stays small — the per-request cost line makes that
// growth observable: `[session] request: N msgs, inbound=<wire bytes>,
// local=<ms from body-read start to handoff>` (+ outbound=<forwarded bytes>
// when the request actually hits upstream), logged once per processed model
// request (upstream forward, forged local response, or fail-fast error).

function okJson(): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
}

function inboundBytesOf(line: string): number {
    const m = line.match(/inbound=(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)/);
    assert.ok(m, `no inbound field in: ${line}`);
    const v = Number(m![1]);
    const mult = m![2] === "B" ? 1 : m![2] === "KiB" ? 1024 : m![2] === "MiB" ? 1024 ** 2 : 1024 ** 3;
    return Math.round(v * mult);
}

function outboundBytesOf(line: string): number {
    const m = line.match(/outbound=(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)/);
    assert.ok(m, `no outbound field in: ${line}`);
    const v = Number(m![1]);
    const mult = m![2] === "B" ? 1 : m![2] === "KiB" ? 1024 : m![2] === "MiB" ? 1024 ** 2 : 1024 ** 3;
    return Math.round(v * mult);
}

test("e2e: per-request cost line reports msg count, inbound wire size and local duration", async () => {
    let upstreamSeen = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamSeen = Buffer.concat(chunks).length;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson());
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
        routes: {},
        kernelConfig: defaultConfig(200_000),
        // operator-tuned window (the ONLY channel that reaches reqConfig here
        // with an empty registry) — required so the #554 side-request guard
        // has a non-zero effective window to gate against.
        compress: { injectTool: true, injectNudge: true, modelContextLimit: 200_000 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "cost-sess" };

        const mkBody = (pads: number): { messages: unknown[]; raw: string } => {
            const messages: unknown[] = [
                { role: "user", content: "hello" },
                { role: "assistant", content: "hi there" },
            ];
            for (let i = 0; i < pads; i++) {
                messages.push({ role: "user", content: `pad${i} ` + "f".repeat(900) });
            }
            messages.push({ role: "assistant", content: "ok" });
            messages.push({ role: "user", content: "and one more" });
            const raw = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 1000, messages });
            return { messages, raw };
        };

        const first = mkBody(1);
        const r1 = await fetch(url, { method: "POST", headers, body: first.raw });
        assert.equal(r1.status, 200);
        await r1.text();
        const up1 = upstreamSeen;

        const second = mkBody(3);
        const r2 = await fetch(url, { method: "POST", headers, body: second.raw });
        assert.equal(r2.status, 200);
        await r2.text();
        const up2 = upstreamSeen;

        // Blocked side request (#554 gate): tiny output budget + raw-history
        // estimate reaching the effective window -> 413 locally, upstream never
        // contacted, so the cost line carries no outbound= field.
        const sideMessages: unknown[] = [{ role: "user", content: "title?" }];
        for (let i = 0; i < 230; i++) sideMessages.push({ role: "user", content: `pad${i} ` + "f".repeat(4200) });
        const thirdRaw = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 100, messages: sideMessages });
        const r3 = await fetch(url, { method: "POST", headers, body: thirdRaw });
        assert.equal(r3.status, 413);
        await r3.text();

        const costLines = lines.filter((l) => l.startsWith("[cost-sess] request: "));
        assert.equal(costLines.length, 3, `expected exactly one cost line per request, got: ${costLines.join(" | ")}`);

        const l1 = costLines[0]!;
        assert.match(l1, /^\[cost-sess\] request: 5 msgs, inbound=\d+(?:\.\d+)?(B|KiB|MiB|GiB), outbound=\d+(?:\.\d+)?(B|KiB|MiB|GiB), local=\d+ms$/);
        assert.ok(Math.abs(inboundBytesOf(l1) - Buffer.byteLength(first.raw)) <= 100, `inbound ${l1} vs sent ${Buffer.byteLength(first.raw)}`);
        assert.ok(Math.abs(outboundBytesOf(l1) - up1) <= 100, `outbound ${l1} vs upstream-received ${up1}`);

        const l2 = costLines[1]!;
        assert.match(l2, /^\[cost-sess\] request: 7 msgs, inbound=\d+(?:\.\d+)?(B|KiB|MiB|GiB), outbound=\d+(?:\.\d+)?(B|KiB|MiB|GiB), local=\d+ms$/);
        assert.ok(Math.abs(inboundBytesOf(l2) - Buffer.byteLength(second.raw)) <= 100, `inbound ${l2} vs sent ${Buffer.byteLength(second.raw)}`);
        assert.ok(Math.abs(outboundBytesOf(l2) - up2) <= 100, `outbound ${l2} vs upstream-received ${up2}`);
        assert.ok(inboundBytesOf(l2) > inboundBytesOf(l1), "growing history must show up as growing inbound");

        const l3 = costLines[2]!;
        assert.match(l3, /^\[cost-sess\] request: 231 msgs, inbound=\d+(?:\.\d+)?(B|KiB|MiB|GiB), local=\d+ms$/);
        assert.ok(Math.abs(inboundBytesOf(l3) - Buffer.byteLength(thirdRaw)) <= 100, `inbound ${l3} vs sent ${Buffer.byteLength(thirdRaw)}`);
    } finally {
        setLogCapture(null);
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
