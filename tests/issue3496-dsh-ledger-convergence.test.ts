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
        writeFileSync(path.join(copyDir, "package.json"), JSON.stringify({ name: "billion-context", version: opts.copyVersion }) + "\n");
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
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"]);
        assert.deepEqual(res.details.map((d) => [d.field, d.before, d.after]), [
            ["specifier", "^0.1.196", "^0.1.197"],
            ["version", "0.1.196", "0.1.197"],
        ]);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^0\.1\.197/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.ok(lock.includes("billion-context@0.1.196:"), "store bookkeeping sections stay untouched — pnpm reconciles them itself");
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
        const res = convergeDshLedger(dir, "1.2.9");
        assert.equal(res.error, undefined);
        assert.deepEqual(res.changed, ["pnpm-lock.yaml"], "the declaration ADMITS the copy — bili keeps it, converges the record");
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^1\.2\.9/);
        assert.match(lock, /version: 1\.2\.9/);
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
        const res = convergeDshLedger(dir, "0.1.197");
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
        const res = convergeDshLedger(dir, "0.1.197");
        assert.equal(res.error, undefined);
        const lock = readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
        assert.match(lock, /specifier: \^0\.1\.197/);
        assert.match(lock, /version: 0\.1\.197/);
        assert.match(lock, /\/billion-context\/0\.1\.196:/, "packages map untouched");
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
        const res = convergeDshLedger(dir, "0.1.197");
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
        const res = convergeDshLedger(dir, "0.1.197");
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
        const res = convergeDshLedger(dir, "0.1.197");
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
        const res = convergeDshLedger(dir, "0.1.197");
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

test("#3496: fixDshLedgers walks every profile, fixes only the drifted, leaves the rest byte-identical", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-q-"));
    try {
        const wedged = makeProfile(root, "wedged", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const healthy = makeProfile(root, "healthy", { spec: "^0.1.197", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.197", "0.1.197") });
        const pinned = makeProfile(root, "pinned", { spec: "link:/dev/x", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const beforeHealthy = profileFiles(healthy);
        const beforePinned = profileFiles(pinned);
        const beforeHealthyMt = profileMtimes(healthy);
        const beforePinnedMt = profileMtimes(pinned);

        const rows = fixDshLedgers({ ...process.env, DSH_HOME: root });
        assert.deepEqual(rows.map((r) => r.profile), ["wedged"]);
        const row = rows[0]!;
        assert.deepEqual([...row.changed].sort(), ["package.json", "pnpm-lock.yaml"]);
        assert.ok(row.details.some((d) => d.file === "package.json" && d.before === "^1.2.9" && d.after === "^0.1.197"));
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

test("#3496: fixDshLedgers refuses (with a visible reason) when the spec is outside rewrite authority", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-r-"));
    try {
        makeProfile(root, "tilde", { spec: "~1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const rows = fixDshLedgers({ ...process.env, DSH_HOME: root });
        assert.equal(rows.length, 1);
        assert.ok(rows[0]!.error?.includes("rewrite authority"));
        assert.ok(rows[0]!.residualFindings.length > 0, "the drift stays reported until the human aligns the declaration");
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: fixDshLedgers fail-soft — dsh home absent or empty yields no rows", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-s-"));
    try {
        assert.deepEqual(fixDshLedgers({ ...process.env, DSH_HOME: path.join(root, "never-existed") }), []);
        mkdirSync(path.join(root, "empty-home", "profiles"), { recursive: true });
        assert.deepEqual(fixDshLedgers({ ...process.env, DSH_HOME: path.join(root, "empty-home") }), []);
    } finally {
        rmrf(root);
        rmrf(__cacheRoot);
    }
});

test("#3496: renderLedgerFixReport prints every change and never claims false success", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-i3496-t-"));
    try {
        assert.match(renderLedgerFixReport([]), /nothing written/);
        makeProfile(root, "wedged", { spec: "^1.2.9", copyVersion: "0.1.197", pnpmLock: pnpmLockV9("^0.1.196", "0.1.196") });
        const rows = fixDshLedgers({ ...process.env, DSH_HOME: root });
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
