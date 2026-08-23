import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { exportSession, listSessions } from "../src/export.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

// E2E for `bili export` (#151): drives the REAL proxy (startServer) against a
// mock upstream that plays the model's side of the compress protocol — it reads
// the REAL <acp> ref tags off the wire, calls the injected `compress` tool with
// a real startId/endId range, and the proxy executes it into a real block.
// Asserts the block lands in the REAL on-disk SessionStore and that
// exportSession (the code `bili export` runs) renders the model-written summary
// into the handoff doc. The chain HTTP → compress → block → persist → export
// is exercised with zero hand-built session state — unlike cli-export.test.ts,
// which constructs blocks by hand.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const SUMMARY_MARKER = "E2E-HANDOFF-SUMMARY";

test("e2e export: real proxy compresses via real tool call, block persists, bili export renders it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-e2e-export-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    setRegistryForTest({});

    const bodies: string[] = [];
    let compressSent = false;

    // Mock upstream: round 1 answers the injected compress tool with a real
    // range parsed from the actual <acp> tags on the wire; later rounds answer
    // with plain text.
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            bodies.push(body);
            const parsed = JSON.parse(body) as {
                messages: { role: string; content: unknown }[];
                tools?: { function?: { name?: string } }[];
            };
            const toolNames = (parsed.tools ?? []).map((t) => t.function?.name).filter(Boolean);

            // Collect real per-message refs, in order, from user/assistant
            // messages only (system prompt examples must not leak in).
            const refs: string[] = [];
            for (const m of parsed.messages) {
                if (m.role !== "user" && m.role !== "assistant") continue;
                const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                for (const match of text.matchAll(/<acp[^>]*>(m\d+)<\/acp>/g)) {
                    if (!refs.includes(match[1]!)) refs.push(match[1]!);
                }
            }

            const json = (payload: unknown) => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
            };

            if (!compressSent && toolNames.includes("compress") && refs.length >= 4) {
                compressSent = true;
                const [startId, endId] = [refs[2]!, refs[3]!];
                json({
                    id: "r1",
                    object: "chat.completion",
                    choices: [{
                        index: 0,
                        finish_reason: "tool_calls",
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{
                                id: "call_compress_1",
                                type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{
                                            startId,
                                            endId,
                                            topic: "greeting round",
                                            summary: `${SUMMARY_MARKER}: user greeted the proxy and asked about export testing in e2e-export-handoff.ts:1.`,
                                        }],
                                    }),
                                },
                            }],
                        },
                    }],
                });
                return;
            }

            json({
                id: "r2",
                object: "chat.completion",
                choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "E2E-FINAL-ANSWER after compression" } }],
            });
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const big = (label: string, n: number) => `${label}: ${"detail ".repeat(n)}`.slice(0, 4800);
        const history = [
            { role: "user", content: `${big("hello proxy, please track this greeting", 400)} ${big("", 300)}` },
            { role: "assistant", content: big("greeting tracked", 700) },
            { role: "user", content: `${big("work item B", 800)} DEEPMARKER778899 ${big("", 300)}` },
            { role: "assistant", content: big("work B done", 800) },
            { role: "user", content: big("work item C", 800) },
            { role: "assistant", content: big("work C done", 800) },
            { role: "user", content: big("work item D", 800) },
            { role: "assistant", content: big("work D done", 800) },
            { role: "user", content: "final question" },
        ];
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "e2e-export-sess" },
            body: JSON.stringify({ model: "gpt-test", stream: false, messages: history }),
        });
        assert.equal(resp.status, 200, `proxy responded ${resp.status}`);
        const out = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
        const finalText = out.choices?.[0]?.message?.content ?? "";
        assert.ok(compressSent, "mock upstream never issued the compress tool call");
        assert.ok(
            bodies.length >= 2 || finalText.includes("block"),
            `compression result not observed: bodies=${bodies.length} final=${finalText.slice(0, 120)}`,
        );

        // debounceMs: 0 — the debounced persistence write lands within a tick.
        await new Promise((r) => setTimeout(r, 100));

        // `bili export` reads the SAME dir with a fresh store — proving the
        // on-disk file is self-sufficient, not an artifact of the live session.
        const sessions = await listSessions({ dir });
        assert.equal(sessions.length, 1, `expected 1 persisted session, got ${sessions.length}: ${sessions.map((s) => s.id).join(",")}`);
        assert.ok(sessions[0]!.blocks >= 1, "real compression block did not persist");

        const md = await exportSession(sessions[0]!.id, { dir });
        assert.match(md, /# billion-context session handoff/);
        assert.match(md, new RegExp(SUMMARY_MARKER), "model-written summary missing from folded handoff doc");
        assert.match(md, /final question/, "uncompressed tail missing from handoff doc");
        assert.doesNotMatch(md, /DEEPMARKER778899/, "folded handoff view should omit compressed originals (deep body text leaked)");
        const full = await exportSession(sessions[0]!.id, { dir, full: true });
        assert.match(full, /hello proxy, please track this greeting/, "--full handoff view lost the original messages");
        assert.match(full, /DEEPMARKER778899/, "--full handoff view lost deep compressed-original text");
    } finally {
        await close(proxy);
        await close(upstream);
        rmSync(dir, { recursive: true, force: true });
    }
});
