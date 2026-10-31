import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState, defaultCountTokens } from "acp-kernel";
import { startServer, isSideRequest, outputBudgetField, restoreOutputBudget, sideRequestGuard, resolveKnownOutputCeiling, _resetNoOutputCeilingWarningsForTest, _resetDshMidBandWarningsForTest, OUTPUT_RESTORE_ABSOLUTE_FLOOR } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { recordPluginRuntimeInfo, _resetPluginStateForTest } from "../src/plugin.ts";
import { estimateRawBodyTokens } from "../src/preflight.ts";
import { inspectContextOverflow } from "../src/util.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #388: side requests (title-gen / small utility calls) share the main session
// key but must not touch kernel state. The proxy routes them as pure passthrough
// (no processTurn / snapshot / usage capture) so the main session's view, nudge
// baseline and per-block survivedCount are driven ONLY by main requests.

test("isSideRequest: tiny output budget across protocol field names", () => {
    assert.equal(isSideRequest({ max_tokens: 100 }), true);
    assert.equal(isSideRequest({ max_tokens: 200 }), true, "boundary 200 is a side request");
    assert.equal(isSideRequest({ max_tokens: 201 }), false, "201 is NOT a side request");
    assert.equal(isSideRequest({ max_completion_tokens: 150 }), true, "openai max_completion_tokens");
    assert.equal(isSideRequest({ max_output_tokens: 50 }), true, "responses max_output_tokens");
    assert.equal(isSideRequest({ max_tokens: 8192 }), false, "normal budget is not a side request");
    assert.equal(isSideRequest({}), false, "no budget → not a side request");
    assert.equal(isSideRequest(null), false, "null body");
    assert.equal(isSideRequest(undefined), false, "undefined body");
    assert.equal(isSideRequest("not-an-object"), false, "non-object body");
    assert.equal(isSideRequest({ max_tokens: 0 }), false, "zero budget");
    assert.equal(isSideRequest({ max_tokens: -5 }), false, "negative budget");
    assert.equal(isSideRequest({ max_tokens: "100" }), false, "string budget is not a number");
    assert.equal(isSideRequest({ max_tokens: 100, tools: [{ name: "compress" }] }), false, "#546: tool-carrying request is a MAIN turn even with a starved budget");
    assert.equal(isSideRequest({ max_tokens: 100, tools: [] }), true, "empty tools array does not rescue a tiny budget");
    assert.equal(isSideRequest({ max_output_tokens: 16, tools: [{ type: "function", function: { name: "f" } }] }), false, "#546: responses wire, starved budget + tools → main");
});

test("isSideRequest: host-declared side-request agent outranks the token-budget heuristic (#1699)", () => {
    // opencode v2 title-gen carries NO max_tokens (options {} for kind==="title"),
    // so the budget path can never see it. Declaring the persona by intent fixes
    // the misclassification without touching any request that omits max_tokens.
    const noBudget = { messages: [{ role: "user", content: "Generate a short title." }] };
    assert.equal(isSideRequest(noBudget, "title"), true, "#1699: no-budget title request is a side req by intent");
    assert.equal(isSideRequest(noBudget), false, "same body WITHOUT the agent id stays non-side (no regression)");
    // Intent outranks even the #546 tool-carrying main-turn guard (title-gen never
    // carries tools; if it did, the host's explicit declaration wins).
    assert.equal(isSideRequest({ max_tokens: 100, tools: [{ name: "compress" }] }, "title"), true, "#1699: intent beats the tools heuristic");
    // A MAIN persona is never a side request — real turns keep compression.
    assert.equal(isSideRequest({ max_tokens: 5000 }, "build"), false, "main persona with a normal budget is not a side req");
    assert.equal(isSideRequest({}, "build"), false, "main persona without a budget is not a side req");
    // An unknown persona id is inert — falls back to the token-budget heuristic.
    assert.equal(isSideRequest({}, "unknown-persona"), false, "unknown persona does not grant side status");
    assert.equal(isSideRequest({ max_tokens: 100 }, "unknown-persona"), true, "unknown persona still honors a tiny budget");
});

test("isSideRequest: explicit main intent vetoes side heuristics", () => {
    for (const body of [{ max_tokens: 100 }, { max_completion_tokens: 100 }, { max_output_tokens: 100 }, { generationConfig: { maxOutputTokens: 100 } }]) {
        assert.equal(isSideRequest(body, "main"), false, "main intent outranks a tiny budget even without tools");
        assert.equal(isSideRequest(body, "title"), true, "title intent remains side");
        assert.equal(isSideRequest(body, "other"), true, "unknown intent keeps the budget heuristic");
        assert.equal(isSideRequest(body), true, "missing intent keeps the budget heuristic");
    }
});

const noopLog = (): void => {};

function metaSession(id: string): { id: string; metadata: Record<string, unknown> } {
    return { id, metadata: {} };
}

test("outputBudgetField: first positive numeric field wins (#546)", () => {
    assert.equal(outputBudgetField({ max_tokens: 5 }), "max_tokens");
    assert.equal(outputBudgetField({ max_completion_tokens: 5 }), "max_completion_tokens");
    assert.equal(outputBudgetField({ max_output_tokens: 5 }), "max_output_tokens");
    assert.equal(outputBudgetField({ max_tokens: 0, max_completion_tokens: 7 }), "max_completion_tokens", "zero/negative fields skipped");
    assert.equal(outputBudgetField({ max_tokens: "16" }), null, "string budget ignored");
    assert.equal(outputBudgetField({}), null);
    assert.equal(outputBudgetField(null), null);
});

