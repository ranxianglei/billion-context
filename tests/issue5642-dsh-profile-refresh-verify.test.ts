// #5642: the channel refresh must trust what the host package operation
// actually left behind, not its exit code. A desktop host's lifecycle can
// wipe a profile's node_modules while `dsh plugin … add` still exits clean —
// the old code counted that as success and re-spawned the same destructive
// op on every check cycle (reporter logs: two runs ~5h apart, each followed
// by an emptied node_modules). Now: exit-0 only counts when the copy is
// readable AT TARGET, and a copy that went readable→unreadable is remembered
// in the advisory .dsh-profile-copies.json ledger — one loud warning with a
// manual-repair command, then silent skips until the profile is repaired.
// Genuinely fresh declared-but-missing profiles still get the #1196 install
// path; the #1803 in-step skip is unchanged.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DSH_PACKAGE, _resetProfileCopyLedgerForTest, _setDshRunnersForTest, refreshDshProfileBundles } from "../src/dsh-channel.ts";
import type { DshPlan } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue5642-")));
const prevXdgCacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = path.join(root, "cache");

after(() => {
    if (prevXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevXdgCacheHome;
    _resetProfileCopyLedgerForTest();
    rmrf(root);
});

function ledgerFile(): string {
    return path.join(process.env.XDG_CACHE_HOME!, "billion-context", ".dsh-profile-copies.json");
}

function readLedger(): Record<string, unknown> {
    try {
        const doc = JSON.parse(fs.readFileSync(ledgerFile(), "utf-8")) as { v?: unknown; copies?: Record<string, unknown> };
        return doc.copies ?? {};
    } catch {
        return {};
    }
}

function installedVersion(profileDir: string): string | undefined {
    try {
        return (JSON.parse(fs.readFileSync(path.join(profileDir, "node_modules", DSH_PACKAGE, "package.json"), "utf-8")) as { version?: string }).version;
    } catch {
        return undefined;
    }
}

function makeHome(profiles: string[]): { home: string; dirs: Record<string, string> } {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const dirs: Record<string, string> = {};
    for (const name of profiles) {
        const dir = path.join(home, "profiles", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { [DSH_PACKAGE]: "^1.0.0" } }));
        dirs[name] = dir;
    }
    return { home, dirs };
}

function installCopy(profileDir: string, version: string): void {
    const copy = path.join(profileDir, "node_modules", DSH_PACKAGE);
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: DSH_PACKAGE, version }));
}

/** Test double for the dsh CLI. mode "materialize" mirrors the real channel
 *  leaving the requested copy readable (landingVersion overrides the request
 *  to simulate a divergent resolution); "destroy" mirrors a host lifecycle
 *  that exits clean but empties the profile's node_modules; "nothing"
 *  simulates an op that changes nothing. */
function runner(home: string, calls: string[], opts: { mode?: "materialize" | "destroy" | "nothing"; landingVersion?: string } = {}): (plan: DshPlan) => Promise<{ stdout: string; stderr: string }> {
    const mode = opts.mode ?? "materialize";
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        calls.push(tokens.join(" "));
        const name = tokens[tokens.indexOf("--profile") + 1];
        const dir = path.join(home, "profiles", name);
        if (mode === "destroy") {
            fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
        } else if (mode === "materialize") {
            const spec = tokens[tokens.length - 1];
            const requested = spec.startsWith(`${DSH_PACKAGE}@`) ? spec.slice(`${DSH_PACKAGE}@`.length) : undefined;
            installCopy(dir, opts.landingVersion ?? requested ?? "0.0.0");
        }
        return { stdout: "", stderr: "" };
    };
}

function makeLog(): { log: (level: "info" | "warn", msg: string) => void; entries: string[] } {
    const entries: string[] = [];
    return { log: (level, msg) => { entries.push(`${level}\t${msg}`); }, entries };
}

