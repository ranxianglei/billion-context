import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning } from "../src/launcher.ts";
import { isPidAlive, portZoneFilePath, readZonePort } from "../src/instance.ts";
import { resolveZonePortBase } from "../src/config.ts";
// #3182: in CI the zone-slot preload gives this file its own BILI_ZONE_PORT
// band so concurrent live files never fight over the default base; locally
// (plain npm test) this resolves to the exported default 18787.
const ZONE_PORT_BASE = resolveZonePortBase();
import { UPGRADE_REPLACEMENT_ENV } from "../src/listen-policy.ts";

// #1660 live regression: the sticky-zone lifecycle against REAL proxy
// processes — real spawn handshake, real EADDRINUSE ladder, real attach
// probe, real sticky follow. The mocked sequences in port-zone.test.ts pin
// the decision table; this file pins the WIRING: the bug class where a call
// site pre-resolves the port and the settle never fires (90cc7e8) only
// surfaces with a real child writing a real instance file. Gated exactly
// like the claude-native live e2e (#1248): the dedicated CI runner sets
// ACP_TEST_CLAUDE_NATIVE=1; locally loaded sandboxes skip.
const LIVE = process.env.ACP_TEST_CLAUDE_NATIVE === "1";
const liveSkip = LIVE ? undefined : "set ACP_TEST_CLAUDE_NATIVE=1 (live proxy e2e; #1248)";

const root = path.resolve(import.meta.dirname, "..");
const distCli = path.join(root, "dist", "index.js");

// CI's test step runs before `npm run build` — build on demand.
/** #3182 family: a STALE dist is worse than a missing one — the test then
 * exercises last week's product code and "fails" on fixes that exist (the
 * #3044 marked-replacement hang was exactly this). Rebuild when any src/
 * source is newer than the built entry. */
function distStale(entry: string): boolean {
    let newest = 0;
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
        }
    };
    walk(path.join(root, "src"));
    return fs.statSync(entry).mtimeMs < newest;
}
let distBuiltOnce = false;
function ensureDistBuilt(): void {
    if (distBuiltOnce && fs.existsSync(distCli) && !distStale(distCli)) return;
    distBuiltOnce = true;
    if (!fs.existsSync(distCli) || distStale(distCli)) {
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], {
            cwd: root,
            stdio: "pipe",
            timeout: 300_000,
        });
    }
    assert.ok(fs.existsSync(distCli), `build did not produce ${distCli}`);
}

// Backstop cleanup: every test also kills eagerly in its own finally so the
// NEXT test's zone base is free (tests run serially within this file).
const cleanup: Array<() => void> = [];
after(() => {
    for (const fn of cleanup.splice(0)) {
        try {
            fn();
        } catch {}
    }
});

function trackKill(pid: number | undefined): void {
    if (pid === undefined || pid <= 1) return;
    cleanup.push(() => {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    });
}

function killNow(pid: number | undefined): void {
    if (pid !== undefined && pid > 1) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }
}

function portOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port });
        s.once("connect", () => {
            s.destroy();
            resolve(true);
        });
        s.once("error", () => resolve(false));
    });
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.once("error", reject);
    });
}

/** A dumb port squatter: accepts nothing — destroys every connection so
 *  health probes fail fast instead of hanging on a silent socket. */
async function squatted(port: number): Promise<net.Server> {
    const srv = net.createServer((sock) => {
        sock.on("error", () => {});
        sock.destroy();
    });
    await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", () => resolve());
    });
    cleanup.push(() => {
        try {
            srv.close();
        } catch {}
    });
    return srv;
}

// Redirect the WHOLE view — this process's state-dir reads AND the spawned
// child's (the launcher builds the child env off process.env) — so
// port-zone.json, the instance file and the #707 starting marker stay in a
// throwaway sandbox.
/** #3182: bounded wait for the band base to be free (teardown SIGKILLs
 * return before the kernel releases the listener; under shard load the next
 * test's first bind can land inside that window). Within this file's private
 * band only our own earlier daemons can hold the base, so waiting is
 * deterministic. Gives up after `ms` so a genuine wedge still fails loudly.
 */
