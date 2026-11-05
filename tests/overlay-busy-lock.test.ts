/** #1952: the shared `<home>-bili` overlay is exclusive per live launch. A
 *  second live launch must refuse (zero writes) instead of clobbering the
 *  first launch's generated .env / MCP config / pid marker; crashed holders'
 *  leases are reclaimed; normal relaunch after exit keeps working. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
    OverlayBusyError,
    acquireOverlayLease,
    prepareCodexHome,
    prepareDshHome,
    releaseOverlayLease,
    runLaunch,
    type LauncherDeps,
    type SpawnChild,
} from "../src/launcher.ts";

function mkdtemp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(...dirs: string[]): void {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** A live foreign process whose pid can be planted as the overlay owner. */
async function spawnHolder(): Promise<{ pid: number; stop(): void }> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    return { pid: child.pid ?? -1, stop: () => { try { child.kill(); } catch {} } };
}

function deadPid(): number {
    const res = spawnSync(process.execPath, ["-e", ""]);
    if (res.pid === undefined || res.pid <= 0) throw new Error("spawnSync returned no pid");
    return res.pid;
}

function makeChild(pid: number, onKill?: () => void): SpawnChild {
    return { pid, unref() {}, kill() { onKill?.(); return true; }, on() {} };
}

function plantLease(overlay: string, pid: number, token?: string): void {
    const dir = path.join(overlay, ".bili-launch.lock");
    fs.mkdirSync(dir, { recursive: true });
    if (token !== undefined) {
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid, token, ts: Date.now() }, null, 2));
    }
}

const CODEX_OPTS_BASE = { caPath: "/ca.pem", manageRouting: true } as const;

test("second live launch refuses instead of clobbering the first launch's overlay (#1952)", async () => {
    const home = mkdtemp("bili-1952-home-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    const holder = await spawnHolder();
    try {
        const o1 = prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "first-session", ...CODEX_OPTS_BASE });
        assert.equal(o1, overlay);
        const envBefore = fs.readFileSync(path.join(overlay, ".env"), "utf8");
        const cfgBefore = fs.readFileSync(path.join(overlay, "config.toml"), "utf8");
        assert.ok(envBefore.includes("http://127.0.0.1:11111"));
        // Plant a concurrent owner the way a pre-fix bili launch would look:
        // live foreign pid in the legacy marker.
        fs.writeFileSync(path.join(overlay, ".bili-launch.pid"), `${holder.pid}\n`);
        let err: unknown;
        try {
            prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:22222", conversationId: "second-session", ...CODEX_OPTS_BASE });
        } catch (e) {
            err = e;
        }
        assert.ok(err instanceof OverlayBusyError, `expected OverlayBusyError, got: ${String(err)}`);
        assert.equal((err as OverlayBusyError).holderPid, holder.pid);
        assert.equal(fs.readFileSync(path.join(overlay, ".env"), "utf8"), envBefore);
        assert.equal(fs.readFileSync(path.join(overlay, "config.toml"), "utf8"), cfgBefore);
        assert.equal(fs.readFileSync(path.join(overlay, ".bili-launch.pid"), "utf8"), `${holder.pid}\n`);
        const owner = JSON.parse(fs.readFileSync(path.join(overlay, ".bili-launch.lock", "owner.json"), "utf8")) as { pid: number };
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseOverlayLease();
        holder.stop();
        cleanup(home);
    }
});

