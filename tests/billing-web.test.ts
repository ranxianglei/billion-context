import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// Hermetic config + legacy storage baseline (same discipline as
// tests/issue3199-overview-cold-scan.test.ts): a developer machine's real
// billion-context.json and unified store must not leak into these rows.
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-billing-web-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.XDG_STATE_HOME = `${import.meta.dirname ?? "."}/.billing-web-state-${process.pid}`;
// Isolate the disk index from the real machine corpus (same discipline as
// tests/issue3199-overview-cold-scan.test.ts): buildOverview walks the
// sessions dir when no index row exists, and this suite asserts exact USD
// totals — a real session with priced folds would break them.
process.env.BILI_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "bili-billing-web-sessions-"));

import { handleConfigPut, handlePricingGet } from "../src/web/api.js";
import { buildOverview, buildSessionList, _resetDiskCacheForTest } from "../src/web/sessions-data.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { loadOptions } from "../src/config.ts";
import { resolveBillingPrice, setBillingOverrides } from "../src/billing.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

function resetState(): void {
    setRegistryForTest({}, { "somehost/claude-bill": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } });
    setBillingOverrides(undefined);
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetDiskCacheForTest();
}

function seedSession(id: string, model: string | undefined): void {
    const s = getSession(id, { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    if (model) s.metadata.lastModel = model;
    s.stats.requests = 2; // survive isEmptyStub (requests<=1 && no ctx/blocks/ledger gets hidden)
}

/** Display-precision rounding the panel applies at the summary boundary. */
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

async function getPricing(): Promise<{ status: number; payload: Record<string, unknown> }> {
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handlePricingGet(res as unknown as ServerResponse);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

async function putConfig(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
    const req = new Readable({ read() {} });
    req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigPut(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => loadOptions(), 8787);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

function withRawConfig(t: test.TestContext, rawText: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-billing-web-cfg-"));
    const p = path.join(dir, "billion-context.json");
    writeFileSync(p, rawText, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = p;
    t.after(() => {
        process.env.BILI_CONFIG_FILE = prev ?? "";
        rmrf(dir);
    });
    return p;
}

test("#4899 pricing GET: lists session models with resolved prices, marks overrides, keeps orphan override keys editable", async () => {
    resetState();
    seedSession("web-bill-1", "claude-bill");
    seedSession("web-bill-2", "claude-unknown");
    setBillingOverrides({ "anthropic/gone-model": { input: 9 } });

    const { status, payload } = await getPricing();
    assert.equal(status, 200);
    const models = payload.models as Array<Record<string, unknown>>;
    const byModel = new Map(models.map((m) => [String(m.model), m]));

    const known = byModel.get("claude-bill");
    assert.ok(known, "session model listed");
    assert.equal((known!.price as Record<string, unknown>).input, 3, "registry row resolved (cross-host suffix scan)");
    assert.equal(known!.override, undefined, "no override for this model");
    assert.equal(known!.host, "api.somehost.com", "origin host carried for host-aware matching");

    const unknown = byModel.get("claude-unknown");
    assert.ok(unknown, "unpriced session model listed");
    assert.equal(unknown!.price, null, "no price anywhere: null, the UI shows tokens only");

    const orphan = byModel.get("anthropic/gone-model");
    assert.ok(orphan, "override key with no recent session stays listed/editable");
    assert.ok((orphan!.override as Record<string, unknown>).input === 9, "its override entry is exposed");
    assert.notEqual((payload.overrides as Record<string, unknown>)["anthropic/gone-model"], undefined, "raw override table echoed");
});

test("#4899 pricing PUT: writes billing.prices, hot-applies overrides, empty map deletes the block", async (t) => {
    resetState();
    withRawConfig(t, "{\n  \"upstreamProxy\": \"http://127.0.0.1:9999\",\n}\n");

    const put = await putConfig({ billing: { prices: { "anthropic/claude-bill": { input: 6, output: 30, cacheRead: 0.6 } } } });
    assert.equal(put.status, 200, `save accepted (${JSON.stringify(put.payload)})`);
    const saved = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
        saved.billing,
        { prices: { "anthropic/claude-bill": { input: 6, output: 30, cacheRead: 0.6 } } },
        "block persisted into the config file, other keys preserved",
    );
    // onChanged → loadOptions → setBillingOverrides: hot-applied without restart.
    const resolved = resolveBillingPrice("claude-bill");
    assert.ok(resolved);
    assert.equal(resolved.source, "config");
    assert.equal(resolved.input, 6, "override outranks the registry row");
    assert.equal(resolved.cacheWrite, 6, "missing cacheWrite falls back to the override's input rate");

    // Saving an empty prices map deletes the block (registry defaults take over).
    const put2 = await putConfig({ billing: { prices: {} } });
    assert.equal(put2.status, 200);
    const saved2 = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(saved2.billing, undefined, "empty prices map removes the block");
    assert.equal(resolveBillingPrice("claude-bill")?.source, "registry", "registry row back in charge");
});

test("#4899 pricing PUT: invalid shapes are rejected loudly (400), never silently dropped", async (t) => {
    resetState();
    withRawConfig(t, "{}\n");
    const bad = await putConfig({ billing: { prices: { m: { input: -1 } } } });
    assert.equal(bad.status, 400);
    const bad2 = await putConfig({ billing: { prices: { m: { input: 3, typo: 1 } } } });
    assert.equal(bad2.status, 400);
    const bad3 = await putConfig({ billing: { prices: "x" } });
    assert.equal(bad3.status, 400);
    const saved = JSON.parse(readFileSync(process.env.BILI_CONFIG_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(saved.billing, undefined, "nothing written on rejection");
});

test("#4899 pricing PUT: a broken config file still blocks every structured save (409 guard intact)", async (t) => {
    resetState();
    withRawConfig(t, "{ not json\n");
    const put = await putConfig({ billing: { prices: { m: { input: 1 } } } });
    assert.equal(put.status, 409, "guard fires before any merge, #3572 discipline preserved");
});

test("null billing prices: config load warns, clears stale overrides, and preserves the file", (t) => {
    resetState();
    const raw = JSON.stringify({ port: 9876, billing: { prices: null } });
    const file = withRawConfig(t, raw);
    setBillingOverrides({ "claude-bill": { input: 9 } });
    const warnings: string[] = [];
    setLogCapture((level, message) => { if (level === "warn") warnings.push(message); });
    t.after(() => setLogCapture(null));

    const options = loadOptions({});
    assert.equal(options.port, 9876, "other config remains available");
    assert.ok(warnings.some((message) => message.includes('ignoring invalid "billing" block')));
    assert.equal(resolveBillingPrice("claude-bill")?.source, "registry", "invalid block cannot retain stale overrides");
    assert.equal(readFileSync(file, "utf8"), raw, "load never rewrites invalid user configuration");
});

test("null billing prices: structured and whole-file saves reject without mutation", async (t) => {
    resetState();
    const raw = JSON.stringify({ billing: { prices: { "claude-bill": { input: 9 } } } });
    const file = withRawConfig(t, raw);
    loadOptions({});

    for (const body of [
        { billing: { prices: null } },
        { file: JSON.stringify({ billing: { prices: null } }) },
    ]) {
        const result = await putConfig(body);
        assert.equal(result.status, 400);
        assert.match(String(result.payload.error), /invalid billing settings/);
        assert.equal(readFileSync(file, "utf8"), raw, "rejection preserves the complete config file");
        assert.equal(resolveBillingPrice("claude-bill")?.input, 9, "rejection preserves active overrides");
    }
});

test("#4899 web summaries: sessions carry costUsd/savedUsd/model; overview totals aggregate USD", async () => {
    resetState();
    const priced = getSession("web-money-1", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    priced.metadata.lastModel = "claude-bill";
    priced.stats.requests = 2;
    // The stamp site writes the absolute-flag alongside $/Mtok profiles; the
    // fixture simulates a post-fix registry/user-anchored stamp.
    priced.metadata.cachePriceProfile = { w: 3.75, r: 0.3, q: 15 };
    priced.metadata.cachePriceProfileAbs = true;
    priced.metadata.cacheLedger = { folds: [{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }] };
    priced.stats.costUsd = { input: 0.003, cacheRead: 0.00012, cacheWrite: 0.000375, output: 0.03 };
    const unpriced = getSession("web-money-2", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    unpriced.metadata.lastModel = "claude-unknown";
    unpriced.stats.requests = 2;
    unpriced.metadata.cacheLedger = { folds: [{ S: 90000, sigma: 9000, T: 9000, requestsAfter: 50 }] };
    // #4899 follow-up regression pin: a dimensionless user-ratio profile with
    // NO absolute flag and no stamped billing price (unanchored or legacy
    // pre-flag stamp) must NOT be billed as $/Mtok — savedUsd stays undefined,
    // tokens only.
    const ratioOnly = getSession("web-money-4", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    ratioOnly.metadata.lastModel = "claude-ratio";
    ratioOnly.stats.requests = 2;
    ratioOnly.metadata.cachePriceProfile = { w: 1, r: 0.1, q: 4 };
    ratioOnly.metadata.cacheLedger = { folds: [{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }] };
    // Same ratio WITH a stamped billing price and NO live table entry for this
    // model: falls back to anchoring at read time (ratio × input rate) — real
    // dollars without touching the stamped profile values any existing consumer
    // reads.
    const anchored = getSession("web-money-5", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    anchored.metadata.lastModel = "claude-anchored";
    anchored.stats.requests = 2;
    anchored.metadata.cachePriceProfile = { w: 1, r: 0.1, q: 4 };
    anchored.metadata.billingPrice = { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75, source: "registry" };
    anchored.metadata.cacheLedger = { folds: [{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }] };

    const list = await buildSessionList();
    const row1 = list.find((s) => s.id === "web-money-1");
    assert.ok(row1);
    assert.equal(row1!.model, "claude-bill", "model id surfaced for the pricing editor");
    assert.ok(Math.abs(row1!.costUsd!.total - (0.003 + 0.00012 + 0.000375 + 0.03)) < 1e-12, "spend total sums the ledger");
    // #4899 follow-up (live pricing): the panel prices folds at the CURRENT
    // price table — live registry tiers {input:3, cacheRead:0.3,
    // cacheWrite:3.75, output:15} override the stamped {w:3.75,…} profile.
    // Saved mirrors the kernel fold formula: (S−σ)·ra·r − [(w−r)·T + q·σ − r·S],
    // w = the CACHE-WRITE tier (#4956: fold replay re-uploads at the write
    // premium — same contract as kernel/src/cache-report.ts/acp_cache),
    // rounded to 4 decimals at the summary boundary (display precision).
    const perTurn = (50000 - 5000) * 10 * 0.3; // 135000
    const oneTime = (3.75 - 0.3) * 3000 + 15 * 5000 - 0.3 * 50000; // 70350
    const expectSaved = Math.round(((perTurn - oneTime) / 1e6) * 1e4) / 1e4; // 0.0647
    assert.ok(row1!.savedUsd !== undefined && Math.abs(row1!.savedUsd! - expectSaved) < 1e-9, `savedUsd ${row1!.savedUsd}`);
    // #4899 v3: payback decomposition — the split faces must be exactly the
    // one-time terms of the canonical formula, so gross − spent == savedUsd
    // on screen (no second arithmetic the user can't reconcile).
    const pb1 = row1!.payback;
    assert.ok(pb1 !== undefined, "priced fold session exposes payback");
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const expectReplay1 = r4(((3.75 - 0.3) * 3000) / 1e6);
    const expectSigma1 = r4((15 * 5000) / 1e6);
    const expectCredit1 = r4((0.3 * 50000) / 1e6);
    const expectSpent1 = r4(expectReplay1 + expectSigma1 - expectCredit1);
    assert.ok(Math.abs((pb1!.replayUsd ?? 0) - expectReplay1) < 1e-9, `replay ${pb1?.replayUsd}`);
    assert.ok(Math.abs((pb1!.sigmaUsd ?? 0) - expectSigma1) < 1e-9, `sigma ${pb1?.sigmaUsd}`);
    assert.ok(Math.abs((pb1!.creditUsd ?? 0) - expectCredit1) < 1e-9, `credit ${pb1?.creditUsd}`);
    assert.ok(Math.abs((pb1!.spentUsd ?? 0) - expectSpent1) < 1e-9, `spent ${pb1?.spentUsd}`);
    assert.equal(pb1!.actualTurns, 10, "Σ post-fold requests");
    assert.ok(Math.abs((pb1!.breakevenTurns ?? 0) - Math.round((expectSpent1 / (0.135 / 10)) * 100) / 100) < 1e-9, `beTurns ${pb1?.breakevenTurns}`);
    // Persisted ledger present ⇒ spend reads as exact (no estimated flag);
    // gross-$ face rides the same live profile r=0.3.
    assert.equal(row1!.costUsd?.estimated, undefined, "persisted spend ledger is exact, not estimated");
    assert.ok(Math.abs((row1!.savedUsdGross ?? 0) - 0.135) < 1e-9, `savedUsdGross ${row1!.savedUsdGross}`);
    const row2 = list.find((s) => s.id === "web-money-2");
    assert.ok(row2);
    assert.equal(row2!.costUsd, undefined, "unpriced: no spend row, tokens only");
    assert.equal(row2!.savedUsd, undefined, "no stamped profile: never priced on fabricated defaults");
    const row4 = list.find((s) => s.id === "web-money-4");
    assert.ok(row4);
    assert.equal(
        row4!.savedUsd,
        undefined,
        "ratio profile without the absolute flag is never billed as $/Mtok (#4899 follow-up)",
    );
    // Anchored ratio: kernel-default-filled {w:1,r:0.1,q:4} × input 3 →
    // {w:3,r:0.3,q:12}: perTurn=(50000−5000)·10·0.3=135000, oneTime=(3−0.3)·3000+12·5000−0.3·50000=53100.
    const expectAnchored = Math.round(((135000 - 53100) / 1e6) * 1e4) / 1e4;
    const row5 = list.find((s) => s.id === "web-money-5");
    assert.ok(row5);
    assert.ok(row5!.savedUsd !== undefined && Math.abs(row5!.savedUsd! - expectAnchored) < 1e-9, `anchored savedUsd ${row5!.savedUsd}`);
    // Anchored profile {w:3,r:0.3,q:12}: spent == the anchored oneTime terms.
    const pb5 = row5!.payback;
    assert.ok(pb5 !== undefined, "anchored session exposes payback too");
    // v5: each priced session carries the exact tier rates its faces used
    // (live table {w:3.75, r:0.3, q:15} beats the stamp; anchored ratio keeps
    // q=12). #4956: w is the cacheWrite tier, NOT input — positive pin.
    assert.deepEqual(row1!.rates, { w: 3.75, r: 0.3, q: 15 }, "live tier rates exposed");
    assert.ok(row5!.rates && Math.abs(row5!.rates!.w - 3) < 1e-9 && Math.abs(row5!.rates!.r - 0.3) < 1e-9 && Math.abs(row5!.rates!.q - 12) < 1e-9,
        `anchored ratio rates (kernel 0.1×input → r) ${JSON.stringify(row5!.rates)}`);
    const expectSpent5 = r4(r4(((3 - 0.3) * 3000) / 1e6) + r4((12 * 5000) / 1e6) - expectCredit1);
    assert.ok(Math.abs((pb5!.spentUsd ?? 0) - expectSpent5) < 1e-9, `anchored spent ${pb5?.spentUsd}`);
    assert.equal(pb5!.actualTurns, 10);

    const ov = await buildOverview();
    assert.ok(Math.abs(ov.costUsdTotal - (0.003 + 0.00012 + 0.000375 + 0.03)) < 1e-12, "overview spend total");
    // Per-tier split must reconcile with the total so each overview token
    // card's ≈$ line sums back to the 花费 card.
    const cu1 = ov.costUsdSplitTotal;
    assert.ok(cu1 !== undefined, "priced sessions expose the tier split");
    assert.ok(Math.abs(cu1!.i - r4(0.003)) < 1e-9 && Math.abs(cu1!.r - r4(0.00012)) < 1e-9 && Math.abs(cu1!.w - r4(0.000375)) < 1e-9 && Math.abs(cu1!.o - r4(0.03)) < 1e-9, `split ${JSON.stringify(cu1)}`);
    assert.ok(Math.abs((cu1!.i + cu1!.r + cu1!.w + cu1!.o) - ov.costUsdTotal) < 3e-4, "tiers sum to the spend card");
    assert.ok(Math.abs(ov.savedUsdTotal - (expectSaved + expectAnchored)) < 1e-9, "overview saved-$ total includes both priced sessions");
    // Both priced fold sessions share r=0.3 → gross faces sum to 2×0.135.
    assert.ok(Math.abs((ov.savedUsdGrossTotal ?? 0) - 0.27) < 1e-9, `savedUsdGrossTotal ${ov.savedUsdGrossTotal}`);
    // Fleet payback aggregation: only the two fold-priced sessions contribute
    // (unpriced + unanchored-ratio sessions stay out — never fabricated $).
    assert.ok(ov.paybackUsdTotal !== undefined, "overview carries fleet payback");
    assert.equal(ov.paybackUsdTotal!.turns, 20, "Σ post-fold turns across priced folds");
    assert.ok(Math.abs(ov.paybackUsdTotal!.spent - (expectSpent1 + expectSpent5)) < 1e-9, `fleet spent ${ov.paybackUsdTotal?.spent}`);
    assert.ok(Math.abs(ov.paybackUsdTotal!.saved - 0.27) < 1e-9, `fleet saved ${ov.paybackUsdTotal?.saved}`);
    assert.equal(ov.hasMoneyData, true, "money totals exist when any session is priced");
    // v5: concrete multipliers — fold count + ONE rate triple only while the
    // whole fleet prices at identical tiers; row1 (q=15) vs row5 (q=12) mix
    // them ⇒ no single fleet-wide formula line.
    assert.equal(ov.foldsTotal, 4, "every session in this fixture folded once");
    if (ov.moneyRates !== undefined) assert.fail(`mixed-tier fleet must not print one rate: ${JSON.stringify(ov.moneyRates)}`);

    // A world with no prices anywhere reports hasMoneyData=false (dash, not $0).
    resetState();
    seedSession("web-money-3", "claude-nobody");
    const ov2 = await buildOverview();
    assert.equal(ov2.hasMoneyData, false);
    assert.equal(ov2.costUsdTotal, 0);
    assert.equal(ov2.costUsdSplitTotal, undefined, "no priced sessions → no tier split either");
    assert.equal(ov2.savedUsdTotal, 0);
    assert.equal(ov2.paybackUsdTotal, undefined, "no priced folds → no fleet payback line");
    if (ov2.moneyRates !== undefined) assert.fail(`no priced sessions but got ${JSON.stringify(ov2.moneyRates)}`);
    assert.equal(ov2.foldsTotal, 0);
});

test("#4899 legacy sessions: $ faces derive LIVE from the current price table (no stamps needed)", async () => {
    resetState();
    const legacy = getSession("web-legacy-1", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    legacy.metadata.lastModel = "claude-bill";
    legacy.stats.requests = 2;
    legacy.stats.inputTokens = 1_000_000;
    legacy.stats.cachedTokens = 500_000;
    legacy.stats.outputTokens = 10_000;
    legacy.metadata.cacheLedger = { folds: [{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }] };

    const list = await buildSessionList();
    const row = list.find((s) => s.id === "web-legacy-1");
    assert.ok(row);
    // Live estimate from the registry {input:3, output:15, cache_read:0.3}:
    // fresh 500k@3 + cached 500k@0.3 + output 10k@15 = 1.5 + 0.15 + 0.15.
    assert.equal(row!.costUsd?.estimated, true, "live-derived spend is flagged estimated");
    assert.ok(row!.costUsd && Math.abs(row!.costUsd.total - 1.8) < 1e-12, `spend ${row!.costUsd?.total}`);
    // Folds priced at the same live tiers: perTurn=(45000)·10·0.3=135000,
    // oneTime=(3.75−0.3)·3000+15·5000−0.3·50000=70350 → 0.0647 (w = cacheWrite,
    // #4956).
    assert.ok(row!.savedUsd !== undefined && Math.abs(row!.savedUsd! - 0.0647) < 1e-9, `savedUsd ${row!.savedUsd}`);
    assert.ok(Math.abs((row!.savedUsdGross ?? 0) - 0.135) < 1e-9, `savedUsdGross ${row!.savedUsdGross}`);
    // #4899 v3: legacy sessions get the same payback view; output splits into
    // normal vs summary-generation tokens (σ of the fold = 5000).
    assert.ok(row!.payback !== undefined, "legacy fold session exposes payback");
    assert.ok(Math.abs((row!.payback!.sigmaUsd ?? 0) - r4((15 * 5000) / 1e6)) < 1e-9, `legacy sigma ${row!.payback?.sigmaUsd}`);
    assert.ok(Math.abs((row!.payback!.normalOutputUsd ?? 0) - r4(((10_000 - 5000) * 15) / 1e6)) < 1e-9, `normal output ${row!.payback?.normalOutputUsd}`);
    assert.equal(row!.payback!.actualTurns, 10);
    const ov = await buildOverview();
    assert.equal(ov.hasMoneyData, true, "live estimate counts as money data");
    assert.ok(Math.abs(ov.costUsdTotal - 1.8) < 1e-12, `overview spend ${ov.costUsdTotal}`);
    // Live-estimate split: 500k fresh @3 + 500k cached @0.3 + 10k output @15.
    const cul = ov.costUsdSplitTotal;
    assert.ok(cul && Math.abs(cul.i - 1.5) < 1e-9 && Math.abs(cul.r - 0.15) < 1e-9 && cul.w === 0 && Math.abs(cul.o - 0.15) < 1e-9, `legacy split ${JSON.stringify(cul)}`);
    assert.ok(ov.paybackUsdTotal && Math.abs(ov.paybackUsdTotal.turns - 10) < 1e-9 && ov.paybackUsdTotal.saved === r4(0.135 * 1), `legacy fleet payback turns=${ov.paybackUsdTotal?.turns} saved=${ov.paybackUsdTotal?.saved}`);
    // v5: a single-tier fleet prints its exact rates inside the formula lines.
    assert.deepEqual(ov.moneyRates, { w: 3.75, r: 0.3, q: 15 }, "single-rate fleet exposes the triple");
    assert.equal(ov.foldsTotal, 1);

    // Editing the price table re-prices immediately (nothing was persisted).
    setBillingOverrides({ "claude-bill": { input: 6, output: 15, cacheRead: 0.3 } });
    const list2 = await buildSessionList();
    const row2 = list2.find((s) => s.id === "web-legacy-1");
    assert.ok(row2!.costUsd && Math.abs(row2!.costUsd.total - (3.0 + 0.15 + 0.15)) < 1e-12, `re-priced ${row2!.costUsd?.total}`);
    // oneTime=(6−0.3)·3000+15·5000−0.3·50000=77100 → (135000−77100)/1e6
    // (#4956 negative direction: the override row carries NO cacheWrite, so
    // w follows the cache_write ?? input fallback and stays at 6).
    assert.ok(row2!.savedUsd !== undefined && Math.abs(row2!.savedUsd! - 0.0579) < 1e-9, `re-priced savedUsd ${row2!.savedUsd}`);
    // v5: the exposed rates follow the edit too — nothing frozen at stamp time.
    assert.deepEqual(row2!.rates, { w: 6, r: 0.3, q: 15 }, `re-priced rates ${JSON.stringify(row2!.rates)}`);
});

test("#4899 v3 payback: a fold whose one-time cost outruns its avoidance reads NOT-yet-paid-back", async () => {
    resetState();
    seedSession("web-payback-pending", "claude-bill");
    const p = getSession("web-payback-pending", { protocol: "anthropic", upstreamOrigin: "http://api.somehost.com" });
    // Tiny S, huge σ: the summary is almost as long as what it replaced — the
    // owner's "is compression worth it?" worst case.
    p.metadata.cacheLedger = { folds: [{ S: 10_000, sigma: 9_000, T: 0, requestsAfter: 1 }] };
    const list = await buildSessionList();
    const row = list.find((s) => s.id === "web-payback-pending");
    assert.ok(row);
    // perTurn=(10000−9000)·1·0.3=300; oneTime=(3−0.3)·0+15·9000−0.3·10000=132000
    // → net=−0.1317 < 0 — money-losing while actualTurns(1) ≪ breakevenTurns(440).
    assert.ok(row!.savedUsd !== undefined && Math.abs(row!.savedUsd! - r4((300 - 132_000) / 1e6)) < 1e-9, `saved ${row?.savedUsd}`);
    const pb = row!.payback;
    assert.ok(pb !== undefined, "exposes payback even for money-losing folds");
    assert.ok(Math.abs((pb!.sigmaUsd ?? 0) - r4((15 * 9_000) / 1e6)) < 1e-9, `sigma ${pb?.sigmaUsd}`);
    assert.ok(Math.abs((pb!.creditUsd ?? 0) - r4((0.3 * 10_000) / 1e6)) < 1e-9, `credit ${pb?.creditUsd}`);
    assert.equal(pb!.replayUsd, 0, "T=0 → no full-price replay term");
    assert.ok(Math.abs((pb!.spentUsd ?? 0) - 0.132) < 1e-9, `spent ${pb?.spentUsd}`);
    assert.equal(pb!.actualTurns, 1);
    assert.ok(Math.abs((pb!.breakevenTurns ?? 0) - 440) < 1e-9, `beTurns ${pb?.breakevenTurns}`);
    // Reconciliation on screen: gross − spent ≈ saved (rounding drift allowed).
    assert.ok(Math.abs((row!.savedUsdGross ?? 0) - (pb!.spentUsd ?? 0) - (row!.savedUsd ?? 0)) < 3e-4, "faces reconcile");
    const ov = await buildOverview();
    assert.ok(ov.paybackUsdTotal !== undefined && ov.paybackUsdTotal.saved - ov.paybackUsdTotal.spent < 0,
        "fleet line shows a negative net while no session has paid back");
    // v5: single-session fleet → fold count + rate triple both printable.
    assert.equal(ov.foldsTotal, 1);
    assert.deepEqual(ov.moneyRates, { w: 3.75, r: 0.3, q: 15 });
});
