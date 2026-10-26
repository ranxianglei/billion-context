import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

// #3632: on the CONNECT/MITM lane every lookup runs against a rewritten
// mitm://<host> URL, so a plain https:// providers key can never match
// MITM-lane traffic to its host — and sat silently inert (window falling back
// to the 2e5 default) until a per-request [window] line much later. The fix is
// diagnostic, in two layers these tests pin:
//   A. config load — warnInertMitmLaneKeys warns once per inert https:// key on
//      a MITM-whitelisted host that has no covering mitm:// twin;
//   B. request time — warnRouteMissIfNew names the scheme mismatch when the
//      only same-host keys are https:// ones.

import { loadRoutes, _resetNamedProviderWarningsForTest } from "../src/config.ts";
import { warnRouteMissIfNew, _resetRouteMissWarnedForTest } from "../src/server.ts";
import { setLogCapture } from "../src/logger.ts";
import { setMaskHostsEnabled } from "../src/log-mask.ts";
import { rmrf } from "./tmp-rm.ts";

test.before(() => setMaskHostsEnabled(false));
test.after(() => setMaskHostsEnabled(true));

function withFile(t: test.TestContext, file: Record<string, unknown>): void {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue3632-"));
    const p = path.join(dir, "billion-context.json");
    writeFileSync(p, JSON.stringify(file, null, 2), "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = p;
    t.after(() => {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        rmrf(dir);
    });
}

function setEnv(t: test.TestContext, vars: Record<string, string>): void {
    const prevs: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prevs[k] = process.env[k];
        process.env[k] = v;
    }
    t.after(() => {
        for (const [k, v] of Object.entries(prevs)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

function captureWarnings(t: test.TestContext): string[] {
    const lines: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") lines.push(msg); });
    t.after(() => setLogCapture(null));
    return lines;
}

test("#3632 A1: https:// key on an explicitly whitelisted MITM host without a twin warns, naming the exact twin", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: { "https://opencode.ai": { models: { "space-bunny-free": { context: 1048576 } } } },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('providers."https://opencode.ai"'), warnings[0]);
    assert.ok(warnings[0].includes("inert for MITM-lane traffic to opencode.ai"), warnings[0]);
    assert.ok(warnings[0].includes('Add a "mitm://opencode.ai" entry'), warnings[0]);
});

test("#3632 A2: the same entry is quiet once a mitm:// twin exists", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: {
            "https://opencode.ai": { models: { m: { context: 1000 } } },
            "mitm://opencode.ai": { models: { m: { context: 1048576 } } },
        },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.deepEqual(warnings, []);
});

test("#3632 A3: default-whitelisted hosts (no explicit mitm.domains needed) warn too", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: { "https://api.anthropic.com": { compress: { maxContextLimitPct: 0.75 } } },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('Add a "mitm://api.anthropic.com" entry'), warnings[0]);
});

test("#3632 A4: BILI_MITM=0 silences the warning (no MITM lane at all)", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: { "https://api.anthropic.com": { compress: { maxContextLimitPct: 0.75 } } },
    });
    setEnv(t, { BILI_MITM: "0" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.deepEqual(warnings, []);
});

