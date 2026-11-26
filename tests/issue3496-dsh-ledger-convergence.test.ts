// #3496: three-ledger convergence for dsh profiles — the fixture matrix covers
// the drift combinations from the #3160 incident (phantom manifest spec, stale
// lockfile record, out-of-band copy), every lockfile shape pnpm/npm emit, the
// zero-writes guarantee for healthy profiles, and the authority boundary bili
// respects when rewriting declarations. Plus the `bili doctor --fix` surface
// (walk, explicit report, fail-soft).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    convergeDshLedger,
    dshProfileLedgerFindings,
    patchNpmLock,
    patchPnpmLock,
    readDshLedgerState,
    specAdmits,
} from "../src/dsh-ledger.ts";
import { rmrf } from "./tmp-rm.ts";

// #2206: src/update.ts freezes its cache-dir paths at import time and doctor.ts
// pulls it in — point XDG_CACHE_HOME at a temp root BEFORE the dynamic import
// so the suite never touches (or races) the machine's live cross-process state.
const __cacheRoot = mkdtempSync(path.join(tmpdir(), "bc-issue3496-cache-"));
process.env.XDG_CACHE_HOME = path.join(__cacheRoot, "cache");
const { fixDshLedgers, renderLedgerFixReport } = await import("../src/doctor.ts");

// — fixtures ————————————————————————————————————————————————————————————————

interface ProfileOpts {
    /** Manifest dep spec; undefined = no dependency declared. */
    spec?: string;
    /** On-disk bundle copy version; undefined = no readable copy. */
    copyVersion?: string;
    /** The on-disk copy's own direct deps (its package.json) — #7125 dep-map
     *  cross-check. Absent = the copy declares no deps (cross-check skipped). */
    copyDeps?: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    pnpmLock?: string;
    npmLock?: unknown;
    /** Raw package.json content override (corrupt-file cases). */
    manifestRaw?: string;
}

function makeProfile(root: string, name: string, opts: ProfileOpts): string {
    const dir = path.join(root, "profiles", name);
    mkdirSync(dir, { recursive: true });
    if (opts.manifestRaw !== undefined) {
        writeFileSync(path.join(dir, "package.json"), opts.manifestRaw);
    } else {
        const doc: Record<string, unknown> = { name: `@dsh/profile-${name}` };
        if (opts.spec !== undefined) doc.dependencies = { "billion-context": opts.spec, "other-dep": "^1.2.3" };
        writeFileSync(path.join(dir, "package.json"), JSON.stringify(doc, null, 2) + "\n");
    }
    if (opts.copyVersion !== undefined) {
        const copyDir = path.join(dir, "node_modules", "billion-context");
        mkdirSync(copyDir, { recursive: true });
        const copyDoc: Record<string, unknown> = { name: "billion-context", version: opts.copyVersion };
        if (opts.copyDeps?.dependencies !== undefined) copyDoc.dependencies = opts.copyDeps.dependencies;
        if (opts.copyDeps?.optionalDependencies !== undefined) copyDoc.optionalDependencies = opts.copyDeps.optionalDependencies;
        writeFileSync(path.join(copyDir, "package.json"), JSON.stringify(copyDoc, null, 2) + "\n");
    }
    if (opts.pnpmLock !== undefined) writeFileSync(path.join(dir, "pnpm-lock.yaml"), opts.pnpmLock);
    if (opts.npmLock !== undefined) writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(opts.npmLock, null, 2) + "\n");
    return dir;
}

/** Realistic pnpm v9 (nested, importers) lockfile. */
function pnpmLockV9(spec: string, version: string): string {
    return [
        "lockfileVersion: '9.0'",
        "",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      billion-context:",
        `        specifier: ${spec}`,
        `        version: ${version}`,
        "      other-dep:",
        "        specifier: ^1.2.3",
        "        version: 1.2.3",
        "",
        "packages:",
        "",
        `  billion-context@${version}:`,
        "    resolution: {integrity: sha512-fake==}",
        "",
        "snapshots:",
        "",
        `  billion-context@${version}: {}`,
        "",
    ].join("\n");
}

/** pnpm v9 lockfile where the importer's resolution carries a PEER SUFFIX —
 *  what pnpm writes when billion-context (or a dependency of it) has a peer
 *  that the profile satisfies: `version: 0.1.197(@types/node@16.9.1)`, with
 *  the suffixed key under `snapshots:` and the bare key under `packages:`. */
