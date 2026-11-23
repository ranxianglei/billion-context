// #6003 phase 2 — unit suite for the user-registerable egress-transform pipeline
// (src/egress-transforms.ts). Pins the acceptance contract: priority/registration
// ordering, match gating (byte-zero on miss), the fail-open guarantees (a throwing /
// timing-out / illegal-body / unloadable plugin never breaks the request or poisons
// the pipeline), header merge + stale content-length drop, Buffer passthrough, the
// per-hop byte observability line, and hot-reload (module-cache reset picks up edited
// plugin code). Plugin modules are written as real .mjs files into a temp dir and
// referenced by absolute path so parsing passes through untouched.
import assert from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import {
    applyEgressTransforms,
    parseEgressTransformEntries,
    resetEgressModuleCache,
    type EgressTransformBase,
} from "../src/egress-transforms.ts";
import type { Logger } from "../src/logger.ts";

const dir = mkdtempSync(join(tmpdir(), "egress-transforms-"));

function plugin(name: string, code: string): string {
    const p = join(dir, name);
    writeFileSync(p, code);
    return p;
}

const silent: Logger = () => {};

const base = (over: Partial<EgressTransformBase> = {}): EgressTransformBase => ({
    sessionId: "t-sid",
    upstreamUrl: "https://api.example.com/v1/chat/completions",
    method: "POST",
    url: "https://api.example.com/v1/chat/completions",
    headers: {},
    protocol: "openai",
    model: "gpt-x",
    stage: "initial",
    ...over,
});

// ---- parse validation ----

test("parse: undefined/null/non-array -> [] (fail-open at config edge)", () => {
    assert.deepStrictEqual(parseEgressTransformEntries(undefined), []);
    assert.deepStrictEqual(parseEgressTransformEntries(null), []);
    assert.deepStrictEqual(parseEgressTransformEntries("nope"), []);
    assert.deepStrictEqual(parseEgressTransformEntries({}), []);
});

