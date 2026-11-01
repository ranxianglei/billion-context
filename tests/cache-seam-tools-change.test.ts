// #5466: tools-array-change attribution. The Anthropic wire prefix is
// system + tools + messages, so a mid-session change to the request's tools
// array invalidates the cached span WITHOUT touching any message. detectSeam
// was blind to it (message-only fingerprint) and blamed the first incidental
// divergence — the client (#3023) or an unexplained seam. toolsArrayFps
// captures per-entry tool fingerprints at the send chokepoint; when the prev/cur
// tool tables differ the residual books into the dedicated tools bucket
// (prov:"tools"), naming which entries appeared/disappeared/were redefined/
// reordered. Stable tools, a missing capture on either side, and no-tools lanes
// keep the legacy arms untouched (fail soft, like the message ladder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache, toolsArrayFps } from "../src/cache-ledger.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `tools-seam-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.parse("2026-10-13T10:00:00Z");
function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}
const inbound = (msgs: string[]): CoreMessage[] => msgs.map((c) => ({ role: "user", content: c })) as unknown as CoreMessage[];

type Tool = { name: string; description: string; input_schema: { type: string } };
const A: Tool = { name: "read_file", description: "Read a file", input_schema: { type: "object" } };
const B: Tool = { name: "write_file", description: "Write a file", input_schema: { type: "object" } };
const C: Tool = { name: "bash", description: "Run a shell command", input_schema: { type: "object" } };

// Mirror the send chokepoint: note the FULL parsed body and derive the tools
// fingerprints from it exactly as src/server/relay.ts and src/loop/core.ts do.
function note(s: Session, msgs: string[], tools?: Tool[]): void {
    const obj: Record<string, unknown> = { model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) };
    if (tools !== undefined) obj.tools = tools;
    const str = JSON.stringify(obj);
    noteForwardedBody(s, str, (obj.messages as unknown[]).length, undefined, undefined, toolsArrayFps(obj));
}

test("tools gained mid-session with stable messages books the tools bucket, not client/seam", () => {
    const s = makeSession();
    note(s, ["a", "b", "c"], [A, B]);
    settle(s, T0, 100_000, 99_000);
    note(s, ["a", "b", "c"], [A, B, C]);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.prov, "tools");
    assert.equal(line.seam, undefined, "NOT a seam suspect");
    assert.equal(led.agg.toolSeams, 1);
    assert.ok(led.agg.toolSeamMissed > 0);
    assert.equal(led.agg.clientInserts, 0);
    assert.equal(led.agg.seamSuspects, 0);
    const ev = led.seamEvents?.[0];
    assert.ok(ev?.tools, "seam event carries tools forensics");
    assert.deepEqual(ev!.tools!.appeared, ["bash"]);
    assert.equal(ev!.tools!.disappeared.length, 0);
    assert.match(handleAcpCache(s).text, /TOOLS-ARRAY CHANGE/);
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.tools.count, 1);
    assert.ok(report.seam.tools.missed > 0);
});

test("#5459 shape: tools gained AND a turn appended still attributes to tools, not provider-side/client", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    note(s, ["a", "b", "c"], [A]);
    settle(s, T0, 100_000, 99_000);
    noteInboundMessages(s, inbound(["a", "b", "c", "d"]));
    note(s, ["a", "b", "c", "d"], [A, B, C]);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.prov, "tools", "tools change precedes the appended turn in the prefix");
    assert.equal(led.agg.toolSeams, 1);
    assert.equal(led.agg.clientInserts, 0);
    assert.equal(led.agg.providerSideMisses, 0, "NOT booked provider-side");
    assert.deepEqual(led.seamEvents?.[0]?.tools?.appeared, ["write_file", "bash"]);
});

test("stable tools + genuine client mid-history rewrite stays prov=client (no regression)", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    note(s, ["a", "b", "c"], [A, B]);
    settle(s, T0, 100_000, 99_000);
    noteInboundMessages(s, inbound(["a", "X", "b", "c"]));
    note(s, ["a", "X", "b", "c"], [A, B]);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.lines[led.lines.length - 1]!.prov, "client");
    assert.equal(led.agg.toolSeams, 0, "stable tools never flag");
    assert.equal(led.agg.clientInserts, 1);
});

test("stable tools + inbound-prefix-stable outbound break stays a seam suspect (no regression)", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    note(s, ["a", "b", "c"], [A, B]);
    settle(s, T0, 100_000, 99_000);
    noteInboundMessages(s, inbound(["a", "b", "c", "d"]));
    note(s, ["a", "B2", "c", "d"], [A, B]);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1, "legacy seam bucket preserved");
    assert.equal(line.prov, undefined);
    assert.equal(led.agg.toolSeams, 0);
});

test("no tools on either side keeps the legacy seam bucket (fail-soft)", () => {
    const s = makeSession();
    note(s, ["a", "b", "c"]);
    settle(s, T0, 100_000, 99_000);
    note(s, ["a", "B2", "c"]);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.toolSeams, 0);
});

test("tools appearing where the earlier side had none fails soft to the legacy arms", () => {
    const s = makeSession();
    note(s, ["a", "b", "c"]);            // no tools array -> undefined capture
    settle(s, T0, 100_000, 99_000);
    note(s, ["a", "b", "c"], [A, B]);    // tools present -> defined capture
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.toolSeams, 0, "a missing-capture side declines to classify");
    assert.notEqual(led.lines[led.lines.length - 1]!.prov, "tools");
});

test("delta classifies removed / redefined / reordered entries by name", () => {
    const s1 = makeSession();
    note(s1, ["a"], [A, B]);
    settle(s1, T0, 100_000, 99_000);
    note(s1, ["a"], [A]);
    settle(s1, T0 + 1000, 100_000, 20_000);
    assert.deepEqual(getCacheLedger(s1).seamEvents?.[0]?.tools?.disappeared, ["write_file"]);

    const s2 = makeSession();
    note(s2, ["a"], [{ name: "x", description: "old", input_schema: { type: "object" } }]);
    settle(s2, T0, 100_000, 99_000);
    note(s2, ["a"], [{ name: "x", description: "new", input_schema: { type: "object" } }]);
    settle(s2, T0 + 1000, 100_000, 20_000);
    assert.deepEqual(getCacheLedger(s2).seamEvents?.[0]?.tools?.edited, ["x"]);

    const s3 = makeSession();
    note(s3, ["a"], [A, B]);
    settle(s3, T0, 100_000, 99_000);
    note(s3, ["a"], [B, A]);
    settle(s3, T0 + 1000, 100_000, 20_000);
    const d3 = getCacheLedger(s3).seamEvents?.[0]?.tools;
    assert.ok(d3, "reorder produces a tools delta");
    assert.equal(d3.appeared.length, 0);
    assert.equal(d3.disappeared.length, 0);
    assert.equal(d3.edited.length, 0);
    assert.equal(d3.moved, 2);
    assert.match(d3.summary, /reordered/);
});
