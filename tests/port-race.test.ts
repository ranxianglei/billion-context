import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { canConnect, assertPortDead } from "./port-race.ts";

function listen(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ server, port });
        });
    });
}

function close(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("canConnect: true on a live listener, false on a dead port", async () => {
    const { server, port } = await listen();
    try {
        assert.equal(await canConnect(port), true);
    } finally {
        await close(server);
    }
    assert.equal(await canConnect(port), false);
});

test("assertPortDead: resolves once a squatter releases the port", async () => {
    const { server, port } = await listen();
    const probing = assertPortDead(port, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 150));
    await close(server);
    await probing;
});

test("assertPortDead: throws the squat diagnostic when the port stays held", async () => {
    const { server, port } = await listen();
    try {
        await assert.rejects(
            assertPortDead(port, { timeoutMs: 400, intervalMs: 50, label: "squatted-port" }),
            (err: unknown) => err instanceof Error && /still accepting connections after 400ms/.test(err.message) && /squatted-port/.test(err.message),
        );
    } finally {
        await close(server);
    }
});

test("assertPortDead: resolves fast on an already-dead port", async () => {
    const { server, port } = await listen();
    await close(server);
    const started = Date.now();
    await assertPortDead(port, { timeoutMs: 5_000 });
    assert.ok(Date.now() - started < 1_000);
});
