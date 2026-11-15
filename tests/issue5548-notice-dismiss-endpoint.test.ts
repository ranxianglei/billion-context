import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// #5548 / PR #5575 reviewer supplement: pins the POST /__bili/notices/dismiss
// ROUTE end-to-end — the content-addressed fix (77c0e05c9) only unit-pins the
// resolver+store, so an endpoint-glue regression slips past that pin. Shapes:
// persistent LOCAL, built-in (bare allowlist), unknown (400), persistent REMOTE.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notice-dismiss-endpoint-"));
process.env.BILI_CONFIG_FILE = path.join(root, "cfg.json"); // absent ⇒ defaults
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
const annDir = path.join(root, "announcements");

const { handleAdminRoute } = await import("../src/server/admin.ts");
const { PCK_NOTICE_ID, dismissedUpgradeNotices } = await import("../src/pck-notice.ts");
const { visibleLocalNotices } = await import("../src/announcements.ts");
const { runRemoteNoticesCheck, _resetRemoteNoticesForTest, visibleRemoteRecords } = await import("../src/remote-notices.ts");

type CtxT = Parameters<typeof handleAdminRoute>[2];
function makeCtx(): CtxT {
    return {
        opts: { host: "127.0.0.1" }, core: {}, config: {}, log: (): void => {},
        instanceId: "t", instanceStartedAt: Date.now(), proxyWatchers: new Set<number>(),
        initialWatcherPid: null, bootReady: (): boolean => true, requestShutdown: (): void => {},
    } as unknown as CtxT;
}
function postReq(id: string): http.IncomingMessage {
    const stream = Readable.from([Buffer.from(JSON.stringify({ id }))]);
    return Object.assign(stream, {
        method: "POST", url: "/__bili/notices/dismiss", headers: { host: "127.0.0.1" }, socket: { remoteAddress: "127.0.0.1" },
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
async function dismiss(id: string): Promise<{ code?: number; body?: string }> {
    const { res, out } = mkRes();
    await handleAdminRoute(postReq(id), res, makeCtx());
    return out;
}

test("endpoint dismisses a persistent LOCAL notice (content-addressed)", async () => {
    fs.mkdirSync(annDir, { recursive: true });
    const raw = { id: "team-note", kind: "suggestion", title: { "zh-CN": "提示", en: "Note" } };
    fs.writeFileSync(path.join(annDir, "a.json"), JSON.stringify(raw));
    try {
        assert.equal(visibleLocalNotices().some((n) => n.id === "team-note"), true, "visible before");
        const out = await dismiss("team-note");
        assert.equal(out.code, 200, `endpoint must accept the dismiss (got ${out.code}: ${out.body})`);
        assert.equal(visibleLocalNotices().some((n) => n.id === "team-note"), false, "suppressed after");
    } finally {
        fs.rmSync(path.join(annDir, "a.json"), { force: true });
    }
});

test("built-in PCK still dismisses via the bare allowlist id (legacy path)", async () => {
    const out = await dismiss(PCK_NOTICE_ID);
    assert.equal(out.code, 200, `builtin dismiss must succeed (got ${out.code}: ${out.body})`);
    assert.equal(dismissedUpgradeNotices(process.env).has(PCK_NOTICE_ID), true, "bare id written, not a hash");
});

test("unknown id still 400s (unchanged)", async () => {
    const out = await dismiss("no-such-notice-xyz");
    assert.equal(out.code, 400, `unknown id must be rejected (got ${out.code})`);
});

test("endpoint dismisses a persistent REMOTE feed entry (content-addressed)", async () => {
    _resetRemoteNoticesForTest();
    const doc = JSON.stringify({ v: 1, entries: [{ id: "feed-note", kind: "warning", title: { "zh-CN": "远程", en: "Remote" } }] });
    const srv = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(doc); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: `http://127.0.0.1:${port}/feed`, log: () => {} }, true);
        assert.equal(visibleRemoteRecords().some((r) => r.id === "feed-note"), true, "remote visible before");
        const out = await dismiss("feed-note");
        assert.equal(out.code, 200, `remote endpoint must accept the dismiss (got ${out.code}: ${out.body})`);
        assert.equal(visibleRemoteRecords().some((r) => r.id === "feed-note"), false, "suppressed after");
    } finally {
        srv.closeAllConnections?.();
        await new Promise<void>((r) => srv.close(() => r()));
        _resetRemoteNoticesForTest();
    }
});