function pnpmLockV9Peer(spec: string, version: string, peerSuffix = "(@types/node@16.9.1)"): string {
    return [
        "lockfileVersion: '9.0'",
        "",
        "settings:",
        "  autoInstallPeers: false",
        "  excludeLinksFromLockfile: false",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      '@types/node':",
        "        specifier: 16.9.1",
        "        version: 16.9.1",
        "      billion-context:",
        `        specifier: ${spec}`,
        `        version: ${version}${peerSuffix}`,
        "      other-dep:",
        "        specifier: ^1.2.3",
        "        version: 1.2.3(@types/node@16.9.1)",
        "",
        "packages:",
        "",
        "  '@types/node@16.9.1':",
        "    resolution: {integrity: sha512-fake==}",
        "",
        `  billion-context@${version}:`,
        "    resolution: {integrity: sha512-fake==}",
        "",
        "snapshots:",
        "",
        "  '@types/node@16.9.1': {}",
        "",
        `  billion-context@${version}${peerSuffix}:`,
        "    dependencies:",
        "      '@types/node': 16.9.1",
        "",
    ].join("\n");
}

/** Flat pnpm ≤5.4 lockfile (same-line values). */
function pnpmLockFlat(spec: string, version: string): string {
    return [
        "lockfileVersion: 5.4",
        "",
        "specifiers:",
        `  billion-context: ${spec}`,
        "  other-dep: ^1.2.3",
        "",
        "dependencies:",
        `  billion-context: ${version}`,
        "  other-dep: 1.2.3",
        "",
    ].join("\n");
}

/** pnpm v6–v8 lockfile (nested entries under the top-level dependencies map). */
function pnpmLockV6(spec: string, version: string): string {
    return [
        "lockfileVersion: 6.0",
        "",
        "dependencies:",
        "  billion-context:",
        `    specifier: ${spec}`,
        `    version: ${version}`,
        "  other-dep:",
        "    specifier: ^1.2.3",
        "    version: 1.2.3",
        "",
        "packages:",
        `  /billion-context/${version}:`,
        "    resolution: {integrity: sha512-fake==}",
        "",
    ].join("\n");
}

/** npm-materialized profile lockfile. */
function npmLock(spec: string, version: string): Record<string, unknown> {
    return {
        name: "@dsh/profile-test",
        lockfileVersion: 3,
        requires: true,
        packages: {
            "": {
                name: "@dsh/profile-test",
                dependencies: { "billion-context": spec, "other-dep": "^1.2.3" },
            },
            "node_modules/billion-context": {
                version,
                resolved: `https://registry.npmjs.org/billion-context/-/billion-context-${version}.tgz`,
                integrity: "sha512-stalehash==",
            },
            "node_modules/other-dep": { version: "1.2.3" },
        },
    };
}

const HELPER_FILES = ["package.json", "pnpm-lock.yaml", "package-lock.json"];

function profileFiles(dir: string): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const f of HELPER_FILES) {
        try {
            out[f] = readFileSync(path.join(dir, f), "utf8");
        } catch {
            out[f] = undefined;
        }
    }
    return out;
}

function profileMtimes(dir: string): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {};
    for (const f of HELPER_FILES) {
        try {
            out[f] = statSync(path.join(dir, f)).mtimeMs;
        } catch {
            out[f] = undefined;
        }
    }
    return out;
}

function assertZeroWrites(dir: string, before: Record<string, string | undefined>, beforeMtimes: Record<string, number | undefined>): void {
    const after = profileFiles(dir);
    const afterMtimes = profileMtimes(dir);
    for (const f of HELPER_FILES) {
        assert.equal(after[f], before[f], `${f} must be byte-identical on a no-op convergence`);
        // mtime pins the stronger claim: no rewrite at all, not even a
        // byte-identical re-serialization (a host-owned file touched is a write).
        assert.equal(afterMtimes[f], beforeMtimes[f], `${f} must not be rewritten on a no-op convergence`);
    }
}

// — convergence core ————————————————————————————————————————————————————————

