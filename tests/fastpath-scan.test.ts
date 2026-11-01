import assert from "node:assert/strict";
import test from "node:test";
import { scanFastpath, sliceElementWindow, parseElementWindow } from "../src/server/fastpath-scan.ts";

// Reference parse of a body's messages array — the oracle every scanner
// assertion is checked against.
function refMessages(raw: string): unknown[] {
    const p = JSON.parse(raw) as { messages?: unknown };
    if (!Array.isArray(p.messages)) throw new Error("test body must have a messages array");
    return p.messages;
}

// The load-bearing invariant: slicing a window out of the raw string and
// re-parsing it yields EXACTLY the corresponding slice of a full parse. This
// is what makes "parse only the tail" safe — the bytes are identical, so the
// downstream core conversion sees the same values regardless of path.
function assertWindowRoundTrip(raw: string, lo: number, hi: number): void {
    const scan = scanFastpath(raw);
    assert.ok(scan, "scan should succeed");
    const ref = refMessages(raw);
    const got = parseElementWindow(raw, scan, lo, hi);
    assert.ok(Array.isArray(got));
    assert.deepEqual(got, ref.slice(lo, hi));
}

test("empty / non-object / no-messages inputs all degrade to null", () => {
    assert.equal(scanFastpath(""), null);
    assert.equal(scanFastpath("   "), null);
    assert.equal(scanFastpath("[1,2,3]"), null);          // top-level array
    assert.equal(scanFastpath('"str"'), null);            // top-level string
    assert.equal(scanFastpath("42"), null);               // top-level number
    assert.equal(scanFastpath("{}"), null);               // object, no messages
    assert.equal(scanFastpath('{"model":"x"}'), null);    // object, no messages key
    assert.equal(scanFastpath('{"messages":{"a":1}}'), null); // messages not an array
    assert.equal(scanFastpath('{"messages":"x"}'), null);      // messages a string
});

test("malformed bodies degrade to null (never throw)", () => {
    assert.equal(scanFastpath('{"messages":[{role:"user"'), null);       // truncated element
    assert.equal(scanFastpath('{"messages":["unterminated'), null);      // unterminated string
    assert.equal(scanFastpath('{"messages":[1,,2]}'), null);             // empty slot
    assert.equal(scanFastpath('{"messages":[1 2]}'), null);              // missing comma
    assert.equal(scanFastpath('{"messages":['), null);                   // truncated array
    assert.equal(scanFastpath('{"messages":[1}'), null);                 // array closed by }
    assert.equal(scanFastpath('{"messages":[{"a":\\}]},') , null);       // bad escape
    assert.equal(scanFastpath('{"messages":[1,}'), null);                // trailing comma
});

test("simple flat body: offsets match a full parse, count correct", () => {
    const raw = JSON.stringify({ model: "m", messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "again" },
    ] });
    const scan = scanFastpath(raw);
    assert.ok(scan, "flat body must scan");
    if (scan === null) throw new Error("unreachable");
    assert.equal(scan.count, 3);
    const ref = refMessages(raw);
    for (let i = 0; i < 3; i++) {
        const s: number = scan.elementOffsets[2 * i];
        const e: number = scan.elementOffsets[2 * i + 1];
        assert.deepEqual(JSON.parse(raw.slice(s, e)), ref[i]);
    }
    // The whole-array window round-trips too.
    assertWindowRoundTrip(raw, 0, 3);
    assertWindowRoundTrip(raw, 1, 3);
    assert.deepEqual(parseElementWindow(raw, scan, 2, 3), [ref[2]]);
});

test("nested braces/brackets inside values do not fool depth tracking", () => {
    const raw = JSON.stringify({
        model: "m",
        messages: [
            // Nested containers plus a leaf whose VALUE carries braces/brackets/quotes
            // (built via stringify so the escaping is provably correct).
            { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: 'echo { [ ] "done"' }) } }] },
            { role: "tool", tool_call_id: "c1", content: "result with { braces } and [ brackets ]" },
            { role: "user", content: "{ not json ] at all [" },
        ],
    });
    const scan = scanFastpath(raw);
    assert.ok(scan);
    assert.equal(scan.count, 3);
    assertWindowRoundTrip(raw, 0, 3);
    assertWindowRoundTrip(raw, 2, 3);
});