test("foreign live lease: prepare refuses before writing anything (#1952)", async () => {
    const home = mkdtemp("bili-1952-lease-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    const holder = await spawnHolder();
    try {
        plantLease(overlay, holder.pid, "foreign-token");
        let err: unknown;
        try {
            prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        } catch (e) {
            err = e;
        }
        assert.ok(err instanceof OverlayBusyError, `expected OverlayBusyError, got: ${String(err)}`);
        assert.equal((err as OverlayBusyError).holderPid, holder.pid);
        assert.ok(!fs.existsSync(path.join(overlay, ".env")));
        assert.ok(!fs.existsSync(path.join(overlay, ".bili-launch.pid")));
    } finally {
        releaseOverlayLease();
        holder.stop();
        cleanup(home);
    }
});

test("partially written owner record reads busy (#1952)", async () => {
    const home = mkdtemp("bili-1952-partial-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        plantLease(overlay, 1);
        let err: unknown;
        try {
            prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        } catch (e) {
            err = e;
        }
        assert.ok(err instanceof OverlayBusyError, `expected OverlayBusyError, got: ${String(err)}`);
        assert.equal((err as OverlayBusyError).holderPid, undefined);
        assert.match((err as Error).message, /\.bili-launch\.lock/);
    } finally {
        releaseOverlayLease();
        cleanup(home);
    }
});

test("stale lease from a crashed launch is reclaimed (#1952)", async () => {
    const home = mkdtemp("bili-1952-stale-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        plantLease(overlay, deadPid(), "crashed-token");
        const o = prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        assert.equal(o, overlay);
        assert.ok(fs.readFileSync(path.join(overlay, ".env"), "utf8").includes("http://127.0.0.1:11111"));
    } finally {
        releaseOverlayLease();
        cleanup(home);
    }
});

test("stale legacy marker alone does not block a relaunch (#1952)", async () => {
    const home = mkdtemp("bili-1952-stalemk-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        fs.mkdirSync(overlay, { recursive: true });
        fs.writeFileSync(path.join(overlay, ".bili-launch.pid"), `${deadPid()}\n`);
        const o = prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        assert.equal(o, overlay);
    } finally {
        releaseOverlayLease();
        cleanup(home);
    }
});

test("same-process relaunch after release reuses the overlay (#1952)", async () => {
    const home = mkdtemp("bili-1952-roundtrip-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        const o1 = prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        assert.equal(o1, overlay);
        releaseOverlayLease();
        const o2 = prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:22222", conversationId: "s2", ...CODEX_OPTS_BASE });
        assert.equal(o2, overlay);
        assert.ok(fs.readFileSync(path.join(overlay, ".env"), "utf8").includes("http://127.0.0.1:22222"));
    } finally {
        releaseOverlayLease();
        cleanup(home);
    }
});

test("release leaves a token-mismatched (reclaimed) lease untouched (#1952)", async () => {
    const home = mkdtemp("bili-1952-token-");
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "audit-model"\n');
    try {
        prepareCodexHome({ codexHome: home, origin: "http://127.0.0.1:11111", conversationId: "s1", ...CODEX_OPTS_BASE });
        const ownerFile = path.join(overlay, ".bili-launch.lock", "owner.json");
        const rec = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
        rec.token = "someone-else";
        fs.writeFileSync(ownerFile, JSON.stringify(rec));
        releaseOverlayLease();
        assert.ok(fs.existsSync(path.join(overlay, ".bili-launch.lock")));
    } finally {
        releaseOverlayLease();
        cleanup(home);
    }
});

test("six racing processes: exactly one wins the lease (#1952)", { timeout: 60_000 }, async () => {
    const tmp = mkdtemp("bili-1952-race-");
    const overlay = path.join(tmp, "race-overlay");
    fs.mkdirSync(overlay, { recursive: true });
    const launcherUrl = new URL("../src/launcher.ts", import.meta.url).href;
    const script = path.join(tmp, "race-child.mjs");
    fs.writeFileSync(
        script,
        [
            `const mod = await import(${JSON.stringify(launcherUrl)});`,
            `try { mod.acquireOverlayLease(process.argv[2]); console.log("WIN"); }`,
            `catch (err) { console.log(err instanceof Error && err.name === "OverlayBusyError" ? "BUSY" : "ERR:" + String(err)); }`,
            // Hold until signaled so every racer contends against a LIVE holder — exiting
            // early would leave a stale lease that later racers legitimately reclaim.
            // (A pending top-level await alone does NOT hold Node alive — it exits 13.)
            `setInterval(() => {}, 60_000);`,
            `process.once("SIGTERM", () => { mod.releaseOverlayLease(); process.exit(0); });`,
        ].join("\n"),
    );
    const K = 6;
    const results: string[] = [];
    const stderrs: string[] = [];
    const children: ChildProcess[] = [];
    for (let i = 0; i < K; i++) {
        // Point every temp var at our own fixture so the child's tooling (tsx's
        // transform cache) never depends on the host's /tmp state or perms.
        children.push(
            spawn(process.execPath, ["--import", "tsx", script, overlay], {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
            }),
        );
    }
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (err?: Error): void => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };
            children.forEach((c, i) => {
                let buf = "";
                c.stdout?.on("data", (d: Buffer) => {
                    buf += d.toString();
                    let nl: number;
                    while ((nl = buf.indexOf("\n")) >= 0 && !settled) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);
                        if (!line) continue;
                        results.push(line);
                        if (results.length === K) {
                            finish();
                            break;
                        }
                    }
                });
                c.stderr?.on("data", (d: Buffer) => {
                    stderrs[i] = (stderrs[i] ?? "") + d.toString();
                });
                c.on("error", (err: Error) => finish(err));
                c.on("close", (code) => {
                    if (!settled && code !== 0) {
                        finish(new Error(`race child ${i} exited ${code}: ${(stderrs[i] ?? "").trim().slice(0, 400) || "(no stderr)"}`));
                    }
                });
            });
        });
    } finally {
        for (const c of children) {
            try { c.kill("SIGTERM"); } catch {}
        }
    }
    assert.equal(
        results.filter((r) => r === "WIN").length,
        1,
        `expected exactly one WIN, got results=${JSON.stringify(results)} stderr=${JSON.stringify(stderrs.map((s) => s.trim()).filter(Boolean))}`,
    );
    assert.equal(results.filter((r) => r === "BUSY").length, K - 1);
    cleanup(tmp);
});

