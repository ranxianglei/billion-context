import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleResponsesInputTurn, resetResponsesInputLane } from "../src/responses-lane.ts";

const servers: ReturnType<typeof createServer>[] = [];
after(async () => {
    for (const server of servers) {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    resetResponsesInputLane();
});

async function fixture(forward: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const busy = new Set<string>();
    const server = createServer(async (req, res) => {
        try {
            const parts: Buffer[] = [];
            for await (const part of req) {
                parts.push(Buffer.from(part));
            }
            const payload = JSON.parse(Buffer.concat(parts).toString());
            await handleResponsesInputTurn(req, res, payload, payload.conversationId, payload.path, busy, forward);
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end(String(error));
        }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    return (payload: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-turn": "1", authorization: "Bearer synthetic" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
}

const user = { role: "user", content: [{ type: "input_text", text: "fixture β\n" }] };
const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "OPAQUE==β\n" };
const seed = { conversationId: "responses-lane-fixture", path: "/bili/provider/v1/responses", wireFormat: "responses", sinceSeq: 0, resync: true, request: { model: "gpt-fixture", instructions: "current" }, messages: [user] };

test("Responses HTTP forward reconstructs exact input, preserves auth/socket, and acknowledges wire count", async () => {
    resetResponsesInputLane();
    const seen: unknown[] = [];
    const send = await fixture(async (req, res) => {
        assert.equal(req.url, seed.path);
        assert.equal(req.headers.authorization, "Bearer synthetic");
        assert.equal(req.headers["x-bili-plugin-turn"], undefined);
        assert.equal(req.headers["x-bili-plugin-conversation"], seed.conversationId);
        assert.ok(req.socket.remoteAddress?.includes("127.0.0.1"));
        const parts: Buffer[] = [];
        for await (const part of req) {
            parts.push(Buffer.from(part));
        }
        const bytes = Buffer.concat(parts);
        assert.equal(req.headers["content-length"], String(bytes.length));
        seen.push(JSON.parse(bytes.toString()));
        res.writeHead(200, "OK", { "content-type": "text/event-stream" });
        res.end("data: synthetic\n\n");
    });
    const first = await send(seed);
    assert.equal(first.headers.get("x-bili-applied-seq"), "1");
    assert.equal(await first.text(), "data: synthetic\n\n");
    const next = await send({ ...seed, resync: false, sinceSeq: 1, messages: [reasoning] });
    assert.equal(next.headers.get("x-bili-applied-seq"), "2");
    await next.text();
    assert.deepEqual(seen, [
        { ...seed.request, input: [user] },
        { ...seed.request, input: [user, reasoning] },
    ]);
});

test("Responses HTTP failed forward has no ack or speculative prefix; route/cold errors never forward", async () => {
    resetResponsesInputLane();
    let status = 503;
    let calls = 0;
    const send = await fixture(async (_req, res) => { calls++; res.writeHead(status); res.end("synthetic"); });
    const failed = await send(seed);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("x-bili-applied-seq"), null);
    await failed.text();
    const cold = await send({ ...seed, resync: false, sinceSeq: 1, messages: [reasoning] });
    assert.equal(cold.status, 409);
    assert.equal(calls, 1);
    await cold.text();
    const bad = await send({ ...seed, path: "/__bili/status" });
    assert.equal(bad.status, 400);
    await bad.text();
    status = 200;
    const retry = await send(seed);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("x-bili-applied-seq"), "1");
    await retry.text();
});
