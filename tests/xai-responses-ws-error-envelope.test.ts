// x.ai rejects a stale previous_response_id on the Responses WebSocket with an
// HTTP-style envelope and no top-level type. OpenAI sends
// {type:"error", error:{code:"previous_response_not_found"}}. Treating the x.ai
// frame as a protocol violation closed the socket and armed emergency shrink
// even though the existing resend-full path recovers the turn.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ResponsesWsUpstream } from "../src/responses-ws.ts";

type Item = Record<string, unknown>;

const user = (text: string): Item => ({ type: "message", role: "user", content: text });
const assistant = (text: string): Item => ({ type: "message", role: "assistant", content: text });

function completedFrame(id: string, output: Item[]): string {
    return JSON.stringify({
        type: "response.completed",
        response: { id, status: "completed", output },
    });
}

async function upstream() {
    const seen: Item[] = [];
    const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server });
    let serial = 0;
    wss.on("connection", peer => {
        peer.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Item;
            seen.push(request);
            if (typeof request.previous_response_id === "string") {
                peer.send(JSON.stringify({
                    error: {
                        message: `gRPC error: Response with id=${request.previous_response_id} not found`,
                        type: "api_error",
                    },
                }));
                return;
            }
            const id = `resp_xai_${++serial}`;
            const output = [assistant(`ok-${serial}`)];
            peer.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
            peer.send(completedFrame(id, output));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    return {
        seen,
        url: `http://127.0.0.1:${port}/v1/responses`,
        close: () => new Promise<void>(resolve => { wss.close(); server.close(() => resolve()); }),
    };
}

test("x.ai untyped response-not-found envelope resends the full request", { timeout: 15000 }, async () => {
    const fake = await upstream();
    const log: string[] = [];
    const transport = new ResponsesWsUpstream((_level, message) => log.push(message));
    const firstInput = [user("one")];
    const firstOutput = [assistant("ok-1")];
    try {
        const first = await transport.fetch(fake.url, {
            method: "POST",
            body: JSON.stringify({ model: "grok-4", input: firstInput }),
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(first.status, 200);
        assert.equal((await first.json() as Item).id, "resp_xai_1");
        const second = await transport.fetch(fake.url, {
            method: "POST",
            body: JSON.stringify({ model: "grok-4", input: [...firstInput, ...firstOutput, user("two")] }),
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(second.status, 200, "continuation miss must recover, not fail the turn");
        const recovered = await second.json() as Item;
        assert.equal(recovered.status, "completed");
        assert.equal(recovered.id, "resp_xai_2");
        assert.equal(fake.seen.length, 3, JSON.stringify(fake.seen.map(row => row.previous_response_id ?? "full")));
        assert.equal(fake.seen[0].previous_response_id, undefined);
        assert.equal(fake.seen[1].previous_response_id, "resp_xai_1");
        assert.equal(fake.seen[2].previous_response_id, undefined, "retry must drop the dead checkpoint");
        assert.deepEqual(fake.seen[2].input, [...firstInput, ...firstOutput, user("two")]);
        const text = log.join("\n");
        assert.match(text, /upstream retry reason=continuation-rejected action=resend-full/);
        assert.doesNotMatch(text, /resp_xai_1|Invalid Responses WebSocket event/);
    } finally {
        transport.close();
        await fake.close();
    }
});

test("an untyped error envelope that is not a missing response is surfaced, not a socket kill", { timeout: 15000 }, async () => {
    const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server });
    let sends = 0;
    wss.on("connection", peer => {
        peer.on("message", () => {
            sends++;
            peer.send(JSON.stringify({ error: { message: "rate limit", type: "api_error" } }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const transport = new ResponsesWsUpstream();
    try {
        const response = await transport.fetch(`http://127.0.0.1:${port}/v1/responses`, {
            method: "POST",
            body: JSON.stringify({ model: "grok-4", input: [user("one")] }),
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as Item;
        assert.equal((body.error as Item).message, "rate limit");
        assert.equal(sends, 1, "a non-continuation error must not be resent");
    } finally {
        transport.close();
        await new Promise<void>(resolve => { wss.close(); server.close(() => resolve()); });
    }
});
