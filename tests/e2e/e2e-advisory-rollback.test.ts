// E2E for #1588: rollback-form advisories against a REAL long-lived
// `bili start` + hermetic verdaccio (#1153 fixture). Proves the two halves
// of the fix end-to-end through the real watcher loops, the real forced
// install chain, the real log, and the real /__bili/status surface:
//
//   A (ping-pong): after the advisory rolls the disk back to its target, the
//      normal self-update loop must NOT pull `latest` (still inside the
//      affected range) back over it — neither while the old process still
//      runs (deferral) nor after a restart onto the clean target
//      (advisoryBlocksVersion candidate gate).
//   B (silent rollback): the restart banner must STAY up while the running
//      process still executes an affected version (disk < running leaves the
//      stale-install machinery silent), and clear once a restart lands on a
//      version outside the range.
//
// Loopback only, zero secrets, zero tokens. Gated like ACP_TEST_REGISTRY so
// plain `npm test` stays free; requires `npm run build` first.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";
import { biliSpawnEnv, isolatedEnv, npmHomeEnv, npmRunSync } from "./crossplat.ts";
import { rmrf } from "../tmp-rm.ts";

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[]; scripts?: Record<string, string> };

// Version choreography (all published to the local registry as real
// tarballs of THIS build):
//   START  = the repo version — the affected install the process starts on
//   LATEST = START+1 — registry `latest`, ALSO inside the affected range
//   TARGET = START-1 — the advisory's safe rollback version
const START = PKG.version;
const LATEST = bumpPatch(START);
const TARGET = decPatch(START);
const ADV_ID = "e2e-1588-rollback";
const ADV_AFFECTED = `>=${START} <${bumpPatch(LATEST)}`;
const ADV_REASON = "e2e rollback-form advisory (#1588)";
const CYCLE_MS = 2_500; // fast watcher cadence via BILI_UPDATE_CHECK_INTERVAL_MS

