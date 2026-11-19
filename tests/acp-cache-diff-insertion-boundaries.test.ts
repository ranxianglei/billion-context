import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareWires, runDiff } from "../src/acp-cache-diff.ts";

const message = (text: string) => ({ role: "user", content: text });
const original = [message("first 日本語 😀"), message("last unchanged")];
const inserted = message("new instruction");
const wire = (key: string, messages: unknown[], extra: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ model: "fixture", ...extra, [key]: messages }));

for (const key of ["messages", "input", "contents"]) {
    test(`${key}: inserting a whole message before existing history is a divergence`, () => {
        const result = compareWires(wire(key, original), wire(key, [inserted, ...original]));
        assert.equal(result.rel, "diverge");
        assert.equal(result.append, null);
    });

    test(`${key}: inserting a whole message between existing messages is a divergence`, () => {
        const result = compareWires(wire(key, original), wire(key, [original[0], inserted, original[1]]));
        assert.equal(result.rel, "diverge");
        assert.equal(result.append, null);
    });

    test(`${key}: growth before the root array is not growth inside a message`, () => {
        const result = compareWires(wire(key, original, { model: "fixture" }), wire(key, original, { model: "fixture-long" }));
        assert.equal(result.rel, "diverge");
        assert.equal(result.append, null);
        assert.equal(result.preArray, true);
    });

    test(`${key}: extending one message before a fixed trailer retains semantic append`, () => {
        const before = [message('FILTERED_HISTORY ["one"] PENDING_ACTION {"tool":"read"}'), original[1]];
        const after = [message('FILTERED_HISTORY ["one","two 日本語 😀"] PENDING_ACTION {"tool":"read"}'), original[1]];
        const result = compareWires(wire(key, before), wire(key, after));
        assert.equal(result.rel, "append");
        assert.deepEqual(result.append, { kind: "mid-insert", countA: 2, countB: 2 });
    });

    test(`${key}: empty and nonempty histories still accept ordinary tail appends`, () => {
        const first = compareWires(wire(key, []), wire(key, original));
        assert.equal(first.rel, "append");
        assert.equal(first.append?.countA, 0);
        assert.equal(first.append?.countB, 2);
        const more = compareWires(wire(key, original), wire(key, [...original, inserted]));
        assert.equal(more.rel, "append");
        assert.deepEqual(more.append, { kind: "json-tail", countA: 2, countB: 3 });
    });
}

test("a pure insertion in a preceding nested schema does not grow the root message", () => {
    const before = wire("messages", original, { tools: [{ examples: { messages: [message("a")] } }] });
    const after = wire("messages", original, { tools: [{ examples: { messages: [message("aa")] } }] });
    assert.equal(compareWires(before, after).rel, "diverge");
});

test("an empty root array with preserved whitespace still accepts its first message", () => {
    const before = Buffer.from('{"mess\\u0061ges":[  ]}');
    const after = Buffer.from('{"mess\\u0061ges":[  {"role":"user","content":"first"}]}');
    assert.equal(compareWires(before, after).rel, "append");
});

test("valid whitespace before a separator preserves growth inside a later message", () => {
    const before = '{"messages":[{"role":"system","content":"kept"} \n,\t {"role":"user","content":"head tail"} \n]}';
    const after = before.replace("head tail", "head more history tail");
    assert.equal(compareWires(Buffer.from(before), Buffer.from(after)).append?.kind, "mid-insert");
});

test("strict byte prefixes and substitutions retain their classifications", () => {
    assert.equal(compareWires(Buffer.from('{"a":1'), Buffer.from('{"a":12}')).append?.kind, "strict");
    assert.equal(compareWires(wire("messages", [message("before")]), wire("messages", [message("after!")])).rel, "diverge");
});

for (const producer of ["proxy", "client", "normalized"] as const) {
    test(`actual dump files retain ${producer} attribution for whole-message insertion`, async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "bili-insertion-boundary-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const before = wire("messages", original).toString();
        const after = wire("messages", [original[0], inserted, original[1]]).toString();
        const bIncoming = producer === "proxy" ? before : after;
        const bOutgoing = producer === "normalized" ? before : after;
        for (const [stamp, kind, body] of [[1000, "INCOMING", before], [1001, "REQ", before], [5000, "INCOMING", bIncoming], [5001, "REQ", bOutgoing]]) {
            writeFileSync(join(dir, `${stamp}-session-${kind}.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
        }
        const report = await runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 1);
        const pair = report.sessions[0]!.pairs[0]!;
        if (producer === "normalized") {
            assert.equal(pair.category, "pure-append");
            assert.equal(pair.incoming, "diverge");
            assert.ok(pair.notes.some((note) => note.includes("client rewrote history")));
        } else {
            assert.equal(pair.category, "mid-stream-rewrite");
            assert.equal(pair.attribution, producer);
            assert.equal(pair.divergence?.messageIndex, 1);
            assert.equal(pair.divergence?.roleType, "user");
        }
    });
}

test("actual dump reports retain the field-level note when a model name grows", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-insertion-field-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const before = wire("messages", original, { model: "fixture" }).toString();
    const after = wire("messages", original, { model: "fixture-long" }).toString();
    for (const [stamp, kind, body] of [[1000, "INCOMING", before], [1001, "REQ", before], [5000, "INCOMING", before], [5001, "REQ", after]]) {
        writeFileSync(join(dir, `${stamp}-session-${kind}.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
    }
    const pair = (await runDiff(dir, { noLog: true })).sessions[0]!.pairs[0]!;
    assert.equal(pair.category, "mid-stream-rewrite");
    assert.equal(pair.attribution, "proxy");
    assert.equal(pair.divergence?.messageIndex, null);
    assert.ok(pair.notes.includes("divergence before the message array (field-level change)"));
});
