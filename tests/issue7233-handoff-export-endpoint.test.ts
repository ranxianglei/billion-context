import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// #7233: pin the route-level failure shapes that the unit tests cannot see.
// Unknown ids must stay 404s (and malformed ids must not throw), so an empty
// sessions dir is enough; 409/500 need a real handoff fixture and are covered
// by the handler logic in admin.ts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-export-endpoint-"));
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
fs.mkdirSync(process.env.BILI_SESSIONS_DIR, { recursive: true });
process.env.BILI_CONFIG_FILE = path.join(root, "config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_PERSIST_ZSTD = "0";

const { handleAdminRoute } = await import("../src/server/admin.ts");

type CtxT = Parameters<typeof handleAdminRoute>[2];
function makeCtx(): CtxT {
    return {
        opts: { host: "127.0.0.1" },
        core: {},
        config: {},
        log: (): void => {},
        instanceId: "t",
        instanceStartedAt: Date.now(),
        proxyWatchers: new Set<number>(),
        initialWatcherPid: null,
        bootReady: (): boolean => true,
        requestShutdown: (): void => {},
    } as unknown as CtxT;
}

function postReq(id: string): http.IncomingMessage {
    return postReqPath(`/__bili/sessions/${encodeURIComponent(id)}/handoff/export`);
}

function postReqPath(url: string): http.IncomingMessage {
    const stream = Readable.from([]);
    return Object.assign(stream, {
        method: "POST",
        url,
        headers: { host: "127.0.0.1" },
        socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as http.IncomingMessage;
}

function mkRes(): { res: http.ServerResponse; out: { code?: number; body?: string } } {
    const out: { code?: number; body?: string } = {};
    const res = {
        writeHead(code: number): void { out.code = code; },
        end(body?: string): void { out.body = body ?? ""; },
    };
    return { res: res as unknown as http.ServerResponse, out };
}

test("#7233 unknown session keeps the route-level 404 contract", async () => {
    const { res, out } = mkRes();
    await handleAdminRoute(postReq("no-such-session"), res, makeCtx());
    assert.equal(out.code, 404, `expected 404, got ${out.code}: ${out.body}`);
    assert.match(out.body ?? "", /unknown session/);
});

test("#7233 malformed session id is treated as unknown, not a crash", async () => {
    const { res, out } = mkRes();
    await handleAdminRoute(
        postReqPath("/__bili/sessions/%E0%A4%A/handoff/export"),
        res,
        makeCtx(),
    );
    assert.equal(out.code, 404, `expected 404, got ${out.code}: ${out.body}`);
});