test("restoreOutputBudget: high-water learning + starved-budget restore (#546)", () => {
    const s = metaSession("hw");
    // Healthy request → learns the high-water (last non-starved value wins).
    restoreOutputBudget({ max_tokens: 32768 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 32768);
    // Starved main request (tools present) → restored to the high-water.
    const starved = { max_tokens: 16, tools: [{ name: "compress" }] } as { max_tokens: number; tools: unknown[] };
    restoreOutputBudget(starved, s, noopLog);
    assert.equal(starved.max_tokens, 32768, "starved budget restored to high-water");
    // No high-water yet + starved + tools + NO ceiling → #3071 absolute floor: a
    // born-starved / fork-inherited rattle is never forwarded verbatim.
    const fresh = metaSession("fresh");
    const noWater = { max_tokens: 16, tools: [{ name: "compress" }] };
    restoreOutputBudget(noWater, fresh, noopLog);
    assert.equal(noWater.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "born-starved floored to the absolute minimum (#3071)");
    // Side request (tiny budget, NO tools) → never touched, stays a side req.
    const side = { max_tokens: 100 };
    restoreOutputBudget(side, s, noopLog);
    assert.equal(side.max_tokens, 100, "side request budget must not be restored");
    assert.equal(isSideRequest(side), true);
    // A non-starved value is always trusted and recorded verbatim as the
    // high-water (even below the absolute floor) — only a STARVE consults it.
    restoreOutputBudget({ max_tokens: 8000 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 8000, "non-starved value recorded verbatim as high-water");
    const starved2 = { max_tokens: 200, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved2, s, noopLog);
    assert.equal(starved2.max_tokens, 8000, "boundary 200 starve restored to the session's own high-water, never raised to the floor above it (#3406)");
    restoreOutputBudget({ max_tokens: 32768 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 32768, "a later healthy value wins as high-water");
    // Field-name fidelity: restore writes the SAME field the client used.
    const s2 = metaSession("hw2");
    restoreOutputBudget({ max_output_tokens: 49152 }, s2, noopLog);
    const responsesStarved = { max_output_tokens: 1, tools: [{ type: "function" }] } as { max_output_tokens: number };
    restoreOutputBudget(responsesStarved, s2, noopLog);
    assert.equal(responsesStarved.max_output_tokens, 49152, "responses field restored on the same field");
});

test("restoreOutputBudget: configured-output-limit floor for poisoned or missing high-water (#1665)", () => {
    // Death spiral: the client decays through small positive values before
    // starving completely — the water mark ends up holding a death rattle.
    const s = metaSession("poison");
    restoreOutputBudget({ max_tokens: 384000 }, s, noopLog);
    restoreOutputBudget({ max_tokens: 680 }, s, noopLog);
    restoreOutputBudget({ max_tokens: 234 }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 234, "last non-starved value wins (decay tracked verbatim)");
    const starved = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog, 384000);
    assert.equal(starved.max_tokens, 384000, "death-rattle water mark floored by the configured output limit");
    // #3833: a healthy water mark ABOVE the declared ceiling is clamped DOWN to the
    // ceiling (never restored verbatim) — the ceiling is the hard upstream bound
    // (strict providers 400 above it), so a water above it is either a stale
    // cross-model artifact or an over-conservative declaration. The over-bound
    // water is corrected in place so later turns stop replaying it.
    const s2 = metaSession("healthy");
    restoreOutputBudget({ max_tokens: 500000 }, s2, noopLog);
    const starved2 = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved2, s2, noopLog, 384000);
    assert.equal(starved2.max_tokens, 384000, "water mark above the ceiling clamped down to it (#3833)");
    assert.equal(s2.metadata.outputBudgetHighWater, 384000, "the over-bound high-water is corrected in place (#3833)");
    // Born-dead session: the first request bili ever sees is already starved.
    const s3 = metaSession("borndead");
    const bornDead = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(bornDead, s3, noopLog, 32768);
    assert.equal(bornDead.max_tokens, 32768, "missing water mark falls back to the configured limit");
    // No configured limit → no ceiling → the #3071 absolute floor applies (the
    // starved budget is never forwarded verbatim).
    const s4 = metaSession("nofloor");
    const noFloor = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(noFloor, s4, noopLog);
    assert.equal(noFloor.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "no ceiling → absolute floor, not verbatim (#3071)");
    // A limit at/below the side threshold is not a usable ceiling — the absolute
    // floor still applies.
    const s5 = metaSession("tinyfloor");
    restoreOutputBudget({ max_tokens: 234 }, s5, noopLog);
    const tinyFloor = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(tinyFloor, s5, noopLog, 200);
    assert.equal(tinyFloor.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "limit <= 200 is not a usable ceiling; rattle high-water 234 is below the trust line — absolute floor applies (#3071/#3406)");
    // Side requests (no tools) never receive the floor.
    const side = { max_tokens: 100 } as { max_tokens: number };
    restoreOutputBudget(side, s3, noopLog, 32768);
    assert.equal(side.max_tokens, 100, "side request untouched even with a floor available");
});

test("restoreOutputBudget: no-ceiling restore never exceeds the session's proven high-water (#3406 hard-cap providers)", () => {
    // A provider hard-caps maxOutputTokens at 8192 — below the 32K absolute
    // floor — and bili has NO ceiling source for it (no runtime-info, no
    // launcher, no config, no registry row). The session ran HEALTHY at 8000
    // (the provider accepted that exact value at full size), then the client's
    // budget starved. Raising to the 32K floor would hard-reject the request;
    // the restore must return the session's own proven budget instead.
    const s = metaSession("hardcap");
    restoreOutputBudget({ max_tokens: 8000 }, s, noopLog);
    const starved = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog);
    assert.equal(starved.max_tokens, 8000, "restored to the proven high-water, never raised above it (#3406)");
    // A high-water ABOVE the floor keeps passing untouched (unchanged).
    const s2 = metaSession("hardcap2");
    restoreOutputBudget({ max_tokens: 49152 }, s2, noopLog);
    const starved2 = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(starved2, s2, noopLog);
    assert.equal(starved2.max_tokens, 49152, "high-water above the floor is still restored as-is");
    // Without ANY high-water the #3071 floor still guarantees a lower bound
    // (born-starved / fork-inherited rattle — nothing was ever proven legal).
    const s3 = metaSession("hardcap3");
    const born = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(born, s3, noopLog);
    assert.equal(born.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "born-starved keeps the absolute floor (#3071)");
    // A rattle high-water BELOW the trust line still gets the floor — the
    // #3071 death spiral must stay fixed (decay chains end in exactly this
    // state, and a few hundred tokens cannot emit a compress call).
    const s4 = metaSession("hardcap4");
    restoreOutputBudget({ max_tokens: 2061 }, s4, noopLog);
    const rattle = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(rattle, s4, noopLog);
    assert.equal(rattle.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "high-water below the trust line (2061) is overridden by the floor (#3071)");
    // Boundary: exactly at the trust line the high-water is a proven bound.
    const s5 = metaSession("hardcap5");
    restoreOutputBudget({ max_tokens: 4096 }, s5, noopLog);
    const atLine = { max_tokens: 1, tools: [{ name: "t" }] } as { max_tokens: number };
    restoreOutputBudget(atLine, s5, noopLog);
    assert.equal(atLine.max_tokens, 4096, "high-water at the trust line (4096) is restored as-is, not raised (#3406)");
});

test("restoreOutputBudget: warns once per SESSION+model when no output ceiling backs the restore (#1840/#3071)", () => {
    _resetNoOutputCeilingWarningsForTest();
    const lines: string[] = [];
    const log = (_lvl: string, msg: string): void => { lines.push(msg); };
    const tools = [{ name: "t" }];
    const A = "stepfun/step-5-preview";
    // Decaying client, NO ceiling from any source. The non-starved value is
    // trusted verbatim (recorded as high-water, silently); the STARVE is what
    // gets floored to the absolute minimum — and that is where the warn fires.
    const s = metaSession("nocap");
    restoreOutputBudget({ max_tokens: 583, model: A }, s, log);
    assert.equal(s.metadata.outputBudgetHighWater, 583, "non-starved learning is silent and tracked verbatim");
    const starved = { max_tokens: 1, tools, model: A } as { max_tokens: number };
    restoreOutputBudget(starved, s, log);
    assert.equal(starved.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "ceiling-less starve with a rattle high-water (583 < trust line) floored to the absolute minimum (#3071)");
    let warns = lines.filter((l) => l.includes("NO known output ceiling"));
    assert.equal(warns.length, 1, "one warn per session+model (on the starve, not the silent learning)");
    assert.match(warns[0] ?? "", /model=stepfun\/step-5-preview/, "names the model");
    assert.match(warns[0] ?? "", /raised 1 -> 32768/, "states what was actually raised");
    assert.match(warns[0] ?? "", /providers\.<url>\.models/, "points at the config escape hatch");
    // Same session + model again → deduped (no second warn).
    restoreOutputBudget({ max_tokens: 1, tools, model: A }, s, log);
    assert.equal(lines.filter((l) => l.includes("NO known output ceiling")).length, 1, "deduped per session+model");
    // A DIFFERENT session on the SAME ceiling-less model gets its OWN warn
    // (#3071 path 2a: the old once-per-model dedup left the second session silent).
    const sOther = metaSession("other");
    restoreOutputBudget({ max_tokens: 1, tools, model: A }, sOther, log);
    warns = lines.filter((l) => l.includes("NO known output ceiling"));
    assert.equal(warns.length, 2, "per-session, not per-model (#3071)");
    assert.match(warns[1] ?? "", /\[other\]/, "names the affected session");
    assert.equal(sOther.metadata.outputBudgetHighWater, undefined, "the starved branch does not seed a high-water");
    // With a usable ceiling → no warn at all (the floor note rides on the info line).
    _resetNoOutputCeilingWarningsForTest();
    lines.length = 0;
    const s2 = metaSession("capped");
    restoreOutputBudget({ max_tokens: 583, model: "capped/model" }, s2, log, 32768);
    const capped = { max_tokens: 1, tools, model: "capped/model" } as { max_tokens: number };
    restoreOutputBudget(capped, s2, log, 32768);
    assert.equal(capped.max_tokens, 32768, "ceiling lifts the death rattle");
    assert.equal(lines.filter((l) => l.includes("NO known output ceiling")).length, 0, "a usable ceiling suppresses the warn");
    assert.ok(lines.some((l) => l.includes("high-water 583 below known output ceiling — floored (#1665/#1840)")), "floored info note present");
});

