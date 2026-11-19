// #7053: the takeover-attribution banner ships "copy diagnostics / report on
// GitHub" buttons wired to topic=attribution, but the topic was never registered
// in the diagnostics TOPICS map — the blob fell back to the generic title and
// printed "topic: attribution (no topic-specific section registered)", so the
// report carried NONE of the attribution evidence (which agent degraded, state,
// refusals, error, endpoint) a maintainer needs to adjudicate a takeover-broken
// episode. These tests pin the registered section:
//   1. topic=attribution produces a SPECIFIC title (not the generic fallback)
//      and a "--- takeover attribution ---" section (not "no topic-specific
//      section registered");
//   2. an empty map (no report yet) degrades to an explicit note, not a blank;
//   3. a degraded agent renders state/refusals/since + error + endpoint;
//   4. the host-supplied error text passes the publish boundary (credential
//      shapes scrubbed) — same guarantee as every other section;
//   5. the generic enrichment (host client versions + config) still rides along.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { recordAttributionReport, _resetAttributionStatusForTest } from "../src/server/attribution-status.js";

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

test("#7053 attribution topic is registered — specific title + section, not the generic fallback", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-attr-"));
    t.after(() => { rmSync(root, { recursive: true, force: true }); _resetAttributionStatusForTest(); });
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };

    // 1. empty map: the section is present (not "no topic-specific section
    //    registered") and degrades to an explicit note.
    _resetAttributionStatusForTest();
    const empty = await withEnv(env, () => buildDiagnostics("attribution"));
    assert.ok(empty.title.startsWith("Takeover attribution failure (bili v"), `specific title, got: ${empty.title}`);
    assert.ok(!empty.title.startsWith("bili diagnostics report"), "no longer the generic fallback title");
    assert.ok(!empty.blob.includes("no topic-specific section registered"), "registered topic must not print the unregistered note");
    assert.ok(empty.blob.includes("--- takeover attribution ---"), "attribution section header present");
    assert.ok(empty.blob.includes("(no attribution reports received by this process"), "empty map degrades to an explicit note");
    // the generic enrichment still rides along after the topic section
    assert.ok(empty.blob.includes("--- host client versions ---"), "enrichment present");
    assert.ok(empty.blob.indexOf("--- takeover attribution ---") < empty.blob.indexOf("--- host client versions ---"), "topic section precedes enrichment");

    // 2. a degraded agent renders state/refusals/since + error + endpoint
    const since = 1760000000000;
    recordAttributionReport("dsh", {
        state: "threw",
        refusals: 7,
        since,
        error: "attribution gate threw: agent scope disposed after version swap",
        endpoint: "https://relay.example.com/v1/chat/completions",
    });
    const rep = await withEnv(env, () => buildDiagnostics("attribution"));
    const blob = rep.blob;
    assert.ok(blob.includes(`dsh: state=threw refusals=7 since=${new Date(since).toISOString()}`),
        `per-agent line with state/refusals/since, got:\n${blob}`);
    assert.ok(blob.includes("error: attribution gate threw: agent scope disposed after version swap"), "error text rendered");
    // the endpoint is already origin+pathname-only at the source, but the sink
    // still host-masks it (publish boundary) — assert the masked form AND that
    // the raw host never survives.
    assert.ok(blob.includes("endpoint: https://<private-host>/v1/chat/completions"), "masked endpoint rendered");
    assert.ok(!blob.includes("relay.example.com"), "endpoint host must be host-masked by the publish boundary");
    assert.ok(blob.includes("banner policy (#3581/#3651)"), "banner-policy note present");
    // URL round-trip: the prefilled body decodes back to the exact blob.
    const u = new URL(rep.url);
    assert.equal(u.origin + u.pathname, "https://github.com/ranxianglei/billion-context/issues/new");
    assert.equal(decodeURIComponent(u.searchParams.get("body") ?? ""), blob);
});

test("#7053 attribution error text passes the publish boundary — credential shapes scrubbed", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-attr-redact-"));
    t.after(() => { rmSync(root, { recursive: true, force: true }); _resetAttributionStatusForTest(); });
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    _resetAttributionStatusForTest();
    // a `threw` episode whose error text carries a credential-shaped value must
    // not leak it into the PUBLISHED blob (the sink-level redactForPublish is the
    // guarantee, same as every other section).
    recordAttributionReport("dsh", {
        state: "threw",
        refusals: 1,
        since: 1760000000000,
        error: "upstream 401: authorization: bearer sk-live-abcdefgh123456789 rejected",
    });
    const blob = (await withEnv(env, () => buildDiagnostics("attribution"))).blob;
    assert.ok(blob.includes("--- takeover attribution ---"), "section present");
    assert.ok(!blob.includes("sk-live-abcdefgh123456789"), "credential-shaped error value must not survive into the published blob");
});
