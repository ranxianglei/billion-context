// #7139: unit tests for the pnpm minimumReleaseAge gate (src/release-maturity.ts).
// Policy resolution (precedence, parsing, fail-closed), exclude matching
// (the pnpm version-policy rule grammar), and the verdict logic against a
// stubbed registry packument.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// #2206 discipline: the module's time cache lands under cacheDir() (resolved
// at call time), but isolate XDG_CACHE_HOME before import anyway so no test
// can touch the machine's real cache.
const __cacheRoot = mkdtempSync(path.join(tmpdir(), "bc-release-maturity-cache-"));
process.env.XDG_CACHE_HOME = path.join(__cacheRoot, "cache");
const { checkReleaseMaturity, resolveMaturityPolicy, matchMaturityExclude } = await import("../src/release-maturity.ts");
import { rmrf } from "./tmp-rm.ts";

const REGISTRY = "https://registry.test";

function makeEnv(root: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".config"), { recursive: true });
    return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PREFIX: path.join(root, "prefix"), ...overrides };
}

function isoHoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** Stub the registry: serves ONLY the packument (the gate's only fetch).
 *  `time` = the packument's time map (omit via opts to test the no-time case). */
function stubPackumentFetch(time: Record<string, string> | undefined, opts: { failNetwork?: boolean; status?: number } = {}): { packumentCalls: number } {
    const state = { packumentCalls: 0 };
    globalThis.fetch = ((url: unknown) => {
        const u = String(url);
        if (u === `${REGISTRY}/billion-context`) {
            state.packumentCalls++;
            if (opts.failNetwork) return Promise.reject(new Error("network down"));
            if (opts.status) return Promise.resolve(new Response("nope", { status: opts.status }));
            const doc: Record<string, unknown> = { name: "billion-context", versions: {} };
            if (time !== undefined) doc.time = time;
            return Promise.resolve(new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as unknown as typeof fetch;
    return state;
}

function projectWith(root: string, yaml?: string, npmrc?: string, name = "project"): string {
    const projectDir = path.join(root, name);
    mkdirSync(projectDir, { recursive: true });
    if (yaml !== undefined) writeFileSync(path.join(projectDir, "pnpm-workspace.yaml"), yaml);
    if (npmrc !== undefined) writeFileSync(path.join(projectDir, ".npmrc"), npmrc);
    return projectDir;
}

// —— resolveMaturityPolicy: precedence & parsing ———

test("policy: no source anywhere → no minimumReleaseAge", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-nopolicy-"));
    try {
        const projectDir = projectWith(root);
        const r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.policy.minAgeMinutes, undefined);
        assert.deepEqual(r.policy.excludeSpecs, []);
    } finally {
        rmrf(root);
    }
});

test("policy: env pnpm_config wins over project yaml; npm_config is the fallback", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-env-"));
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 60\n");
        const env = makeEnv(root, { pnpm_config_minimum_release_age: "1440", npm_config_minimum_release_age: "30" });
        const r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.policy.minAgeMinutes, 1440);
        assert.equal(r.policy.minAgeSource, "env pnpm_config_minimum_release_age");
        const r2 = resolveMaturityPolicy(projectDir, makeEnv(root, { npm_config_minimum_release_age: "30" }));
        assert.equal(r2.ok, true);
        if (!r2.ok) return;
        assert.equal(r2.policy.minAgeMinutes, 30);
        assert.equal(r2.policy.minAgeSource, "env npm_config_minimum_release_age");
    } finally {
        rmrf(root);
    }
});