test("restoreOutputBudget: tracks the no-ceiling degraded state for the user-visible surfaces (#2904/#3071)", () => {
    const tools = [{ name: "t" }];
    // A non-starved value is trusted verbatim and sets NO marker; a STARVE is
    // what records the no-ceiling degraded state (floored to the absolute minimum).
    const s = metaSession("deg");
    restoreOutputBudget({ max_tokens: 249, model: "prov/deepseek-flash" }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 249, "non-starved learning tracked verbatim");
    assert.equal(s.metadata.outputBudgetDegraded, undefined, "healthy-value learning sets no marker");
    const starved = { max_tokens: 16, tools, model: "prov/deepseek-flash" } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog);
    assert.equal(starved.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "starved 16 restored to the absolute floor (#3071)");
    const deg = s.metadata.outputBudgetDegraded as { model: string; value: number; ts: number } | undefined;
    assert.ok(deg !== undefined, "ceiling-less starved restore records the degraded state");
    assert.equal(deg!.model, "prov/deepseek-flash");
    assert.equal(deg!.value, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "records what was actually forwarded (the restored target)");
    assert.equal(typeof deg!.ts, "number");
    // A usable ceiling appearing CLEARS the marker (the pin is resolved).
    const capped = { max_tokens: 1, tools, model: "prov/deepseek-flash" } as { max_tokens: number };
    restoreOutputBudget(capped, s, noopLog, 65536);
    assert.equal(capped.max_tokens, 65536, "ceiling lifts the death rattle");
    assert.equal(s.metadata.outputBudgetDegraded, undefined, "a known ceiling clears the marker");
    // Re-starve ceiling-less → the marker returns.
    restoreOutputBudget({ max_tokens: 1, tools, model: "prov/deepseek-flash" }, s, noopLog);
    assert.ok(s.metadata.outputBudgetDegraded !== undefined, "marker re-set on a fresh ceiling-less starve");
    // A healthy (non-starved) budget for the SAME model clears it again.
    restoreOutputBudget({ max_tokens: 32768, model: "prov/deepseek-flash" }, s, noopLog);
    assert.equal(s.metadata.outputBudgetDegraded, undefined, "a recovered client estimate clears the marker");
    // Single slot: the last ceiling-less starved model wins (no per-model map).
    const sB = metaSession("degB");
    restoreOutputBudget({ max_tokens: 10, tools, model: "prov/model-a" }, sB, noopLog);
    restoreOutputBudget({ max_tokens: 10, tools, model: "prov/model-b" }, sB, noopLog);
    assert.equal((sB.metadata.outputBudgetDegraded as { model?: string })?.model, "prov/model-b", "last starved model wins the single slot");
    // Born-starved (no high-water yet, no ceiling): floored to the absolute minimum —
    // never recorded as a verbatim-forwarded rattle (#3071 path 2b).
    const sC = metaSession("bornDead");
    restoreOutputBudget({ max_tokens: 16, tools, model: "prov/cold" }, sC, noopLog);
    assert.equal((sC.metadata.outputBudgetDegraded as { value?: number })?.value, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "no high-water + no ceiling → records the floored value");
});

test("restoreOutputBudget: #3071 absolute floor stops the ceiling-less death spiral end-to-end", () => {
    const tools = [{ name: "t" }];
    const s = metaSession("spiral");
    // The observed decay (v0.1.195, model ark-code-latest, no declared output
    // ceiling): each NON-starved turn the client's raw-history estimate shrinks
    // further. Those are trusted verbatim and drive the high-water down to a
    // death rattle — exactly the poisoned state the old restore target pinned on.
    for (const v of [41753, 3071, 2061, 252]) {
        const body = { max_tokens: v, tools, model: "ark-code-latest" };
        restoreOutputBudget(body, s, noopLog);
        assert.equal(body.max_tokens, v, `non-starved ${v} is trusted verbatim`);
    }
    assert.equal(s.metadata.outputBudgetHighWater, 252, "high-water decayed to the poison (last non-starved wins)");
    // Once fully starved (<=200), every restore must hit the absolute minimum —
    // NOT the poisoned high-water of 252 that pinned the old behavior.
    for (let i = 0; i < 8; i += 1) {
        const body = { max_tokens: 1, tools, model: "ark-code-latest" };
        restoreOutputBudget(body, s, noopLog);
        assert.equal(body.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, `starved turn ${i} floored to the absolute minimum, not 252`);
    }
});

test("restoreOutputBudget: #3071 fork-inherited rattle is floored; a healthy value still wins", () => {
    const tools = [{ name: "t" }];
    // Path 2b: a fresh fork child inherits the parent's starved budget with no
    // high-water of its own and no known ceiling — the old code forwarded it
    // verbatim (max_tokens=1 out the door). It is now always floored.
    const child = metaSession("fork-child");
    const inherited = { max_tokens: 1, tools, model: "ark-code-latest" };
    restoreOutputBudget(inherited, child, noopLog);
    assert.equal(inherited.max_tokens, OUTPUT_RESTORE_ABSOLUTE_FLOOR, "fork-inherited starved budget is floored, not forwarded verbatim (#3071 path 2b)");
    // The floor is a LOWER bound only — a genuinely-healthy value above it is not
    // over-floored and sets no degraded marker.
    const healthy = metaSession("healthy");
    const big = { max_tokens: 32768, model: "ark-code-latest" };
    restoreOutputBudget(big, healthy, noopLog);
    assert.equal(big.max_tokens, 32768, "a value above the floor passes through untouched");
    assert.equal(healthy.metadata.outputBudgetDegraded, undefined, "a healthy value sets no degraded marker");
});

test("restoreOutputBudget: #3071 leaves the ceiling-known behavior unchanged (regression guard)", () => {
    const tools = [{ name: "t" }];
    // With a usable ceiling the client's small NON-starved value is trusted (not
    // raised by the absolute minimum) — only the starved branch consults it.
    const s = metaSession("ceiling-guard");
    const small = { max_tokens: 252, model: "capped/model" };
    restoreOutputBudget(small, s, noopLog, 131072);
    assert.equal(small.max_tokens, 252, "ceiling-known: a small non-starved value is trusted, not floored (#3071 scope)");
    assert.equal(s.metadata.outputBudgetHighWater, 252, "high-water tracks the client's own value when a ceiling exists");
    const starved = { max_tokens: 1, tools, model: "capped/model" };
    restoreOutputBudget(starved, s, noopLog, 131072);
    assert.equal(starved.max_tokens, 131072, "ceiling-known starve still restores to the ceiling");
    // A known ceiling BELOW the absolute minimum must win un-raised — the floor
    // bounds only a CEILING-LESS restore, never overrides a smaller declared cap.
    const sCap = metaSession("small-cap");
    const cappedSmall = { max_tokens: 1, tools, model: "small/cap" };
    restoreOutputBudget(cappedSmall, sCap, noopLog, 4096);
    assert.equal(cappedSmall.max_tokens, 4096, "known ceiling below the absolute floor is honored, not over-floored (#3071 scope)");
});

test("restoreOutputBudget: dsh-lane mid-band collapse is rescued when a ceiling is known (#3438)", () => {
    _resetDshMidBandWarningsForTest();
    const lines: string[] = [];
    const log = (_lvl: string, msg: string): void => { lines.push(msg); };
    const tools = [{ type: "function", function: { name: "bash" } }];
    const M = "cn:deepseek-v4.1-flash";
    const CEIL = 393_216;
    // Incident replay (v0.1.197, DSH desktop, responses wire): the session ran
    // healthy at the declared cap, then the client's raw-history estimate decayed
    // THROUGH the mid-band toward zero. Before #3438 every >200 value passed
    // verbatim AND re-seeded the high-water; the <=200 trigger was the only
    // rescue entry and all three observed collapses (2260/872/204) slipped past it.
    const s = metaSession("dsh-incident");
    const healthy = { max_output_tokens: CEIL, tools, model: M };
    restoreOutputBudget(healthy, s, noopLog, CEIL, true);
    assert.equal(healthy.max_output_tokens, CEIL, "at-ceiling value passes untouched");
    assert.equal(s.metadata.outputBudgetHighWater, CEIL, "the healthy value seeds the high-water");
    for (const v of [2260, 872, 204]) {
        const body = { max_output_tokens: v, tools, model: M };
        restoreOutputBudget(body, s, log, CEIL, true);
        assert.equal(body.max_output_tokens, CEIL, `${v} restored to the known ceiling (#3438)`);
        assert.equal(s.metadata.outputBudgetHighWater, CEIL, "a collapsed value must NOT re-seed the high-water");
    }
    assert.ok(lines.some((l) => l.includes("output budget restored 2260 -> 393216")), "the restore is logged");
    assert.ok(lines.some((l) => l.includes("#3438: dsh-lane mid-band collapse")), "the mid-band origin names itself in the log");
    // A mid-band value far above the starve gate is the same signature.
    const deep = { max_output_tokens: 25_484, tools, model: M };
    restoreOutputBudget(deep, s, log, CEIL, true);
    assert.equal(deep.max_output_tokens, CEIL, "25484 (< ceiling) is a collapse too, not a healthy small budget");
    // The over-restoration surface is deliberate on this lane: even a plausible
    // deliberate-looking 32K budget is raised to the declared cap — on the dsh
    // contract the client's number is always its estimator, never intent.
    const mid = { max_output_tokens: 32_768, tools, model: M };
    restoreOutputBudget(mid, s, log, CEIL, true);
    assert.equal(mid.max_output_tokens, CEIL, "32768 < 393216 is still below the declared cap -> raised");
    // A side request (no tools) on the same lane is NEVER touched — restoring it
    // would break its side status — and it must not seed the high-water either.
    const side = { max_output_tokens: 1024, model: M };
    restoreOutputBudget(side, s, log, CEIL, true);
    assert.equal(side.max_output_tokens, 1024, "tool-less mid-band passes verbatim");
    assert.equal(s.metadata.outputBudgetHighWater, CEIL, "the side request did not poison the high-water");
    // Below the starve gate the pre-existing rescue entry point still applies.
    const starved = { max_output_tokens: 150, tools, model: M };
    restoreOutputBudget(starved, s, log, CEIL, true);
    assert.equal(starved.max_output_tokens, CEIL, "the <=200 entry point still rescues on the dsh lane");
});

