// #2652: the agent-side tool bridge hard-coded a 60s HTTP wait while the proxy's
// external-summary budget (compress.externalSummary.budget.totalTimeoutMs) is freely
// tunable up to 600s. Raising the budget above 60s made every legitimately-slow fold
// die client-side with "timeout after 60000ms". Fix: the proxy advertises its summary
// ceiling in the plugin manifest (capabilities.externalSummary.maxToolDurationMs) and
// the bridges size their compress-call wait to it (+ overhead margin). This suite pins
// both halves of that contract:
//   1. the manifest advertises maxToolDurationMs exactly when the chain is enabled
//      (the budget's totalTimeoutMs), and omits it when disabled;
//   2. the client derives the compress-call wait from the advertisement — grows past
//      the 60s floor when the budget demands it, keeps the floor otherwise, and never
//      lengthens the wait for non-compress tools.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";

import { defaultConfig, type Config } from "acp-kernel";
import { handlePluginManifest } from "../src/plugin.ts";
import { fetchManifest, effectiveToolTimeoutMs } from "../src/agent/shared.ts";

process.env.BILI_PERSIST = "0";

const BASE_FLOOR_MS = 60_000;
const OVERHEAD_MARGIN_MS = 30_000;

function captureManifestBody(config: Config): Record<string, unknown> {
    let body = "";
    const res = {
        writeHead(): void {},
        end(chunk?: string | Buffer): void { if (typeof chunk === "string") body += chunk; },
    } as unknown as ServerResponse;
    handlePluginManifest(res, config);
    return JSON.parse(body) as Record<string, unknown>;
}

const extSummaryConfig = (totalTimeoutMs: number): Config => ({
    ...defaultConfig(100_000),
    externalSummary: {
        enabled: true,
        targets: [],
        budget: { totalTimeoutMs, targetTimeoutMs: Math.min(totalTimeoutMs, 25_000), maxSummaryBytes: 64 * 1024 },
    },
} as Config);

test("#2652 manifest advertises maxToolDurationMs when the external-summary chain is enabled", () => {
    const body = captureManifestBody(extSummaryConfig(180_000));
    const caps = body.capabilities as { externalSummary?: { enabled?: boolean; maxToolDurationMs?: number } };
    assert.equal(caps.externalSummary?.enabled, true);
    assert.equal(caps.externalSummary?.maxToolDurationMs, 180_000);
});

test("#2652 manifest omits maxToolDurationMs when the chain is disabled", () => {
    const body = captureManifestBody({ ...defaultConfig(100_000) } as Config);
    const caps = body.capabilities as { externalSummary?: unknown };
    assert.equal(caps.externalSummary, undefined);
});

type LiveServer = { origin: string; close: () => Promise<void> };

async function startManifestServer(manifest: Record<string, unknown>): Promise<LiveServer> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(manifest));
            return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const baseManifest = (extraCaps?: Record<string, unknown>): Record<string, unknown> => ({
    ok: true,
    protocolVersion: 1,
    version: "0.0.0-test",
    tools: { anthropic: [{ name: "compress", input_schema: { type: "object", properties: {} } }] },
    ...(extraCaps ? { capabilities: extraCaps } : {}),
});

let servers: LiveServer[] = [];
afterEach(async () => {
    for (const s of servers) await s.close();
    servers = [];
});

test("#2652 client grows the compress wait past the floor when the budget advertises it", async () => {
    const srv = await startManifestServer(baseManifest({ externalSummary: { enabled: true, maxToolDurationMs: 180_000 } }));
    servers.push(srv);
    await fetchManifest(srv.origin);
    assert.equal(effectiveToolTimeoutMs(srv.origin, "compress"), 180_000 + OVERHEAD_MARGIN_MS);
    // Non-compress tools commit locally and keep the historical floor.
    assert.equal(effectiveToolTimeoutMs(srv.origin, "acp_status"), BASE_FLOOR_MS);
    assert.equal(effectiveToolTimeoutMs(srv.origin, "decompress"), BASE_FLOOR_MS);
});

test("#2652 client keeps the floor when the proxy advertises nothing (chain off / older build)", async () => {
    const srv = await startManifestServer(baseManifest());
    servers.push(srv);
    await fetchManifest(srv.origin);
    assert.equal(effectiveToolTimeoutMs(srv.origin, "compress"), BASE_FLOOR_MS);
});

test("#2652 client floors small advertised budgets at the base timeout", async () => {
    const srv = await startManifestServer(baseManifest({ externalSummary: { enabled: true, maxToolDurationMs: 20_000 } }));
    servers.push(srv);
    await fetchManifest(srv.origin);
    // 20_000 + 30_000 margin < 60_000 floor → floor wins.
    assert.equal(effectiveToolTimeoutMs(srv.origin, "compress"), BASE_FLOOR_MS);
});