test("policy: project yaml beats project .npmrc beats user .npmrc beats global config.yaml beats $PREFIX/etc/npmrc", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-precedence-"));
    try {
        const env = makeEnv(root);
        const userNpmrc = path.join(env.HOME as string, ".npmrc");
        writeFileSync(userNpmrc, "minimumReleaseAge=50\n");
        const globalYaml = path.join(env.XDG_CONFIG_HOME as string, "pnpm");
        mkdirSync(globalYaml, { recursive: true });
        writeFileSync(path.join(globalYaml, "config.yaml"), "minimumReleaseAge: 40\n");
        mkdirSync(path.join(env.PREFIX as string, "etc"), { recursive: true });
        writeFileSync(path.join(env.PREFIX as string, "etc", "npmrc"), "minimumReleaseAge=30\n");

        let projectDir = projectWith(root, "minimumReleaseAge: 100\n", "minimumReleaseAge=90\n", "p-yaml");
        let r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.policy.minAgeSource, "project pnpm-workspace.yaml");

        // a null project value is "not provided" — it must not shadow the user's positive value
        projectDir = projectWith(root, "minimumReleaseAge:\n", undefined, "p-null");
        r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.policy.minAgeMinutes, 50);
            assert.equal(r.policy.minAgeSource, "user ~/.npmrc");
        }

        projectDir = projectWith(root, undefined, "minimumReleaseAge=90\n", "p-npmrc");
        r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.policy.minAgeSource, "project .npmrc");

        projectDir = projectWith(root, undefined, undefined, "p-none");
        r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.policy.minAgeSource, "user ~/.npmrc");

        // no user npmrc → global config.yaml
        writeFileSync(userNpmrc, "");
        r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.policy.minAgeSource, "global pnpm config.yaml");

        // no global yaml → $PREFIX/etc/npmrc
        writeFileSync(path.join(globalYaml, "config.yaml"), "");
        r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.policy.minAgeSource, "global $PREFIX/etc/npmrc");
    } finally {
        rmrf(root);
    }
});

test("policy: excludes travel with the source that defines them (env minAge + project excludes)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-exclsrc-"));
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 60\nminimumReleaseAgeExclude:\n  - billion-context\n");
        const env = makeEnv(root, { pnpm_config_minimum_release_age: "1440" });
        const r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.policy.minAgeMinutes, 1440);
        assert.deepEqual(r.policy.excludeSpecs, ["billion-context"]);
        assert.equal(r.policy.excludeSource, "project pnpm-workspace.yaml");
    } finally {
        rmrf(root);
    }
});

test("policy: a null exclude list does not shadow a lower-precedence list (pnpm: null = unset)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-null-excl-"));
    try {
        const env = makeEnv(root);
        writeFileSync(path.join(env.HOME as string, ".npmrc"), "minimumReleaseAgeExclude=billion-context\n");
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n");
        const r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.policy.minAgeMinutes, 1440);
            assert.equal(r.policy.minAgeSource, "project pnpm-workspace.yaml");
            assert.deepEqual(r.policy.excludeSpecs, ["billion-context"]);
            assert.equal(r.policy.excludeSource, "user ~/.npmrc");
        }
    } finally {
        rmrf(root);
    }
});

test("policy: an explicit empty exclude list ([]) IS provided and clears lower lists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-empty-excl-"));
    try {
        const env = makeEnv(root);
        writeFileSync(path.join(env.HOME as string, ".npmrc"), "minimumReleaseAgeExclude=billion-context\n");
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: []\n");
        const r = resolveMaturityPolicy(projectDir, env);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.policy.minAgeMinutes, 1440);
            assert.deepEqual(r.policy.excludeSpecs, []);
            assert.equal(r.policy.excludeSource, "project pnpm-workspace.yaml");
        }
    } finally {
        rmrf(root);
    }
});

test("policy: yaml forms — flow list, null value, inline comments, quoted values", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-yaml-"));
    try {
        let projectDir = projectWith(root, 'minimumReleaseAge: "1440" # twenty-four hours\nminimumReleaseAgeExclude: [billion-context, other@1.0.0]\n');
        let r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.policy.minAgeMinutes, 1440);
            assert.deepEqual(r.policy.excludeSpecs, ["billion-context", "other@1.0.0"]);
        }
        projectDir = projectWith(root, "minimumReleaseAge:\nminimumReleaseAgeExclude:\n  - 'billion-context@1.0.0'\n");
        r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.policy.minAgeMinutes, undefined); // null = "not provided" — no source defines it
            assert.deepEqual(r.policy.excludeSpecs, ["billion-context@1.0.0"]);
        }
    } finally {
        rmrf(root);
    }
});

test("policy: npmrc forms — comments, semicolons, quotes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-npmrc-"));
    try {
        const projectDir = projectWith(root, undefined, "# comment\n; another\nregistry=https://x\nminimumReleaseAge = 1440\nminimumReleaseAgeExclude=\"a@1.0.0, b\"\n");
        const r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.policy.minAgeMinutes, 1440);
        assert.deepEqual(r.policy.excludeSpecs, ["a@1.0.0", "b"]);
    } finally {
        rmrf(root);
    }
});