test("exit-0 + copy readable at target counts as success (behavior preserved)", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log, entries } = makeLog();
        const r = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r, { refreshed: 1, failed: 0 });
        assert.deepEqual(calls, [`plugin --profile a add ${DSH_PACKAGE}@2.0.0`]);
        assert.equal(installedVersion(dirs.a), "2.0.0");
        const entry = readLedger()[dirs.a] as { version: string; brokenAt?: number };
        assert.equal(entry.version, "2.0.0");
        assert.equal(entry.brokenAt, undefined);
        assert.ok(entries.some((l) => l.includes("refreshed 1 dsh profile bundle(s) to 2.0.0")));
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("exit-0 but the op destroyed the copy → failure, remembered, silent next cycle", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    installCopy(dirs.a, "1.0.0");
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls, { mode: "destroy" }) });
    try {
        const { log, entries } = makeLog();
        const r1 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r1, { refreshed: 0, failed: 1 });
        assert.equal(calls.length, 1);
        const w1 = entries.filter((l) => l.startsWith("warn"));
        assert.equal(w1.length, 1);
        assert.ok(w1[0].includes("exited clean but the copy is now missing"));
        const entry = readLedger()[dirs.a] as { version: string; brokenAt?: number };
        assert.equal(entry.version, "1.0.0", "last known good version remembered");
        assert.ok(entry.brokenAt !== undefined, "destruction remembered");
        const r2 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r2, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1, "no second spawn against a damaged profile");
        assert.equal(entries.filter((l) => l.startsWith("warn")).length, 1, "no repeated warnings");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("copy destroyed between cycles → ONE loud warning with manual-repair command, then silence", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log, entries } = makeLog();
        await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 1);
        fs.rmSync(path.join(dirs.a, "node_modules"), { recursive: true, force: true });
        const r2 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r2, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1, "no spawn against a destroyed profile");
        const warns = entries.filter((l) => l.startsWith("warn"));
        assert.equal(warns.length, 1);
        assert.ok(warns[0].includes("billion-context was 2.0.0"));
        assert.ok(warns[0].includes("Leaving the profile untouched"));
        assert.ok(warns[0].includes(`dsh plugin --profile a add ${DSH_PACKAGE}@2.0.0`));
        const r3 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r3, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1);
        assert.equal(entries.filter((l) => l.startsWith("warn")).length, 1, "warning fires exactly once");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("fresh declared-but-missing profile (never observed) still gets the channel op", async () => {
    _resetProfileCopyLedgerForTest();
    const { home } = makeHome(["a"]);
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls, { mode: "nothing" }) });
    try {
        const { log, entries } = makeLog();
        const r1 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 1, "op still attempted for a never-seen profile (#1196)");
        assert.deepEqual(r1, { refreshed: 0, failed: 1 }, "honest failure — nothing landed");
        assert.ok(!entries.some((l) => l.includes("Leaving the profile untouched")), "no false-positive destruction gate");
        const r2 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 2, "still retried next cycle — the caller's backoff paces it (#2192)");
        assert.deepEqual(r2, { refreshed: 0, failed: 1 });
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("repaired profile resumes normally and the destruction marker clears (logged exactly once)", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log, entries } = makeLog();
        await refreshDshProfileBundles("2.0.0", log, env);
        fs.rmSync(path.join(dirs.a, "node_modules"), { recursive: true, force: true });
        await refreshDshProfileBundles("2.0.0", log, env);
        installCopy(dirs.a, "2.0.0");
        const r3 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r3, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1, "in-step after repair — no spawn");
        const infos = entries.filter((l) => l.includes("readable again (2.0.0)"));
        assert.equal(infos.length, 1, "repair noted exactly once");
        const entry = readLedger()[dirs.a] as { version: string; brokenAt?: number };
        assert.equal(entry.version, "2.0.0");
        assert.equal(entry.brokenAt, undefined, "marker cleared");
        const r4 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r4, { refreshed: 0, failed: 0 });
        assert.equal(entries.filter((l) => l.includes("readable again (2.0.0)")).length, 1, "marker does not linger after a same-version repair");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("exit-0 but the wrong version landed → failure, honest state recorded, retry next cycle", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    installCopy(dirs.a, "1.0.0");
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls, { mode: "materialize", landingVersion: "9.9.9" }) });
    try {
        const { log, entries } = makeLog();
        const r1 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r1, { refreshed: 0, failed: 1 });
        const w = entries.filter((l) => l.startsWith("warn"));
        assert.equal(w.length, 1);
        assert.ok(w[0].includes("the copy is now 9.9.9 (expected 2.0.0)"));
        const entry = readLedger()[dirs.a] as { version: string; brokenAt?: number };
        assert.equal(entry.version, "9.9.9", "honest observed state — not the request");
        assert.equal(entry.brokenAt, undefined);
        const r2 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 2, "stale copy keeps being refreshed (paced by caller backoff)");
        assert.deepEqual(r2, { refreshed: 0, failed: 1 });
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("ledger prunes profiles that stop declaring bili (keeps the rest)", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a", "b"]);
    installCopy(dirs.a, "1.0.0");
    installCopy(dirs.b, "1.0.0");
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log } = makeLog();
        await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 2);
        assert.ok(Object.keys(readLedger()).includes(dirs.a));
        assert.ok(Object.keys(readLedger()).includes(dirs.b));
        const manifestA = JSON.parse(fs.readFileSync(path.join(dirs.a, "package.json"), "utf-8")) as { dependencies: Record<string, string> };
        delete manifestA.dependencies[DSH_PACKAGE];
        fs.writeFileSync(path.join(dirs.a, "package.json"), JSON.stringify(manifestA));
        await refreshDshProfileBundles("2.0.0", log, env);
        const copies = readLedger();
        assert.ok(!Object.keys(copies).includes(dirs.a), "unmanaged profile pruned");
        assert.ok(Object.keys(copies).includes(dirs.b), "still-managed profile kept");
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("corrupt ledger file fails open — refresh proceeds and the file is rewritten valid", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.writeFileSync(ledgerFile(), "{not json!!");
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log } = makeLog();
        const r = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r, { refreshed: 1, failed: 0 });
        assert.equal(calls.length, 1);
        const doc = JSON.parse(fs.readFileSync(ledgerFile(), "utf-8")) as { v: number; copies: Record<string, unknown> };
        assert.equal(doc.v, 1);
        assert.ok(Object.keys(doc.copies).includes(dirs.a));
    } finally {
        _setDshRunnersForTest(undefined);
    }
});

