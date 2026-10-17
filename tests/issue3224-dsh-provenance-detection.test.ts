// #3224: three-way provenance detection for dsh profile copies — manifest
// declaration vs lockfile resolution vs on-disk copy version. Covers the
// #3160 residual face where the copy is NOT above the registry target (so
// #3164's ahead advisory never fires) yet the three records contradict each
// other: pure detection, no network, no writes, never throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, renderDoctorReport } from "../src/doctor.ts";
import { auditDshProfileCopyProvenance, dshProfileCopyFindings, specAdmits } from "../src/provenance.ts";
import { rmrf } from "./tmp-rm.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
    const effective: Record<string, string | undefined> = { ...vars };
    // Windows os.homedir() resolves through USERPROFILE, not HOME — mirror the
    // sandboxed HOME there or real-machine config (~/.dsh) leaks into tests.
    if (process.platform === "win32" && effective.HOME !== undefined && effective.USERPROFILE === undefined) {
        effective.USERPROFILE = effective.HOME;
    }
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(effective)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const restore = (): void => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    const r = fn();
    return r instanceof Promise ? r.finally(restore) : (restore(), undefined);
}

interface ProfileOpts {
    /** Manifest dep spec; omit for a profile without the dependency. */
    manifestSpec?: string;
    /** On-disk copy version; omit for a declared-but-missing copy. */
    copyVersion?: string;
    /** Nested pnpm-lock.yaml (lockfile ≥6 / v9 importers form). */
    pnpmLock?: { specifier: string; version: string };
    /** Flat pnpm-lock.yaml (lockfile ≤5.4: specifiers: + dependencies: maps). */
    pnpmLockFlat?: { specifier: string; version: string };
    /** npm package-lock.json fallback. */
    packageLock?: { specifier: string; version: string };
}

function makeProfile(base: string, name: string, opts: ProfileOpts): string {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    if (opts.manifestSpec !== undefined) {
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({
            dependencies: { "billion-context": opts.manifestSpec },
            dsh: { profile: { bundles: ["billion-context"] } },
        }));
    }
    if (opts.copyVersion !== undefined) {
        const copy = path.join(dir, "node_modules", "billion-context");
        mkdirSync(copy, { recursive: true });
        writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "billion-context", version: opts.copyVersion }));
    }
    if (opts.pnpmLock !== undefined) {
        writeFileSync(path.join(dir, "pnpm-lock.yaml"), [
            "lockfileVersion: '9.0'",
            "",
            "importers:",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            `        specifier: ${opts.pnpmLock.specifier}`,
            `        version: ${opts.pnpmLock.version}`,
            "",
        ].join("\n"));
    } else if (opts.pnpmLockFlat !== undefined) {
        writeFileSync(path.join(dir, "pnpm-lock.yaml"), [
            "lockfileVersion: 5.4",
            "",
            "specifiers:",
            `  billion-context: ${opts.pnpmLockFlat.specifier}`,
            "",
            "dependencies:",
            `  billion-context: ${opts.pnpmLockFlat.version}`,
            "",
        ].join("\n"));
    } else if (opts.packageLock !== undefined) {
        writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
            name: name,
            lockfileVersion: 3,
            packages: {
                "": { dependencies: { "billion-context": opts.packageLock.specifier } },
                "node_modules/billion-context": { version: opts.packageLock.version },
            },
        }));
    }
    return dir;
}

test("specAdmits: exact/caret/tilde judged, exotic specs stay unjudgeable (silent)", () => {
    assert.equal(specAdmits("1.2.9", "1.2.9"), true);
    assert.equal(specAdmits("1.2.9", "1.2.10"), false);
    assert.equal(specAdmits("^1.2.9", "1.2.10"), true);
    assert.equal(specAdmits("^1.2.9", "1.2.8"), false);
    assert.equal(specAdmits("^1.2.9", "2.0.0"), false);
    assert.equal(specAdmits("~1.2.9", "1.2.20"), true);
    assert.equal(specAdmits("~1.2.9", "1.3.0"), false);
    // Unjudgeable must be undefined, never false — a warning gate must not cry wolf.
    assert.equal(specAdmits("latest", "0.1.196"), undefined);
    assert.equal(specAdmits(">=1.0.0", "1.2.9"), undefined);
    assert.equal(specAdmits("github:user/repo", "1.2.9"), undefined);
});