test("restoreOutputBudget: non-dsh lanes keep trusting a below-ceiling budget (#3438 scope guard)", () => {
    const tools = [{ name: "t" }];
    const s = metaSession("non-dsh");
    const body = { max_tokens: 8000, tools, model: "prov/model" };
    restoreOutputBudget(body, s, noopLog, 393_216);
    assert.equal(body.max_tokens, 8000, "no lane flag: a below-ceiling value is intent, forwarded verbatim");
    assert.equal(s.metadata.outputBudgetHighWater, 8000, "recorded as the session's own proven budget");
    const explicit = { max_tokens: 4096, tools, model: "prov/model" };
    restoreOutputBudget(explicit, s, noopLog, 393_216, false);
    assert.equal(explicit.max_tokens, 4096, "an explicit false behaves like absent");
    // The <=200 starve restores to the ceiling regardless of the lane flag.
    const starved = { max_tokens: 16, tools, model: "prov/model" };
    restoreOutputBudget(starved, s, noopLog, 393_216, true);
    assert.equal(starved.max_tokens, 393_216, "starve target logic is untouched by the lane flag");
});

test("restoreOutputBudget: dsh-lane mid-band WITHOUT a ceiling forwards verbatim and warns once per session+model (#3438)", () => {
    _resetDshMidBandWarningsForTest();
    const warns: string[] = [];
    const log = (lvl: string, msg: string): void => { if (lvl === "warn") warns.push(msg); };
    const tools = [{ name: "t" }];
    const A = "prov/unknown-model";
    const s = metaSession("dsh-nocap");
    const body = { max_tokens: 2260, tools, model: A };
    restoreOutputBudget(body, s, log, undefined, true);
    assert.equal(body.max_tokens, 2260, "no ceiling: bili cannot judge collapse from intent, forwards verbatim");
    assert.equal(s.metadata.outputBudgetHighWater, 2260, "no-ceiling learning is unchanged (trusted verbatim)");
    let hits = warns.filter((l) => l.includes("cannot tell a raw-history collapse from deliberate intent"));
    assert.equal(hits.length, 1, "one warn for the unrescuable mid-band");
    assert.match(hits[0] ?? "", /model=prov\/unknown-model/, "names the model");
    assert.match(hits[0] ?? "", /providers\.<url>\.models/, "points at the config escape hatch");
    // Deduped per session+model.
    restoreOutputBudget({ max_tokens: 872, tools, model: A }, s, log, undefined, true);
    assert.equal(warns.filter((l) => l.includes("deliberate intent")).length, 1, "deduped per session+model");
    // A different model in the same session warns of its own.
    restoreOutputBudget({ max_tokens: 872, tools, model: "prov/other" }, s, log, undefined, true);
    assert.equal(warns.filter((l) => l.includes("deliberate intent")).length, 2, "per session+model, not per session");
    // Tool-less mid-band: not a main turn, stays silent.
    const side = { max_tokens: 1024, model: A };
    restoreOutputBudget(side, s, log, undefined, true);
    assert.equal(side.max_tokens, 1024, "side request passes verbatim");
    assert.equal(warns.filter((l) => l.includes("deliberate intent")).length, 2, "the side request stays silent");
    // Non-dsh lane: silent passthrough, no new warn.
    const other = { max_tokens: 2260, tools, model: A };
    restoreOutputBudget(other, metaSession("plain"), log);
    assert.equal(other.max_tokens, 2260, "no lane flag: plain passthrough");
    assert.equal(warns.filter((l) => l.includes("deliberate intent")).length, 2, "no lane flag -> no new warn");
});

test("restoreOutputBudget: the <=200 starve log keeps its original wording, the mid-band names #3438", () => {
    const lines: string[] = [];
    const log = (_lvl: string, msg: string): void => { lines.push(msg); };
    const tools = [{ name: "t" }];
    const s = metaSession("wording");
    const starved = { max_tokens: 16, tools, model: "m/x" };
    restoreOutputBudget(starved, s, log, 32_768, true);
    assert.ok(lines.some((l) => l.includes("#546: client shrank it from its raw-history estimate")), "the starve wording is byte-identical to before");
    const mid = { max_tokens: 872, tools, model: "m/x" };
    restoreOutputBudget(mid, s, log, 32_768, true);
    assert.ok(lines.some((l) => l.includes("#3438: dsh-lane mid-band collapse")), "the mid-band restore names itself");
});

test("restoreOutputBudget: a KNOWN ceiling with value >= ceiling is healthy — no spurious 'NO known output ceiling' warn (#4501)", () => {
    _resetDshMidBandWarningsForTest();
    const warns: string[] = [];
    const log = (lvl: string, msg: string): void => { if (lvl === "warn") warns.push(msg); };
    const tools = [{ name: "t" }];
    const M = "prov/capped-model";
    const CEIL = 131_072;
    const midBandWarns = (): number => warns.filter((w) => w.includes("NO known output ceiling")).length;
    // Pre-#4501 the mid-band warn fired on any dsh-lane tool-carrying budget in
    // the healthy branch — including when a ceiling WAS known (value >= ceiling) —
    // spamming operators who had declared one. A known ceiling makes it healthy.
    const s = metaSession("dsh-cap-known");
    const atCap = { max_tokens: CEIL, tools, model: M };
    restoreOutputBudget(atCap, s, log, CEIL, true);
    assert.equal(atCap.max_tokens, CEIL, "at-ceiling value passes untouched");
    assert.equal(midBandWarns(), 0, "a KNOWN ceiling suppresses the mid-band warn");
    const over = { max_tokens: CEIL + 1, tools, model: M };
    restoreOutputBudget(over, s, log, CEIL, true);
    assert.equal(over.max_tokens, CEIL + 1, "above-ceiling passes verbatim (not a collapse)");
    assert.equal(midBandWarns(), 0, "above-ceiling is also not a missing-ceiling gap");
    const s2 = metaSession("dsh-cap-none");
    restoreOutputBudget({ max_tokens: CEIL, tools, model: M }, s2, log, undefined, true);
    assert.equal(midBandWarns(), 1, "no ceiling -> the warn still fires exactly once");
});

