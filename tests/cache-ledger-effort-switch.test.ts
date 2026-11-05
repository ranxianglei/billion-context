import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildSessionCacheReport,
    credentialFingerprint,
    generationParamFp,
    noteForwardedBody,
    settleUsageReport,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// #3803: a host generation-parameter flip (reasoning effort / thinking config)
// re-partitions the provider's prompt-cache namespace and pays ONE full-prefix
// re-prefill. The ledger must charge that re-bill to a named "effort" cause —
// never to a rebuild seam. Both directions are asserted (#3617): it fires when
// the effort surface changes, and it STAYS SILENT when only bytes change.

const T0 = Date.parse("2026-10-04T10:00:00Z");

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `eff-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const KEY = (() => {
    const f = credentialFingerprint({ authorization: "Bearer sk-account-one" });
    assert.ok(f !== undefined, "credential fingerprint must resolve");
    return f;
})();

/** Drive one request end-to-end exactly like the send chokepoints do: stringify
 *  the parsed body, fingerprint its generation-parameter surface from the FULL
 *  object (never the capped head), note it, then settle the usage report. */
function send(
    session: Session,
    bodyObj: Record<string, unknown>,
    at: number,
    total: number,
    cached: number | null,
    protocol: "openai" | "anthropic" | "responses" = "anthropic",
): void {
    const bodyStr = JSON.stringify(bodyObj);
    const arr = bodyObj.messages ?? bodyObj.input ?? bodyObj.contents;
    noteForwardedBody(session, bodyStr, Array.isArray(arr) ? arr.length : null, KEY, generationParamFp(bodyObj));
    settleUsageReport(session, { total, reportedCached: cached, protocol, upstream: "https://relay.example" }, undefined);
    const led = (session.metadata as Record<string, { lines: Array<{ at: number }> }> & object)["cacheLedger"]!;
    led.lines[led.lines.length - 1]!.at = at;
}

test("generationParamFp extracts the effort surface per wire, canonical under reorder, and ignores cache-neutral params (#3803)", () => {
    // Anthropic: output_config.effort + thinking together; different effort flips.
    const anthMax = generationParamFp({ model: "x", messages: [], output_config: { effort: "max" }, thinking: { type: "enabled", budget_tokens: 4096 } });
    const anthHigh = generationParamFp({ model: "x", messages: [], output_config: { effort: "high" }, thinking: { type: "enabled", budget_tokens: 4096 } });
    assert.ok(anthMax && anthHigh, "anthropic surface must fingerprint");
    assert.notEqual(anthMax, anthHigh);
    // Field ORDER must not change the identity (canonical form).
    const orderA = generationParamFp({ output_config: { effort: "max" }, thinking: { budget_tokens: 4096, type: "enabled" } });
    const orderB = generationParamFp({ thinking: { type: "enabled", budget_tokens: 4096 }, output_config: { effort: "max" } });
    assert.equal(orderA, orderB);
    // OpenAI chat-completions: scalar reasoning_effort.
    const oaiHigh = generationParamFp({ model: "x", messages: [], reasoning_effort: "high" });
    const oaiLow = generationParamFp({ model: "x", messages: [], reasoning_effort: "low" });
    assert.ok(oaiHigh && oaiLow);
    assert.notEqual(oaiHigh, oaiLow);
    // Responses: nested reasoning.effort.
    const rspHigh = generationParamFp({ model: "x", input: [], reasoning: { effort: "high" } });
    const rspLow = generationParamFp({ model: "x", input: [], reasoning: { effort: "low" } });
    assert.ok(rspHigh && rspLow);
    assert.notEqual(rspHigh, rspLow);
    // Google native: nested generationConfig.thinkingConfig.
    const gBig = generationParamFp({ model: "x", contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } });
    const gSmall = generationParamFp({ model: "x", contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
    assert.ok(gBig && gSmall);
    assert.notEqual(gBig, gSmall);
    // Cache-neutral params alone must NEVER flag (folding them would mask real losses).
    assert.equal(generationParamFp({ model: "x", messages: [], max_tokens: 4096, temperature: 0.7 }), undefined);
    // Absent / null / empty body → undefined (unknown never flags).
    assert.equal(generationParamFp(null), undefined);
    assert.equal(generationParamFp(undefined), undefined);
    assert.equal(generationParamFp({}), undefined);
});

test("reasoning-effort flip charges the re-prefill to the effort dimension, not a seam (#3803)", () => {
    const s = makeSession();
    s.metadata.lastModel = "deepseek-v4";
    const mk = (effort: string): Record<string, unknown> => ({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }], output_config: { effort } });
    send(s, mk("high"), T0 + 1000, 10_000, 9000); // baseline
    send(s, mk("high"), T0 + 2000, 10_500, 10_000); // warm, same effort
    send(s, mk("max"), T0 + 3000, 11_000, 0); // effort flip → cold re-prefill
    const r = buildSessionCacheReport(s);
    assert.equal(r.effSwitches.count, 1);
    // missed 11000 = growth 500 (new content) + 10500 re-billed stable prefix.
    assert.equal(r.effSwitches.missedTokens, 10_500);
    const ev = r.effSwitches.events[0]!;
    assert.equal(ev.seq, 3);
    assert.match(ev.from!, /^sha256:[0-9a-f]{16}$/);
    assert.match(ev.to, /^sha256:[0-9a-f]{16}$/);
    assert.notEqual(ev.from, ev.to);
    assert.equal(ev.attributed, 10_500);
    const l3 = r.lines.find((l) => l.seq === 3)!;
    assert.equal(l3.newContent, 500);
    assert.equal(l3.ttlRepay, 10_500);
    // The winning cause on the ledger line is effort — NOT a seam suspect.
    const led = (s.metadata as Record<string, { lines: Array<{ cause?: string }> }> & object)["cacheLedger"]!;
    assert.equal(led.lines[2]?.cause, "effort");
    assert.equal(r.seam.suspects, 0);
    assert.equal(r.seam.events.length, 0);
    // Charged to the effort bucket, none of the other dimensions fired.
    assert.equal(r.invalidation.effort, 10_500);
    assert.equal(r.modelSwitches.count, 0);
    assert.equal(r.keySwitches.count, 0);
    assert.equal(r.promptSwitches.count, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("the effort flip is seen even when the body exceeds SEAM_BODY_CAP (#3803)", () => {
    const s = makeSession();
    s.metadata.lastModel = "deepseek-v4";
    const pad = "x".repeat(600 * 1024); // > 512 KiB SEAM_BODY_CAP
    const mk = (effort: string): Record<string, unknown> => ({ model: "deepseek-v4", messages: [{ role: "user", content: pad }], output_config: { effort } });
    send(s, mk("high"), T0 + 1000, 10_000, 9000);
    send(s, mk("high"), T0 + 2000, 10_500, 10_000);
    send(s, mk("max"), T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(s);
    // Without the parsed-object fingerprint this exact shape would fall into the
    // capped-append evidence gap (#3800) and read as a seam; now it is named.
    assert.equal(r.effSwitches.count, 1);
    assert.equal(r.seam.suspects, 0);
    assert.equal(r.invalidation.effort, 10_500);
    assert.equal(r.totals.balanced, true);
});

test("openai reasoning_effort and responses reasoning.effort both flip the effort dimension (#3803)", () => {
    const sa = makeSession();
    sa.metadata.lastModel = "gpt-x";
    const oai = (e: string): Record<string, unknown> => ({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], reasoning_effort: e });
    send(sa, oai("low"), T0 + 1000, 10_000, 9000, "openai");
    send(sa, oai("low"), T0 + 2000, 10_500, 10_000, "openai");
    send(sa, oai("high"), T0 + 3000, 11_000, 0, "openai");
    assert.equal(buildSessionCacheReport(sa).effSwitches.count, 1);

    const sb = makeSession();
    sb.metadata.lastModel = "gpt-x-r";
    const rsp = (e: string): Record<string, unknown> => ({ model: "gpt-x-r", input: [{ role: "user", content: "hi" }], reasoning: { effort: e } });
    send(sb, rsp("low"), T0 + 1000, 10_000, 9000, "responses");
    send(sb, rsp("low"), T0 + 2000, 10_500, 10_000, "responses");
    send(sb, rsp("high"), T0 + 3000, 11_000, 0, "responses");
    assert.equal(buildSessionCacheReport(sb).effSwitches.count, 1);
});

test("identical effort + a genuine mid-history rewrite STILL reads as a seam, not effort (#3803)", () => {
    const s = makeSession();
    s.metadata.lastModel = "deepseek-v4";
    // Same effort surface throughout — only the MIDDLE message changes between
    // the two sends. The new dimension must not excuse a real bili/host rewrite.
    const A = { role: "user", content: "alpha" };
    const B1 = { role: "assistant", content: "beta-original" };
    const B2 = { role: "assistant", content: "beta-REWRITTEN-mid-history" };
    const C = { role: "user", content: "gamma" };
    const mk = (mid: typeof B1): Record<string, unknown> => ({ model: "deepseek-v4", messages: [A, mid, C], output_config: { effort: "high" } });
    send(s, mk(B1), T0 + 1000, 10_000, 9000);
    send(s, mk(B2), T0 + 2000, 10_500, 0); // big miss caused by the mid rewrite
    const r = buildSessionCacheReport(s);
    assert.equal(r.effSwitches.count, 0);
    assert.equal(r.invalidation.effort, 0);
    // The miss is a real mid-history break → booked as a seam suspect.
    assert.ok(r.seam.suspects >= 1, "expected a seam suspect for the mid rewrite");
    const led = (s.metadata as Record<string, { lines: Array<{ cause?: string }> }> & object)["cacheLedger"]!;
    assert.equal(led.lines[1]?.cause, undefined);
    assert.equal(r.totals.balanced, true);
});

test("identical effort + a pure tail append goes provider-side, never to effort (#3803)", () => {
    const s = makeSession();
    s.metadata.lastModel = "deepseek-v4";
    const A = { role: "user", content: "alpha" };
    const B = { role: "assistant", content: "beta" };
    const C = { role: "user", content: "gamma" };
    const base: Record<string, unknown> = { model: "deepseek-v4", messages: [A, B], output_config: { effort: "high" } };
    const appended: Record<string, unknown> = { model: "deepseek-v4", messages: [A, B, C], output_config: { effort: "high" } };
    send(s, base, T0 + 1000, 10_000, 9000);
    send(s, appended, T0 + 2000, 10_500, 0); // big miss, but the list only grew
    const r = buildSessionCacheReport(s);
    assert.equal(r.effSwitches.count, 0);
    assert.equal(r.invalidation.effort, 0);
    // Not a rebuild seam either — the whole previous list survives, so this is a
    // benign tail-append (recognized by the #2059 arm as bodyClass "append"),
    // charged to the provider path, never to effort nor to a seam suspect.
    assert.equal(r.seam.suspects, 0);
    const l2 = r.lines.find((l) => l.seq === 2)!;
    assert.equal(l2.bodyClass, "append");
    assert.notEqual(l2.prov, undefined);
    assert.equal(r.totals.balanced, true);
});

test("a ledger persisted before the effort dimension still loads and balances (#3803)", () => {
    const s = makeSession();
    s.metadata.lastModel = "deepseek-v4";
    const mk = (effort: string): Record<string, unknown> => ({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }], output_config: { effort } });
    send(s, mk("high"), T0 + 1000, 10_000, 9000);
    send(s, mk("high"), T0 + 2000, 10_500, 10_000);
    // Simulate a pre-upgrade persisted ledger: strip every newly-added field.
    const led = (s.metadata as Record<string, Record<string, unknown>> & object)["cacheLedger"]!;
    delete (led.agg as Record<string, unknown>)["effSwitches"];
    delete (led.agg as Record<string, unknown>)["effSwitchMissed"];
    delete led["lastKnownEff"];
    delete led["invEff"];
    for (const ln of led.lines as Array<Record<string, unknown>>) {
        delete ln["ef"];
        delete ln["efp"];
    }
    // Re-reading normalizes the missing counters and keeps the arithmetic honest.
    const r = buildSessionCacheReport(s);
    assert.equal(r.effSwitches.count, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});