test("#3496: post-self-heal wedge (stale lock record) converges the lockfile, manifest and store sections untouched", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-a-"));
    try {
        // The state the pre-#3496 self-heal left behind: copy swapped + manifest
        // synced (#2894), lockfile still naming the old version in BOTH fields —
        // so two rungs fire, exactly as #3231's detection would report.
        const dir = makeProfile(root, "wedge", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const kinds = dshProfileLedgerFindings(dir).map((f) => f.kind);
        assert.deepEqual(kinds, ["copy-vs-lock", "manifest-vs-lock"]);
        const before = profileFiles(dir);
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"]);
        assert.deepEqual(res.details.map((d) => [d.field, d.before, d.after]), [
            ["specifier", "^0.1.196", "^0.1.197"],
            ["version", "0.1.196", "0.1.197"],
            ["snapshots: billion-context@0.1.197", "(missing)", "cloned from billion-context@0.1.196"],
            ["packages: billion-context@0.1.197", "(missing)", "cloned from billion-context@0.1.196"],
        ]);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^0\.1\.197/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.ok(lock.includes("  billion-context@0.1.196:"), "old packages entry is kept");
        assert.ok(lock.includes("  billion-context@0.1.196: {}"), "old snapshots entry is kept");
        assert.ok(lock.includes("  billion-context@0.1.197: {}"), "new snapshots entry resolves the importer");
        assert.match(lock, /  billion-context@0\.1\.197:\n    resolution: \{integrity: sha512-new==\}/, "new packages entry carries the new hash");
        assert.equal(readFileSync(path.join(dir, "package.json"), "utf8"), before["package.json"], "in-step manifest must not be rewritten");
        assert.deepEqual(dshProfileLedgerFindings(dir), [], "re-audit after convergence must be clean");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: #3160 raw shape — phantom spec + hand-placed copy converge to the copy via --fix semantics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-b-"));
    try {
        // manifest hand-edited to a spec the registry cannot resolve; lock stuck
        // on the last real install; copy hand-placed at the phantom version.
        const dir = makeProfile(root, "phantom", { spec: "^1.2.9", copyVersion: "1.2.9", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const kinds = dshProfileLedgerFindings(dir).map((f) => f.kind).sort();
        assert.deepEqual(kinds, ["copy-vs-lock", "manifest-vs-lock"]);
        const res = convergeDshLedger(dir, "1.2.9", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"], "the declaration ADMITS the copy — bili keeps it, converges the record");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^1\.2\.9/);
        assert.match(lock, /version: 1\.2\.9/);
        assert.ok(lock.includes("  billion-context@1.2.9: {}"), "the phantom version's snapshots entry is still recorded");
        assert.deepEqual(dshProfileLedgerFindings(dir), [], "ledgers agree — the residual risk (a version the registry lacks) is reported, see the --fix output contract");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: phantom spec + REAL newer copy — manifest AND lockfile converge (all three rungs clear)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-c-"));
    try {
        const dir = makeProfile(root, "full", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        // copy-vs-manifest is the no-lockfile rung — with a lock present, two rungs fire.
        assert.deepEqual(dshProfileLedgerFindings(dir).map((f) => f.kind), ["copy-vs-lock", "manifest-vs-lock"]);
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual([...res.changed].sort(), ["package.json", "pnpm-lock.yaml"]);
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        assert.equal(manifest.dependencies["billion-context"], "^0.1.197");
        assert.equal(manifest.dependencies["other-dep"], "^1.2.3", "unrelated deps survive");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^0\.1\.197/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: healthy triple — ZERO writes, byte-identical files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-d-"));
    try {
        const dir = makeProfile(root, "healthy", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.197", "0.1.197") });
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, []);
        assert.deepEqual(res.details, []);
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: healthy triple with a pnpm peer suffix on the lock version — no finding, ZERO writes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-peer-a-"));
    try {
        // `version: 0.1.197(@types/node@16.9.1)` IS v0.1.197 — the suffix names
        // the peer set, not a different version. Reading it as one made every
        // such profile a permanent copy-vs-lock finding, and made convergence
        // strip the suffix (pointing the importer at a snapshots key that does
        // not exist).
        const dir = makeProfile(root, "peer", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9Peer("^0.1.197", "0.1.197") });
        assert.equal(readDshLedgerState(dir).lockVersion, "0.1.197", "the peer suffix is not part of the resolved version");
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, []);
        assert.deepEqual(res.details, []);
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: peer-suffixed lock version — real drift swaps the version part only, the suffix survives", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-peer-b-"));
    try {
        const dir = makeProfile(root, "peerdrift", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9Peer("^0.1.196", "0.1.196") });
        const findings = dshProfileLedgerFindings(dir);
        assert.deepEqual(findings.map((f) => f.kind), ["copy-vs-lock", "manifest-vs-lock"]);
        assert.equal(findings[0]!.lockVersion, "0.1.196", "findings name the version, not the peer set");
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"]);
        assert.deepEqual(res.details.map((d) => [d.field, d.before, d.after]), [
            ["specifier", "^0.1.196", "^0.1.197"],
            ["version", "0.1.196(@types/node@16.9.1)", "0.1.197(@types/node@16.9.1)"],
            ["snapshots: billion-context@0.1.197(@types/node@16.9.1)", "(missing)", "cloned from billion-context@0.1.196(@types/node@16.9.1)"],
            ["packages: billion-context@0.1.197", "(missing)", "cloned from billion-context@0.1.196"],
        ]);
        const after = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        // The two billion-context importer lines move (the version keeps its
        // peer suffix); the store sections gain the new version's entries so
        // the importer resolves — the old entries are kept.
        assert.match(after, /specifier: \^0\.1\.197/);
        assert.match(after, /version: 0\.1\.197\(@types\/node@16\.9\.1\)/);
        assert.ok(after.includes("  billion-context@0.1.197(@types/node@16.9.1):"), "new suffixed snapshots entry");
        assert.match(after, /  billion-context@0\.1\.197:\n    resolution: \{integrity: sha512-new==\}/, "new bare packages entry carries the new hash");
        assert.ok(after.includes("  billion-context@0.1.196(@types/node@16.9.1):"), "old suffixed snapshots entry is kept");
        assert.ok(after.includes("  billion-context@0.1.196:"), "old bare packages entry is kept");
        assert.ok(after.includes("        version: 1.2.3(@types/node@16.9.1)"), "another dependency's suffixed version is not ours to touch");
        assert.deepEqual(dshProfileLedgerFindings(dir), [], "re-audit after convergence must be clean");
        // Second pass is a no-op: the suffixed record is already in step.
        const mt = profileMtimes(dir);
        const again = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.deepEqual(again.changed, []);
        assertZeroWrites(dir, profileFiles(dir), mt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: patchPnpmLock peer suffix — multi-peer and quoted values keep their shape; v6–v8 nested entries too", () => {
    // several peers chain their parentheses; the whole tail is the suffix
    const multi = pnpmLockV9Peer("^0.1.196", "0.1.196", "(@types/node@16.9.1)(zod@4.1.8)");
    const inStep = patchPnpmLock(multi, "^0.1.196", "0.1.196");
    assert.equal(inStep.kind, "ok");
    assert.deepEqual(inStep.kind === "ok" ? inStep.details : undefined, [], "same version + suffix is in step — no details, so no write");
    const moved = patchPnpmLock(multi, "^0.1.196", "0.1.197");
    assert.equal(moved.kind, "ok");
    if (moved.kind === "ok") {
        assert.ok(moved.next.includes("        version: 0.1.197(@types/node@16.9.1)(zod@4.1.8)\n"));
        assert.deepEqual(moved.details.map((d) => [d.field, d.before, d.after]), [
            ["version", "0.1.196(@types/node@16.9.1)(zod@4.1.8)", "0.1.197(@types/node@16.9.1)(zod@4.1.8)"],
        ]);
    }
    // a quoted value keeps its quotes
    const quoted = pnpmLockV9Peer("^0.1.196", "0.1.196").replace("version: 0.1.196(@types/node@16.9.1)", "version: '0.1.196(@types/node@16.9.1)'");
    const q = patchPnpmLock(quoted, "^0.1.196", "0.1.197");
    assert.equal(q.kind, "ok");
    if (q.kind === "ok") assert.ok(q.next.includes("        version: '0.1.197(@types/node@16.9.1)'\n"));
    // v6–v8: nested entries under the top-level dependencies map carry the same suffix form
    const v6 = pnpmLockV6("^0.1.196", "0.1.196").replace("    version: 0.1.196", "    version: 0.1.196(@types/node@16.9.1)");
    const v6Same = patchPnpmLock(v6, "^0.1.196", "0.1.196");
    assert.deepEqual(v6Same.kind === "ok" ? v6Same.details : undefined, []);
    const v6Moved = patchPnpmLock(v6, "^0.1.196", "0.1.197");
    assert.equal(v6Moved.kind, "ok");
    if (v6Moved.kind === "ok") assert.ok(v6Moved.next.includes("    version: 0.1.197(@types/node@16.9.1)\n"));
});

test("#3496: flat pnpm ≤5.4 lockfile converges both same-line sections", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-e-"));
    try {
        const dir = makeProfile(root, "flat", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockFlat("^0.1.196", "0.1.196") });
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /^  billion-context: \^0\.1\.197$/m, "specifiers section");
        assert.match(lock.replace(/^  billion-context: \^0\.1\.197$/m, ""), /^  billion-context: 0\.1\.197$/m, "dependencies section");
        assert.match(lock, /^  other-dep: \^1\.2\.3$/m);
        assert.match(lock, /^  other-dep: 1\.2\.3$/m);
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: pnpm v6–v8 top-level nested lockfile converges", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-f-"));
    try {
        const dir = makeProfile(root, "v6", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV6("^0.1.196", "0.1.196") });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^0\.1\.197/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.match(lock, /\/billion-context\/0\.1\.196:/, "old packages entry is kept");
        assert.match(lock, /\/billion-context\/0\.1\.197:\n    resolution: \{integrity: sha512-new==\}/, "new packages entry carries the new hash");
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: npm package-lock.json converges — spec mirror, version, resolved swap, stale integrity dropped", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-g-"));
    try {
        const dir = makeProfile(root, "npm", { spec: "^1.2.9", copyVersion: "0.1.197", npmLock: npmLock("^0.1.196", "0.1.196") });
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["package.json", "package-lock.json"]);
        const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8")) as {
            packages: Record<string, { version?: string; dependencies?: Record<string, string>; resolved?: string; integrity?: string }>;
        };
        assert.equal(lock.packages[""]!.dependencies?.["billion-context"], "^0.1.197");
        const entry = lock.packages["node_modules/billion-context"]!;
        assert.equal(entry.version, "0.1.197");
        assert.equal(entry.resolved, "https://registry.npmjs.org/billion-context/-/billion-context-0.1.197.tgz");
        assert.equal(entry.integrity, undefined, "the displaced version's hash cannot be verified offline — drop it, let npm re-fetch");
        assert.deepEqual(lock.packages["node_modules/other-dep"], { version: "1.2.3" });
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: deliberate local pin — respected, zero writes, detection silent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-h-"));
    try {
        const dir = makeProfile(root, "pinned", { spec: "link:/somewhere/dev", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        assert.deepEqual(dshProfileLedgerFindings(dir), [], "pins are outside detection by design");
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, []);
        assert.ok(res.notes.some((n) => n.includes("local pin")));
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: dist-tag spec rides along — declaration kept, lockfile converges", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-i-"));
    try {
        const dir = makeProfile(root, "disttag", { spec: "latest", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const before = profileFiles(dir);
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"]);
        assert.equal(readFileSync(path.join(dir, "package.json"), "utf8"), before["package.json"], "'latest' is the user's declaration — never rewritten");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: latest/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: admitting range spec — kept, lockfile converges, quoted YAML round-trips", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-j-"));
    try {
        const dir = makeProfile(root, "range", { spec: ">=0.1.0", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: ">=0\.1\.0"/, "leading '>' is a YAML block indicator — must be quoted");
        assert.equal(readDshLedgerState(dir).lockSpecifier, ">=0.1.0", "the reader strips the quotes back off");
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: bare `*` spec — quoted in the lockfile (YAML alias indicator), round-trips", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-u-"));
    try {
        const dir = makeProfile(root, "star", { spec: "*", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: "\*"/, "a leading '*' would parse as a YAML alias token — must be quoted");
        assert.equal(readDshLedgerState(dir).lockSpecifier, "*", "the reader strips the quotes back off");
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: tilde spec that does NOT admit the copy — REFUSED, zero writes, finding stays visible", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-k-"));
    try {
        const dir = makeProfile(root, "tilde", { spec: "~1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.ok(res.error?.includes("rewrite authority"), `expected refusal, got: ${res.error}`);
        assertZeroWrites(dir, before, beforeMt);
        assert.ok(dshProfileLedgerFindings(dir).length > 0, "an unsatisfied declaration must stay reported, not papered over");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: exact-style spec keeps exact style when converged", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-l-"));
    try {
        const dir = makeProfile(root, "exact", { spec: "0.1.190", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("0.1.190", "0.1.190") });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        assert.equal(manifest.dependencies["billion-context"], "0.1.197", "no caret invented where the user declared none");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: 0\.1\.197/);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: no lockfile + copy-vs-manifest wedge — manifest converges alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-m-"));
    try {
        const dir = makeProfile(root, "nolock", { spec: "^1.2.9", copyVersion: "0.1.197" });
        assert.deepEqual(dshProfileLedgerFindings(dir).map((f) => f.kind), ["copy-vs-manifest"]);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["package.json"]);
        assert.ok(res.notes.some((n) => n.includes("no lockfile")));
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: corrupt manifest — clean failure, nothing written anywhere", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-n-"));
    try {
        const dir = makeProfile(root, "corrupt", { manifestRaw: "{ not json", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197");
        assert.ok(res.error !== undefined);
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: moving-target guard — copy ≠ requested version refuses", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-o-"));
    try {
        const dir = makeProfile(root, "moving", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "9.9.9");
        assert.ok(res.error?.includes("moving target"));
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: desktop gating — detection excludes by default, includeDesktop reaches it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-p-"));
    try {
        const dir = makeProfile(root, "desktop", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        assert.deepEqual(dshProfileLedgerFindings(dir), [], "#3224 option A: the in-place writer's lane stays out of passive detection");
        const kinds = dshProfileLedgerFindings(dir, { includeDesktop: true }).map((f) => f.kind);
        assert.deepEqual(kinds, ["copy-vs-lock", "manifest-vs-lock"]);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

// — #7125: the store sections must move with the importer record ——————————————————

test("#7125: broken lockfile on the desktop profile (importer moved, store not) — invisible to passive detection, repaired by --fix", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-a-"));
    try {
        // The exact #7125 shape: the importer record points at 0.1.197 but the
        // store sections still only hold 0.1.196 — what the pre-fix auto-update
        // left behind.
        const brokenLock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.197",
            "        version: 0.1.197",
            "      other-dep:",
            "        specifier: ^1.2.3",
            "        version: 1.2.3",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "desktop", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: brokenLock });
        // The record and its resolution data disagree — detected by state read…
        const state = readDshLedgerState(dir);
        assert.equal(state.lockVersion, "0.1.197");
        assert.equal(state.lockStoreBroken, true, "the store sections lack the recorded version's entries");
        // …and by the audit, but ONLY when the desktop profile is included
        // (#3224 option A: the in-place writer's lane stays out of passive detection).
        assert.deepEqual(dshProfileLedgerFindings(dir), []);
        assert.deepEqual(dshProfileLedgerFindings(dir, { includeDesktop: true }).map((f) => f.kind), ["lockfile-internal"]);
        // Converging repairs the store WITHOUT moving the importer (already at the target).
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"], "only the lockfile changes — manifest and importer are already in step");
        assert.ok(res.details.some((d) => d.field === "snapshots: billion-context@0.1.197" && d.before === "(missing)"));
        assert.ok(res.details.some((d) => d.field === "packages: billion-context@0.1.197" && d.before === "(missing)"));
        assert.ok(!res.details.some((d) => d.field === "specifier" || d.field === "version"), "the importer is untouched");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /billion-context@0\.1\.197:\n    resolution: \{integrity: sha512-new==\}/);
        assert.match(lock, /billion-context@0\.1\.197: \{\}/);
        assert.match(lock, /billion-context@0\.1\.196:/, "the old store entry is kept");
        // Re-audit (includeDesktop) is clean: the record and its resolution data now agree.
        assert.deepEqual(dshProfileLedgerFindings(dir, { includeDesktop: true }), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: converge without the new integrity fails soft when the source entry carries one — zero writes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-b-"));
    try {
        const dir = makeProfile(root, "nohash", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197"); // no integrity
        assert.ok(res.error !== undefined, "the source entry's hash cannot be reused for the new version");
        assert.ok(res.error!.includes("integrity"), "the failure names the missing integrity");
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: dep-map cross-check — declared dep resolved from the store, undeclared dep dropped", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-c-"));
    try {
        // The 0.1.196 snapshots entry carries a dep map (other-dep); the on-disk
        // copy (0.1.197) declares some-dep instead. The store holds a unique
        // some-dep entry to resolve it from.
        const lock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.196",
            "        version: 0.1.196",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196:",
            "    dependencies:",
            "      other-dep: 1.2.3",
            "",
            "  some-dep@1.0.0: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "deps", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: lock, copyDeps: { dependencies: { "some-dep": "^1.0.0" } } });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined);
        const out = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        const count = (s: string, sub: string): number => s.split(sub).length - 1;
        assert.equal(count(out, "other-dep: 1.2.3"), 1, "the undeclared dep is dropped from the cloned entry (kept only in the old one)");
        assert.equal(count(out, "some-dep: 1.0.0"), 1, "the declared dep is resolved from the store and added once");
        assert.match(out, /billion-context@0\.1\.197:\n    dependencies:\n      some-dep: 1\.0\.0/);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: dep-map cross-check — an ambiguous store entry fails soft, zero writes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-d-"));
    try {
        const lock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.196",
            "        version: 0.1.196",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196:",
            "    dependencies:",
            "      other-dep: 1.2.3",
            "",
            "  some-dep@1.0.0: {}",
            "",
            "  some-dep@2.0.0: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "ambig", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: lock, copyDeps: { dependencies: { "some-dep": "^1.0.0" } } });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.ok(res.error !== undefined, "two store candidates for some-dep — cannot pick one");
        assert.ok(res.error!.includes("some-dep"));
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: dep-map cross-check — a surviving entry whose resolution contradicts the new declaration fails soft, zero writes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-e-"));
    try {
        // The 0.1.196 snapshot resolved zod to 4.1.8; the on-disk copy
        // (0.1.197) declares EXACT 4.6.7 — the dependency's spec changed
        // between versions without the name or bucket moving. Cloning the old
        // resolution would record a dep the new manifest contradicts (a frozen
        // install would faithfully install the wrong zod), so the patch must
        // refuse instead.
        const lock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.196",
            "        version: 0.1.196",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196:",
            "    dependencies:",
            "      zod: 4.1.8",
            "",
            "  zod@4.1.8: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "depchange", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: lock, copyDeps: { dependencies: { zod: "4.6.7" } } });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.ok(res.error !== undefined, "a contradicting cloned resolution must fail the patch");
        assert.ok(res.error!.includes("zod"), `reason must name the dep: ${res.error}`);
        assert.ok(res.error!.includes("4.1.8") && res.error!.includes("4.6.7"), `reason must carry both versions: ${res.error}`);
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: dep-map cross-check — a surviving entry whose resolution SATISFIES the new declaration clones through", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-f-"));
    try {
        // Negative gate: the range spec still admits the old resolution — no
        // false positive, the clone proceeds as before.
        const lock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.196",
            "        version: 0.1.196",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196:",
            "    dependencies:",
            "      mysql2: 3.15.5",
            "",
            "  mysql2@3.15.5: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "depsat", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: lock, copyDeps: { dependencies: { mysql2: "^3.15.3" } } });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined, `satisfying resolution must not fail the patch: ${res.error}`);
        const out = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(out, /billion-context@0\.1\.197:\n    dependencies:\n      mysql2: 3\.15\.5/);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#7125: dep-map cross-check — an unjudgeable declared spec (dist-tag) stays silent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i7125-g-"));
    try {
        // Same "err on fewer false positives" discipline as specAdmits: a
        // dist-tag declaration cannot be semver-checked, so the clone
        // proceeds as before.
        const lock = [
            "lockfileVersion: '9.0'",
            "",
            "settings:",
            "  autoInstallPeers: true",
            "  excludeLinksFromLockfile: false",
            "",
            "importers:",
            "",
            "  .:",
            "    dependencies:",
            "      billion-context:",
            "        specifier: ^0.1.196",
            "        version: 0.1.196",
            "",
            "packages:",
            "",
            "  billion-context@0.1.196:",
            "    resolution: {integrity: sha512-fake==}",
            "",
            "snapshots:",
            "",
            "  billion-context@0.1.196:",
            "    dependencies:",
            "      some-dep: 2.0.0",
            "",
            "  some-dep@2.0.0: {}",
            "",
        ].join("\n");
        const dir = makeProfile(root, "deptest", { spec: "^0.1.196", copyVersion: "0.1.197", pnpmLock: lock, copyDeps: { dependencies: { "some-dep": "latest" } } });
        const res = convergeDshLedger(dir, "0.1.197", { integrity: "sha512-new==" });
        assert.equal(res.error, undefined, `unjudgeable spec must not fail the patch: ${res.error}`);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

// — pure patchers ————————————————————————————————————————————————————————————————

test("#3496: patchPnpmLock structural failures — no partial result", () => {
    const broken = [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      billion-context:",
        "        specifier: ^1.2.9",
        "",
    ].join("\n");
    const r1 = patchPnpmLock(broken, "^0.1.197", "0.1.197");
    assert.equal(r1.kind, "fail");
    assert.ok(r1.kind === "fail" && r1.reason.includes("lacks both"));

    const missing = ["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:", "      other-dep:", "        specifier: ^1.2.3", "        version: 1.2.3", ""].join("\n");
    const r2 = patchPnpmLock(missing, "^0.1.197", "0.1.197");
    assert.equal(r2.kind, "fail");
    assert.ok(r2.kind === "fail" && r2.reason.includes("no billion-context entry"));
});

for (const field of ["specifier", "version"] as const) {
    test(`patchPnpmLock rejects a devDependency missing ${field} after a valid dependency`, () => {
        const broken = pnpmLockV6("^0.1.196", "0.1.196") + [
            "devDependencies:",
            "  billion-context:",
            field === "specifier" ? "    version: 0.1.196" : "    specifier: ^0.1.196",
            "",
        ].join("\n");
        const result = patchPnpmLock(broken, "^0.1.197", "0.1.197");
        assert.equal(result.kind, "fail");
        assert.ok(result.kind === "fail" && result.reason.includes("lacks both"));
    });
}

test("ledger convergence leaves every file untouched when a later pnpm section is malformed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-ledger-partial-"));
    try {
        const broken = pnpmLockV6("^0.1.196", "0.1.196") + [
            "devDependencies:",
            "  billion-context:",
            "    specifier: ^0.1.196",
            "",
        ].join("\n");
        const dir = makeProfile(root, "partial", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: broken });
        const before = profileFiles(dir);
        const beforeMt = profileMtimes(dir);
        const result = convergeDshLedger(dir, "0.1.197");
        assert.match(result.error ?? "", /lacks both/);
        assert.deepEqual(result.changed, []);
        assert.deepEqual(result.details, []);
        assertZeroWrites(dir, before, beforeMt);
    } finally {
        rmrf(root);
    }
});

test("patchPnpmLock accepts a later section containing only unrelated dependencies", () => {
    const lock = pnpmLockV6("^0.1.196", "0.1.196") + [
        "devDependencies:",
        "  other-dev:",
        "    specifier: ^2.0.0",
        "    version: 2.0.0",
        "",
    ].join("\n");
    const result = patchPnpmLock(lock, "^0.1.197", "0.1.197");
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
        assert.match(result.next, /specifier: \^0\.1\.197\n    version: 0\.1\.197/);
        assert.ok(result.next.endsWith(lock.slice(lock.indexOf("devDependencies:"))));
    }
});

test("#3496: patchNpmLock without the node_modules entry fails cleanly", () => {
    const r = patchNpmLock(JSON.stringify({ packages: { "": { dependencies: { "billion-context": "^1.2.9" } } } }), "^0.1.197", "0.1.197");
    assert.equal(r.kind, "fail");
    assert.ok(r.kind === "fail" && r.reason.includes("no node_modules/billion-context entry"));
});

test("#3496: specAdmits — caret/tilde/exact, loose ^0.x, unjudgeable stays silent", () => {
    assert.equal(specAdmits("^0.1.196", "0.1.197"), true);
    assert.equal(specAdmits("^0.1.196", "0.1.196"), true);
    assert.equal(specAdmits("^0.1.196", "1.0.0"), false);
    assert.equal(specAdmits("~1.2.9", "1.2.15"), true);
    assert.equal(specAdmits("~1.2.9", "1.3.0"), false);
    assert.equal(specAdmits("0.1.196", "0.1.197"), false);
    assert.equal(specAdmits("^0.1.0", "0.9.9"), true, "deliberately loose: gates a warning, errs fewer");
    assert.equal(specAdmits("latest", "0.1.197"), undefined);
    assert.equal(specAdmits(">=0.1.0", "0.1.197"), undefined);
    assert.equal(specAdmits("link:/x", "0.1.197"), undefined);
});

// — bili doctor --fix surface ———————————————————————————————————————————————————————

test("#3496: fixDshLedgers walks every profile, fixes only the drifted, leaves the rest byte-identical", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-q-"));
    try {
        const wedged = makeProfile(root, "wedged", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const healthy = makeProfile(root, "healthy", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.197", "0.1.197") });
        const pinned = makeProfile(root, "pinned", { spec: "link:/dev/x", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const beforeHealthy = profileFiles(healthy);
        const beforePinned = profileFiles(pinned);
        const beforeHealthyMt = profileMtimes(healthy);
        const beforePinnedMt = profileMtimes(pinned);

        const rows = await fixDshLedgers({ ...process.env, DSH_HOME: root }, { fetchVersionDoc: async () => ({ integrity: "sha512-test==" }) });
        assert.deepEqual(rows.map((r) => r.profile), ["wedged"]);
        const row = rows[0]!;
        assert.deepEqual([...row.changed].sort(), ["package.json", "pnpm-lock.yaml"]);
        assert.ok(row.details.some((d) => d.file === "package.json" && d.before === "^1.2.9" && d.after === "^0.1.197"));
        assert.ok(row.details.some((d) => d.field === "packages: billion-context@0.1.197"), "the store section is synced so the importer resolves (#7125)");
        assert.deepEqual(row.residualFindings, [], "re-verification after the fix must be clean");
        assert.equal(row.error, undefined);
        assertZeroWrites(healthy, beforeHealthy, beforeHealthyMt);
        assertZeroWrites(pinned, beforePinned, beforePinnedMt);
        assert.deepEqual(dshProfileLedgerFindings(wedged, { includeDesktop: true }), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: fixDshLedgers refuses (with a visible reason) when the spec is outside rewrite authority", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-r-"));
    try {
        makeProfile(root, "tilde", { spec: "~1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const rows = await fixDshLedgers({ ...process.env, DSH_HOME: root }, { fetchVersionDoc: async () => ({ integrity: "sha512-test==" }) });
        assert.equal(rows.length, 1);
        assert.ok(rows[0]!.error?.includes("rewrite authority"));
        assert.ok(rows[0]!.residualFindings.length > 0, "the drift stays reported until the human aligns the declaration");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: fixDshLedgers fail-soft — dsh home absent or empty yields no rows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-s-"));
    try {
        assert.deepEqual(await fixDshLedgers({ ...process.env, DSH_HOME: path.join(root, "never-existed") }), []);
        mkdirSync(path.join(root, "empty-home", "profiles"), { recursive: true });
        assert.deepEqual(await fixDshLedgers({ ...process.env, DSH_HOME: path.join(root, "empty-home") }), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: renderLedgerFixReport prints every change and never claims false success", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-t-"));
    try {
        assert.match(renderLedgerFixReport([]), /nothing written/);
        makeProfile(root, "wedged", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const rows = await fixDshLedgers({ ...process.env, DSH_HOME: root }, { fetchVersionDoc: async () => ({ integrity: "sha512-test==" }) });
        const text = renderLedgerFixReport(rows);
        assert.match(text, /wedged/);
        assert.match(text, /converged/);
        assert.match(text, /\^1\.2\.9 → \^0\.1\.197/, "before→after must be printed for the explicit-trigger contract");
        assert.match(text, /provenance/, "lockfile-moved rows carry the phantom-copy caution");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});
