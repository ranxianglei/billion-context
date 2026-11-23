// #7439/#6884 trust-stamped-id (server-side, gated).
//
// With the flag ON, the persona-order resolver's |sub: CONTENT-forecasting
// (derived-aux / derived-task / persona-lane-by-content) is retired for
// id-bearing traffic: the stamped session id IS the complete identity, so the
// retired forks ride the verbatim raw id instead of forking. The ONE survivor
// is the #5095 client-DECLARED subagent lane-token tail, which still forks —
// it is a declared distinct lane, not a content guess.
//
// The flag is forced ON for this whole file. node --test gives each file its
// own process, so this env never leaks into the OFF characterization corpus in
// tests/issue2944-neutral-skeleton.test.ts (which pins the byte-identical
// legacy forks). Hermetic roots are set here because a directly-invoked single
// file does NOT get tests/preload-test-env.mjs.
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";

const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tsi-"));
process.env.XDG_DATA_HOME = path.join(XDG, "data");
process.env.XDG_STATE_HOME = path.join(XDG, "state");
process.env.XDG_CACHE_HOME = path.join(XDG, "cache");
process.env.XDG_CONFIG_HOME = path.join(XDG, "config");
process.env.BILI_PERSIST = "0";
process.env.NODE_ENV = "test";
process.env.BILI_ROLLOUT_TRUST_STAMPED_ID = "1";

const { resolveSessionOrder, resetSessionOrderForTest } = await import("../src/session-resolve.ts");

type Msg = { role: string; content: string };
/** Alternating user/assistant turns, ~120 chars each (same shape as the
 *  legacy-corpus helper). */
function msgs(n: number, tag = "m"): Msg[] {
    const out: Msg[] = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        out.push({ role, content: `${tag} #${i} — body with enough prose to be a realistic cell ${"x".repeat(80)}` });
    }
    return out;
}

test("trust-stamped-id ON: first-sight shallow side request rides the verbatim id (no |sub:aux fork)", () => {
    resetSessionOrderForTest();
    // A lone user turn (no assistant, no persona tag): the legacy ladder forks
    // this onto `aux-id|sub:aux`; trusted, it rides the stamped id verbatim.
    const r = resolveSessionOrder("aux-id", [
        { role: "user", content: "start a side thing, please be brief " + "z".repeat(80) },
    ]);
    assert.equal(r.key, "aux-id");
    assert.equal(r.action, "claim");
});

test("trust-stamped-id ON: growth under a claimed id continues verbatim (no fork)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("grow-id", msgs(6, "seed"));
    const r = resolveSessionOrder("grow-id", msgs(10, "seed"));
    assert.equal(r.key, "grow-id");
    assert.equal(r.action, "continue");
});

test("trust-stamped-id ON: a divergent/shorter stranger order rides the verbatim id (no |sub:task fork)", () => {
    resetSessionOrderForTest();
    // Seed a main-shaped 10-turn skeleton, then a shorter, different-content
    // history under the same id that tail-aligns by alternation but whose
    // fragments do NOT match: the legacy ladder forks it onto
    // `task-id|sub:task:<skel8>` (id-reuse guard); trusted, it re-anchors to
    // the stamped id.
    resolveSessionOrder("task-id", msgs(10, "seed"));
    const r = resolveSessionOrder("task-id", msgs(4, "other"));
    assert.equal(r.key, "task-id");
});

test("trust-stamped-id ON: the #5095 lane-token tail STILL forks (the declared-lane survivor)", () => {
    resetSessionOrderForTest();
    // The token value the resolver sees is the BARE 12-hex (handle.ts extracts
    // it via claudeSubagentLaneTokenOf → claudeLaneTokenIn, which strips the
    // `bili-lane-token:` marker). isClaudeLaneToken matches exactly /^[0-9a-f]{12}$/.
    const token = "001122334455";
    // The token is a client-declared subagent dispatch (handle.ts extracts it
    // from the dispatch's first user message and passes it as the 5th arg).
    // A declared distinct lane must survive the flag and fork — it is not a
    // content guess. No persona tag is passed, so the key takes the two-segment
    // form `<id>|sub:t:<token>`.
    const r = resolveSessionOrder("sub-id", msgs(6, "seed"), undefined, undefined, token);
    assert.equal(r.action, "derived-persona");
    assert.ok(r.key.startsWith("sub-id|sub:"), `expected a |sub: lane-token tail, got ${r.key}`);
    assert.ok(r.key.endsWith(`t:${token}`), `expected the token tail, got ${r.key}`);
});
