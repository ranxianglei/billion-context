import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inline-body-cancel-"));
const previous = new Map<string, string | undefined>();
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
    previous.set(name, process.env[name]);
    process.env[name] = path.join(root, name);
}
const { getInlineEngine, INLINE_ORIGIN, _resetInlineEngineForTest } = await import("../src/inline-engine.ts");
const engine = await getInlineEngine();
const streams: http.ServerResponse[] = [];
const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        streams.push(res);
        if (req.url === "/complete") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("complete response");
        } else if (req.url === "/v1/messages") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first token"}}\n\n');
        } else {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.write("first chunk\n");
        }
        // All non-complete responses stay open and idle. Only cancellation
        // should end them; another upstream chunk cannot mask a missing hook.
    });
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const target = `${INLINE_ORIGIN}/bili/http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    _resetInlineEngineForTest();
    for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

async function closesPromptly(res: http.ServerResponse): Promise<void> {
    if (res.destroyed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            new Promise<void>(resolve => res.once("close", resolve)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("upstream remained open after response body cancellation")), 1000); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

for (const mode of ["unread body", "active reader", "reader with caller signal"]) {
    test(`cancelling the ${mode} closes an idle raw upstream`, { timeout: 10_000 }, async () => {
        const controller = new AbortController();
        const response = await engine.dispatch(`${target}/raw`, mode === "reader with caller signal" ? { signal: controller.signal } : undefined, globalThis.fetch);
        assert.equal(response.status, 200);
        const upstreamResponse = streams.at(-1)!;
        try {
            if (mode === "unread body") {
                await response.body!.cancel("caller no longer needs the response");
            } else {
                const reader = response.body!.getReader();
                assert.equal((await reader.read()).done, false);
                await reader.cancel(new Error("caller stopped reading"));
                assert.equal((await reader.read()).done, true);
                reader.releaseLock();
            }
            await closesPromptly(upstreamResponse);
            assert.equal(controller.signal.aborted, false, "stream cancellation does not abort the caller-owned controller");
        } finally {
            upstreamResponse.destroy();
        }
    });
}

test("cancelling the model response reader stops an idle SSE generation", { timeout: 10_000 }, async () => {
    const response = await engine.dispatch(`${target}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": "inline-body-cancel-model" },
        body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }, globalThis.fetch);
    assert.equal(response.status, 200);
    const upstreamResponse = streams.at(-1)!;
    const reader = response.body!.getReader();
    try {
        let text = "";
        while (!text.includes("first token")) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            text += Buffer.from(chunk.value!).toString();
        }
        await reader.cancel();
        await closesPromptly(upstreamResponse);
    } finally {
        reader.releaseLock();
        upstreamResponse.destroy();
    }
});

test("normal response completion remains readable", async () => {
    const response = await engine.dispatch(`${target}/complete`, undefined, globalThis.fetch);
    assert.equal(await response.text(), "complete response");
});