test("resolveKnownOutputCeiling: runtime-info > launcher > declared > registry rank order (#1840)", () => {
    _resetPluginStateForTest();
    setRegistryForTest({ "stepfun/step-5-preview": { limit: { context: 1_000_000, output: 1_000_000 } } });
    try {
        const routes = { "https://api.stepfun.com": { models: { "stepfun/step-5-preview": { output: 4096 } } } };
        const url = "https://api.stepfun.com/step_plan/v1/chat/completions";
        const parsed = { model: "stepfun/step-5-preview" };
        // Registry alone (no headers, no routes): last-resort source. The host is
        // not a known models.dev provider, so the cross-provider suffix scan finds it.
        assert.equal(resolveKnownOutputCeiling({}, parsed, {}, url), 1_000_000, "registry ceiling is the last resort");
        // Operator-declared outranks the registry data (#924 rank).
        assert.equal(resolveKnownOutputCeiling({}, parsed, routes, url), 4096, "declared output outranks registry data");
        // Agent-scoped runtime-info outranks the declaration (#955 rank): what the
        // client is configured to ask beats operator guesswork.
        recordPluginRuntimeInfo({ agent: "dsh", model: "stepfun/step-5-preview", maxOutput: 256_000, source: "client-config", ts: Date.now() });
        assert.equal(resolveKnownOutputCeiling({ "x-bili-plugin": "dsh" }, parsed, routes, url), 256_000, "runtime-info table outranks declared");
        // Per-request header outranks the table (same gate as the window chain).
        recordPluginRuntimeInfo({ agent: "dsh", model: "stepfun/step-5-preview", maxOutput: 8_000, source: "client-config", ts: Date.now() });
        const hdrs = { "x-bili-plugin": "dsh", "x-bili-plugin-model": "step-5-preview", "x-bili-plugin-max-output": "131072" };
        assert.equal(resolveKnownOutputCeiling(hdrs, parsed, routes, url), 131_072, "per-request header outranks the runtime table");
        // Stale entry: a report for one model never sizes another.
        assert.equal(resolveKnownOutputCeiling({ "x-bili-plugin": "dsh" }, { model: "other/model" }, routes, url), undefined, "stale entry never sizes another model");
        // Unannounced max-output header (no x-bili-plugin) is inert by design.
        assert.equal(resolveKnownOutputCeiling({ "x-bili-plugin-max-output": "999999" }, parsed, routes, url), 4096, "unannounced header ignored, falls through to declared");
        // No model on the body → nothing to resolve.
        assert.equal(resolveKnownOutputCeiling({}, {}, routes, url), undefined);
    } finally {
        setRegistryForTest({});
        _resetPluginStateForTest();
    }
});

const MODEL = "claude-sonnet-4-5";
const SESSION = "side-iso-sess";
const MAIN_INPUT_TOKENS = 50_000;
const SIDE_INPUT_TOKENS = 56;

test("estimateRawBodyTokens: counts string leaves, skips binary-carrying keys (#554)", () => {
    const txt = "z".repeat(800);
    const body = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: txt }] };
    assert.equal(
        estimateRawBodyTokens(body),
        defaultCountTokens(MODEL) + defaultCountTokens("user") + defaultCountTokens(txt),
        "every counted string leaf goes through the CJK-aware estimator",
    );
    // Binary-carrying fields are excluded (image-tokens charges them separately).
    const data = "A".repeat(8000);
    const imgBody = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: [
        { type: "text", text: txt },
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ] }] };
    assert.equal(
        estimateRawBodyTokens(imgBody),
        defaultCountTokens(MODEL) + defaultCountTokens("user")
        + defaultCountTokens("text") + defaultCountTokens(txt)
        + defaultCountTokens("image") + defaultCountTokens("base64") + defaultCountTokens("image/png"),
        "data field excluded, structural strings still counted",
    );
    assert.equal(estimateRawBodyTokens({ url: "http://x/y".repeat(1000) }), 0, "url field excluded");
    assert.equal(estimateRawBodyTokens({ b64_json: "A".repeat(10_000) }), 0, "b64_json field excluded");
    assert.equal(estimateRawBodyTokens({ file_data: "data:application/pdf;base64,".padEnd(10_000, "A") }), 0, "file_data data-URL excluded");
    assert.equal(estimateRawBodyTokens(null), 0, "null body");
    assert.equal(estimateRawBodyTokens(42), 0, "non-object body");
    // CJK must not be undercounted by the chars/4 fast path.
    assert.ok(estimateRawBodyTokens({ content: "汉".repeat(100) }) >= 100, "CJK counted per-char");
});

test("inspectContextOverflow: exceed_context_size_error pattern + (A / B > W) window parse (#554)", () => {
    const llama = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 150,528)" } });
    const hit = inspectContextOverflow(400, llama);
    assert.equal(hit.isOverflow, true, "llama.cpp-family marker recognized");
    assert.equal(hit.window, 150_528, "window is the limit after '>' inside the parens, not A or B");
    assert.equal(inspectContextOverflow(200, llama).isOverflow, false, "status gate: 200 is not an overflow");
    assert.equal(inspectContextOverflow(418, llama).isOverflow, false, "status gate: only 400/413 count");
    // Existing markers still work (regression).
    assert.equal(inspectContextOverflow(400, JSON.stringify({ error: { message: "context_length_exceeded" } })).isOverflow, true);
    const openai = inspectContextOverflow(400, JSON.stringify({ error: { message: "maximum context length is 131072 tokens" } }));
    assert.equal(openai.isOverflow, true);
    assert.equal(openai.window, 131_072);
});

test("sideRequestGuard: raw-body fit against declared ∩ armed window minus output headroom (#554)", () => {
    const txt = "z".repeat(8000);
    const body = { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: txt }] };
    const est = estimateRawBodyTokens(body);
    assert.ok(est > 0);
    assert.equal(sideRequestGuard(body, "anthropic", 0, undefined, undefined, 1).blocked, false, "unknown window → forward as before");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, undefined, undefined, 1).blocked, false, "fits");
    assert.equal(sideRequestGuard(body, "anthropic", Math.floor(est / 1.15), undefined, undefined, 1).blocked, true, "boundary: estimate == limit x 1.15 blocks");
    assert.equal(sideRequestGuard(body, "anthropic", Math.floor(est / 1.10), undefined, undefined, 1).blocked, false, "within the 15% estimator tolerance → forward");
    assert.equal(sideRequestGuard(body, "anthropic", 1_000_000, undefined, undefined, 1, Math.floor(est / 1.15)).blocked, true, "armed smaller (beyond tolerance) → blocks");
    assert.equal(sideRequestGuard(body, "anthropic", est + 1, undefined, undefined, 1, 1_000_000).blocked, false, "armed larger than declared is ignored");
    // OpenAI wire: the output budget counts against the window → headroom
    // reserved. #4205: the reservation policy is passed from the call site —
    // these rows pin the reserving direction explicitly.
    const oa = { model: MODEL, max_completion_tokens: 2_000, stream: true, messages: [{ role: "user", content: txt }] };
    const oaEst = estimateRawBodyTokens(oa);
    const oaLimit = Math.floor(oaEst / 1.15);
    const g = sideRequestGuard(oa, "openai", oaLimit + 2_000, undefined, undefined, 1, 0, undefined, true);
    assert.equal(g.limit, oaLimit, "limit reduced by max_completion_tokens");
    assert.equal(g.blocked, true, "boundary after reservation (with tolerance) blocks");
    assert.equal(sideRequestGuard(oa, "openai", oaEst + 2_001, undefined, undefined, 1, 0, undefined, true).blocked, false);
    // #4205: wrapper providers on the anthropic wire reserve too — same
    // mechanics, policy decided by the caller (route + model evidence).
    // The rows above with default (false) pin the non-reserving real-Claude
    // route; these pin the reserving wrapper route (#3617 both directions).
    const gw = sideRequestGuard(body, "anthropic", Math.floor(est / 1.15) + 100, undefined, undefined, 1, 0, undefined, true);
    assert.equal(gw.limit, Math.floor(est / 1.15), "anthropic wrapper route: limit reduced by max_tokens");
    assert.equal(gw.blocked, true, "anthropic wrapper route: boundary after reservation blocks");
    assert.equal(sideRequestGuard(body, "anthropic", est + 101, undefined, undefined, 1, 0, undefined, true).blocked, false, "anthropic wrapper route: within tolerance after reservation forwards");
    // Image tokens count toward the estimate.
    const imgBody = { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: [
        { type: "text", text: "z".repeat(4000) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(8000) } },
    ] }] };
    const imgEst = estimateRawBodyTokens(imgBody) + Math.ceil(8000 / 4);
    assert.equal(sideRequestGuard(imgBody, "anthropic", Math.floor(imgEst / 1.15), undefined, undefined, 1).blocked, true, "image cost included at boundary");
    // CJK estimator bias: defaultCountTokens counts CJK per-char (~1.6x real),
    // so a CJK-heavy payload estimated at ~110% of the window must forward —
    // the upstream's real overflow 400 arms the evidence that blocks re-sends.
    const cjkBody = { model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "汉".repeat(4000) }] };
    const cjkEst = estimateRawBodyTokens(cjkBody);
    assert.ok(cjkEst >= 4000, "CJK counted per-char");
    assert.equal(sideRequestGuard(cjkBody, "anthropic", Math.floor(cjkEst / 1.10), undefined, undefined, 1).blocked, false, "CJK over-estimation absorbed by tolerance");
    assert.equal(sideRequestGuard(cjkBody, "anthropic", Math.floor(cjkEst / 1.20), undefined, undefined, 1).blocked, true, "genuinely oversized CJK still blocks");
});

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** When set, served verbatim for side requests (max_tokens<=200) instead
     *  of the generated okSse stream. */
    sideScript: string | null;
    /** Last request body received by the upstream (for wire assertions). */
    lastBody: Record<string, unknown> | null;
    /** Total requests received by the upstream (hit-count assertions). */
    upstreamHits: number;
    /** When set, side requests get this status + JSON body instead of okSse. */
    sideErrorStatus: number | null;
    sideErrorBody: string | null;
}

