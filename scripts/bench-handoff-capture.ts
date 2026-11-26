// Real HTTP client -> production SSE parser -> saved handoff reply. An optional
// module path selects an unchanged historical createHandoffReply for comparison.
// Build fixtures outside the measured interval; validate complete wire + reply.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { createSession, type Session } from "../src/session.ts";
import { createHandoffReply } from "../src/server/handoff-response.ts";

const modulePath = process.argv[2];
const capture: typeof createHandoffReply = modulePath
    ? (await import(pathToFileURL(path.resolve(modulePath)).href) as typeof import("../src/server/handoff-response.ts")).createHandoffReply
    : createHandoffReply;
const scenarios = [
    { name: "unicode-3000", count: 3000, delta: "界😀".repeat(16) },
    { name: "ascii-3000", count: 3000, delta: "abcdefgh".repeat(12) },
    { name: "unicode-8", count: 8, delta: "界😀".repeat(16) },
];
let chunks: Buffer[] = [];
let session: Session;
const server = createServer((_req, res) => {
    session = createSession("handoff-capture-benchmark");
    const reply = capture(session);
    const source = new ReadableStream<Uint8Array>({ start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
    } });
    void pipePluginChatWithStrip(source, res, "openai", undefined, undefined, undefined, undefined, undefined, undefined, undefined, reply)
        .catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const rows: { name: string; deltas: number; textBytes: number; ms: number; wireBytes: number; outputSha256: string }[] = [];
try {
    for (const scenario of scenarios) {
        const frame = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: scenario.delta } }] })}\n\n`);
        chunks = Array.from({ length: scenario.count }, () => frame);
        chunks.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        const expected = scenario.delta.repeat(scenario.count);
        let warmupHash = "";
        for (let run = 0; run < 2; run++) {
            const start = performance.now();
            const response = await fetch(`http://127.0.0.1:${address.port}`);
            const wire = Buffer.from(await response.arrayBuffer());
            const ms = performance.now() - start;
            const saved = session!.metadata.handoffResponse;
            assert.deepEqual(saved, { request: 0, messages: [{ id: "reply_text_1", role: "assistant", contentType: "text", text: expected }] });
            const outputSha256 = createHash("sha256").update(wire).update(JSON.stringify(saved)).digest("hex");
            if (run === 0) warmupHash = outputSha256;
            else {
                assert.equal(outputSha256, warmupHash);
                rows.push({ name: scenario.name, deltas: scenario.count, textBytes: Buffer.byteLength(expected), ms, wireBytes: wire.length, outputSha256 });
            }
        }
    }
} finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log(JSON.stringify({ node: process.version, warmupsPerScenario: 1, measuredPerScenario: 1, rows }, null, 2));