async function waitForBandFree(port: number, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (await portOpen(port)) {
        if (Date.now() > deadline) {
            throw new Error(`#3182: band base ${port} still occupied after ${ms}ms — an earlier scenario's daemon never released it`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zone-live-"));
    // Full XDG isolation, not just state: children inherit process.env, and
    // a dev box's real config (e.g. storage.unified=full) or data dir makes
    // every spawned daemon open the machine's real index.db and queue on its
    // lock behind live daemons — the #3044 fail-fast then never fires within
    // the test's patience (observed as a 120s hang). CI runners are hermetic;
    // this restores that guarantee everywhere.
    const prev = {
        state: process.env.XDG_STATE_HOME,
        config: process.env.XDG_CONFIG_HOME,
        data: process.env.XDG_DATA_HOME,
        cache: process.env.XDG_CACHE_HOME,
    };
    process.env.XDG_STATE_HOME = path.join(home, "state");
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CACHE_HOME = path.join(home, "cache");
    try {
        // #3182: teardown kills tracked daemons with SIGKILL but returns
        // without waiting for the kernel to release the listener. Under a
        // concurrent shard runner the NEXT test can reach its first bind
        // inside that window and eat a spurious EADDRINUSE on the band base.
        // Wait (bounded) for the base to be free before every scenario —
        // within this file's private band only our own earlier daemons can
        // hold it, so this is deterministic, not a race.
        await waitForBandFree(ZONE_PORT_BASE);
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[`XDG_${k.toUpperCase()}_HOME`];
            else process.env[`XDG_${k.toUpperCase()}_HOME`] = v;
        }
    }
}

function launch(opts: { lane?: string; port?: number; strictPort?: boolean; script?: string; modelWindows?: Record<string, number>; modelMaxOutputs?: Record<string, number> } = {}) {
    return ensureProxyRunning(
        {
            host: "127.0.0.1",
            port: opts.port ?? 0,
            strictPort: opts.strictPort,
            passthrough: false,
            debug: false,
            lane: opts.lane,
            modelWindows: opts.modelWindows,
            modelMaxOutputs: opts.modelMaxOutputs,
        },
        { scriptPath: opts.script ?? distCli },
    );
}

// #1723: a byte-different copy of the entry script = a DIFFERENT build — the
// fingerprint hashes contents (entryScriptFingerprint), which is exactly what
// an upgrade produces on disk. Written INSIDE the repo tree so the copy still
// resolves the root package.json's "type": "module" (a /tmp copy would run as
// CJS and die on the bundle's import statements before ever reaching listen).
let v2Seq = 0;
function makeV2Script(): string {
    const p = path.join(root, `bili-zone-live-v2-${process.pid}-${++v2Seq}.js`);
    fs.writeFileSync(p, fs.readFileSync(distCli, "utf8") + "\n// v2 marker\n");
    return p;
}

test(
    "zone live: lane'd port-0 launch binds the base, settles sticky; a repeat attaches",
    { timeout: 180_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const h1 = await launch({ lane: "zcode" });
            trackKill(h1.child?.pid);
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "fresh lane'd launch binds the zone base");
                assert.equal(readZonePort("zcode"), ZONE_PORT_BASE, "the bound port settles sticky");
                const h2 = await launch({ lane: "zcode" });
                assert.equal(h2.attached, true, "repeat launch attaches to the live daemon");
                assert.equal(h2.origin, h1.origin);
            } finally {
                killNow(h1.child?.pid);
            }
        });
    },
);