// modelContextLimit alone is NOT enough to shrink the effective window: per-
// request resolution re-resolves it from the registry/static table (claude-
// sonnet-4-5 → 200k) unless the operator explicitly tunes
// compress.modelContextLimit, which outranks everything (#344). The rig exposes
// both so tests can pin the exact window the guard sees.
async function startRig(opts?: { modelContextLimit?: number; compressModelContextLimit?: number; store?: SessionStore; routeModels?: Record<string, { context?: number; output?: number }> }): Promise<Rig> {
    const modelContextLimit = opts?.modelContextLimit ?? 200_000;
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, sideScript: null, lastBody: null, upstreamHits: 0, sideErrorStatus: null, sideErrorBody: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { max_tokens?: number } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            rig.lastBody = parsed as Record<string, unknown>;
            rig.upstreamHits++;
            // Side requests (tiny max_tokens) report a TINY context; main requests
            // report a large one. The proxy must NOT capture the side request's
            // usage — that is exactly the pollution this regression guards.
            const isSide = typeof parsed.max_tokens === "number" && parsed.max_tokens <= 200;
            if (isSide && rig.sideErrorStatus !== null) {
                res.writeHead(rig.sideErrorStatus, { "content-type": "application/json" });
                res.end(rig.sideErrorBody ?? "{}");
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(isSide && rig.sideScript ? rig.sideScript : okSse(isSide ? SIDE_INPUT_TOKENS : MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(opts?.store ?? new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        proxy: "",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: opts?.routeModels ? { models: opts.routeModels } : {} },
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: { injectTool: true, injectNudge: true, ...(opts?.compressModelContextLimit !== undefined ? { modelContextLimit: opts.compressModelContextLimit } : {}) },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("e2e: opencode v2 title-gen is classified by intent, not token budget (#1699)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const baseHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "opencode",
            "x-bili-plugin-conversation": SESSION,
        };
        // The exact opencode v2 title-gen shape that triggered the bug: one short
        // instruction, NO max_tokens (options {} for kind==="title").
        const titleBody = { model: MODEL, stream: true, messages: [{ role: "user", content: "Generate a short title for this conversation." }] };

        // Repro (pre-fix behavior): WITHOUT x-bili-plugin-agent the budget heuristic
        // sees no max_tokens → defaults to 8192 → NOT a side request → treated as a
        // main turn, so its standing system slot gets filled. #4998 made the compress
        // surface observational per request: this exact title-gen shape declares no bili
        // tools, so the slot now carries the small tags-only prompt instead of the full
        // standing compress prompt (the reported ~11KiB injection) — silencing a tool
        // the one-shot title model cannot call.
        const rControl = await fetch(url, { method: "POST", headers: baseHeaders, body: JSON.stringify(titleBody) });
        assert.equal(rControl.status, 200);
        await rControl.text();
        const controlFwd = rig.lastBody as { messages?: unknown } | null;
        assert.ok(controlFwd, "control: upstream received the request");
        assert.notDeepEqual(controlFwd?.messages, titleBody.messages, "control: without the agent header the title request is misclassified as a main turn and its messages are rewritten");
        assert.ok(!JSON.stringify(controlFwd ?? {}).includes("Compression Philosophy"), "control: the toolless round carries no standing compress prompt — reachability is observed per request (#4998)");

        // Fix: WITH x-bili-plugin-agent=title the request is a side request by
        // intent and is forwarded VERBATIM — its messages arrive byte-identical,
        // nothing injected, kernel state untouched.
        const rFix = await fetch(url, { method: "POST", headers: { ...baseHeaders, "x-bili-plugin-agent": "title" }, body: JSON.stringify(titleBody) });
        assert.equal(rFix.status, 200);
        await rFix.text();
        const fixFwd = rig.lastBody as { messages?: unknown } | null;
        assert.ok(fixFwd, "fix: upstream received the request");
        assert.deepEqual(fixFwd?.messages, titleBody.messages, "fix: title-gen messages forwarded verbatim (no compress prompt/render tags injected)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: side request response still gets render-tag stripping (#460 contract)", async () => {
    const LT = "\x3c";
    const GT = "\x3e";
    const OPEN_MARK = `${LT}acp `;
    const CLOSE_MARK = `${LT}/acp${GT}`;
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        // Main request first so the session has a real view.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        await r1.text();
        const stateAfterMain = JSON.stringify(getSession(SESSION).state);
        // Side request whose stream echoes a render tag (a model echoing the
        // compressed history into a title). The strip pipes must still run for
        // side requests — kernel state untouched, response hygiene intact.
        const tagged = `title: ${LT}acp tokens="12" type="text"${GT}m00009${LT}/acp${GT}ok`;
        const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: SIDE_INPUT_TOKENS } } })}\n\n` +
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tagged } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
        rig.sideScript = sse;
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title." }] }) });
        assert.equal(r2.status, 200);
        let raw = "";
        for await (const chunk of r2.body!) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "side-request stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "side-request stream leaked a render close tag");
        assert.equal(JSON.stringify(getSession(SESSION).state), stateAfterMain, "tag-strip pipe must not touch kernel state (session stays off)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: anthropic side request (title-gen) leaves main session kernel state untouched", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main request 1: a normal turn (large max_tokens) → kernel state mutates.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request must mutate kernel state");
        assert.ok(Object.keys(s1.state.messageRefs.byRaw).length > 0, "refs assigned to the main messages");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main request usage captured as the nudge baseline");
        assert.ok(s1.lastMessages && s1.lastMessages.length > 0, "message snapshot set to the main request view");

        const stateAfterMain1 = JSON.stringify(s1.state);
        const statsAfterMain1 = JSON.stringify(s1.stats);
        const snapshotAfterMain1 = JSON.stringify(s1.lastMessages);
        const requestsAfterMain1 = s1.stats.requests;

        // Side request: title-gen (tiny max_tokens) on the SAME session key.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title for this conversation." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the side request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain1, "side request must NOT mutate kernel state (refs / survivedCount / nudge baseline)");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain1, "side request must NOT mutate stats");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain1, "side request must NOT clobber the message snapshot (bili export view)");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "side request's tiny usage must NOT overwrite the main nudge baseline");
        assert.equal(s2.stats.requests, requestsAfterMain1, "side request must NOT increment the main request counter");

        // Main request 2: a normal turn again → kernel state advances (monotonic).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();

        const s3 = getSession(SESSION);
        assert.ok(s3, "session exists after main request 2");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain1, "main request 2 must advance kernel state (driven only by main requests)");
        assert.ok(s3.stats.requests > requestsAfterMain1, "main request 2 increments the request counter");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: starved tool-carrying main request re-enters pipeline at restored budget (#546)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        const tools = [{ name: "compress", description: "compress", input_schema: { type: "object", properties: {} } }];

        // Healthy main turn WITH tools: teaches the session its output budget.
        // Above OUTPUT_RESTORE_ABSOLUTE_FLOOR so this exercises the high-water
        // path, not the #3071 ceiling-less floor.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 49152, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(SESSION);
        const requestsAfterMain1 = s1.stats.requests;
        assert.equal(s1.metadata.outputBudgetHighWater, 49152, "high-water learned from the healthy main turn");

        // Death-spiral turn: the client shrank the budget to 16 tokens off its
        // raw-history estimate. The request still carries tools → it is a MAIN
        // turn: the pipeline must run (no side passthrough) and the budget must
        // reach the upstream restored to the high-water.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 16, stream: true, tools, messages: mainConversation(9) }) });
        assert.equal(r2.status, 200);
        await r2.text();
        const s2 = getSession(SESSION);
        assert.ok(s2.stats.requests > requestsAfterMain1, "starved main turn must go through the pipeline, not side passthrough");
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 49152, "upstream received the restored budget (#546)");

        // A real side request (no tools, tiny budget) on the same session stays
        // a pure passthrough: budget NOT restored, kernel untouched.
        const stateBeforeSide = JSON.stringify(s2.state);
        const statsBeforeSide = JSON.stringify(s2.stats);
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "short title" }] }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 100, "side request budget untouched");
        const s3 = getSession(SESSION);
        assert.equal(JSON.stringify(s3.state), stateBeforeSide, "side request left kernel state untouched");
        assert.equal(JSON.stringify(s3.stats), statsBeforeSide, "side request left stats untouched");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: starved main request with a poisoned high-water is floored by the configured output limit (#1665)", async () => {
    const rig = await startRig({ routeModels: { [MODEL]: { output: 4096 } } });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        const tools = [{ name: "compress", description: "compress", input_schema: { type: "object", properties: {} } }];

        // First request bili sees for this session is already mid-death-spiral:
        // the client's raw-history estimate decayed its budget to 234 (>200, so it
        // seeds the water mark) — without the floor every later starved turn would
        // restore 234 forever.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 234, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(getSession(SESSION).metadata.outputBudgetHighWater, 234, "poisoned water mark seeded from the decaying client");

        // Fully starved now: the configured output limit must floor the restore.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1, stream: true, tools, messages: mainConversation(9) }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 4096, "configured output limit floors the poisoned restore (#1665)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: poisoned high-water is floored by the known output ceiling when no route output is declared (#1840)", async () => {
    // NO routeModels: nothing operator-declared on this route — exactly the
    // stepfun scenario where the bili config stayed empty and only the registry
    // (or the client itself) knows the model's output ceiling.
    const rig = await startRig();
    try {
        setRegistryForTest({ [MODEL]: { limit: { output: 8192 } } });
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        const tools = [{ name: "compress", description: "compress", input_schema: { type: "object", properties: {} } }];

        // First request bili sees is already mid-death-spiral (budget decayed to
        // 234) — seeds the poisoned water mark exactly like #1665.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 234, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(getSession(SESSION).metadata.outputBudgetHighWater, 234, "poisoned water mark seeded");

        // Fully starved, nothing declared anywhere but the registry knows the
        // ceiling → the registry floor must lift the restore out of the rattle.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1, stream: true, tools, messages: mainConversation(9) }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 8192, "registry ceiling floors the poisoned restore when nothing is declared (#1840)");

        // Born-starved session (fresh id, first request already <=200): the floor
        // applies even though no high-water was ever learned.
        const r3 = await fetch(url, { method: "POST", headers: { ...headers, "x-acp-session": SESSION + "-born" }, body: JSON.stringify({ model: MODEL, max_tokens: 1, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 8192, "never-seeded session restored to the known ceiling (#1840)");

        // Per-request runtime-info header (what dsh stamps from its own profile)
        // outranks the registry listing — the client's configured budget wins.
        const r4 = await fetch(url, { method: "POST", headers: { ...headers, "x-bili-plugin": "dsh", "x-bili-plugin-model": MODEL, "x-bili-plugin-max-output": "16384" }, body: JSON.stringify({ model: MODEL, max_tokens: 1, stream: true, tools, messages: mainConversation(10) }) });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 16384, "client-reported max output outranks the registry listing (#1840)");
    } finally {
        setRegistryForTest({});
        await closeRig(rig);
    }
});

test("e2e: dsh-lane mid-band budget is restored to the declared output ceiling on the wire (#3438)", async () => {
    // Server-level wiring proof for the incident: a dsh plugin-stamped main turn
    // whose raw-history estimate decayed into the mid-band (above the <=200 starve
    // gate, below the declared ceiling) must leave the proxy at the ceiling.
    // 16K stays well inside the default 200K rig window so the downstream clamp
    // cannot touch the restored value.
    const CEIL = 16_384;
    const rig = await startRig({ routeModels: { [MODEL]: { output: CEIL } } });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "dsh",
            "x-bili-plugin-conversation": SESSION,
        };
        // Host-shaped tool names: a tool literally named "compress" is a LEAKED
        // bili tool on this lane — #1897 strips it and demotes the request to
        // side passthrough BEFORE restoreOutputBudget ever runs (#1897 gate).
        const tools = [
            { name: "bash", description: "run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
            { name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        ];
        // Healthy turn at the declared cap first (seeds the water mark, like the
        // incident session before its estimate decayed).
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: CEIL, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, CEIL, "at-ceiling value forwarded untouched");
        // The incident's three collapses, one by one through the real pipeline.
        for (const v of [2260, 872, 204]) {
            const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: v, stream: true, tools, messages: mainConversation(9) }) });
            assert.equal(r.status, 200);
            await r.text();
            assert.equal(rig.lastBody && rig.lastBody.max_tokens, CEIL, `${v} restored to the declared ceiling on the wire (#3438)`);
            assert.equal(getSession(SESSION).metadata.outputBudgetHighWater, CEIL, "the collapsed value did not re-seed the high-water");
        }
        // A non-dsh client on the SAME route keeps the old behavior: below-ceiling
        // is intent there and forwards verbatim (the lane flag is the whole scope).
        const rPlain = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": SESSION + "-plain" }, body: JSON.stringify({ model: MODEL, max_tokens: 2260, stream: true, tools, messages: mainConversation(8) }) });
        assert.equal(rPlain.status, 200);
        await rPlain.text();
        assert.equal(rig.lastBody && rig.lastBody.max_tokens, 2260, "non-dsh lane: below-ceiling trusted verbatim (#3438 scope guard)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: oversized side request is blocked locally (413), never reaches the upstream (#554)", async () => {
    const rig = await startRig({ modelContextLimit: 4_000, compressModelContextLimit: 4_000 });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ~40 × ~130 tokens ≈ 5k+ > 4_000 window → guaranteed upstream 400 if forwarded.
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: mainConversation(40) }) });
        assert.equal(r.status, 413);
        const j = (await r.json()) as { error: { type: string; code: string; retryable: boolean; message: string } };
        assert.equal(j.error.type, "server_error");
        assert.equal(j.error.code, "side_request_payload_too_large");
        assert.equal(j.error.retryable, false);
        assert.match(j.error.message, /NOT forwarded/);
        assert.equal(rig.upstreamHits, 0, "oversized side request must NOT reach the upstream");

        // A fitting side request on the same rig still passes through verbatim.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "fitting side request reaches the upstream");
        assert.equal(rig.lastBody?.max_tokens, 100, "body untouched (verbatim passthrough preserved)");

        const s = getSession(SESSION);
        assert.ok(s, "session row exists (created before the gate)");
        assert.equal(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state untouched by side requests (blocked or not)");
        assert.equal(s.stats.requests, 0, "side requests do not count as main requests");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: overflow 400 on a side request arms the stated window; next one is blocked locally (#554)", async () => {
    const rig = await startRig(); // 200_000 configured window
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ~1200 × ~130 ≈ 155k tokens: below the 200k configured window (so the
        // first attempt forwards) but above the real 120,000 window the upstream
        // reports in its overflow marker. #987: the marker's number is no longer
        // LEARNED, but it arms the one-shot evidence at 120k — enough for the
        // guard to block the second attempt locally.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400, "first overflow surfaces to the client");
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1);
        assert.equal(s1.metadata.confirmedContextLimits, undefined, "#987: no window learned");
        assert.equal(s1.stats.lastInputTokens, 120_000, "emergency shrink armed at the stated window");

        // Identical second request: now blocked locally — no second upstream hit.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413);
        const j = (await r2.json()) as { error: { code: string } };
        assert.equal(j.error.code, "side_request_payload_too_large");
        assert.equal(rig.upstreamHits, 1, "second oversized side request must NOT reach the upstream again");
        assert.equal(JSON.stringify(getSession(SESSION).state), JSON.stringify(createInitialState()), "kernel state untouched throughout");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: healthy host baseline must NOT clamp an unrelated side request (#1110)", async () => {
    const rig = await startRig(); // declared window 200_000
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Host conversation active and healthy: one normal main turn whose real
        // usage lands at MAIN_INPUT_TOKENS (50k) → nudge baseline 50k, source
        // "usage". NO overflow ever happened, so there is NO overflow arm.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main turn");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "healthy host turn sets the nudge baseline");
        assert.equal(s1.stats.lastInputTokensSource, "usage", "baseline provenance is a real usage report");
        assert.equal(s1.stats.overflowArmTokens, undefined, "#1110: no overflow occurred → no arm");

        // An UNRELATED in-process caller's fixed-size request (the MemOS shape):
        // no tools, tiny output budget → a side request, but its raw body (~90k
        // tokens) exceeds the host's 50k baseline × 1.15 while still fitting the
        // model's real 200k window. Pre-#1110 the guard clamped the effective
        // window to that 50k baseline and 413'd this permanently; post-fix it
        // must forward verbatim.
        const bigSideContent = "z".repeat(360_000);
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: bigSideContent }] }) });
        assert.equal(r2.status, 200, "#1110: unrelated side request that fits the real window must forward, not be 413'd by the host baseline");
        await r2.text();
        assert.ok(rig.upstreamHits >= 2, "the unrelated side request reached the upstream");

        // Side passthrough left the host baseline and kernel state untouched.
        assert.equal(getSession(SESSION).stats.lastInputTokens, MAIN_INPUT_TOKENS, "side request did not clobber the host baseline");
        assert.equal(getSession(SESSION).stats.overflowArmTokens, undefined, "#1110: a forwarded (non-overflow) side request must not mint an arm");
    } finally {
        await closeRig(rig);
    }
});