test("in-step observation keeps the entry alive past the TTL, so a later destruction stays remembered", async () => {
    _resetProfileCopyLedgerForTest();
    const { home, dirs } = makeHome(["a"]);
    const env = { ...process.env, DSH_HOME: home };
    const calls: string[] = [];
    _setDshRunnersForTest({ async: runner(home, calls) });
    try {
        const { log, entries } = makeLog();
        await refreshDshProfileBundles("2.0.0", log, env);
        assert.equal(calls.length, 1);
        // Age the entry past the 7-day TTL like steady-state weeks would, then
        // observe it in-step again: the next prune pass must keep it — forget
        // it and a later destruction looks "never observed", re-arming the
        // destructive install op (#5642).
        const doc = JSON.parse(fs.readFileSync(ledgerFile(), "utf-8")) as { v: number; copies: Record<string, { version: string; updatedAt: number }> };
        doc.copies[dirs.a].updatedAt -= 8 * 24 * 60 * 60 * 1000;
        fs.writeFileSync(ledgerFile(), JSON.stringify(doc));
        const r2 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r2, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1, "in-step — no spawn");
        const kept = (JSON.parse(fs.readFileSync(ledgerFile(), "utf-8")) as { copies: Record<string, unknown> }).copies[dirs.a];
        assert.ok(kept, "observed entry survives the TTL prune");
        fs.rmSync(path.join(dirs.a, "node_modules"), { recursive: true, force: true });
        const r3 = await refreshDshProfileBundles("2.0.0", log, env);
        assert.deepEqual(r3, { refreshed: 0, failed: 0 });
        assert.equal(calls.length, 1, "no destructive retry against a remembered profile");
        const warns = entries.filter((l) => l.startsWith("warn"));
        assert.equal(warns.length, 1);
        assert.ok(warns[0].includes("Leaving the profile untouched"));
    } finally {
        _setDshRunnersForTest(undefined);
    }
});