test("dsh lane: same busy refusal on the shared -bili overlay (#1952)", async () => {
    const dshHome = mkdtemp("bili-1952-dsh-");
    const overlay = `${dshHome}-bili`;
    fs.writeFileSync(path.join(dshHome, "settings.yaml"), "baseURL: http://127.0.0.1:8199/v1\n");
    const holder = await spawnHolder();
    try {
        plantLease(overlay, holder.pid, "dsh-foreign");
        let err: unknown;
        try {
            prepareDshHome(dshHome, "http://127.0.0.1:4321", [{ key: "dsh", realUpstream: "http://127.0.0.1:8199/v1" }]);
        } catch (e) {
            err = e;
        }
        assert.ok(err instanceof OverlayBusyError, `expected OverlayBusyError, got: ${String(err)}`);
        assert.equal((err as OverlayBusyError).holderPid, holder.pid);
        assert.ok(!fs.existsSync(path.join(overlay, "settings.yaml")));
    } finally {
        releaseOverlayLease();
        holder.stop();
        cleanup(dshHome);
    }
});

test("runLaunch(codex): busy overlay stops this launch's proxy, skips the client, exits 1 (#1952)", async () => {
    const codexHome = mkdtemp("bili-1952-run-");
    const overlay = `${codexHome}-bili`;
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "audit-model"\n');
    const fakeClient = path.join(codexHome, "fake-codex");
    fs.writeFileSync(fakeClient, "#!/bin/sh\nexit 0\n");
    const holder = await spawnHolder();
    plantLease(overlay, holder.pid, "run-foreign");

    const prevExit = process.exit;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevHome = process.env.CODEX_HOME;
    const prevConsoleError = console.error;
    const exitCalls: number[] = [];
    const errLines: string[] = [];
    process.exit = ((code?: number) => { exitCalls.push(code ?? 0); return undefined as never; }) as typeof process.exit;
    console.error = ((...a: unknown[]) => { errLines.push(a.map(String).join(" ")); }) as typeof console.error;
    process.env.BILI_CLIENT_BIN = fakeClient;
    process.env.CODEX_HOME = codexHome;
    let clientSpawned = false;
    let proxyKilled = false;
    const deps: LauncherDeps = {
        fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, pid: 42423 }),
        readInstanceFile: () => undefined,
        sleep: () => Promise.resolve(),
        zonePreferredPort: () => 45999,
        writeZonePort: () => {},
        attachDiag: () => {},
        spawnImpl: (cmd) => {
            if (cmd === fakeClient) {
                clientSpawned = true;
                return makeChild(42424);
            }
            return makeChild(42423, () => { proxyKilled = true; });
        },
    };
    try {
        await runLaunch({ client: "codex", clientArgs: [], overrides: {} }, deps);
        assert.deepEqual(exitCalls, [1]);
        assert.equal(clientSpawned, false);
        if (process.platform !== "win32") assert.equal(proxyKilled, true);
        assert.ok(errLines.some((l) => l.includes("another bili launch (pid")), "user-visible busy message");
    } finally {
        process.exit = prevExit;
        console.error = prevConsoleError;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevHome;
        releaseOverlayLease();
        holder.stop();
        cleanup(codexHome);
    }
});