test("policy: malformed values fail closed (no policy established)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-malformed-"));
    try {
        let projectDir = projectWith(root, "minimumReleaseAge: abc\n");
        let r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.reason, /not a non-negative integer/);

        projectDir = projectWith(root, "minimumReleaseAge: -5\n");
        r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, false);

        projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAge: 60\n");
        r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.reason, /duplicate/);

        projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: just-a-scalar\n");
        r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.reason, /must be a list/);

        projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: [a,\n  b]\n");
        r = resolveMaturityPolicy(projectDir, makeEnv(root));
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.reason, /multi-line flow/);

        // a directory where a config file should be: unreadable → fail closed
        const weird = projectWith(root, undefined, undefined, "p-unreadable");
        mkdirSync(path.join(weird, ".npmrc"));
        r = resolveMaturityPolicy(weird, makeEnv(root));
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.reason, /cannot read project \.npmrc/);
    } finally {
        rmrf(root);
    }
});

// —— matchMaturityExclude: the pnpm version-policy rule grammar ———

test("exclude: bare name and scoped name exclude every version", () => {
    assert.deepEqual(matchMaturityExclude(["billion-context"], "billion-context", "9.9.9"), { matched: true, spec: "billion-context" });
    assert.deepEqual(matchMaturityExclude(["@scope/tools"], "@scope/tools", "1.0.0"), { matched: true, spec: "@scope/tools" });
    assert.deepEqual(matchMaturityExclude(["other"], "billion-context", "1.0.0"), { matched: false });
});

test("exclude: exact name@version and version unions", () => {
    assert.deepEqual(matchMaturityExclude(["billion-context@1.0.0"], "billion-context", "1.0.0"), { matched: true, spec: "billion-context@1.0.0" });
    assert.deepEqual(matchMaturityExclude(["billion-context@1.0.0"], "billion-context", "1.0.1"), { matched: false });
    assert.deepEqual(matchMaturityExclude(["billion-context@1.0.0 || 2.0.0"], "billion-context", "2.0.0"), { matched: true, spec: "billion-context@1.0.0 || 2.0.0" });
    assert.deepEqual(matchMaturityExclude(["billion-context@1.0.0 || 2.0.0"], "billion-context", "3.0.0"), { matched: false });
});

test("exclude: wildcard names (no version part) match by glob", () => {
    assert.deepEqual(matchMaturityExclude(["is-*"], "is-foo", "1.0.0"), { matched: true, spec: "is-*" });
    assert.deepEqual(matchMaturityExclude(["@scope/*"], "@scope/anything", "1.0.0"), { matched: true, spec: "@scope/*" });
    assert.deepEqual(matchMaturityExclude(["is-*"], "other", "1.0.0"), { matched: false });
    assert.deepEqual(matchMaturityExclude(["b?llion-context"], "billion-context", "1.0.0"), { matched: true, spec: "b?llion-context" });
});

test("exclude: malformed rules are errors, not silent misses", () => {
    assert.ok("error" in matchMaturityExclude(["is-*@1.0.0"], "is-foo", "1.0.0"));
    assert.ok("error" in matchMaturityExclude(["billion-context@1.0.0 ||"], "billion-context", "1.0.0"));
    assert.ok("error" in matchMaturityExclude([""], "billion-context", "1.0.0"));
});

// —— checkReleaseMaturity: verdicts against a stubbed packument ———

test("gate: no policy → no-policy, zero registry traffic", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-nopolicy-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root);
        globalThis.fetch = (() => Promise.reject(new Error("no registry traffic expected with no policy"))) as unknown as typeof fetch;
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "1.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.deepEqual(v, { kind: "no-policy" });
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: excluded package → excluded, zero registry traffic", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-excluded-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - billion-context\n");
        globalThis.fetch = (() => Promise.reject(new Error("no registry traffic expected for an excluded package"))) as unknown as typeof fetch;
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "1.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.deepEqual(v, { kind: "excluded", spec: "billion-context", source: "project pnpm-workspace.yaml" });
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

// NOTE: the module keeps an in-process memo keyed by package@version, so every
// gate test below uses a UNIQUE version — a reused version would be served
// from the memo and the stub (and the verdict under test) never exercised.

