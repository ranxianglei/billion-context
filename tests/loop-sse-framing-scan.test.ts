import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";
import { createSseFramer, finalizeSseLineEndings } from "../src/sse-util.ts";

function chunks(wire: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({ pull(controller) {
        if (offset >= wire.length) { controller.close(); return; }
        controller.enqueue(wire.subarray(offset, offset + chunkSize));
        offset += chunkSize;
    } });
}

function googleFrame(payload: string): string {
    return `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Generated image." }, { inlineData: { mimeType: "image/png", data: payload } }] } }] })}\n\n`;
}

async function googleOutput(wire: Buffer, chunkSize: number): Promise<string> {
    const adapter = createGoogleAdapter({}, undefined, undefined, "gemini-test");
    const parts: Buffer[] = [];
    for await (const event of adapter.parseStream(chunks(wire, chunkSize), 1)) {
        if (event.kind === "meta") parts.push(event.chunk);
        else if ("raw" in event && event.raw) parts.push(event.raw);
    }
    return Buffer.concat(parts).toString("utf8");
}

test("Google loop framing scans newly received bytes, not the accumulated image prefix", async (t) => {
    const frame = googleFrame("A".repeat(1024 * 1024));
    const wire = Buffer.from(frame);
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
    assert.equal(await googleOutput(wire, 4 * 1024), frame, "the complete image/text frame stays byte-exact");
    t.diagnostic(`SSE searches examined ${searchedChars} characters for ${wire.length} received bytes`);
    assert.ok(searchedChars <= wire.length * 8, `SSE searches examined ${searchedChars} characters for ${wire.length} received bytes`);
});

for (const ending of ["\n", "\r\n", "\r"]) {
    test(`Google loop framing retains Unicode across one-byte ${JSON.stringify(ending)} splits`, async () => {
        const normalized = googleFrame("你好🔥");
        const wire = Buffer.from(normalized.replaceAll("\n", ending));
        assert.equal(await googleOutput(wire, 1), normalized);
    });
}

function frameChunks(parts: string[]): string[] {
    const framer = createSseFramer();
    return [...parts.flatMap(part => [...framer.push(part)]), ...framer.finish()];
}

function wholeFrames(text: string): string[] {
    const frames = finalizeSseLineEndings(text).split("\n\n");
    if (frames.at(-1) === "") frames.pop();
    return frames;
}

test("incremental framing preserves complete-field whitespace and EOF residuals at every split", () => {
    const inputs = [
        "", "\n", "\r", "\r\n", "\n\n\n", "\n\ndata: tail", "\ndata: tail\n",
        ":comment\r\nid:  1\r\nevent: update\r\ndata: {\r\ndata:   \"text\": \"你好🔥\"\r\ndata: }\r\n\r\n",
        "data\ndata:   indented\ndata:\n\ndata: residual\n",
        "event: partial\rdata: {\"text\":\"tail\"}\r",
    ];
    for (const input of inputs) {
        const expected = wholeFrames(input);
        for (let cut = 0; cut <= input.length; cut++) {
            assert.deepEqual(frameChunks([input.slice(0, cut), input.slice(cut)]), expected, `split ${cut}: ${JSON.stringify(input)}`);
        }
        assert.deepEqual(frameChunks(input.split("")), expected, `one-character chunks: ${JSON.stringify(input)}`);
    }
});

test("all short CR/LF combinations match the previous whole-buffer framing", () => {
    const alphabet = ["a", "\r", "\n"];
    let values = [""];
    for (let length = 0; length <= 6; length++) {
        for (const value of values) {
            const expected = wholeFrames(value);
            for (let cut = 0; cut <= value.length; cut++) {
                assert.deepEqual(frameChunks([value.slice(0, cut), value.slice(cut)]), expected);
            }
        }
        values = values.flatMap(value => alphabet.map(char => value + char));
    }
});
