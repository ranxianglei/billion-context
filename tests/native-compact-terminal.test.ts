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

// #321 PR-C: the native-compaction rebase marker must fire ONLY when the
// upstream response semantically completed. failed/incomplete/truncated
// streams, 2xx error JSON, and empty bodies must NOT schedule a rebase.
// Also: a trailing compaction_trigger request must be forwarded WITHOUT the
// compress prompt/tools and with the trigger still final (trigger hardening).

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function conversation() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 4; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}: ` + `WORK_${i}_content_`.repeat(120) });
    }
    return input;
}

function pendingRebase(sessionId: string): boolean | undefined {
    const s = listSessions().find((x) => x.meta.label === sessionId);
    if (!s) return undefined;
    const b = s.metadata.nativeCompactionBoundary as Record<string, unknown> | undefined;
    return b ? (b.pendingRebase as boolean) : undefined;
}

test("e2e #321 PR-C: rebase only on completed; trigger request forwarded clean", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const mode = (req.url?.split("?")[1] ?? "").includes("mode=") ? new URLSearchParams(req.url?.split("?")[1]).get("mode") : undefined;
            if (req.url?.includes("/responses/compact")) {
                if (mode === "json-error") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "compact failed" } }));
                    return;
                }
                if (mode === "empty") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end();
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "resp_c", status: "completed", output: [{ type: "message", role: "user", content: "summary" }], usage: { input_tokens: 10, output_tokens: 1 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (mode === "failed") {
                res.write(sse("response.created", { type: "response.created", response: { id: "r1" } }));
                res.write(sse("response.failed", { type: "response.failed", response: { id: "r1", status: "failed", error: { code: "boom" } } }));
                res.end();
                return;
            }
            if (mode === "truncated") {
                res.write(sse("response.created", { type: "response.created", response: { id: "r1" } }));
                res.write(sse("response.output_item.added", { type: "response.output_item.added", item: { type: "message" } }));
                res.end();
                return;
            }
            res.write(sse("response.created", { type: "response.created", response: { id: "r1" } }));
            res.write(sse("response.completed", { type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

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
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1`;

    const postResponses = (path: string, body: unknown) => fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

    try {
        // 1. Trigger form, SSE completed → rebase scheduled. The forwarded
        //    body must NOT carry the compress prompt/tools, must keep the
        //    client instructions, and the trigger must stay final.
        const r1 = await postResponses("/responses?mode=completed", {
            model: "gpt-resp",
            stream: true,
            session_id: "term-sess",
            instructions: "You are the test coding agent.",
            tools: [{ type: "custom", name: "shell" }],
            input: [...conversation(), { type: "compaction_trigger" }],
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const fwd = JSON.parse(bodies[bodies.length - 1]) as { input: { type: string; content?: unknown }[]; tools?: { name?: string }[] };
        assert.equal(fwd.input[fwd.input.length - 1].type, "compaction_trigger", "trigger stays final");
        const devContent = String(fwd.input.find((i) => i.type === "message" && typeof i.content === "string" && String(i.content).includes("You are the test coding agent."))?.content ?? "");
        assert.ok(devContent.includes("You are the test coding agent."), "client instructions still forwarded");
        assert.ok(!JSON.stringify(fwd).includes("Compression Philosophy"), "compress prompt NOT injected");
        assert.ok(!(fwd.tools ?? []).some((t) => t.name === "compress"), "compress tool NOT injected");
        assert.equal(pendingRebase("term-sess"), true, "completed trigger response schedules the rebase");

        // Reconcile on the next turn: state reset, marker consumed.
        const r1b = await postResponses("/responses", {
            model: "gpt-resp",
            stream: true,
            session_id: "term-sess",
            input: [{ type: "message", role: "user", content: "fresh start" }],
        });
        assert.equal(r1b.status, 200);
        await r1b.text();
        assert.equal(pendingRebase("term-sess"), false, "rebase reconciled on next turn");
        const s1 = listSessions().find((x) => x.meta.label === "term-sess");
        assert.equal(s1?.blockContents.size, 0, "blocks cleared by the rebase");

        // 2. Trigger form, SSE failed → NO rebase.
        const r2 = await postResponses("/responses?mode=failed", {
            model: "gpt-resp",
            stream: true,
            session_id: "term-failed",
            input: [...conversation(), { type: "compaction_trigger" }],
        });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(pendingRebase("term-failed"), undefined, "failed stream must not schedule a rebase");

        // 3. Trigger form, SSE truncated (no terminal event) → NO rebase.
        const r3 = await postResponses("/responses?mode=truncated", {
            model: "gpt-resp",
            stream: true,
            session_id: "term-trunc",
            input: [...conversation(), { type: "compaction_trigger" }],
        });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(pendingRebase("term-trunc"), undefined, "truncated stream must not schedule a rebase");

        // 4. Endpoint form, 2xx JSON error body → NO rebase.
        const r4 = await postResponses("/responses/compact?mode=json-error", { model: "gpt-resp", session_id: "term-jsonerr" });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(pendingRebase("term-jsonerr"), undefined, "2xx error JSON must not schedule a rebase");

        // 5. Endpoint form, empty body → NO rebase.
        const r5 = await postResponses("/responses/compact?mode=empty", { model: "gpt-resp", session_id: "term-empty" });
        assert.equal(r5.status, 200);
        await r5.text();
        assert.equal(pendingRebase("term-empty"), undefined, "empty body must not schedule a rebase");

        // 6. Endpoint form, JSON with output → rebase (the #249 happy path).
        const r6 = await postResponses("/responses/compact", { model: "gpt-resp", session_id: "term-jsonok" });
        assert.equal(r6.status, 200);
        await r6.text();
        assert.equal(pendingRebase("term-jsonok"), true, "JSON output response schedules the rebase");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