test(
    "zone live: squatter on the sticky port → ladder drift settles sticky; a repeat attaches at the drifted port",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const h1 = await launch({ lane: "zcode" });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            let daemon2: number | undefined;
            let squatter: net.Server | undefined;
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "precondition: first launch on the base");
                killNow(daemon1);
                await new Promise((r) => setTimeout(r, 300)); // kernel releases the listen socket
                squatter = await squatted(ZONE_PORT_BASE);
                const h2 = await launch({ lane: "zcode" });
                daemon2 = h2.child?.pid;
                trackKill(daemon2);
                assert.equal(h2.port, ZONE_PORT_BASE + 1, "preferred base occupied → +1 ladder drift");
                assert.equal(readZonePort("zcode"), ZONE_PORT_BASE + 1, "sticky follows the drift");
                const h3 = await launch({ lane: "zcode" });
                assert.equal(h3.attached, true);
                assert.equal(h3.port, ZONE_PORT_BASE + 1, "later launches follow the drift");
                // Eager close — the next test expects the zone base free; the
                // after() backstop alone would hold it past this test's end.
                squatter.close();
            } finally {
                killNow(daemon1);
                killNow(daemon2);
                // #3182: close on failure paths too — a leaked listener on
                // the band base starves the next test's waitForBandFree.
                if (squatter) { try { squatter.close(); } catch {} }
            }
        });
    },
);

test(
    "zone live: explicit strictPort pin binds exactly and never settles a zone record",
    { timeout: 180_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const port = await freePort();
            const h = await launch({ lane: "zcode", port, strictPort: true });
            trackKill(h.child?.pid);
            try {
                assert.equal(h.port, port, "the exact pin is the bound port");
                assert.equal(readZonePort("zcode"), undefined, "explicit pins stay out of the sticky file");
                assert.equal(fs.existsSync(portZoneFilePath()), false, "no zone file materialized");
            } finally {
                killNow(h.child?.pid);
            }
        });
    },
);

test(
    "zone live: a second lane spawns its own daemon past the first and keeps an independent sticky key",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const h1 = await launch({ lane: "zcode" });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            try {
                assert.equal(h1.port, ZONE_PORT_BASE);
                const h2 = await launch({ lane: "kimi" });
                trackKill(h2.child?.pid);
                try {
                    assert.equal(h2.attached, undefined, "cross-lane instances are never attach targets");
                    assert.equal(h2.port, ZONE_PORT_BASE + 1, "second lane ladders past the first lane's daemon");
                    assert.equal(readZonePort("zcode"), ZONE_PORT_BASE);
                    assert.equal(readZonePort("kimi"), ZONE_PORT_BASE + 1, "each lane settles its own sticky key");
                } finally {
                    killNow(h2.child?.pid);
                }
            } finally {
                killNow(daemon1);
            }
        });
    },
);

test(
    "zone live: an unlane'd launch is ephemeral and leaves no zone record",
    { timeout: 180_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const h = await launch({});
            trackKill(h.child?.pid);
            try {
                assert.ok(h.port > 0);
                assert.notEqual(h.port, ZONE_PORT_BASE, "unlane'd traffic never rides the zone base");
                assert.equal(fs.existsSync(portZoneFilePath()), false, "no sticky record without a lane");
            } finally {
                killNow(h.child?.pid);
            }
        });
    },
);

// ---------------------------------------------------------------------------
// #1723 (#1660 follow-up): the upgrade-restart overlap. The old build's
// instance still holds the lane's sticky port while the new build's child is
// already trying to bind it — the exact window an auto-update restart opens.
// The new child must WAIT for the predecessor to release and rebind the SAME
// port (sticky stays put), and only fall back to the +1 ladder when the
// holder never leaves (bounded wait → today's behavior as worst case).
// ---------------------------------------------------------------------------

test(
    "zone live: upgrade-restart overlap — new build waits out the same-lane predecessor and rebinds the SAME port (#1723)",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const v2Script = makeV2Script();
            const h1 = await launch({ lane: "zcode" });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            let daemon2: number | undefined;
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "precondition: the old build holds the zone base");
                const p2 = launch({ lane: "zcode", script: v2Script });
                // Let the new child hit EADDRINUSE and enter its predecessor
                // wait, then retire the old build the way an exiting host's
                // parent-gone flush does — the listen socket frees at once.
                await new Promise((r) => setTimeout(r, 1500));
                killNow(daemon1);
                const h2 = await p2;
                daemon2 = h2.child?.pid;
                trackKill(daemon2);
                assert.equal(h2.attached, undefined, "different builds never attach to each other");
                assert.equal(h2.port, ZONE_PORT_BASE, "waited out the predecessor and rebound the SAME port — no drift");
                assert.equal(readZonePort("zcode"), ZONE_PORT_BASE, "sticky did NOT ratchet up");
            } finally {
                killNow(daemon1);
                killNow(daemon2);
                fs.rmSync(v2Script, { force: true });
            }
        });
    },
);

