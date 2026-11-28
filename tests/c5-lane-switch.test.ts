// C5 (PR #7684): a session's WIRE-LANE switch is explicit. When a conversation
// moves to a different wire dialect (openai -> anthropic -> responses ...), the
// stored rows (dialect-neutral cores) get re-rendered on the NEW lane — and
// that re-render has bounded, explicit losses (thinking signatures, redacted
// placeholders, tool-error flags, mid-system placement). Before this commit
// the switch was silent: no log line, no counter, no loss list. This test
// asserts the loud line with the per-turn loss list, the per-session counter,
// and the steady-state silence (no re-log on same-lane turns, none on the
// first observed lane).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL_A = "c5-openai-model";
const MODEL_B = "c5-anthropic-model";
const MODEL_C = "c5-responses-model";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("C5 a session that switches wire lanes gets a loud lane-switch line with the per-turn loss list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-switch-c5-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        setRegistryForTest({});
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
            req.on("end", () => {
                const u = new URL(req.url ?? "/", "http://127.0.0.1");
                res.writeHead(200, { "content-type": "application/json" });
                if (u.pathname === "/v1/messages") {
                    res.end(JSON.stringify({
                        id: "msg-test", type: "message", role: "assistant", model: MODEL_B,
                        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
                        usage: { input_tokens: 10, output_tokens: 3 },
                    }));
                    return;
                }
                if (u.pathname === "/v1/responses") {
                    res.end(JSON.stringify({
                        id: "resp-test", object: "response", status: "completed", model: MODEL_C,
                        output: [{ type: "message", id: "msg_o", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
                        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
                    }));
                    return;
                }
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL_A,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: {
                // routes are keyed by upstream URL (ProviderRoutes), not by
                // model name — one fake upstream serves all three lanes here.
                [llmUrl]: {
                    models: {
                        [MODEL_A]: { context: 100_000 },
                        [MODEL_B]: { context: 100_000 },
                        [MODEL_C]: { context: 100_000 },
                    },
                },
            },
            modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: false, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        const H = { "content-type": "application/json", "x-acp-session": "c5-sess", "x-bili-plugin": "opencode" } as Record<string, string>;
        const turn = (path: string, body: unknown) => fetch(`${base}${path}`, {
            method: "POST", headers: H,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        }).then(async (r) => ({ status: r.status, text: await r.text() }));

        // Turn 1: openai lane — the FIRST observed lane, no switch line.
        // max_tokens must be > 200 or the turn is a side request (passthrough
        // only, never touches the kernel/lane bookkeeping).
        let r = await turn("/v1/chat/completions", {
            model: MODEL_A, max_tokens: 1024,
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(r.status, 200, r.text);
        assert.ok(!logs.some((l) => l.includes("[lane-switch]")),
            "the first observed lane must not log a switch");

        // Turn 2: SAME conversation on the anthropic wire — carries a signed
        // thinking block in the resent history so the loss list has real
        // content when the lane changes again.
        r = await turn("/v1/messages", {
            model: MODEL_B, max_tokens: 1024,
            messages: [
                { role: "user", content: "think" },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "hmm", signature: "c5-sig" },
                        { type: "text", text: "ok" },
                    ],
                },
                { role: "user", content: "more" },
            ],
        });
        assert.equal(r.status, 200, r.text);
        const sw1 = logs.filter((l) => l.includes("[lane-switch]"));
        assert.equal(sw1.length, 1, `one switch line after the first lane change (logs: ${logs.slice(-6).join(" | ")})`);
        assert.match(sw1[0], /openai\s*->\s*anthropic/);
        assert.match(sw1[0], /switch #1/);
        assert.match(sw1[0], /loss/); // the explicit loss list section

        // Turn 3: same lane again — steady state, NO new line.
        r = await turn("/v1/messages", {
            model: MODEL_B, max_tokens: 1024,
            messages: [{ role: "user", content: "again" }],
        });
        assert.equal(r.status, 200, r.text);
        assert.equal(logs.filter((l) => l.includes("[lane-switch]")).length, 1,
            "same-lane turns must not re-log");

        // Turn 4: a THIRD dialect (responses) — the second switch, and the
        // signed thinking from turn 2's history must be on the loss list
        // (a responses render degrades it to plain text).
        r = await turn("/v1/responses", {
            model: MODEL_C, max_output_tokens: 1024,
            input: [{ type: "message", role: "user", content: "third lane" }],
        });
        assert.equal(r.status, 200, r.text);
        const sws = logs.filter((l) => l.includes("[lane-switch]"));
        assert.equal(sws.length, 2, "a second switch line for the second lane change");
        assert.match(sws[1], /anthropic\s*->\s*responses/);
        assert.match(sws[1], /switch #2/);
        assert.match(sws[1], /thinking/); // signed thinking is a real loss here
    } finally {
        setLogCapture(null);
        await new Promise<void>((res) => { (srv?.close(res as never) as unknown) as void; });
        await new Promise<void>((res) => { (upstream?.close(res as never) as unknown) as void; });
    }
});