// #1129: the RELEASE direction of the one-shot overflow arm. #554/#1110 pin
// the ARMING direction (overflow 400 → next oversized side request 413s
// locally); nothing pinned that a REAL usage report on a later main turn
// retires the arm so the side request forwards again. The release rests on
// paired `delete session.stats.overflowArmTokens` writes (streaming
// src/loop/core.ts, non-streaming src/server.ts, plugin src/plugin.ts, plus
// resetSessionCompression) — a refactor that mis-gates any of them would
// 413 side requests permanently: the #1110 deadlock re-entered through the
// overflow path.
test("e2e: real usage report RETIRES the overflow arm — the blocked side request forwards again (#1129)", async () => {
    const rig = await startRig(); // declared window 200_000
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // 1) ARM — same shape as the #554 arm test: ~155k payload fits the
        //    declared 200k window (first attempt forwards) but exceeds the real
        //    120,000 the upstream states in its overflow marker.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400, "first overflow surfaces to the client");
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1);
        assert.equal(s1.stats.overflowArmTokens, 120_000, "arm recorded separately from the nudge baseline (#1110)");

        // 2) Armed → identical side request is blocked locally, no upstream hit.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413);
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "armed guard blocks without a second upstream hit");

        // 3) RELEASE — one healthy MAIN turn streams a real usage report. The
        //    streaming recordUsage path (src/loop/core.ts) must delete the arm
        //    alongside the lastInputTokens = "usage" write.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = getSession(SESSION);
        assert.equal(s3.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main turn resets the nudge baseline");
        assert.equal(s3.stats.lastInputTokensSource, "usage", "release provenance is a real usage report");
        assert.equal(s3.stats.overflowArmTokens, undefined, "#1129: a real usage report retires the one-shot arm");

        // 4) The SAME oversized-but-fits-declared-window side request forwards
        //    again — the released arm must not linger as a permanent clamp.
        rig.sideErrorStatus = null;
        const r4 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r4.status, 200, "#1129: released arm lets the side request through again");
        await r4.text();
        assert.equal(rig.upstreamHits, 3, "overflow + main + resent side request — nothing else hit the upstream");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: the overflow arm survives a restart round-trip; usage after reload releases it (#1129)", async () => {
    // Restart shape: armed session flushed to disk, memory cleared, a FRESH
    // store instance over the same dir (process restart). The arm must still
    // block locally after reload, and a real usage report must still release it.
    const dir = mkdtempSync(join(tmpdir(), "bili-side-arm-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    let store2: SessionStore | null = null;
    const rig = await startRig({ store });
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // ARM: overflow 400 → arm at the stated 120k.
        const big = mainConversation(1200);
        rig.sideErrorStatus = 400;
        rig.sideErrorBody = JSON.stringify({ error: { message: "exceed_context_size_error (198,277 / 198,661 > 120,000)" } });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r1.status, 400);
        await r1.text();
        assert.equal(getSession(SESSION).stats.overflowArmTokens, 120_000, "armed in memory");

        // Flush the armed session to disk (the arm path markDirty'd it; force
        // the debounce so the restart has something to reload).
        await store.flushAll();

        // RESTART: clear memory, swap in a fresh store over the same dir.
        _resetSessionsForTest();
        store2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        _setStoreForTest(store2);

        // Still blocked after the round-trip: the reload path (memory miss →
        // store.loadSync) must restore the arm, and the guard must honor it.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r2.status, 413, "arm survives the restart round-trip and still blocks locally");
        await r2.text();
        assert.equal(rig.upstreamHits, 1, "no upstream hit for the post-restart block");
        const s2 = getSession(SESSION);
        assert.equal(s2.stats.overflowArmTokens, 120_000, "reloaded session carries the armed window");

        // RELEASE after restart: a healthy main turn's real usage retires it.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(getSession(SESSION).stats.overflowArmTokens, undefined, "usage report releases the reloaded arm too");

        // Forwards again.
        rig.sideErrorStatus = null;
        const r4 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: big }) });
        assert.equal(r4.status, 200, "released after restart — side request forwards again");
        await r4.text();
        assert.equal(rig.upstreamHits, 3);
    } finally {
        await closeRig(rig);
        store.cancelAll();
        store2?.cancelAll();
        rmrf(dir);
    }
});

