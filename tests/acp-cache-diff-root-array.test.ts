import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareWires, runDiff } from "../src/acp-cache-diff.ts";
import { rmrf } from "./tmp-rm.ts";

const first = { role: "user", content: "one" };
const changed = { role: "user", content: "two" };
const second = { role: "assistant", content: "answer" };
const wire = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

function request(key: string, messages: unknown[], example = "sample"): Record<string, unknown> {
    return {
        tools: [{
            type: "function",
            function: {
                name: "replay",
                parameters: { type: "object", properties: { defaults: { default: { [key]: [{ role: "user", content: example }] } } } },
            },
        }],
        [key]: messages,
    };
}

for (const key of ["messages", "input", "contents"]) {
    test(`cache diff: a nested ${key} example cannot hide a root history rewrite`, () => {
        const result = compareWires(wire(request(key, [first])), wire(request(key, [changed])));
        assert.equal(result.rel, "diverge");
        assert.equal(result.append, null);
        assert.equal(result.preArray, false);
    });

    test(`cache diff: root ${key} append uses its own element spans`, () => {
        const result = compareWires(wire(request(key, [first])), wire(request(key, [first, second])));
        assert.equal(result.rel, "append");
        assert.deepEqual(result.append, { kind: "json-tail", countA: 1, countB: 2 });
    });

    test(`cache diff: changing a nested ${key} example stays before the root array`, () => {
        const result = compareWires(wire(request(key, [first], "before")), wire(request(key, [first], "AFTER!")));
        assert.equal(result.rel, "diverge");
        assert.equal(result.preArray, true);
    });
}

test("cache diff: escaped root keys and delimiters inside strings retain root positions", () => {
    const a = Buffer.from('{"model":"old","note":"} [ \\\"messages\\\": [","mess\\u0061ges":[{"role":"user","content":"one"}]}');
    const b = Buffer.from(a.toString().replace('"old"', '"new"'));
    assert.doesNotThrow(() => JSON.parse(a.toString()));
    assert.doesNotThrow(() => JSON.parse(b.toString()));
    const result = compareWires(a, b);
    assert.equal(result.rel, "diverge");
    assert.equal(result.preArray, true);
});

test("cache diff: duplicate root keys use the last value as JSON.parse does", () => {
    const a = Buffer.from('{"messages":[{"role":"user","content":"example"}],"messages":[{"role":"user","content":"one"}]}');
    const b = Buffer.from(a.toString().replace('"one"', '"two"'));
    assert.equal(compareWires(a, b).rel, "diverge");
});

test("cache diff: ordinary arrays and strict byte prefixes keep their classifications", () => {
    assert.equal(compareWires(wire({ messages: [first] }), wire({ messages: [first, second] })).append?.kind, "json-tail");
    assert.equal(compareWires(wire({ messages: [first] }), wire({ messages: [changed] })).rel, "diverge");
    assert.equal(compareWires(Buffer.from('{"a":1'), Buffer.from('{"a":12}')).append?.kind, "strict");
});

test("cache diff: dumped nested examples cannot mask proxy rewriting in the public report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-diff-root-array-"));
    try {
        const incoming = JSON.stringify(request("messages", [first]));
        const rewritten = JSON.stringify(request("messages", [changed]));
        for (const [stamp, kind, body] of [[1000, "INCOMING", incoming], [1001, "REQ", incoming], [2000, "INCOMING", incoming], [2001, "REQ", rewritten]]) {
            fs.writeFileSync(path.join(dir, `${stamp}-ses_root-${kind}.txt`), `POST /v1/chat/completions\ncontent-type: application/json\n\n${body}`);
        }
        const report = await runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 1);
        const pair = report.sessions[0]!.pairs[0]!;
        assert.equal(pair.category, "mid-stream-rewrite");
        assert.equal(pair.attribution, "proxy");
        assert.equal(pair.divergence?.messageIndex, 0);
        assert.equal(pair.divergence?.roleType, "user");
    } finally {
        rmrf(dir);
    }
});
