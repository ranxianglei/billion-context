// #5096: a launcher-spawned proxy that crashes on a fatal startup error must
// not leave the port dead and the reason buried at the END of the child log.
// Launcher failure messages need the tail sample plus a human cause for the
// EPERM/EACCES-on-own-data-files signature, and the child side needs the
// placeholder failure page (503 health that can never read as healthy).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
    classifyStartupFailure,
    startupFailureInfo,
    renderStartupFailurePage,
    createStartupFailureHandler,
    serveStartupFailurePage,
} from "../src/startup-failure-page.ts";
import { ensureProxyRunning, type ProbeOutcome, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

test("#5096 classifyStartupFailure: EPERM on a bili data path yields the antivirus/permission hint", () => {
    const fatal = `bili: failed to start: Error: EPERM: operation not permitted, open 'C:\\Users\\u\\.local\\share\\billion-context\\ca\\combined-ca.pem'`;
    const hint = classifyStartupFailure(fatal);
    assert.ok(hint.includes("antivirus"), hint);
    assert.ok(hint.includes("EPERM"), hint);
    assert.ok(classifyStartupFailure("StorageError: attempt to write a readonly database (index.db)").length > 0);
    assert.equal(classifyStartupFailure("Error: EPERM: operation not permitted, open 'C:\\random\\unrelated.txt'"), "");
    assert.equal(classifyStartupFailure("Error: something else entirely broke"), "");
    assert.equal(classifyStartupFailure(""), "");
});

test("#5096 startupFailureInfo keeps fs code/path and classifies the message", () => {
    const err = Object.assign(new Error("EPERM: operation not permitted, open 'C:\\Users\\u\\.local\\share\\billion-context\\ca\\combined-ca.pem'"), {
        code: "EPERM",
        path: "C:\\Users\\u\\.local\\share\\billion-context\\ca\\combined-ca.pem",
    });
    const info = startupFailureInfo(err, "127.0.0.1", 18787);
    assert.ok(info.message.includes("combined-ca.pem"), info.message);
    assert.ok(info.hint.includes("antivirus"), info.hint);
    assert.equal(info.origin, "http://127.0.0.1:18787/__bili/");
});

test("#5096 page escapes the error text and shows the hint only when classified", () => {
    const bad = startupFailureInfo(new Error("<script>alert(1)</script> EPERM open combined-ca.pem"), "127.0.0.1", 18787);
    const html = renderStartupFailurePage(bad);
    assert.ok(html.includes("&lt;script&gt;"), "raw markup must be escaped");
    assert.ok(!html.includes("<script>alert"), "unescaped payload must not survive");
    assert.ok(html.includes("受控文件夹访问"), "the zh hint must render for the permission signature");
    assert.ok(html.includes('http-equiv="refresh"'), "auto-refresh so a fixed environment replaces the page");
    const clean = startupFailureInfo(new Error("some unrelated crash"), "127.0.0.1", 18787);
    assert.ok(!renderStartupFailurePage(clean).includes("受控文件夹访问"), "no hint without the signature");
});

test("#5096 handler: health answers 503 ok:false, pages answer 503 html with the error", async () => {
    const info = startupFailureInfo(new Error("EPERM: operation not permitted, open 'C:\\x\\.local\\share\\billion-context\\ca\\combined-ca.pem'"), "127.0.0.1", 18787);
    const server = http.createServer(createStartupFailureHandler(info));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const health = await fetch(`${origin}/__bili/health`);
        assert.equal(health.status, 503, "a probe must never adopt this placeholder as healthy");
        const body = (await health.json()) as { ok: boolean; status: string };
        assert.equal(body.ok, false);
        assert.equal(body.status, "startup-failed");
        const page = await fetch(`${origin}/__bili/`);
        assert.equal(page.status, 503);
        assert.match(page.headers.get("content-type") ?? "", /text\/html/);
        assert.ok((await page.text()).includes("combined-ca.pem"));
    } finally {
        server.close();
    }
});

test("#5096 serveStartupFailurePage stays a no-op without the launcher token or a real port", async () => {
    const saved = process.env.BILI_LAUNCH_TOKEN;
    delete process.env.BILI_LAUNCH_TOKEN;
    try {
        assert.equal(await serveStartupFailurePage({ host: "127.0.0.1", port: 18787 }, new Error("x")), false);
        process.env.BILI_LAUNCH_TOKEN = "test-token";
        assert.equal(await serveStartupFailurePage({ host: "127.0.0.1", port: 0 }, new Error("x")), false);
    } finally {
        if (saved === undefined) delete process.env.BILI_LAUNCH_TOKEN;
        else process.env.BILI_LAUNCH_TOKEN = saved;
    }
});

