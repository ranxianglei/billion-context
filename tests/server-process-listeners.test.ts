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
