import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";

// P0c: structured content rejection outranks diagnostic words quoted in its
// message, including a verdict returned by an otherwise legitimate repair.
for (const repair of ["role", "pck", "overflow-cap"] as const) {
    for (const pluginMode of [false, true]) {
        for (const duringRepair of [false, true]) {
            test(`content rejection stops ${repair} repair (plugin=${pluginMode}, duringRepair=${duringRepair})`, async () => {
                const captured: Record<string, unknown>[] = [];
                const rejection = JSON.stringify({ error: {
                    code: "content-blocked", type: "agent_router_content_blocked",
                    message: (duringRepair ? "Rejected source quotes: System message must be at the beginning." : "Rejected source quotes: Invalid role: developer") + " Quoted reasoning_content, reasoning_text, content[].thinking; maximum context length exceeded.",
                } });
                const upstream = http.createServer((req, res) => {
                    const chunks: Buffer[] = [];
                    req.on("data", (chunk: Buffer) => chunks.push(chunk));
                    req.on("end", () => {
                        captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                        const initialValidationError = duringRepair && captured.length === 1;
                        res.writeHead(400, { "content-type": "application/json", "x-request-id": initialValidationError ? "initial-validation" : "content-verdict" });
                        res.end(initialValidationError ? JSON.stringify({ error: { type: "invalid_request_error", message: repair === "role" ? "Invalid role: developer" : repair === "pck" ? "Unsupported parameter(s): prompt_cache_key" : "Requested token count exceeds the model's maximum context length of 100000 tokens. You requested a total of 110000 tokens: 90000 tokens from the input messages and 20000 tokens for the completion." } }) : rejection);
                    });
                });
                upstream.listen(0, "127.0.0.1");
                await once(upstream, "listening");
                const ua = upstream.address();
                assert.ok(ua && typeof ua === "object");
                _resetSessionsForTest();
                _setStoreForTest(new SessionStore({ enabled: false }));
                setRegistryForTest({});
                const proxy = await startServer({
                    port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
                    routes: { [`http://127.0.0.1:${ua.port}`]: { models: { "gpt-test": { context: 100000 } } } },
                    modelContextLimit: 100000, kernelConfig: defaultConfig(100000),
                    compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
                    log: false, sessionHeader: "x-acp-session", debug: false, passthrough: false, autoUpdate: false,
                    mitm: { enabled: false, domains: [] }, compat: { roles: {} }, streamErrorShape: "protocol",
                    passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
                });
                if (!proxy.listening) await once(proxy, "listening");
                const pa = proxy.address();
                assert.ok(pa && typeof pa === "object");
                try {
                    const sid = `content-${repair}-${pluginMode}-${duringRepair}`;
                    const response = await fetch(`http://127.0.0.1:${pa.port}/bili/http://127.0.0.1:${ua.port}/v1/responses`, {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-acp-session": sid, ...(pluginMode ? { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid } : {}) },
                        body: JSON.stringify({ model: "gpt-test", stream: true, ...(repair === "overflow-cap" ? { max_output_tokens: 20000 } : {}), ...(repair === "pck" ? { prompt_cache_key: "compat-test" } : {}), input: [
                            { type: "message", role: "developer", content: "Be concise." },
                            { type: "message", role: "user", content: "hello" },
                        ] }),
                    });
                    const text = await response.text();
                    assert.equal(captured.length, duringRepair ? 2 : 1, "no sends after the terminal content verdict");
                    assert.equal(response.status, 400);
                    assert.equal(text, rejection, "the terminal verdict must not be replaced by the earlier validation error");
                    assert.equal(response.headers.get("x-request-id"), "content-verdict");
                    assert.notEqual(getSession(sid).metadata.strictReasoningEcho, true, "quoted diagnostics in a content verdict must not teach reasoning compatibility");
                    if (repair === "overflow-cap" && duringRepair) {
                        assert.deepEqual(captured.map(body => body.max_output_tokens), [20000, 10000], "the legitimate output-budget retry is preserved");
                    }
                } finally {
                    const pc = once(proxy, "close"); proxy.close(); proxy.closeIdleConnections(); await pc;
                    const uc = once(upstream, "close"); upstream.close(); upstream.closeIdleConnections(); await uc;
                }
            });
        }
    }
}
