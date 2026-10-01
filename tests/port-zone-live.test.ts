import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning } from "../src/launcher.ts";
import { portZoneFilePath, readZonePort } from "../src/instance.ts";
import { ZONE_PORT_BASE } from "../src/config.ts";

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
function ensureDistBuilt(): void {
    if (!fs.existsSync(distCli)) {
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
async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zone-live-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(home, "state");
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
    }
}

function launch(opts: { lane?: string; port?: number; strictPort?: boolean; script?: string } = {}) {
    return ensureProxyRunning(
        {
            host: "127.0.0.1",
            port: opts.port ?? 0,
            strictPort: opts.strictPort,
            passthrough: false,
            debug: false,
            lane: opts.lane,
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
            try {
                assert.equal(h1.port, ZONE_PORT_BASE, "precondition: first launch on the base");
                killNow(daemon1);
                await new Promise((r) => setTimeout(r, 300)); // kernel releases the listen socket
                const squatter = await squatted(ZONE_PORT_BASE);
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
