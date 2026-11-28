import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #6811: generalize the route-miss near-miss hint beyond the #3632 MITM-scheme
// case. A same-host providers key that differs only in port and/or scheme
// (port drift, http vs https) is the other #1 silent-miss shape — the operator
// configured a passthrough / per-provider route but the request URL drifted, so
// the request silently fell back to kernel rewrite while the operator believed
// the config applied. The generic #2317 warning lists the known keys but leaves
// the drift to guesswork; the near-miss hint names the key and WHAT differs.
// The #3632 MITM-scheme hint is preserved verbatim and owns that lane; the
// general hint is skipped when #3632 already named the same-host key.

import { warnRouteMissIfNew, _resetRouteMissWarnedForTest } from "../src/server.ts";
import { setMaskHostsEnabled } from "../src/log-mask.ts";

test.before(() => setMaskHostsEnabled(false));
test.after(() => setMaskHostsEnabled(true));

function fire(origin: string, model: string, keys: string[]): string[] {
    _resetRouteMissWarnedForTest();
    const lines: string[] = [];
    const log = (level: string, msg: string) => { if (level === "warn") lines.push(msg); };
    const fired = warnRouteMissIfNew(origin, model, keys, log);
    assert.equal(fired, true, `expected the warning to fire for ${origin}`);
    return lines;
}

test("#6811 N1: port drift on a plain lane names the near-miss key and the port diff", () => {
    const lines = fire("http://127.0.0.1:18998", "zcode", ["http://127.0.0.1:18999"]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[route] no provider route matched"), lines[0]);
    assert.ok(lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].includes("127.0.0.1:18999"), lines[0]);
    assert.ok(lines[0].includes("differs in port"), lines[0]);
    assert.ok(lines[0].includes("port and scheme must match verbatim"), lines[0]);
});

test("#6811 N2: http vs https on a plain lane names the scheme diff", () => {
    const lines = fire("http://relay.example", "m", ["https://relay.example"]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].includes("differs in scheme (http vs https)"), lines[0]);
});

test("#6811 N3: both port and scheme differ are both named", () => {
    const lines = fire("http://relay.example", "m", ["https://relay.example:8443"]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].includes("differs in scheme (http vs https) and port"), lines[0]);
});

test("#6811 N4: MITM-lane port drift (no https:// sibling) gets the general hint, not the #3632 scheme hint", () => {
    const lines = fire("mitm://relay.internal:8443", "m", ["mitm://relay.internal:9443"]);
    assert.equal(lines[0].length > 0, true);
    assert.ok(!lines[0].includes("Scheme mismatch"), lines[0]);
    assert.ok(lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].includes("differs in port"), lines[0]);
});

test("#6811 N5: the #3632 MITM-scheme case does NOT also emit the general near-miss hint (no duplicate line)", () => {
    const lines = fire("mitm://opencode.ai", "m", ["https://opencode.ai"]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("Scheme mismatch"), lines[0]);
    assert.ok(!lines[0].includes("Near-miss"), lines[0]);
});

test("#6811 N6: no near-miss hint when the host differs (the generic #2317 message stays verbatim)", () => {
    const lines = fire("http://127.0.0.1:18998", "m", ["http://other.example:18998"]);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].endsWith("Add a matching key to the providers block in ~/.config/billion-context/billion-context.json."), lines[0]);
});

test("#6811 N7: host comparison is case-insensitive", () => {
    const lines = fire("http://Relay.Example", "m", ["http://relay.example:8443"]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("Near-miss"), lines[0]);
    assert.ok(lines[0].includes("differs in port"), lines[0]);
});

test("#6811 N8: the near-miss hint dedupes per (origin, model) like the base warning", () => {
    _resetRouteMissWarnedForTest();
    let count = 0;
    const log = (level: string, msg: string) => { if (level === "warn" && msg.includes("Near-miss")) count++; };
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:18998", "m", ["http://127.0.0.1:18999"], log), true);
    assert.equal(warnRouteMissIfNew("http://127.0.0.1:18998", "m", ["http://127.0.0.1:18999"], log), false);
    assert.equal(count, 1);
});
