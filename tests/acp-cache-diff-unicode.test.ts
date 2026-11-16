import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareWires, runDiff } from "../src/acp-cache-diff.ts";
import { rmrf } from "./tmp-rm.ts";

const message = { role: "user", content: "same question" };

for (const key of ["messages", "input", "contents"]) {
    for (const prefix of ["界".repeat(100), "😀".repeat(100)]) {
        test(`classifies a Unicode-prefixed field rewrite before ${key} as divergence`, () => {
            const before = Buffer.from(JSON.stringify({ system: `${prefix}A`, [key]: [message] }));
            const after = Buffer.from(JSON.stringify({ system: `${prefix}B`, [key]: [message] }));
            const result = compareWires(before, after);
            assert.equal(result.rel, "diverge");
            assert.equal(result.preArray, true);
            assert.equal(result.append, null);
            assert.equal(result.byteOffset, after.indexOf(Buffer.from("B")));
        });
    }
}

async function pair(before: string, after: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-diff-unicode-"));
    try {
        for (const [stamp, body] of [[1000, before], [2000, after]] as const) {
            for (const kind of ["REQ", "INCOMING"]) {
                fs.writeFileSync(path.join(dir, `${stamp}-unicode-${kind}.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
            }
        }
        const report = await runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 1);
        return report.sessions[0]!.pairs[0]!;
    } finally { rmrf(dir); }
}

test("locates rewritten message evidence after a multibyte history prefix while retaining wire byte offsets", async () => {
    const make = (text: string) => JSON.stringify({ messages: [{ role: "user", content: "界".repeat(100) }, { role: "assistant", content: text }] });
    const before = make("OLD answer"), after = make("NEW answer");
    const report = await pair(before, after);
    assert.equal(report.category, "mid-stream-rewrite");
    assert.equal(report.attribution, "client");
    assert.equal(report.divergence?.messageIndex, 1);
    assert.equal(report.divergence?.offset, Buffer.from(after).indexOf(Buffer.from("NEW")));
    assert.ok(report.divergence?.after.startsWith("NEW answer"));
});

test("places evidence at the beginning of a code point when differing bytes are inside it", async () => {
    const make = (text: string) => JSON.stringify({ messages: [{ role: "user", content: text }] });
    const report = await pair(make("😀 old"), make("😁 old"));
    assert.equal(report.divergence?.messageIndex, 0);
    assert.ok(report.divergence?.after.startsWith("😁 old"), report.divergence?.after);
});

test("retains healthy appends and trailing-field changes after Unicode messages", () => {
    const first = { role: "user", content: "界😀".repeat(80) };
    const before = Buffer.from(JSON.stringify({ messages: [first], stream: false }));
    const appended = Buffer.from(JSON.stringify({ messages: [first, message], stream: false }));
    const trailing = Buffer.from(JSON.stringify({ messages: [first], stream: true }));
    assert.equal(compareWires(before, appended).append?.kind, "json-tail");
    assert.equal(compareWires(before, trailing).append?.kind, "tail-fields");
});

test("retains ASCII prefix-field attribution", () => {
    const result = compareWires(Buffer.from(JSON.stringify({ model: "old", messages: [message] })), Buffer.from(JSON.stringify({ model: "new", messages: [message] })));
    assert.equal(result.rel, "diverge");
    assert.equal(result.preArray, true);
});