// #2730: the google lane honors the SAME side-request exclusion as the other
// wires — a dsh title-gen on the gemini wire (tiny generationConfig.maxOutputTokens)
// must ride the #388 verbatim passthrough (raw conversation key, no kernel state,
// no persona fork) instead of being treated as a main turn or forked onto |sub:<fp>.
test("e2e: google-lane dsh side request resolves verbatim — no kernel state, no persona fork (#2730)", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], modelVersion: "gemini-test", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const CONV = "dsh-side-google";
    const SIDE_SYSTEM = "You are a title generator. Write one short title for the conversation.";
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:generateContent`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
    const fork = `${CONV}|sub:${createHash("sha256").update(SIDE_SYSTEM, "utf8").digest("hex").slice(0, 16)}`;
    try {
        // A dsh title-gen on the gemini wire: tiny output budget → a side request
        // by the token-budget heuristic (generationConfig.maxOutputTokens <= 200).
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Summarize this conversation in one short title." }] }], systemInstruction: { parts: [{ text: SIDE_SYSTEM }] }, generationConfig: { maxOutputTokens: 100 } }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s = peekSession(CONV);
        assert.ok(s, "the side request resolved onto the RAW conversation key");
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 0, "side passthrough touches no kernel state");
        assert.equal(s.stats.requests, 0, "side passthrough counts no requests");
        assert.equal(peekSession(fork), undefined, "no junk |sub:<fp(side)> forked session on the google lane");

        // A later MAIN turn keeps the raw key (the side request never stole the anchor).
        const mainContents = Array.from({ length: 4 }, (_, i): { role: string; parts: { text: string }[] } => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `main-${i + 1}-` + "z".repeat(2000) }] }));
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: mainContents, systemInstruction: { parts: [{ text: "You are DeepSeek Harness, the main coding agent.\nWorkspace: /tmp." }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.ok(Object.keys(peekSession(CONV)!.state.messageRefs.byRaw).length >= 4, "main turn assigned refs under the bare id (anchor not stolen by the earlier side request)");
        assert.equal(peekSession(fork), undefined, "still no forked session after the main turn");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