test(
    "zone live: predecessor that never leaves — bounded wait exhausts and the +1 ladder takes over as before (#1723)",
    { timeout: 300_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const v2Script = makeV2Script();
            const h1 = await launch({ lane: "zcode" });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            let daemon2: number | undefined;
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "precondition: the old build holds the zone base");
                // daemon1's owner (this test process) stays alive — no
                // parent-gone flush ever comes, so the holder never frees the
                // port. The new child's bounded wait (~5s) must give up and
                // fall back to the plain +1 ladder: worst case equals today's
                // behavior plus a bounded delay, never a hung launch.
                const h2 = await launch({ lane: "zcode", script: v2Script });
                daemon2 = h2.child?.pid;
                trackKill(daemon2);
                assert.equal(h2.port, ZONE_PORT_BASE + 1, "budget exhausted → the +1 ladder still lands the launch");
                assert.equal(readZonePort("zcode"), ZONE_PORT_BASE + 1, "sticky follows (residual drift, now warned)");
            } finally {
                killNow(daemon1);
                killNow(daemon2);
                fs.rmSync(v2Script, { force: true });
            }
        });
    },
);

// ---------------------------------------------------------------------------
// #3044: the orphan shape end-to-end. A self-restart replacement that cannot
// grab the freed port must DIE LOUDLY instead of hopping +1 and idling as an
// orphan nobody routes to. Spawned directly (not through ensureProxyRunning)
// so the exact replacement env is under test control: launch token + lane
// (which would earn it the #407 ladder pre-#3044) plus the bind-or-die marker.
// ---------------------------------------------------------------------------

test(
    "zone live: marked upgrade-replacement fails fast on an occupied port instead of hopping (#3044)",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            // A non-bili squatter holds the zone base: no same-lane predecessor
            // is recognized, so the marked child gets no wait budget at all —
            // first EADDRINUSE must be its last breath. Under the pre-#3044
            // ladder this exact spawn drifted to base+1 and idled there.
            const squatter = await squatted(ZONE_PORT_BASE);
            const child = spawn(
                process.execPath,
                [distCli, "start", "--host", "127.0.0.1", "--port", String(ZONE_PORT_BASE)],
                {
                    env: {
                        ...process.env,
                        BILI_LAUNCH_TOKEN: "3044-live-test",
                        BILI_LAUNCHER_LANE: "zcode",
                        [UPGRADE_REPLACEMENT_ENV]: "1",
                    },
                    stdio: "ignore",
                    detached: true,
                },
            );
            trackKill(child.pid);
            try {
                const exitCode = await new Promise<number | null | undefined>((resolve) => {
                    child.once("exit", (code) => resolve(code));
                    setTimeout(() => resolve(undefined), 120_000).unref();
                });
                assert.equal(exitCode, 1, "the marked replacement must fail fast with exit code 1 (upgrade pending, host decides retry)");
                assert.equal(await portOpen(ZONE_PORT_BASE + 1), false, "nothing may have hopped onto the next port — that idle hopper IS the #3044 orphan shape");
                assert.equal(await portOpen(ZONE_PORT_BASE), true, "the squatter still owns the base port");
            } finally {
                killNow(child.pid);
                // #3182: close the squatter on failure too — a leaked
                // listener on the band base starves waitForBandFree for the
                // rest of the file (observed as the next test's 10s stall).
                try { squatter.close(); } catch {}
            }
        });
    },
);

