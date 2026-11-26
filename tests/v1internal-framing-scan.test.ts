import assert from "node:assert/strict";
import test from "node:test";
import { v1UnwrapStream } from "../src/v1internal.ts";

function chunks(wire: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({ pull(controller) {
        if (offset >= wire.length) { controller.close(); return; }
        controller.enqueue(wire.subarray(offset, offset + size));
        offset += size;
    } });
}

for (const mode of ["sse", "json"] as const) {
    test(`CloudCode ${mode} unwrapping scans each received image fragment once`, async (t) => {
        const response = { candidates: [{ content: { role: "model", parts: [
            { text: "Generated image." },
            { inlineData: { mimeType: "image/png", data: "A".repeat(1024 * 1024) } },
        ] } }] };
        const envelope = JSON.stringify({ response, traceId: "upstream", metadata: {} });
        const wire = Buffer.from(mode === "sse" ? `data: ${envelope}\n\n` : envelope);
        const expected = mode === "sse" ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response);
        const indexOf = String.prototype.indexOf;
        let searchedChars = 0;
        t.mock.method(String.prototype, "indexOf", function (this: string, needle: string, position?: number): number {
            const value = String(this);
            const result = indexOf.call(value, needle, position);
            if (needle === "\r" || needle === "\n\n" || needle === "\n") {
                const start = Math.max(0, position ?? 0);
                searchedChars += Math.max(0, (result < 0 ? value.length : result + needle.length) - start);
            }
            return result;
        });
        assert.equal(await new Response(v1UnwrapStream(chunks(wire, 4096))).text(), expected);
        t.diagnostic(`newline searches examined ${searchedChars} characters for ${wire.length} received bytes`);
        assert.ok(searchedChars <= wire.length * 8, "unfinished image prefixes must not be rescanned per chunk");
    });
}

const response = { candidates: [{ content: { role: "model", parts: [{ text: "你好🔥" }] } }] };
const envelope = JSON.stringify({ response, traceId: "trace", metadata: {} });
for (const eol of ["\n", "\r\n", "\r"]) {
    test(`CloudCode one-byte ${JSON.stringify(eol)} chunks retain fields, separators and EOF residuals`, async () => {
        const input = `\n\nevent: message\nid: 42\ndata: ${envelope}\n\ndata: [DONE]\n\n: tail\n`;
        const expected = `\n\nevent: message\nid: 42\ndata: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n: tail\n`;
        const raw = Buffer.from(input.replaceAll("\n", eol));
        assert.equal(await new Response(v1UnwrapStream(chunks(raw, 1))).text(), expected);
    });
}

for (const [input, expected] of [
    ["\uFEFF\r\n \t" + envelope + "\r\n", JSON.stringify(response)],
    ["\r\n \t", ""],
    [" { broken\rjson\r\n", "{ broken\njson"],
    [`data: ${envelope}\n\r`, `data: ${JSON.stringify(response)}\n\n`],
    [`data: ${envelope}`, `data: ${JSON.stringify(response)}`],
]) {
    test(`CloudCode retains the existing terminal shape: ${JSON.stringify(input.slice(0, 25))}`, async () => {
        assert.equal(await new Response(v1UnwrapStream(chunks(Buffer.from(input), 1))).text(), expected);
    });
}

test("CloudCode emits a complete frame before HTTP EOF and flushes partial UTF-8 at EOF", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const reader = v1UnwrapStream(input).getReader();
    source.enqueue(Buffer.from(`data: ${envelope}\r\n\r\n`));
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString(), `data: ${JSON.stringify(response)}\n\n`);
    source.enqueue(Uint8Array.from([0x3a, 0x20, 0xf0, 0x9f]));
    source.close();
    const last = await reader.read();
    assert.equal(Buffer.from(last.value!).toString(), ": �");
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
});