function bumpPatch(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unexpected version format: ${v}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function decPatch(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unexpected version format: ${v}`);
    if (Number(m[3]) === 0) throw new Error(`cannot derive a TARGET below ${v} (patch already 0)`);
    return `${m[1]}.${m[2]}.${Number(m[3]) - 1}`;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        });
        s.on("error", reject);
    });
}


async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

function packTarball(stage: string, packs: string, home: string): string {
    const listing = npmRunSync(["pack", "--silent", "--pack-destination", packs], { cwd: stage, env: { PATH: process.env.PATH ?? "", ...npmHomeEnv(home) } })
        .trim()
        .split("\n")
        .pop()
        ?.trim();
    return listing ?? "";
}

// Stage a publishable tarball of THIS package at a synthetic version (same
// shape as e2e-registry.test.ts's helper).
async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    // The staged copy models a PUBLISHED artifact: registry installs never run
    // prepare, and scripts/ is outside `files`, so drop the hook referencing
    // the non-shipped guard script (#2471).
    fs.writeFileSync(
        path.join(stage, "package.json"),
        `${JSON.stringify({ ...PKG, version, scripts: Object.fromEntries(Object.entries(PKG.scripts ?? {}).filter(([name]) => name !== "prepare")) }, null, 2)}\n`,
    );
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = packTarball(stage, packs, home);
    assert.ok(listing.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing);
}

// The companion advisory package: a minimal tarball whose package.json
// carries the billionContextAdvisories payload in the field the packument
// exposes (verdaccio keeps custom fields).
async function makeAdvisoryTarball(work: string): Promise<string> {
    const stage = path.join(work, "fixtures", "advisory");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(
        path.join(stage, "package.json"),
        `${JSON.stringify(
            {
                name: "billion-context-advisories",
                version: "1.0.0",
                billionContextAdvisories: {
                    schema: 1,
                    advisories: [{ id: ADV_ID, affected: ADV_AFFECTED, target: TARGET, reason: ADV_REASON }],
                },
            },
            null,
            2,
        )}\n`,
    );
    const home = path.join(work, "home-pkg");
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const listing = packTarball(stage, packs, home);
    assert.ok(listing.endsWith(".tgz"), `npm pack produced no advisory tarball: ${listing}`);
    return path.join(packs, listing);
}

// The fake install MUST sit under a node_modules directory (isNpmInstallForm
// keys off that path shape; npm pack output has no .git, so the
// source-checkout guard stays clear).
async function extractInstall(work: string, tgz: string): Promise<string> {
    const installDir = path.join(work, "global", "node_modules", PKG.name);
    fs.mkdirSync(installDir, { recursive: true });
    await tar.x({ file: tgz, cwd: installDir, strip: 1 });
    return installDir;
}

type BiliProc = { child: ChildProcess; port: number; stderr: string };

function spawnBiliStart(installDir: string, port: number, env: Record<string, string>): BiliProc {
    const child = spawn(process.execPath, [path.join(installDir, "dist", "index.js"), "start", "--port", String(port)], {
        env: biliSpawnEnv(env),
    });
    const proc: BiliProc = { child, port, stderr: "" };
    child.stderr?.on("data", (d) => (proc.stderr += d));
    child.stdout?.on("data", (d) => (proc.stderr += d));
    return proc;
}

async function stopBili(proc: BiliProc | undefined): Promise<void> {
    if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return;
    proc.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
            proc.child.kill("SIGKILL");
            resolve();
        }, 5_000);
        t.unref?.();
        proc.child.once("exit", () => {
            clearTimeout(t);
            resolve();
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what: string, deadlineMs: number, fn: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await sleep(500);
    }
    assert.fail(`timed out waiting for ${what}`);
}

interface StatusDoc {
    version?: string;
    diskVersion?: string;
    advisory?: { id?: string; target?: string; pendingRestart?: boolean; installedVersion?: string; targetFailed?: boolean } | null;
}

async function fetchStatus(port: number): Promise<StatusDoc> {
    const res = await fetch(`http://127.0.0.1:${port}/__bili/status`);
    assert.equal(res.status, 200, `/__bili/status returned ${res.status}`);
    return (await res.json()) as StatusDoc;
}

test("e2e: rollback-form advisory (#1588) — forced rollback, no ping-pong, persistent restart banner", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "index.js")), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-advisory-"));
    const procs: BiliProc[] = [];
    let reg: Awaited<ReturnType<typeof startRegistry>> | undefined;
    t.after(async () => {
        for (const p of procs) await stopBili(p);
        await reg?.stop();
        await rmrf(work);
    });

    const logFile = () => path.join(work, "state", "billion-context", "bili.log");
    const readLog = () => {
        try {
            return fs.readFileSync(logFile(), "utf8");
        } catch {
            return "";
        }
    };

    // --- setup: registry with the controlled version sequence, disk on START
    reg = await startRegistry(path.join(work, "registry"));
    const envBase = isolatedEnv(work);
    const biliEnv = {
        ...envBase,
        BILI_UPDATE_REGISTRY: reg.url,
        BILI_UPDATE_CHECK_INTERVAL_MS: String(CYCLE_MS),
        // #3619 pins: this suite drives version sequencing via advisory
        // force-installs and periodic checks with tight waits — keep the
        // stagger rollout at legacy immediate and the policy file unreachable.
        BILI_UPDATE_STAGGER_MIN_MS: "0",
        BILI_UPDATE_STAGGER_MAX_MS: "0",
        BILI_UPDATE_POLICY_URL: "http://127.0.0.1:1/no-policy.json",
    };

    const startTgz = await makeFixtureTarball(work, START);
    const latestTgz = await makeFixtureTarball(work, LATEST);
    const targetTgz = await makeFixtureTarball(work, TARGET);
    // Ascending publish order: `latest` must end on LATEST, and npm refuses
    // the implicit latest tag when publishing a version LOWER than the
    // current latest (the TARGET rollback would trip it otherwise).
    await reg.publish(targetTgz);
    await reg.publish(startTgz);
    await reg.publish(latestTgz);
    const installDir = await extractInstall(work, startTgz);
    assert.equal(await readPkgVersion(installDir), START);

    const port = await freePort();
    const procA = spawnBiliStart(installDir, port, biliEnv);
    procs.push(procA);

    await t.test("control: with no advisory package, the normal loop self-updates to latest", async () => {
        const installedRe = new RegExp(`\\[update\\] installed ${escapeRe(START)} → ${escapeRe(LATEST)}\\. Restart to finish\\.`);
        await waitFor(
            `disk ${START} → ${LATEST} via normal self-update`,
            90_000,
            async () => (await readPkgVersion(installDir)) === LATEST && installedRe.test(readLog()),
        );
        assert.match(readLog(), installedRe);
    });

    await t.test("rollback-form advisory lands: forced install of the older target + persistent restart banner", async () => {
        await reg.publish(await makeAdvisoryTarball(work));
        await waitFor(`disk ${LATEST} → ${TARGET} via forced advisory install`, 60_000, async () => (await readPkgVersion(installDir)) === TARGET);
        const log = readLog();
        assert.match(log, new RegExp(`forcing update to ${escapeRe(TARGET)}`));
        // #1588-B: disk left the range but the RUNNING process is still on the
        // affected START — the next advisory cycle must keep the banner up
        // (warned on the cycle AFTER the install lands).
        const bannerRe = new RegExp(`running version ${escapeRe(START)} is affected .* while the on-disk version ${escapeRe(TARGET)} is outside the range — restart bili to finish`);
        await waitFor(`persistent restart banner for the still-affected running ${START}`, 30_000, async () => bannerRe.test(readLog()));
        assert.match(readLog(), bannerRe);
        const st = await fetchStatus(port);
        assert.equal(st.version, START, "running process still executes the affected build");
        assert.equal(st.diskVersion, TARGET);
        assert.equal(st.advisory?.id, ADV_ID);
        assert.equal(st.advisory?.target, TARGET);
        assert.equal(st.advisory?.pendingRestart, true);
        assert.equal(st.advisory?.installedVersion, TARGET);
        assert.equal(st.advisory?.targetFailed, false);
    });

    await t.test("#1588-A (pre-restart): no ping-pong while the affected process keeps running", async () => {
        await sleep(CYCLE_MS * 3 + 2_000); // several full updater+advisory cycles
        assert.equal(await readPkgVersion(installDir), TARGET, `disk must stay at ${TARGET} — updater re-installed latest (ping-pong)`);
        const log = readLog();
        assert.match(log, /deferring to the advisory loop/, "updater must defer to the advisory watcher");
        assert.doesNotMatch(log, new RegExp(`installed ${escapeRe(TARGET)} → ${escapeRe(LATEST)}`), "no back-install of latest over the advisory target");
        const st = await fetchStatus(port);
        assert.equal(st.advisory?.pendingRestart, true, "banner still up across cycles until a restart");
    });

    await t.test("#1588-A (post-restart): candidate gate refuses to pull affected latest back in", async () => {
        await stopBili(procA);
        const logLenBefore = readLog().length;
        const procB = spawnBiliStart(installDir, port, biliEnv);
        procs.push(procB);
        await waitFor("restarted bili to serve /__bili/status", 30_000, async () => {
            try {
                return (await fetchStatus(port)).version === TARGET;
            } catch {
                return false;
            }
        });
        // First updater check fires ~10s after start; give it that plus a
        // couple of cycles to (wrongly, pre-fix) grab latest.
        await sleep(10_000 + CYCLE_MS * 2 + 2_000);
        assert.equal(await readPkgVersion(installDir), TARGET, `disk must stay at ${TARGET} after restart — candidate gate failed (ping-pong)`);
        const tail = readLog().slice(logLenBefore);
        assert.match(
            tail,
            new RegExp(`skipping ${escapeRe(LATEST)}: covered by a critical-bug advisory's affected range \\(#1588\\)`),
            "updater must refuse the affected candidate via advisoryBlocksVersion",
        );
        assert.doesNotMatch(tail, new RegExp(`installed \\S+ → ${escapeRe(LATEST)}`), "no install of latest after the restart");
        const st = await fetchStatus(port);
        assert.equal(st.advisory, null, "banner clears once the running version left the affected range");
        assert.equal(st.diskVersion, TARGET);
    });
});