test("escaped quotes/backslashes and unicode (incl. surrogate pairs) in leaves", () => {
    const raw = JSON.stringify({
        messages: [
            { role: "user", content: 'say "hello" \\ backslash \t tab' },
            { role: "user", content: "emoji 🚀🌍 pair-ends" },
            { role: "user", content: "\\u0041 literal backslash-u in source" },
        ],
    });
    const scan = scanFastpath(raw);
    assert.ok(scan);
    assert.equal(scan.count, 3);
    assertWindowRoundTrip(raw, 0, 3);
    assertWindowRoundTrip(raw, 1, 3);
});

test("whitespace between tokens and pretty-printed bodies", () => {
    const raw = '{\n  "model" : "m" ,\n  "messages" : [\n    {"role":"user","content":"a"},\n\n    {"role":"user","content":"b"}\n  ]\n}';
    const scan = scanFastpath(raw);
    assert.ok(scan);
    assert.equal(scan.count, 2);
    assertWindowRoundTrip(raw, 0, 2);
    assertWindowRoundTrip(raw, 1, 2);
});

test("extra top-level fields before AND after messages survive the scan", () => {
    const raw = JSON.stringify({
        stream: true,
        max_tokens: 128,
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        messages: [{ role: "user", content: "x" }, { role: "user", content: "y" }],
        temperature: 0.7,
        user: "u1",
    });
    const scan = scanFastpath(raw);
    assert.ok(scan);
    assert.equal(scan.count, 2);
    assertWindowRoundTrip(raw, 0, 2);
    // objectStart/objectEnd bracket the whole top-level object.
    assert.equal(raw[scan.objectStart], "{");
    assert.equal(raw[scan.objectEnd - 1], "}");
});

test("empty messages array scans to count 0 and slices to []", () => {
    const raw = '{"messages":[]}';
    const scan = scanFastpath(raw);
    assert.ok(scan);
    assert.equal(scan.count, 0);
    assert.equal(sliceElementWindow(raw, scan, 0, 0), "[]");
    assert.deepEqual(parseElementWindow(raw, scan, 0, 0), []);
    // Out-of-range clamps do not throw.
    assert.equal(sliceElementWindow(raw, scan, -5, 99), "[]");
});

test("large body (thousands of elements): offsets + window round-trip hold", () => {
    const N = 5000;
    const msgs = Array.from({ length: N }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} with some ${i % 7 === 0 ? "nested {obj:[1,2]}" : "plain"} text`,
    }));
    const raw = JSON.stringify({ model: "big", messages: msgs });
    const t0 = process.hrtime.bigint();
    const scan = scanFastpath(raw);
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(scan);
    assert.equal(scan.count, N);
    // A few windows across the range must round-trip against the reference.
    assertWindowRoundTrip(raw, 0, 10);
    assertWindowRoundTrip(raw, N - 50, N);
    assertWindowRoundTrip(raw, 1234, 1234 + 200);
    // Sanity: the scan itself stays well under a full-parse-class cost.
    assert.ok(dtMs < 5000, `scan took ${dtMs.toFixed(1)}ms — unexpectedly slow`);
});

test("sliceElementWindow is a single contiguous view (no per-element join)", () => {
    const raw = JSON.stringify({ messages: [{ a: 1 }, { b: 2 }, { c: 3 }] });
    const scan = scanFastpath(raw)!;
    const win = sliceElementWindow(raw, scan, 1, 3);
    // Exactly "[ …raw substring… ]" — the interior must be a verbatim slice of raw.
    assert.ok(win.startsWith("["));
    assert.ok(win.endsWith("]"));
    const interior = win.slice(1, -1);
    assert.ok(raw.includes(interior), "window interior must be a verbatim contiguous slice of the source");
    assert.deepEqual(JSON.parse(win), [{ b: 2 }, { c: 3 }]);
});
