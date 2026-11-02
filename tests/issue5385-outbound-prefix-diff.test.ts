// #5385: outbound-prefix (LCP) triage instrument — both gate directions.
// Fires (info) exactly when the stable prefix shrinks vs the previous turn
// (a mid-history byte change); stays quiet (debug) on a healthy tail append.
import assert from "node:assert/strict";
import test from "node:test";
import { observeOutboundPrefix } from "../src/server/outbound-prefix.ts";

type Log = { level: string; msg: string };
const capture = (): Log[] => [];
const makeLog = (out: Log[]) => (level: string, msg: string) => out.push({ level, msg });

const m0 = () => ({ role: "user", content: "hello" });
const m1 = () => ({ role: "assistant", content: [{ type: "text", text: "hi there" }] });
const m2 = () => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "next", cache_control: { type: "ephemeral" } }] });

process.env.ACP_DUMP_BODY = "1";

test("disabled by default: logs nothing and writes no session state", () => {
    const prev = process.env.ACP_DUMP_BODY;
    delete process.env.ACP_DUMP_BODY;
    try {
        const out: Log[] = [];
        const meta: Record<string, unknown> = {};
        observeOutboundPrefix("s0", [m0(), m1()], meta, makeLog(out));
        assert.equal(out.length, 0);
        assert.equal(meta["outboundPrefixFingerprint"], undefined, "off ⇒ no session-state write");
    } finally {
        if (prev === undefined) delete process.env.ACP_DUMP_BODY;
        else process.env.ACP_DUMP_BODY = prev;
    }
});

test("first turn stores fingerprints and emits nothing", () => {
    const out: Log[] = [];
    const meta: Record<string, unknown> = {};
    const before = JSON.stringify([m0(), m1()]);
    observeOutboundPrefix("s1", [m0(), m1()], meta, makeLog(out));
    assert.equal(out.length, 0);
    assert.ok(Array.isArray(meta["outboundPrefixFingerprint"]), "stores the fingerprint list");
    assert.equal(JSON.stringify([m0(), m1()]), before, "does not mutate the wire");
});

test("healthy tail append keeps the whole prefix: debug, no BREAK", () => {
    const out: Log[] = [];
    const meta: Record<string, unknown> = {};
    const log = makeLog(out);
    observeOutboundPrefix("s2", [m0(), m1()], meta, log);
    observeOutboundPrefix("s2", [m0(), m1(), m2()], meta, log);
    assert.equal(out.length, 1, "only the second turn logs");
    assert.equal(out[0].level, "debug", "append is NOT a shrinkage event");
    assert.match(out[0].msg, /lcp=2\/3 \(prev 2\)/);
    assert.doesNotMatch(out[0].msg, /BREAK/);
});

test("mid-history byte change at the head: info, BREAK@0", () => {
    const out: Log[] = [];
    const meta: Record<string, unknown> = {};
    const log = makeLog(out);
    observeOutboundPrefix("s3", [m0(), m1(), m2()], meta, log);
    observeOutboundPrefix("s3", [{ role: "user", content: "hello CHANGED" }, m1(), m2()], meta, log);
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "info", "shrinkage escalates to info so it lands in the default bili.log");
    assert.match(out[0].msg, /lcp=0\/3 \(prev 3\)/);
    assert.match(out[0].msg, /BREAK@0/);
});

test("break at index 1 reports that boundary and the cache_control positions", () => {
    const out: Log[] = [];
    const meta: Record<string, unknown> = {};
    const log = makeLog(out);
    observeOutboundPrefix("s4", [m0(), m1(), m2()], meta, log);
    observeOutboundPrefix("s4", [m0(), { role: "assistant", content: [{ type: "text", text: "reworded" }] }, m2()], meta, log);
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "info");
    assert.match(out[0].msg, /lcp=1\/3 \(prev 3\)/);
    assert.match(out[0].msg, /BREAK@1/);
    assert.match(out[0].msg, /cc@\[2\]/, "reports where the current outbound carries cache_control");
});

test("same-length re-encoding with different bytes still breaks (content hash)", () => {
    const out: Log[] = [];
    const meta: Record<string, unknown> = {};
    const log = makeLog(out);
    observeOutboundPrefix("s5", [m0(), m1()], meta, log);
    // same length "hi there" -> "hi there!" minus one char elsewhere; force a byte diff of equal length
    observeOutboundPrefix("s5", [m0(), { role: "assistant", content: [{ type: "text", text: "hi therX" }] }], meta, log);
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "info");
    assert.match(out[0].msg, /BREAK@1/);
});
