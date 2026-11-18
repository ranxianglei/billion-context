import test from "node:test";
import assert from "node:assert/strict";
import { once, type EventEmitter } from "node:events";
import type { Server } from "node:http";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

const events: Array<"uncaughtException" | "unhandledRejection" | NodeJS.Signals> = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT",
    ...(process.platform === "win32" ? ["SIGBREAK" as const] : [])];
const processEvents: EventEmitter = process;
const snapshot = () => new Map(events.map((event) => [event, processEvents.listeners(event)]));

async function start(): Promise<Server> {
    const server = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1:9", routes: {},
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(server, "listening");
    return server;
}

async function close(server: Server): Promise<void> {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
}

function assertSameListeners(expected: ReturnType<typeof snapshot>): void {
    for (const event of events) assert.deepEqual(processEvents.listeners(event), expected.get(event), event);
}

// Remove only this test's leaked handlers when checking the unfixed base so
// one failing regression does not contaminate the next independent scenario.
function restoreListeners(before: ReturnType<typeof snapshot>): void {
    for (const event of events) {
        for (const listener of processEvents.listeners(event)) {
            if (!before.get(event)?.includes(listener)) process.removeListener(event, listener as (...args: unknown[]) => void);
        }
    }
}

// #7026 review follow-up (windows CI red, discussions/6884 audit): on POSIX,
// process.kill(self, sig) dispatches to Node's signal handlers. On WINDOWS the
// same call terminates the process (TerminateProcess) WITHOUT running the
// handlers — the runtime only honors real console control events, and Node's
// own docs state "On Windows, the signal being used to terminate a process
// cannot be changed. SIGTERM is sent." (Verified on a win10 box: SIGINT and
// SIGTERM self-kills die the process with the handler never invoked.) The
// original test 4 therefore killed its own child on the windows-latest CI
// runner before any assertion could run. Invoke the installed handler directly
// instead: it exercises the identical shutdown() path a console Ctrl+C would
// deliver.
const sendSignal = (sig: NodeJS.Signals): void => {
    if (process.platform === "win32") {
        const listeners = processEvents.listeners(sig) as Array<(...args: unknown[]) => void>;
        listeners[listeners.length - 1]?.();
        return;
    }
    process.kill(process.pid, sig);
};

test("closing each server releases its process handlers across repeated lifecycles", async () => {
    const before = snapshot();
    const servers: Server[] = [];
    try {
        for (let i = 0; i < 3; i += 1) {
            const server = await start();
            servers.push(server);
            for (const event of events) assert.equal(process.listenerCount(event), before.get(event)!.length + 1, event);
            await close(server);
            assertSameListeners(before);
        }
    } finally {
        await Promise.all(servers.map(close));
        restoreListeners(before);
    }
});

test("closing one server keeps another live server and foreign process handlers", async () => {
    const before = snapshot();
    const foreign = () => {};
    for (const event of events) process.on(event, foreign);
    const withForeign = snapshot();
    const servers: Server[] = [];
    try {
        const first = await start();
        servers.push(first);
        const withFirst = snapshot();
        const second = await start();
        servers.push(second);
        await close(second);
        assertSameListeners(withFirst);
        assert.equal(first.listening, true);
        await close(first);
        assertSameListeners(withForeign);
    } finally {
        await Promise.all(servers.map(close));
        restoreListeners(before);
    }
});

test("re-listening restores exactly one handler set and closing removes it again", async () => {
    const before = snapshot();
    let server: Server | undefined;
    try {
        server = await start();
        const serving = snapshot();
        await close(server);
        assertSameListeners(before);
        const listening = once(server, "listening");
        server.listen(0, "127.0.0.1");
        await listening;
        assertSameListeners(serving);
        await close(server);
        assertSameListeners(before);
    } finally {
        if (server) await close(server);
        restoreListeners(before);
    }
});

// #7026 review: the "close" event fires when the listener stops accepting, BEFORE
// the session flush in finishDrain. Handlers stripped there left the flush window
// unprotected — a second Ctrl+C would kill the process mid-flush. The handlers
// must survive until the process actually exits. (Placed last: shutdown() latches
// the module-level flag, so the clean-remove tests above must run first.)
// #7026 review: the "close" event fires when the listener stops accepting,
// BEFORE the session flush in finishDrain. Handlers stripped there left the
// flush window unprotected — a second Ctrl+C would kill the process mid-flush.
// The handlers must survive until the process actually exits. (Placed last:
// shutdown() latches the module-level flag, so the clean-remove tests above
// must run first.)
test("graceful shutdown keeps signal handlers until the process exits", async () => {
    const before = snapshot();
    const realExit = process.exit;
    const exits: Array<number | string | undefined> = [];
    process.exit = ((code?: number | string) => { exits.push(code); }) as typeof process.exit;
    const server = await start();
    try {
        const serving = snapshot();
        sendSignal("SIGINT");
        await once(server, "close");
        // Let the shutdown chain reach (the stubbed) process.exit first: the
        // test process must not drain out from under the assertions while the
        // flush is still running. Bounded wait instead of a fixed 500ms sleep
        // — each flush stage is deadline-capped at EXIT_FLUSH_DEADLINE_MS
        // (5s), so a fixed sleep races slow volumes (windows CI first).
        for (let i = 0; i < 600 && exits.length === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertSameListeners(serving);
        // Second Ctrl+C during the flush window: must be absorbed by the
        // idempotent shutdown(), not delivered to Node's default handler.
        sendSignal("SIGTERM");
        await new Promise((resolve) => setImmediate(resolve));
        assertSameListeners(serving);
        assert.ok(exits.length <= 1);
    } finally {
        restoreListeners(before);
        // This is the file's LAST test: if the shutdown chain has not reached
        // the stubbed exit yet, keep the stub in place — a late REAL exit(0)
        // would kill the runner before the TAP summary is written. The node
        // --test child ends via event-loop drain, not process.exit, so the
        // pending chain's exit(0) is then harmlessly recorded instead of fired.
        if (exits.length === 0) return;
        process.exit = realExit;
    }
});