test("#3224: healthy consistent profile (nested pnpm lock) stays silent", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-ok-"));
    try {
        const dir = makeProfile(base, "web", { manifestSpec: "^0.1.196", copyVersion: "0.1.196", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        assert.deepEqual(dshProfileCopyFindings(dir), []);
    } finally {
        rmrf(base);
    }
});

test("#3224: the #3160 incident shape — copy above lock, manifest never installed — flags both contradictions", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-inc-"));
    try {
        // manifest ^1.2.9 (never resolved), lockfile still resolves 0.1.196,
        // on-disk copy hand-placed at 1.2.9 — exactly what happened 2026-10-13.
        const dir = makeProfile(base, "web", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        const findings = dshProfileCopyFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["copy-vs-lock", "manifest-vs-lock"]);
        assert.equal(findings[0].profile, "web");
        assert.equal(findings[0].copyVersion, "1.2.9");
        assert.equal(findings[0].lockVersion, "0.1.196");
        assert.match(findings[0].detail, /does not match the lockfile resolution v0\.1\.196/);
        assert.match(findings[0].detail, /out-of-band/);
        assert.match(findings[1].detail, /manifest declares \^1\.2\.9 but the lockfile records \^0\.1\.196/);
        for (const f of findings) {
            assert.ok(f.detail.includes(`dsh plugin --profile web add billion-context`) && f.detail.includes("bili plugin install dsh"), `remediation missing: ${f.detail}`);
        }
    } finally {
        rmrf(base);
    }
});

test("#3224: hypothetical variant — stale copy beside a phantom manifest spec, no lockfile — flags copy-vs-manifest", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-stale-"));
    try {
        const dir = makeProfile(base, "web", { manifestSpec: "^1.2.9", copyVersion: "0.1.196" });
        const findings = dshProfileCopyFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["copy-vs-manifest"]);
        assert.match(findings[0].detail, /copy v0\.1\.196 does not satisfy the manifest spec \^1\.2\.9/);
        assert.match(findings[0].detail, /no lockfile exists/);
    } finally {
        rmrf(base);
    }
});

test("#3224: declaration changed without an install — manifest-vs-lock alone", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-manifest-"));
    try {
        const dir = makeProfile(base, "web", { manifestSpec: "^0.1.198", copyVersion: "0.1.196", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        const findings = dshProfileCopyFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["manifest-vs-lock"]);
    } finally {
        rmrf(base);
    }
});

test("#3224: out-of-band copy replacement — copy-vs-lock alone", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-copy-"));
    try {
        const dir = makeProfile(base, "web", { manifestSpec: "^0.1.197", copyVersion: "0.1.196", pnpmLock: { specifier: "^0.1.197", version: "0.1.197" } });
        const findings = dshProfileCopyFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["copy-vs-lock"]);
        assert.equal(findings[0].lockVersion, "0.1.197");
    } finally {
        rmrf(base);
    }
});

test("#3224: flat pnpm lockform (≤5.4) parses the same-line values with their correct roles", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-flat-"));
    try {
        // Healthy: specifiers section carries the declared spec, flat dependencies
        // map the RESOLVED version — both consistent with the copy.
        const ok = makeProfile(base, "ok", { manifestSpec: "^0.1.196", copyVersion: "0.1.196", pnpmLockFlat: { specifier: "^0.1.196", version: "0.1.196" } });
        assert.deepEqual(dshProfileCopyFindings(ok), []);
        // Wedged: the flat value is a version — a copy mismatch must surface as
        // copy-vs-lock (not be misread as a specifier).
        const bad = makeProfile(base, "bad", { manifestSpec: "^0.1.196", copyVersion: "1.2.9", pnpmLockFlat: { specifier: "^0.1.196", version: "0.1.196" } });
        assert.deepEqual(dshProfileCopyFindings(bad).map((f) => f.kind), ["copy-vs-lock"]);
    } finally {
        rmrf(base);
    }
});

test("#3224: package-lock.json fallback covers npm-materialized profiles", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-npml-"));
    try {
        const dir = makeProfile(base, "web", { manifestSpec: "^0.1.196", copyVersion: "1.2.9", packageLock: { specifier: "^0.1.196", version: "0.1.196" } });
        const findings = dshProfileCopyFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["copy-vs-lock"]);
    } finally {
        rmrf(base);
    }
});

test("#3224: skip conditions — dev pins, no dep, missing copy, unjudgeable spec all stay silent", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-skip-"));
    try {
        const linkPin = makeProfile(base, "linkpin", { manifestSpec: "link:/local/x", copyVersion: "9.9.9" });
        assert.deepEqual(dshProfileCopyFindings(linkPin), []);
        const filePin = makeProfile(base, "filepin", { manifestSpec: "file:../checkout", copyVersion: "9.9.9" });
        assert.deepEqual(dshProfileCopyFindings(filePin), []);
        const gitPin = makeProfile(base, "gitpin", { manifestSpec: "git+https://example.com/x.git", copyVersion: "9.9.9" });
        assert.deepEqual(dshProfileCopyFindings(gitPin), []);
        const noDep = path.join(base, "nodesc");
        mkdirSync(noDep, { recursive: true });
        writeFileSync(path.join(noDep, "package.json"), JSON.stringify({ dependencies: {} }));
        assert.deepEqual(dshProfileCopyFindings(noDep), []);
        // Declared but copy missing — doctor's "broken" verdict owns that state.
        const noCopy = makeProfile(base, "nocopy", { manifestSpec: "^0.1.196" });
        assert.deepEqual(dshProfileCopyFindings(noCopy), []);
        // Dist-tag spec with no lockfile: unjudgeable, never a finding.
        const distTag = makeProfile(base, "disttag", { manifestSpec: "latest", copyVersion: "0.1.196" });
        assert.deepEqual(dshProfileCopyFindings(distTag), []);
    } finally {
        rmrf(base);
    }
});

