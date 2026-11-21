// #6749: a valid emoji straddling one of the diagnostics report's truncation
// cuts leaves a lone UTF-16 surrogate in the blob; the report is then passed to
// encodeURIComponent(), which throws URIError on an unpaired surrogate.
// buildDiagnostics therefore threw, and the /__bili/diagnostics handler had
// already writeHead(200) — so the UI got a 200 with an empty body it could not
// decode. All five cuts (topic 64, storage-log tail 239, conflict-log tail 239,
// serialized config 1599, conflict-ledger detail 160) shared ONE defect: a raw
// .slice() that can land inside a surrogate pair. The fix routes every cut
// through safePrefix(), which backs off one unit when the cut lands on a lone
// high surrogate, so valid input stays well-formed. Each case pins one cut: the
// straddling emoji (must not throw, must round-trip, must back off exactly one
// unit) plus a control (emoji fully inside the cut, or no emoji, must be
// kept/trimmed exactly as before — no over-truncation).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import type * as http from "node:http";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { handleAdminRoute } from "../src/server/admin.js";
import { getSession, _resetSessionsForTest } from "../src/session.js";

const EMOJI = "\ud83d\ude00"; // 😀 — a two-unit surrogate pair

const ENV_KEYS = ["BILI_CONFIG_FILE", "DSH_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

/** Pin every path-relevant env var (unset ones deleted, so homedir fallbacks
 * can never reach the real machine's dirs); restored in finally. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        if (overrides[k] !== undefined) process.env[k] = overrides[k];
        else delete process.env[k];
    }
    try { return await fn(); } finally {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

function makeRoot(): string {
    return mkdtempSync(path.join(os.tmpdir(), "bili-diag-surrogate-"));
}

function writeJson(p: string, doc: unknown): void {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(doc));
}

function envFor(root: string, configPath: string, stateHome?: string): Record<string, string> {
    return {
        DSH_HOME: path.join(root, "dsh"),
        XDG_STATE_HOME: stateHome ?? path.join(root, "state"),
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_CACHE_HOME: root,
        BILI_CONFIG_FILE: configPath,
    };
}

/** The report must be well-formed end to end: the blob is URI-encodable (no
 * lone surrogate — the exact pre-fix failure) and the prefilled URL decodes
 * back to the exact blob (the UI's copy path). */
function assertWellFormedReport(rep: { blob: string; url: string }): void {
    assert.doesNotThrow(() => encodeURIComponent(rep.blob), "blob must be URI-encodable (no lone surrogate)");
    const u = new URL(rep.url);
    assert.equal(decodeURIComponent(u.searchParams.get("body") ?? ""), rep.blob, "URL body decodes back to the exact blob");
}

test("#6749 topic cut: emoji straddling the 64-unit trim must not break the report", async (t) => {
    const root = makeRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, { compress: { nudgeGrowthTokens: 50000 } });
    const env = envFor(root, configPath);

    // 63 a's + 😀 + "tail" = 69 units; a raw slice(0,64) ends on the emoji's
    // high surrogate (the pre-fix throw). safePrefix backs off one unit.
    const straddling = "a".repeat(63) + EMOJI + "tail";
    const rep = await withEnv(env, () => buildDiagnostics(straddling));
    assertWellFormedReport(rep);
    assert.ok(rep.blob.includes(`topic: ${"a".repeat(63)} (no topic-specific section registered)`),
        `topic line carries the one-unit-backed-off prefix, got:\n${rep.blob}`);
    assert.ok(!rep.blob.includes(EMOJI), "a lone surrogate (half-emoji) must not survive into the blob");

    // control: the emoji fully inside the first 64 units is kept, not backed off.
    const inside = EMOJI + "a".repeat(63); // 65 units; the cut at 64 lands on 'a'
    const rep2 = await withEnv(env, () => buildDiagnostics(inside));
    assertWellFormedReport(rep2);
    assert.ok(rep2.blob.includes(`topic: ${EMOJI}${"a".repeat(62)} (no topic-specific section registered)`),
        `control: emoji fully inside the cut is preserved, got:\n${rep2.blob}`);
});

test("#6749 storage-log tail cut: emoji straddling the 239-unit line cap", async (t) => {
    const root = makeRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateHome = path.join(root, "state");
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, { compress: { nudgeGrowthTokens: 50000 } });
    const env = envFor(root, configPath, stateHome);
    // [storage] line: 10 (prefix) + 228 a's + 😀(2) + "tail"(4) = 244 units > 240.
    const straddleLine = `[storage] ${"a".repeat(228)}${EMOJI}tail`;
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), straddleLine + "\n");

    const rep = await withEnv(env, () => buildDiagnostics("storage-legacy-only"));
    assertWellFormedReport(rep);
    // backed off one unit: the 228 a's survive, the lone high surrogate is
    // dropped, the ellipsis marks the cut.
    assert.ok(rep.blob.includes(`[storage] ${"a".repeat(228)}…`),
        `storage line backed off one unit before the ellipsis, got:\n${rep.blob}`);
    assert.ok(!rep.blob.includes(EMOJI), "a lone surrogate must not survive the storage tail");
});