test(
    "zone live: unmarked lane'd spawn against a LIVE same-build twin exits instead of hopping (#3044)",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            // The 2026-10-13 recurrence shape: a host respawn raced an attach
            // scan and spawned while an identical instance already served the
            // lane's port. Before this fix that child laddered to base+1 and
            // idled as an orphan; now the duplicate must lose loudly. Spawned
            // directly (unmarked, exactly what the launcher produces) because
            // ensureProxyRunning would attach to the twin and never spawn.
            const h1 = await launch({ lane: "zcode" });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            assert.equal(h1.port, ZONE_PORT_BASE, "precondition: the twin serves the zone base");
            const child = spawn(
                process.execPath,
                [distCli, "start", "--host", "127.0.0.1", "--port", String(ZONE_PORT_BASE)],
                {
                    env: { ...process.env, BILI_LAUNCH_TOKEN: "3044-twin-test", BILI_LAUNCHER_LANE: "zcode" },
                    stdio: "ignore",
                    detached: true,
                },
            );
            trackKill(child.pid);
            try {
                const exitCode = await new Promise<number | null | undefined>((resolve) => {
                    child.once("exit", (code) => resolve(code));
                    setTimeout(() => resolve(undefined), 120_000).unref();
                });
                // #3654: a twin-collision loser exits TWIN_ADOPT_EXIT_CODE (3, the spawner's adopt signal);
                // a loser that loses at the post-bind claim exits 1. Both = lost loudly without hopping —
                // the hop/port asserts below carry the real invariant.
                assert.ok(exitCode === 1 || exitCode === 3, `the duplicate must fail fast (exit 1 or the #3654 adopt signal 3), got ${String(exitCode)}`);
                assert.equal(await portOpen(ZONE_PORT_BASE + 1), false, "nothing may have hopped onto the next port — the hopper IS the orphan shape");
                assert.equal(await portOpen(ZONE_PORT_BASE), true, "the serving twin keeps its port");
                assert.ok(daemon1 !== undefined && isPidAlive(daemon1), "the serving twin must still be alive");
            } finally {
                killNow(child.pid);
                killNow(daemon1);
            }
        });
    },
);

// ---------------------------------------------------------------------------
// #3801: config drift must not wedge the lane behind its stale instance. The
// client's model config was edited AFTER the lane's proxy spawned: attach
// rejects the holder (correctly — new sessions must not ride an instance
// that doesn't know the new model), but the spawned replacement must LADDER
// OFF its port instead of dying as a false twin. Pre-fix this child was a
// "twin" (same build, same lane) and exited without binding; the launch then
// failed and every later launch repeated it until someone killed the holder
// or picked another port by hand. Now: the holder keeps serving its own
// sessions untouched, the newcomer settles base+1, sticky follows.
// ---------------------------------------------------------------------------

test(
    "zone live: model-config drift ladders off the drifted holder instead of dying as a false twin (#3801)",
    { timeout: 240_000, skip: LIVE ? process.platform !== "linux" : liveSkip },
    async () => {
        await withSandbox(async () => {
            ensureDistBuilt();
            const h1 = await launch({ lane: "zcode", modelWindows: { "model-a": 1000 } });
            const daemon1 = h1.child?.pid;
            trackKill(daemon1);
            let daemon2: number | undefined;
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "precondition: the drifted holder serves the zone base");
                // Same build, same lane, DIFFERENT model map — exactly the
                // models.json edit of #3801 (a model added after spawn).
                const h2 = await launch({ lane: "zcode", modelWindows: { "model-a": 1000, "model-b": 2000 } });
                daemon2 = h2.child?.pid;
                trackKill(daemon2);
                assert.equal(h2.attached, undefined, "the drifted instance is not attachable — we got our own proxy");
                assert.equal(h2.port, ZONE_PORT_BASE + 1, "laddered off the drifted holder's port instead of exiting");
                assert.equal(readZonePort("zcode"), ZONE_PORT_BASE + 1, "sticky follows the new canonical instance");
                assert.ok(daemon1 !== undefined && isPidAlive(daemon1), "the drifted holder keeps serving undisturbed");
                assert.equal(await portOpen(ZONE_PORT_BASE), true, "the old port still answers");
                assert.equal(await portOpen(ZONE_PORT_BASE + 1), true, "the new instance answers at the drifted port");
            } finally {
                killNow(daemon1);
                killNow(daemon2);
            }
        });
    },
);