test("#3224: desktop profile is skipped by design — wedged desktop stays silent, sibling still flagged", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-desktop-"));
    try {
        const dshHome = path.join(base, "dsh");
        // Identical #3160 wedge shape on both profiles; only the non-desktop one
        // may be reported (bili writes the desktop lane in place — see provenance.ts).
        makeProfile(path.join(dshHome, "profiles"), "desktop", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        makeProfile(path.join(dshHome, "profiles"), "web", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        assert.deepEqual(dshProfileCopyFindings(path.join(dshHome, "profiles", "desktop")), []);
        const findings = auditDshProfileCopyProvenance({ env: { DSH_HOME: dshHome } });
        assert.equal(findings.length, 2);
        assert.ok(findings.every((f) => f.profile === "web"));
    } finally {
        rmrf(base);
    }
});

test("#3224: startup audit walks every profile, warns per finding, healthy ones stay silent", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-audit-"));
    try {
        const dshHome = path.join(base, "dsh");
        makeProfile(path.join(dshHome, "profiles"), "web", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        makeProfile(path.join(dshHome, "profiles"), "clean", { manifestSpec: "^0.1.196", copyVersion: "0.1.196", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        const lines: Array<{ level: string; msg: string }> = [];
        const findings = auditDshProfileCopyProvenance({ env: { DSH_HOME: dshHome }, log: (level, msg) => lines.push({ level, msg }) });
        assert.equal(findings.length, 2);
        assert.ok(findings.every((f) => f.profile === "web"));
        assert.equal(lines.length, 2);
        assert.ok(lines.every((l) => l.level === "warn"));
        assert.match(lines[0].msg, /^\[dsh-profile\] web: .*out-of-band/);
        assert.match(lines[1].msg, /^\[dsh-profile\] web: .*manifest declares \^1\.2\.9/);
    } finally {
        rmrf(base);
    }
});

test("#3224: startup audit fails soft — no dsh home, unreadable profile, no throw", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-soft-"));
    try {
        // dsh never ran on this machine: dshProfileDirs throws, audit returns [].
        assert.deepEqual(auditDshProfileCopyProvenance({ env: { DSH_HOME: path.join(base, "absent") } }), []);
        // One wedged profile plus one whose package.json is corrupt JSON.
        const dshHome = path.join(base, "dsh");
        makeProfile(path.join(dshHome, "profiles"), "web", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
        const broken = path.join(dshHome, "profiles", "corrupt");
        mkdirSync(broken, { recursive: true });
        writeFileSync(path.join(broken, "package.json"), "{ not json");
        const findings = auditDshProfileCopyProvenance({ env: { DSH_HOME: dshHome } });
        assert.equal(findings.length, 2);
        assert.ok(findings.every((f) => f.profile === "web"));
    } finally {
        rmrf(base);
    }
});

function mockFetch(handler: (url: string) => Response | Promise<Response>): (fn: () => Promise<void>) => Promise<void> {
    const original = globalThis.fetch;
    return (fn) => {
        globalThis.fetch = ((url: unknown) => Promise.resolve(handler(String(url)))) as unknown as typeof fetch;
        return fn().finally(() => {
            globalThis.fetch = original;
        });
    };
}

test("#3224: bili doctor surfaces provenance findings as dsh-lane warnings without touching the verdict", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-prov-doctor-"));
    const runWithFetch = mockFetch(() =>
        new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
        await runWithFetch(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined, HERMES_HOME: undefined,
                KIMI_CODE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, OPENCODE_CONFIG: undefined,
            }, async () => {
                const dshHome = path.join(base, "dsh");
                makeProfile(path.join(dshHome, "profiles"), "web", { manifestSpec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: { specifier: "^0.1.196", version: "0.1.196" } });
                process.env.DSH_HOME = dshHome;
                try {
                    const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                    const lane = report.lanes.find((l) => l.agent === "dsh:web");
                    assert.ok(lane !== undefined, "dsh:web lane present");
                    // Registry 999.0.0 > copy 1.2.9: freshness verdict stays stale —
                    // the provenance findings ride warnings, they do not re-grade.
                    // (A shadowed-copy warning may legitimately coexist: in this
                    // harness the running checkout IS the global install.)
                    assert.equal(lane?.verdict, "stale");
                    const prov = lane?.warnings?.filter((w) => w.startsWith("billion-context copy v") || w.startsWith("profile manifest declares")) ?? [];
                    assert.equal(prov.length, 2);
                    assert.ok(prov.some((w) => w.includes("out-of-band")));
                    assert.ok(prov.some((w) => w.includes("manifest declares ^1.2.9")));
                    assert.match(renderDoctorReport(report), /⚠️ .*out-of-band/);
                } finally {
                    delete process.env.DSH_HOME;
                }
            });
        });
    } finally {
        rmrf(base);
    }
});