test("#6749 conflict-log tail cut: emoji straddling the 239-unit line cap", async (t) => {
    const root = makeRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateHome = path.join(root, "state");
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, { compress: { nudgeGrowthTokens: 50000 } });
    const env = envFor(root, configPath, stateHome);
    // A conflict-pattern line whose emoji straddles the 239 cut:
    // 41 (prefix) + 197 a's + 😀(2) + "tail"(4) = 244 units > 240.
    const straddleLine = `compression substrate appears destroyed: ${"a".repeat(197)}${EMOJI}tail`;
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), straddleLine + "\n");

    const rep = await withEnv(env, () => buildDiagnostics("conflict-banner"));
    assertWellFormedReport(rep);
    assert.ok(rep.blob.includes(`compression substrate appears destroyed: ${"a".repeat(197)}…`),
        `conflict line backed off one unit before the ellipsis, got:\n${rep.blob}`);
    assert.ok(!rep.blob.includes(EMOJI), "a lone surrogate must not survive the conflict tail");
});

test("#6749 conflict-ledger detail cut: emoji straddling the 160-unit detail cap", async (t) => {
    const root = makeRoot();
    t.after(() => { _resetSessionsForTest(); rmSync(root, { recursive: true, force: true }); });
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, { compress: { nudgeGrowthTokens: 50000 } });
    const env = envFor(root, configPath);

    await withEnv(env, async () => {
        const s = getSession("ses-emoji-detail");
        // 159 a's + 😀(2) + "tail"(4) = 165 units > 160; a raw slice(0,160) ends
        // on the high surrogate. safePrefix backs off one unit.
        s.metadata.conflictEvents = [{ at: Date.now(), kind: "unannounced-rewrite", detail: "a".repeat(159) + EMOJI + "tail" }];
        const rep = await buildDiagnostics("conflict-banner");
        assertWellFormedReport(rep);
        assert.ok(rep.blob.includes(`unannounced-rewrite: ${"a".repeat(159)}`),
            `ledger detail backed off one unit, got:\n${rep.blob}`);
        assert.ok(!rep.blob.includes(EMOJI), "a lone surrogate must not survive the ledger detail");
    });
});

test("#6749 config section cut: emoji straddling the 1599-unit config cap", async (t) => {
    const root = makeRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, "billion-context.json");
    // {"notes":"a"*1588 + 😀(2) + "tail"(4)"} = 1606 units > 1600; a raw
    // slice(0,1599) ends on the high surrogate. safePrefix backs off one unit.
    writeJson(configPath, { notes: "a".repeat(1588) + EMOJI + "tail" });
    const env = envFor(root, configPath);

    const rep = await withEnv(env, () => buildDiagnostics());
    assertWellFormedReport(rep);
    assert.ok(rep.blob.includes(`… (truncated, 1606 chars total)`),
        `config section truncated with the total-length note, got:\n${rep.blob}`);
    assert.ok(!rep.blob.includes(EMOJI), "a lone surrogate must not survive the config section");
});

test("#6749 /__bili/diagnostics endpoint: 200 with a decodable body, not 200 + empty", async (t) => {
    const root = makeRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, { compress: { nudgeGrowthTokens: 50000 } });
    const env = envFor(root, configPath);
    const topic = "a".repeat(63) + EMOJI + "tail";

    const out = await withEnv(env, async () => {
        const captured: { code?: number; body?: string } = {};
        const res = {
            writeHead(code: number): void { captured.code = code; },
            end(body?: string): void { captured.body = body ?? ""; },
        } as unknown as http.ServerResponse;
        const req = {
            method: "GET",
            url: `/__bili/diagnostics?topic=${encodeURIComponent(topic)}`,
            headers: { host: "127.0.0.1" },
            socket: { remoteAddress: "127.0.0.1" },
        } as unknown as http.IncomingMessage;
        const ctx = {
            opts: { host: "127.0.0.1" }, core: {}, config: {}, log: (): void => {},
            instanceId: "t", instanceStartedAt: Date.now(), proxyWatchers: new Set<number>(),
            initialWatcherPid: null, bootReady: (): boolean => true, requestShutdown: (): void => {},
        } as unknown as Parameters<typeof handleAdminRoute>[2];
        await handleAdminRoute(req, res, ctx);
        return captured;
    });

    assert.equal(out.code, 200, `endpoint must answer 200 (got ${out.code}: ${out.body})`);
    assert.ok(out.body && out.body.length > 0, "body must not be empty (the pre-fix symptom was 200 + empty)");
    const parsed = JSON.parse(out.body ?? "") as { blob: string; title: string; url: string };
    assert.doesNotThrow(() => encodeURIComponent(parsed.blob), "published blob must be URI-encodable (no lone surrogate)");
    const u = new URL(parsed.url);
    assert.equal(decodeURIComponent(u.searchParams.get("body") ?? ""), parsed.blob, "URL body decodes back to the exact blob");
});
