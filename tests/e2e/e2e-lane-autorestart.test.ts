// #2507 hermetic e2e: the lane-aware autoRestartOnUpdate default against the
// REAL self-update chain (local verdaccio + real dist build + real spawn/re-exec):
//   lane proxy (BILI_LAUNCHER_LANE set) -> default ON  -> the update lands on
//     disk and the proxy self-restarts, serving the new version with no host
//     action (the resident-mode gap the issue reports);
//   manual start (no lane marker)       -> default OFF -> the update lands but
//     the process keeps serving the old code (stale=true, opt-in preserved).
// Shares the ACP_TEST_REGISTRY gate and fixture infra with e2e-registry (#1153);
// loopback only, zero secrets, zero external network.
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";
import { biliSpawnEnv, IS_WIN, isolatedEnv, npmHomeEnv, npmRunSync } from "./crossplat.ts";
import { rmrf } from "../tmp-rm.ts";

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[]; scripts?: Record<string, string> };
const OLD_VERSION = PKG.version;

function bumpPatch(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unexpected version format: ${v}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
const NEW_VERSION = bumpPatch(OLD_VERSION);

// Stage a publishable tarball of THIS package at a synthetic version: same
// files field, same dist build, rewritten package.json version (mirrors
// makeFixtureTarball in e2e-registry.test.ts).
async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    const stagedBase = { ...PKG, version };
    // The staged copy models a PUBLISHED artifact: registry installs never run
    // prepare, and scripts/ is outside `files`, so drop the hook referencing
    // the non-shipped guard script (#2471).
    const stagedPkg = {
        ...stagedBase,
        scripts: Object.fromEntries(Object.entries(stagedBase.scripts ?? {}).filter(([name]) => name !== "prepare")),
    };
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = npmRunSync(["pack", "--silent", "--pack-destination", packs], { cwd: stage, env: { PATH: process.env.PATH ?? "", ...npmHomeEnv(home) } })
        .trim()
        .split("\n")
        .pop()
        ?.trim();
    assert.ok(listing?.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing!);
}

// The fake install MUST sit under a node_modules directory: isNpmInstallForm
// keys off that path shape (same layout requirement as e2e-registry).
async function extractInstall(work: string, tgz: string, sub: string): Promise<string> {
    const installDir = path.join(work, "global", sub, "node_modules", PKG.name);
    fs.mkdirSync(installDir, { recursive: true });
    await tar.x({ file: tgz, cwd: installDir, strip: 1 });
    return installDir;
}

async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
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

type BiliProc = { child: ChildProcess; port: number };

function spawnBiliStart(installDir: string, port: number, env: Record<string, string>): BiliProc {
    const child = spawn(process.execPath, [path.join(installDir, "dist", "index.js"), "start", "--port", String(port)], {
        env: biliSpawnEnv(env),
    });
    const proc: BiliProc = { child, port };
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", () => {});
    return proc;
}

function killPid(pid: number): void {
    try {
        if (IS_WIN) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGTERM");
    } catch {
        // already gone
    }
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
    stale?: boolean;
    autoRestartOnUpdate?: boolean;
}

async function fetchStatus(port: number): Promise<StatusDoc | undefined> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/status`);
        if (!res.ok) return undefined;
        return (await res.json()) as StatusDoc;
    } catch {
        return undefined;
    }
}

test("e2e: lane-aware auto-restart default (#2507)", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-lane-autorestart-"));
    const procs: BiliProc[] = [];
    const extraPids: number[] = [];
    let reg: Awaited<ReturnType<typeof startRegistry>> | undefined;
    t.after(async () => {
        for (const p of procs) await stopBili(p);
        for (const pid of extraPids) killPid(pid);
        await reg?.stop();
        await rmrf(work);
    });

    reg = await startRegistry(path.join(work, "registry"));
    const envBase = isolatedEnv(work);
    const biliEnv = { ...envBase, BILI_UPDATE_REGISTRY: reg.url, BILI_UPDATE_CHECK_INTERVAL_MS: "1500" };

    const oldTgz = await makeFixtureTarball(work, OLD_VERSION);
    const newTgz = await makeFixtureTarball(work, NEW_VERSION);
    await reg.publish(oldTgz);
    await reg.publish(newTgz);

    const logFile = path.join(work, "state", "billion-context", "bili.log");
    const readLog = (): string => {
        try {
            return fs.readFileSync(logFile, "utf8");
        } catch {
            return "";
        }
    };

    await t.test("lane proxy (BILI_LAUNCHER_LANE set): default ON, self-activates after update", async () => {
        const installDir = await extractInstall(work, oldTgz, "lane");
        const port = await freePort();
        const proc = spawnBiliStart(installDir, port, { ...biliEnv, BILI_LAUNCHER_LANE: "dsh" });
        procs.push(proc);
        await waitFor("lane proxy ready", 60_000, async () => (await fetchStatus(port)) !== undefined);
        const before = (await fetchStatus(port))!;
        assert.equal(before.autoRestartOnUpdate, true, "lane-spawned proxy must default autoRestartOnUpdate ON (#2507)");
        assert.equal(before.version, OLD_VERSION);
        assert.equal(before.stale, false);

        // The whole point of the issue: no host action — the update lands AND
        // activates. Original child exits via the handover; the replacement
        // (spawned re-exec) takes over the same port with the new version.
        await waitFor("self-restart handover", 120_000, async () => {
            if (proc.child.exitCode === null && proc.child.signalCode === null) return false;
            const s = await fetchStatus(port);
            return s?.version === NEW_VERSION;
        });
        const m = readLog().match(/\[restart\] replacement is up \(pid (\d+)\)/);
        assert.ok(m, `expected the handover log line in ${logFile}:\n${readLog()}`);
        extraPids.push(Number(m[1]));
        const after = (await fetchStatus(port))!;
        assert.equal(after.version, NEW_VERSION, "replacement serves the updated code");
        assert.equal(after.autoRestartOnUpdate, true);
        assert.equal(after.stale, false, "handover leaves no stale state behind");
        assert.equal(await readPkgVersion(installDir), NEW_VERSION);
    });

    await t.test("manual start (no lane marker): default OFF, update lands but no restart", async () => {
        const installDir = await extractInstall(work, oldTgz, "manual");
        const port = await freePort();
        const proc = spawnBiliStart(installDir, port, biliEnv);
        procs.push(proc);
        await waitFor("manual proxy ready", 60_000, async () => (await fetchStatus(port)) !== undefined);
        const before = (await fetchStatus(port))!;
        assert.equal(before.autoRestartOnUpdate, false, "manual start must keep the opt-in default OFF (#811)");
        assert.equal(before.version, OLD_VERSION);

        await waitFor("on-disk flip", 120_000, async () => (await readPkgVersion(installDir)) === NEW_VERSION);
        // Give a (wrongly armed) restart handler a beat to misfire, then prove quiescence.
        await sleep(3_000);
        assert.equal(proc.child.exitCode, null, "manual-start process must NOT self-exit");
        const after = (await fetchStatus(port))!;
        assert.equal(after.version, OLD_VERSION, "still serving the pre-update code");
        assert.equal(after.diskVersion, NEW_VERSION);
        assert.equal(after.stale, true, "staleness stays visible for the host-restart nudge");
        assert.equal(after.autoRestartOnUpdate, false);
    });
});
