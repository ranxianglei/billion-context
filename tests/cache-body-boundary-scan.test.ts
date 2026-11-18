import assert from "node:assert/strict";
import { test } from "node:test";
import { getCacheLedger, noteForwardedBody, settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let serial = 0;
function session(): Session {
    return {
        id: `boundary-scan-${++serial}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function settle(s: Session, body: string): void {
    noteForwardedBody(s, body);
    settleUsageReport(s, { total: 100_000, reportedCached: 99_000, output: 0, protocol: "openai", upstream: "http://fixture" });
}

const tail = { max_tokens: 16384, stop: ["end-of-turn", "stop-marker-one", "stop-marker-two", "presence-padding-field"] };

test("ordinary long-history appends do not repeatedly scan the retained body suffix", () => {
    const s = session();
    const messages = Array.from({ length: 600 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Turn ${i}: ${"ordinary conversation text ".repeat(12)}` }));
    settle(s, JSON.stringify({ model: "m", messages, ...tail }));
    const previous = s.transient?.settledBody?.full;
    assert.ok(previous);
    const originalIndexOf = previous.indexOf;
    const search = originalIndexOf.bind(previous);
    let scannedBytes = 0;
    // Count actual native search spans on this captured body only. No clock
    // threshold: a search that finds nothing has inspected the whole suffix.
    previous.indexOf = (value: string | number | Uint8Array, offsetOrEncoding?: number | BufferEncoding, encoding?: BufferEncoding): number => {
        const found = typeof offsetOrEncoding === "string" ? search(value, offsetOrEncoding) : search(value, offsetOrEncoding, encoding);
        const start = typeof offsetOrEncoding === "number" ? offsetOrEncoding : 0;
        scannedBytes += Math.max(0, (found === -1 ? previous.length : found + 1) - start);
        return found;
    };
    try {
        settle(s, JSON.stringify({ model: "m", messages: [...messages, { role: "user", content: "Continue." }], ...tail }));
    } finally {
        previous.indexOf = originalIndexOf;
    }
    assert.equal(getCacheLedger(s).lines.at(-1)?.bs, "tail");
    assert.ok(scannedBytes <= previous.length * 8, `searched ${scannedBytes} bytes for a ${previous.length}-byte body`);
});

for (const key of ["messages", "input", "contents"]) {
    test(`${key}: nested arrays and escaped delimiters retain tail and mid classifications`, () => {
        const messages = Array.from({ length: 25 }, (_, i) => ({
            role: "user",
            content: [{ type: "text", text: `Turn ${i}: ${'汉字 ] } " \\ \\\\ '.repeat(12)}` }],
        }));
        const first = JSON.stringify({ model: "m", [key]: messages, ...tail });
        const s = session();
        settle(s, first);
        settle(s, JSON.stringify({ model: "m", [key]: messages, ...tail, max_tokens: 4096 }));
        assert.equal(getCacheLedger(s).lines.at(-1)?.bs, "tail");

        const rewritten = structuredClone(messages);
        rewritten[12]!.content[0]!.text = rewritten[12]!.content[0]!.text.replace("汉字", "改写");
        settle(s, JSON.stringify({ model: "m", [key]: rewritten, ...tail, max_tokens: 4096 }));
        assert.equal(getCacheLedger(s).lines.at(-1)?.bs, "mid");
    });
}

test("an unlocatable history array keeps the conservative mid classification", () => {
    const s = session();
    const payload = "ordinary prose ".repeat(200);
    settle(s, JSON.stringify({ model: "m", payload, ...tail }));
    settle(s, JSON.stringify({ model: "m", payload, ...tail, max_tokens: 4096 }));
    assert.equal(getCacheLedger(s).lines.at(-1)?.bs, "mid");
});
