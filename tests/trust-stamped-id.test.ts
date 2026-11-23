// #7525 trust-stamped-id — GA (characterization of the post-retirement
// resolver, 2026-11-23 owner ruling).
//
// The stamped session id IS the complete identity: the resolver rides it
// verbatim, unconditionally. The content-evidence ladder that used to sit
// under it — the |sub:aux / |sub:<fp> / |sub:task:<skel8> fork lanes, their
// recorded skeletons (#3397 persistence), the tag-change migration rungs
// (#2241/#4778/#5686), the #5719 msgid rescue — and the
// BILI_ROLLOUT_TRUST_STAMPED_ID=0 escape hatch are all retired: under the
// GA flag every one of those exits was dead code for stamped traffic, so
// they are gone from src/session-resolve.ts along with it. Reverting to
// fork-lane behavior is a git-level operation now.
//
// The ONE survivor is the #5095 client-DECLARED subagent lane-token tail,
// which still forks — it is a declared distinct lane, not a content guess.
//
// The resolver is a pure function (no in-memory skeletons), so there is no
// state to reset between tests. Hermetic roots are set here because a
// directly-invoked single file does NOT get tests/preload-test-env.mjs.
import assert from "node:assert";
import { createHash } from "node:crypto";
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

const { resolveSessionOrder, personaConversationOrder } = await import("../src/session-resolve.ts");

test("stamped id rides verbatim on first sight (no |sub:aux fork)", () => {
    // A lone side request used to fork onto `aux-id|sub:aux` under the legacy
    // ladder; trusted, it rides the stamped id verbatim.
    const r = resolveSessionOrder("aux-id");
    assert.equal(r.key, "aux-id");
    assert.equal(r.action, "raw");
});

test("a divergent/shorter stranger order rides the verbatim id (no |sub:task fork)", () => {
    // The legacy id-reuse guard forked shorter divergent histories onto
    // `task-id|sub:task:<skel8>`; GA rides the stamped id either way.
    const r = resolveSessionOrder("task-id");
    assert.equal(r.key, "task-id");
    assert.equal(r.action, "raw");
});

test("persona-tag changes never fork anymore (#2241/#4778/#5686 retired)", () => {
    assert.equal(resolveSessionOrder("conv").key, "conv");
    assert.equal(resolveSessionOrder("conv", "a completely different persona text").key, "conv");
    assert.equal(resolveSessionOrder("conv", undefined).action, "raw");
    // GA drift pin (master d904b4e1, the #5844 incident shape): a SHORTER
    // replay under a brand-new persona tag — the legacy ladder forked this
    // onto persona-id|sub:<fp16(tag)>; under GA the id rides verbatim
    // (history shape is not a resolver input, tag drift alone never forks).
    assert.equal(
        resolveSessionOrder("persona-id", "You are the post-upgrade assistant persona, with a completely different system prompt.").key,
        "persona-id",
    );
});

test("the #5095 lane-token tail STILL forks (the declared-lane survivor)", () => {
    // The token value the resolver sees is the BARE 12-hex (handle.ts extracts
    // it via claudeSubagentLaneTokenOf → claudeLaneTokenIn, which strips the
    // `bili-lane-token:` marker). isClaudeLaneToken matches /^[0-9a-f]{12}$/.
    const token = "001122334455";
    // No persona tag: the key takes the two-segment form `<id>|sub:t:<token>`.
    const r = resolveSessionOrder("sub-id", undefined, token);
    assert.equal(r.action, "derived-persona");
    assert.equal(r.key, `sub-id|sub:t:${token}`);
    // With a persona tag: byte-identical to the pre-retirement lane-key shape,
    // so persisted per-dispatch sessions keep their keys across the upgrade.
    const fp = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
    const r2 = resolveSessionOrder("sub-id", "You are a Claude agent...", token);
    assert.equal(r2.key, `sub-id|sub:${fp("You are a Claude agent...")}:t:${token}`);
});

test("a malformed token is ignored → verbatim id (sanitizer)", () => {
    const r = resolveSessionOrder("sub-id", "some persona", "zzz-not-hex!!");
    assert.equal(r.key, "sub-id");
    assert.equal(r.action, "raw");
});

test("personaConversationOrder is the wire adapter used by handle.ts", () => {
    const seen: string[] = [];
    const raw = personaConversationOrder("conv", undefined, undefined, (id, r) => {
        seen.push(`${r.action}:${r.key}`);
    });
    assert.equal(raw, "conv");
    assert.deepEqual(seen, ["raw:conv"], "the raw path still notifies (the handle's observer filters it to silence)");
    const tok = "abcdef123456";
    assert.equal(personaConversationOrder("conv", undefined, tok), `conv|sub:t:${tok}`);
});