test("gate: mature release → mature (publish time outside the window)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-mature-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\n");
        const publishedAt = isoHoursAgo(48);
        const maturityCalls = stubPackumentFetch({ created: publishedAt, modified: publishedAt, "2.0.0": publishedAt });
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "2.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.deepEqual(v, { kind: "mature", publishedAt, minAgeMinutes: 1440 });
        assert.equal(maturityCalls.packumentCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: immature release → immature with the policy source named", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-immature-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\n");
        const publishedAt = isoHoursAgo(1);
        stubPackumentFetch({ created: publishedAt, modified: publishedAt, "3.0.0": publishedAt });
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "3.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.deepEqual(v, { kind: "immature", publishedAt, minAgeMinutes: 1440, source: "project pnpm-workspace.yaml" });
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: null exclude in project yaml → the user-npmrc exclude still applies (excluded, no traffic)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-null-excl-"));
    const originalFetch = globalThis.fetch;
    try {
        const env = makeEnv(root);
        writeFileSync(path.join(env.HOME as string, ".npmrc"), "minimumReleaseAgeExclude=billion-context\n");
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n");
        globalThis.fetch = (() => Promise.reject(new Error("no registry traffic expected for an excluded package"))) as unknown as typeof fetch;
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "8.0.0", registryBase: REGISTRY, env });
        assert.deepEqual(v, { kind: "excluded", spec: "billion-context", source: "user ~/.npmrc" });
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: explicit [] exclude in project yaml → the gate still applies (immature)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-empty-excl-"));
    const originalFetch = globalThis.fetch;
    try {
        const env = makeEnv(root);
        writeFileSync(path.join(env.HOME as string, ".npmrc"), "minimumReleaseAgeExclude=billion-context\n");
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: []\n");
        const publishedAt = isoHoursAgo(1);
        stubPackumentFetch({ created: publishedAt, modified: publishedAt, "8.1.0": publishedAt });
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "8.1.0", registryBase: REGISTRY, env });
        assert.deepEqual(v, { kind: "immature", publishedAt, minAgeMinutes: 1440, source: "project pnpm-workspace.yaml" });
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: packument without a usable time fails closed (undatable)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-notime-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\n");
        // no time key at all
        stubPackumentFetch(undefined);
        let v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "4.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.equal(v.kind, "undatable");
        if (v.kind === "undatable") assert.match(v.reason, /no publish time/);
        // time map present but missing the target version
        stubPackumentFetch({ created: isoHoursAgo(48), modified: isoHoursAgo(48), "0.9.0": isoHoursAgo(48) });
        v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "4.1.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.equal(v.kind, "undatable");
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: fetch failure and non-OK status fail closed (undatable)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-fetchfail-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\n");
        stubPackumentFetch({ "5.0.0": isoHoursAgo(48) }, { failNetwork: true });
        let v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "5.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.equal(v.kind, "undatable");
        if (v.kind === "undatable") assert.match(v.reason, /registry fetch failed/);
        stubPackumentFetch({ "6.0.0": isoHoursAgo(48) }, { status: 404 });
        v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "6.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.equal(v.kind, "undatable");
        if (v.kind === "undatable") assert.match(v.reason, /HTTP 404/);
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: malformed policy fails closed before any registry traffic", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-badpolicy-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: abc\n");
        globalThis.fetch = (() => Promise.reject(new Error("no registry traffic expected when the policy is malformed"))) as unknown as typeof fetch;
        const v = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "1.0.0", registryBase: REGISTRY, env: makeEnv(root) });
        assert.equal(v.kind, "undatable");
        if (v.kind === "undatable") assert.match(v.reason, /not a non-negative integer/);
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});

test("gate: time cache — repeat checks for the same version do not refetch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-maturity-gate-cache-"));
    const originalFetch = globalThis.fetch;
    try {
        const projectDir = projectWith(root, "minimumReleaseAge: 1440\n");
        const publishedAt = isoHoursAgo(48);
        const maturityCalls = stubPackumentFetch({ created: publishedAt, modified: publishedAt, "7.7.7": publishedAt, "7.7.8": isoHoursAgo(1) });
        const env = makeEnv(root);
        const v1 = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "7.7.7", registryBase: REGISTRY, env });
        assert.equal(v1.kind, "mature");
        // same version again: memo + file cache — no traffic
        const v2 = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "7.7.7", registryBase: REGISTRY, env });
        assert.equal(v2.kind, "mature");
        // a DIFFERENT version from the same packument: still served from cache
        const v3 = await checkReleaseMaturity({ projectDir, packageName: "billion-context", version: "7.7.8", registryBase: REGISTRY, env });
        assert.equal(v3.kind, "immature");
        assert.equal(maturityCalls.packumentCalls, 1, `expected exactly one packument fetch, got ${maturityCalls.packumentCalls}`);
    } finally {
        globalThis.fetch = originalFetch;
        rmrf(root);
    }
});