test("#5096 serveStartupFailurePage resolves false when the port cannot be bound", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const saved = process.env.BILI_LAUNCH_TOKEN;
    process.env.BILI_LAUNCH_TOKEN = "test-token";
    try {
        assert.equal(
            await serveStartupFailurePage({ host: "127.0.0.1", port }, new Error("EPERM open combined-ca.pem")),
            false,
        );
    } finally {
        if (saved === undefined) delete process.env.BILI_LAUNCH_TOKEN;
        else process.env.BILI_LAUNCH_TOKEN = saved;
        await new Promise<void>((r) => blocker.close(() => r()));
    }
});

const PORT = 47841;
const LOG_FILE = path.join(os.tmpdir(), `bili-proxy-${PORT}.log`);

function cleanupLog(): void {
    try { fs.unlinkSync(LOG_FILE); } catch {}
}

function makeExittingChild(pid: number, code: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() { return true; },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            // queueMicrotask, NOT setImmediate: the fake-clock loop only ever
            // awaits already-resolved promises (same discipline as the #3116
            // harness — the exit must be visible on the first poll tick).
            if (event === "exit") queueMicrotask(() => list.forEach((l) => l(code, null)));
        },
    };
}

// The launcher records spawnLogOffset at spawn time, so "this spawn's output"
// must be appended AFTER spawnImpl ran — the first poll-loop sleep is the
// first await past that point.
function childOutputSleep(output: string): { now: () => number; sleep: () => Promise<void> } {
    let ticks = 0;
    let wrote = false;
    return {
        now: () => ticks * 1000,
        sleep: () => {
            ticks += 1;
            if (!wrote) {
                wrote = true;
                fs.appendFileSync(LOG_FILE, output);
            }
            return Promise.resolve();
        },
    };
}

test("#5096 launcher: crashed child with EPERM tail — error carries the tail sample and the cause hint", async () => {
    cleanupLog();
    const clock = childOutputSleep(
        `2026-10-29T00:57:56.400Z [warn] [storage] lockfile discipline skipped: EPERM open index.db.lock\n`.repeat(8) +
            `bili: failed to start: Error: EPERM: operation not permitted, open 'C:\\Users\\u\\.local\\share\\billion-context\\ca\\combined-ca.pem'\n`,
    );
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => makeExittingChild(42480, 1)) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLog();
    }
    const msg = (err as Error).message;
    assert.match(msg, /exited before becoming healthy \(code 1\)/);
    assert.ok(msg.includes('child output tail: "'), msg);
    assert.ok(msg.includes("combined-ca.pem"), `the fatal tail line must survive sampling: ${msg}`);
    assert.ok(msg.includes("possible cause:"), `the classified cause must be appended: ${msg}`);
    assert.ok(msg.includes("antivirus"), msg);
});

test("#5096 launcher: crash without the permission signature — tail sample still lands, no invented cause", async () => {
    cleanupLog();
    const clock = childOutputSleep(
        `starting up\n`.repeat(40) + `bili: failed to start: Error: listen EADDRINUSE: address already in use 127.0.0.1:${PORT}\n`,
    );
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => makeExittingChild(42481, 1)) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLog();
    }
    const msg = (err as Error).message;
    assert.ok(msg.includes("EADDRINUSE"), msg);
    assert.ok(msg.includes('child output tail: "'), msg);
    assert.ok(!msg.includes("possible cause:"), `no hint without the signature: ${msg}`);
});

test("#5096 launcher: a stale permission signature from an EARLIER spawn must not be attributed to this one", async () => {
    cleanupLog();
    // Pre-spawn remnant (below spawnLogOffset): an earlier crash left its
    // EPERM line in the append-only port log. This spawn's own output has no
    // permission signature — the hint must stay silent (#4811 discipline).
    fs.appendFileSync(
        LOG_FILE,
        `bili: failed to start: Error: EPERM: operation not permitted, open 'C:\\Users\\u\\.local\\share\\billion-context\\ca\\combined-ca.pem'\n`,
    );
    const clock = childOutputSleep(
        `starting up\n`.repeat(40) + `bili: failed to start: Error: listen EADDRINUSE: address already in use 127.0.0.1:${PORT}\n`,
    );
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => makeExittingChild(42482, 1)) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLog();
    }
    const msg = (err as Error).message;
    assert.match(msg, /exited before becoming healthy \(code 1\)/);
    assert.ok(!msg.includes("possible cause:"), `stale signature from the previous spawn leaked into the hint: ${msg}`);
});