test("#3632 A5: path-scoped twins — a pathless mitm:// key covers deeper https:// paths; a sibling path does not", (t) => {
    const covered = captureWarnings(t);
    withFile(t, {
        providers: {
            "https://opencode.ai/v1": { models: { m: { context: 1000 } } },
            "mitm://opencode.ai": { models: { m: { context: 2000 } } },
        },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.deepEqual(covered, [], `pathless twin must cover /v1: ${JSON.stringify(covered)}`);

    const uncovered = captureWarnings(t);
    withFile(t, {
        providers: {
            "https://opencode.ai/v1": { models: { m: { context: 1000 } } },
            "mitm://opencode.ai/v2": { models: { m: { context: 2000 } } },
        },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.equal(uncovered.length, 1, `sibling-path twin must NOT cover /v1: ${JSON.stringify(uncovered)}`);
    assert.ok(uncovered[0].includes('Add a "mitm://opencode.ai/v1" entry'), uncovered[0]);
});

test("#3632 A6: no false positives — non-whitelisted host, http:// scheme, and bare marker entries stay quiet", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: {
            "https://other.example": { models: { m: { context: 1000 } } },
            "http://opencode.ai": { models: { m: { context: 1000 } } },
            "https://quiet.example": {},
        },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    assert.deepEqual(warnings, [], JSON.stringify(warnings));
});

test("#3632 A7: the warning fires once per key across repeated loads (hot-reload safe)", (t) => {
    const warnings = captureWarnings(t);
    withFile(t, {
        providers: { "https://opencode.ai": { models: { m: { context: 1000 } } } },
        mitm: { domains: ["opencode.ai"] },
    });
    setEnv(t, { BILI_MITM: "1" });
    _resetNamedProviderWarningsForTest();
    loadRoutes();
    loadRoutes();
    loadRoutes();
    assert.equal(warnings.length, 1, `expected one warning across three loads, got: ${JSON.stringify(warnings)}`);
});

test("#3632 B1: runtime route-miss on the MITM lane names the scheme mismatch", () => {
    _resetRouteMissWarnedForTest();
    const lines: string[] = [];
    const log = (level: string, msg: string) => { if (level === "warn") lines.push(msg); };
    const fired = warnRouteMissIfNew("mitm://opencode.ai", "space-bunny-free", ["https://opencode.ai"], log);
    assert.equal(fired, true);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[route] no provider route matched"), lines[0]);
    assert.ok(lines[0].includes("Scheme mismatch"), lines[0]);
    assert.ok(lines[0].includes('"mitm://opencode.ai"'), lines[0]);
    assert.ok(lines[0].includes("keep serving /bili/-embedded requests"), lines[0]);
});

test("#3632 B2: the scheme-mismatch hint keeps ports intact", () => {
    _resetRouteMissWarnedForTest();
    const lines: string[] = [];
    const fired = warnRouteMissIfNew("mitm://relay.internal:8443", "m", ["https://relay.internal:8443"], (l, m) => { if (l === "warn") lines.push(m); });
    assert.equal(fired, true);
    assert.ok(lines[0].includes("Scheme mismatch"), lines[0]);
    assert.ok(lines[0].includes('"mitm://relay.internal:8443"'), lines[0]);
});

test("#3632 B3: no hint when the miss is unrelated to a same-host https:// entry", () => {
    _resetRouteMissWarnedForTest();
    const lines: string[] = [];
    const fired = warnRouteMissIfNew("mitm://opencode.ai", "m", ["https://other.example"], (l, m) => { if (l === "warn") lines.push(m); });
    assert.equal(fired, true);
    assert.ok(!lines[0].includes("Scheme mismatch"), lines[0]);
});

test("#3632 B4: plain-https misses keep the #2317 message verbatim (no hint)", () => {
    _resetRouteMissWarnedForTest();
    const lines: string[] = [];
    const fired = warnRouteMissIfNew("https://unconfigured.example", "m", ["https://other.example"], (l, m) => { if (l === "warn") lines.push(m); });
    assert.equal(fired, true);
    assert.ok(!lines[0].includes("Scheme mismatch"), lines[0]);
    assert.ok(lines[0].endsWith("Add a matching key to the providers block in ~/.config/billion-context/billion-context.json."), lines[0]);
});

test("#3632 B5: the sharpened warning still dedupes per (origin, model)", () => {
    _resetRouteMissWarnedForTest();
    let count = 0;
    const log = (level: string, msg: string) => { if (level === "warn" && msg.includes("Scheme mismatch")) count++; };
    assert.equal(warnRouteMissIfNew("mitm://opencode.ai", "m", ["https://opencode.ai"], log), true);
    assert.equal(warnRouteMissIfNew("mitm://opencode.ai", "m", ["https://opencode.ai"], log), false);
    assert.equal(count, 1);
});
