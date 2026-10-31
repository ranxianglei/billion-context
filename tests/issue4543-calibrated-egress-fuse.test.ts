import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCore, defaultConfig } from "acp-kernel";
import { forward, type Prepared } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

const WINDOW = 1_000_000;
const MODEL = "gpt-4543";
const CJK = "中文历史记录".repeat(150_000);

interface Fixture {
    body?: Record<string, unknown>;
    stats?: Partial<Session["stats"]>;
    pluginMode?: boolean;
    protocol?: Prepared["protocol"];
    window?: number;
    committedStream?: boolean;
}

test("#4543: route-calibrated egress guard closes the CJK byte-floor blind spot", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bili-4543-"));
    const xdgKeys = ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;
    const previousXdg = xdgKeys.map((key) => process.env[key]);
    for (const key of xdgKeys) process.env[key] = root;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const received: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            received.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "reply", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const config = defaultConfig(WINDOW);
    const opts = {
        port: 0, host: "127.0.0.1", modelContextLimit: WINDOW, kernelConfig: config, sessionHeader: "x-test-session",
        upstream: upstreamOrigin, routes: {}, compat: { roles: {} },
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, mitm: { enabled: false, domains: [] },
        autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
        passthrough: false, debug: false, log: false, streamErrorShape: "protocol",
    } as ProxyOptions;
    const core = createCore();
    const fixtures = new Map<string, Fixture>();
    const sessions = new Map<string, Session>();
    const proxy = http.createServer(async (req, res) => {
        try {
            const id = String(req.headers["x-test-session"]);
            const fixture = fixtures.get(id)!;
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks).toString("utf8");
            const session = getSession(id);
            session.metadata.effectiveContextLimit = fixture.window ?? WINDOW;
            session.metadata.lastModel = MODEL;
            Object.assign(session.stats, {
                lastInputTokens: 155_973,
                lastInputTokensSource: "usage",
                lastInputTokensOrigin: "https://previous-route.invalid",
                calibratedEstimate: 1.25,
                calibratedEstimateOrigin: upstreamOrigin,
                calibratedEstimateModel: MODEL,
            }, fixture.stats);
            sessions.set(id, session);
            const prepared: Prepared = {
                body, session, protocol: fixture.protocol ?? "openai", model: MODEL, stream: false,
                compressInjected: false, pluginMode: fixture.pluginMode ?? true,
                // The final wire body, rather than this stale projection, must
                // decide the new guard after send-side rewrites.
                processedMessages: [{ id: "stale", role: "user", contentType: "text", text: "small old view" }],
                originalMessages: [],
            };
            if (fixture.committedStream) res.writeHead(200, { "content-type": "text/event-stream" });
            await forward(req, res, opts, body, prepared, core, config, () => {},
                { upstream: upstreamOrigin, rewrittenUrl: `${upstreamOrigin}/v1/chat/completions` }, "test-4543");
        } catch (error) {
            res.writeHead(500);
            res.end(String(error));
        }
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/chat/completions`;
    let serial = 0;
    const post = async (fixture: Fixture = {}) => {
        const id = `issue4543-${Date.now()}-${serial++}`;
        fixtures.set(id, fixture);
        const body = JSON.stringify(fixture.body ?? { model: MODEL, messages: [{ role: "user", content: CJK }] });
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json", "x-test-session": id },
            body, signal: AbortSignal.timeout(15_000),
        });
        return { response, body, id };
    };
    try {
        const protocolBodies: Record<Prepared["protocol"], Record<string, unknown>> = {
            openai: { model: MODEL, messages: [{ role: "user", content: CJK }] },
            anthropic: { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: [{ type: "text", text: CJK }] }] },
            responses: { model: MODEL, input: [{ role: "user", content: [{ type: "input_text", text: CJK }] }] },
            google: { contents: [{ role: "user", parts: [{ text: CJK }] }] },
        };
        for (const protocol of ["openai", "anthropic", "responses", "google"] as const) {
            for (const pluginMode of [true, false]) {
                await t.test(`${protocol}/${pluginMode ? "plugin" : "proxy"}: same-route CJK overflow never reaches upstream`, async () => {
                    const before = received.length;
                    const { response, body, id } = await post({ pluginMode, protocol, body: protocolBodies[protocol] });
                    assert.ok(Buffer.byteLength(body) < WINDOW * 7.5, "the old byte-floor fuse does not catch this payload");
                    const result = await response.json() as { error: { code: string; message: string; retryable: boolean } };
                    assert.equal(response.status, 413, JSON.stringify(result));
                    assert.equal(result.error.code, "egress_window_fuse");
                    assert.match(result.error.message, /calibrated/i);
                    assert.equal(result.error.retryable, false);
                    assert.equal(received.length, before, "not even a probe may forward this payload");
                    assert.equal(sessions.get(id)!.stats.lastInputTokens, 155_973, "local refusal must not become billed usage");
                    assert.equal(sessions.get(id)!.stats.lastLocalTextEstimate, undefined, "no pending send may be recorded");
                });
            }
        }
        await t.test("already committed SSE returns an in-band error without egress", async () => {
            const before = received.length;
            const { response } = await post({ committedStream: true });
            const text = await response.text();
            assert.equal(response.status, 200, "an already committed stream cannot change its HTTP status");
            assert.match(text, /calibrated/i);
            assert.match(text, /error/i);
            assert.equal(received.length, before);
        });
        await t.test("text still overflows when the same body also contains images", async () => {
            const before = received.length;
            const { response } = await post({ body: { model: MODEL, messages: [{ role: "user", content: [
                { type: "text", text: CJK },
                { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(100_000)}` } },
            ] }] } });
            assert.equal(response.status, 413, await response.text());
            assert.equal(received.length, before);
        });
        const passCases: Array<[string, Fixture]> = [
            ["fitting calibrated CJK", { stats: { calibratedEstimate: 1 } }],
            ["existing assumed-window floor is preserved", { window: 500_000, stats: { calibratedEstimate: 1 } }],
            ["different upstream", { stats: { calibratedEstimateOrigin: "https://other.invalid" } }],
            ["different model", { stats: { calibratedEstimateModel: "another-model" } }],
            ["unknown model provenance", { stats: { calibratedEstimateModel: undefined } }],
            ["unknown upstream provenance", { stats: { calibratedEstimateOrigin: undefined } }],
            ["no calibration", { stats: { calibratedEstimate: undefined } }],
            ["invalid calibration", { stats: { calibratedEstimate: Number.POSITIVE_INFINITY } }],
            ["dense text accepted by calibrated route", {
                stats: { calibratedEstimate: 0.25 },
                body: { model: MODEL, messages: [{ role: "user", content: "x".repeat(4_100_000) }] },
            }],
            ["image bytes are not charged as calibrated text", {
                body: { model: MODEL, messages: [{ role: "user", content: [
                    { type: "text", text: "Describe the image." },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4_100_000)}` } },
                ] }] },
            }],
        ];
        for (const [name, fixture] of passCases) {
            await t.test(name, async () => {
                const before = received.length;
                const { response, body } = await post(fixture);
                const text = await response.text();
                assert.equal(response.status, 200, text);
                assert.equal(received.length, before + 1);
                assert.equal(received.at(-1), body, "allowed payloads must remain byte-exact");
            });
        }
    } finally {
        proxy.close();
        proxy.closeAllConnections();
        upstream.close();
        upstream.closeAllConnections();
        for (const [i, key] of xdgKeys.entries()) {
            if (previousXdg[i] === undefined) delete process.env[key];
            else process.env[key] = previousXdg[i];
        }
        rmrf(root);
    }
});