test("parse: valid entry gets defaults + absolute module path passthrough", () => {
    const mod = plugin("p-valid.mjs", "export default { transform: async (c)=>({body:c.body}) };");
    const out = parseEgressTransformEntries([{ id: "a", module: mod, priority: 3 }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, "a");
    assert.strictEqual(out[0].module, mod); // absolute -> unchanged
    assert.strictEqual(out[0].enabled, true); // default
    assert.strictEqual(out[0].priority, 3);
    assert.strictEqual(out[0].order, 0);
});

test("parse: item missing module skipped; non-object item skipped", () => {
    const out = parseEgressTransformEntries([
        { id: "no-mod" }, // no string module -> skip
        "garbage", // non-object -> skip
        { id: "ok", module: "/abs/x.mjs" },
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, "ok");
});

test("parse: non-finite priority coerced to unset; non-string match keys dropped", () => {
    const out = parseEgressTransformEntries([
        { id: "np", module: "/abs/a.mjs", priority: Number.NaN },
        { id: "nm", module: "/abs/b.mjs", match: { urlPrefix: 42 } },
    ]);
    assert.strictEqual(out[0].priority, undefined);
    assert.strictEqual(out[1].match, undefined); // urlPrefix not a string -> empty match -> undefined
});

// ---- unconfigured = exact no-op (zero regression) ----

test("apply: empty entries returns input unchanged (same reference)", async () => {
    const body = '{"a":1}';
    const out = await applyEgressTransforms(body, base(), [], silent);
    assert.strictEqual(out, body);
});

// ---- ordering ----

test("apply: smaller priority first; unset sinks last; ties by registration order", async () => {
    const ma = plugin("ord-a.mjs", "export default { transform: async (c)=>({body: c.body+'A'}) };");
    const mb = plugin("ord-b.mjs", "export default { transform: async (c)=>({body: c.body+'B'}) };");
    const mc = plugin("ord-c.mjs", "export default { transform: async (c)=>({body: c.body+'C'}) };");
    // registration order: A(prio 10), B(unset), C(prio 5) => run order C(5),A(10),B(inf)
    const entries = parseEgressTransformEntries([
        { id: "a", module: ma, priority: 10 },
        { id: "b", module: mb },
        { id: "c", module: mc, priority: 5 },
    ]);
    const out = await applyEgressTransforms("start", base(), entries, silent);
    assert.strictEqual(out, "startCAB");
});

test("apply: equal/unset priorities preserve registration order", async () => {
    const ma = plugin("tie-a.mjs", "export default { transform: async (c)=>({body: c.body+'A'}) };");
    const mb = plugin("tie-b.mjs", "export default { transform: async (c)=>({body: c.body+'B'}) };");
    const entries = parseEgressTransformEntries([
        { id: "a", module: ma },
        { id: "b", module: mb },
    ]);
    const out = await applyEgressTransforms("s", base(), entries, silent);
    assert.strictEqual(out, "sAB");
});

// ---- match gating ----

test("apply: urlPrefix mismatch skips plugin entirely (byte-zero)", async () => {
    const mod = plugin("m-url.mjs", "export default { transform: async (c)=>({body: c.body+'!'}) };");
    const entries = parseEgressTransformEntries([
        { id: "u", module: mod, match: { urlPrefix: "https://other.host/" } },
    ]);
    const miss = await applyEgressTransforms("abc", base(), entries, silent);
    assert.strictEqual(miss, "abc"); // our upstream is api.example.com -> untouched
    const hit = await applyEgressTransforms("abc", base({ upstreamUrl: "https://other.host/x" }), entries, silent);
    assert.strictEqual(hit, "abc!");
});

test("apply: provider match compares origin case-insensitively", async () => {
    const mod = plugin("m-prov.mjs", "export default { transform: async (c)=>({body: c.body+'@'}) };");
    const entries = parseEgressTransformEntries([
        { id: "p", module: mod, match: { provider: "HTTPS://API.EXAMPLE.COM" } },
    ]);
    const hit = await applyEgressTransforms("x", base(), entries, silent);
    assert.strictEqual(hit, "x@");
    const miss = await applyEgressTransforms("x", base({ upstreamUrl: "https://elsewhere.io/" }), entries, silent);
    assert.strictEqual(miss, "x");
});

// ---- fail-open guarantees ----

test("fail-open: throwing plugin keeps previous body; pipeline continues", async () => {
    const boom = plugin("f-boom.mjs", "export default { transform: async ()=>{ throw new Error('boom') }; };");
    const ok = plugin("f-ok.mjs", "export default { transform: async (c)=>({body: c.body+'OK'}) };");
    const entries = parseEgressTransformEntries([
        { id: "boom", module: boom, priority: 1 },
        { id: "ok", module: ok, priority: 2 },
    ]);
    const out = await applyEgressTransforms("base", base(), entries, silent);
    assert.strictEqual(out, "baseOK"); // boom discarded, ok ran on the ORIGINAL body
});

test("fail-open: slow plugin times out near timeoutMs and keeps previous body", async () => {
    const slow = plugin("f-slow.mjs", "export default { timeoutMs: 15, transform: async()=>new Promise(r=>setTimeout(()=>r({body:'late'}),200)) };");
    const entries = parseEgressTransformEntries([{ id: "slow", module: slow }]);
    const t0 = Date.now();
    const out = await applyEgressTransforms("keep", base(), entries, silent);
    assert.strictEqual(out, "keep");
    assert.ok(Date.now() - t0 < 150, `expected early bail near 15ms, took ${Date.now() - t0}ms (should not await the full 200ms task)`);
});

test("fail-open: illegal body type (number) keeps previous body", async () => {
    const bad = plugin("f-illegal.mjs", "export default { transform: async ()=>({body: 12345}) };");
    const entries = parseEgressTransformEntries([{ id: "bad", module: bad }]);
    const out = await applyEgressTransforms("orig", base(), entries, silent);
    assert.strictEqual(out, "orig");
});

test("fail-open: missing module skipped; subsequent plugins still run", async () => {
    const ok = plugin("l-ok.mjs", "export default { transform: async (c)=>({body: c.body+'R'}) };");
    const entries = parseEgressTransformEntries([
        { id: "ghost", module: join(dir, "does-not-exist.mjs"), priority: 1 },
        { id: "r", module: ok, priority: 2 },
    ]);
    const out = await applyEgressTransforms("go", base(), entries, silent);
    assert.strictEqual(out, "goR");
});

test("fail-open: module whose default export lacks transform() is skipped", async () => {
    const bad = plugin("l-badexp.mjs", "export default { nope: true };");
    const entries = parseEgressTransformEntries([{ id: "badexp", module: bad }]);
    const out = await applyEgressTransforms("stay", base(), entries, silent);
    assert.strictEqual(out, "stay");
});

test("apply: enabled:false entry is skipped", async () => {
    const mod = plugin("t-dis.mjs", "export default { transform: async (c)=>({body: c.body+'D'}) };");
    const entries = parseEgressTransformEntries([{ id: "dis", module: mod, enabled: false }]);
    const out = await applyEgressTransforms("nope", base(), entries, silent);
    assert.strictEqual(out, "nope");
});

// ---- output shape + headers ----

test("apply: Buffer output stays a Buffer", async () => {
    const mod = plugin("t-buf.mjs", "export default { transform: async (c)=>({body: Buffer.from(c.body+'!','utf8')}) };");
    const entries = parseEgressTransformEntries([{ id: "buf", module: mod }]);
    const out = await applyEgressTransforms("data", base(), entries, silent);
    assert.ok(Buffer.isBuffer(out));
    assert.strictEqual(out.toString("utf8"), "data!");
});

test("apply: undefined/null result leaves body unchanged", async () => {
    const u = plugin("t-undef.mjs", "export default { transform: async ()=>undefined };");
    const n = plugin("t-null.mjs", "export default { transform: async ()=>null };");
    const entries = parseEgressTransformEntries([{ id: "u", module: u }, { id: "n", module: n }]);
    const out = await applyEgressTransforms("same", base(), entries, silent);
    assert.strictEqual(out, "same");
});

test("apply: returned headers merged; stale content-length dropped when bytes change", async () => {
    const mod = plugin("t-hdr.mjs", "export default { transform: async (c)=>({body: c.body+'!!', headers: {'x-added':'yes'}}) };");
    const h: Record<string, string> = { "content-length": "4", "x-old": "keep" };
    const entries = parseEgressTransformEntries([{ id: "hdr", module: mod }]);
    await applyEgressTransforms("abcd", base({ headers: h }), entries, silent);
    assert.strictEqual(h["x-added"], "yes"); // merged
    assert.strictEqual(h["x-old"], "keep"); // untouched
    assert.ok(!("content-length" in h)); // bytes changed 4->6 -> stale length dropped
});

test("apply: content-length kept when body bytes unchanged", async () => {
    const mod = plugin("t-samelen.mjs", "export default { transform: async (c)=>({body: c.body.replace('ab','cd')}) };");
    const h: Record<string, string> = { "content-length": "4" };
    const entries = parseEgressTransformEntries([{ id: "sl", module: mod }]);
    const out = await applyEgressTransforms("abcd", base({ headers: h }), entries, silent);
    assert.strictEqual(out, "cdcd"); // abcd -> cdcd (same 4 bytes)
    assert.strictEqual(h["content-length"] ?? "", "4"); // same byte count -> length preserved
});

// ---- observability ----

test("observe: one debug hop line per plugin that ran (per-hop bytes + reason)", async () => {
    const lines: string[] = [];
    const log: Logger = (_level, msg) => { lines.push(msg); };
    const ma = plugin("obs-a.mjs", "export default { transform: async (c)=>({body: c.body+'A', reason:'ra'}) };");
    const entries = parseEgressTransformEntries([{ id: "a", module: ma }]);
    await applyEgressTransforms("ab", base({ sessionId: "S1" }), entries, log);
    const hop = lines.find((l) => l.includes("[egress:a]"));
    assert.ok(hop, "expected a per-plugin hop line");
    assert.match(hop!, /\bin=\d+B out=\d+B/);
    assert.match(hop!, /stage=initial/);
    assert.match(hop!, /\(ra\)/);
});

// ---- hot reload ----

test("hot-reload: resetEgressModuleCache picks up edited plugin code (mtime cache-bust)", async () => {
    const p = join(dir, "reload.mjs");
    writeFileSync(p, "export default { transform: async (c)=>({body: c.body+'V1'}) };");
    const entries = parseEgressTransformEntries([{ id: "rl", module: p }]);
    const v1 = await applyEgressTransforms("h", base(), entries, silent);
    assert.strictEqual(v1, "hV1");

    // Edit the SAME file, force its mtime forward past the cache-bust key, reset, re-run.
    writeFileSync(p, "export default { transform: async (c)=>({body: c.body+'V2'}) };");
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    resetEgressModuleCache();
    const v2 = await applyEgressTransforms("h", base(), entries, silent);
    assert.strictEqual(v2, "hV2");
});

test("hot-reload: within one generation the loaded module is stable (no mid-flight swap)", async () => {
    const p = join(dir, "stable.mjs");
    writeFileSync(p, "export default { transform: async (c)=>({body: c.body+'A'}) };");
    const entries = parseEgressTransformEntries([{ id: "st", module: p }]);
    const first = await applyEgressTransforms("x", base(), entries, silent);
    assert.strictEqual(first, "xA"); // first load sees version A
    // Without a reset, editing the file must NOT change behavior mid-generation.
    writeFileSync(p, "export default { transform: async (c)=>({body: c.body+'B'}) };");
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    const second = await applyEgressTransforms("x", base(), entries, silent);
    assert.strictEqual(second, "xA"); // still the first-loaded version (cache hit by path)
    resetEgressModuleCache(); // leave a clean cache for later tests
});
