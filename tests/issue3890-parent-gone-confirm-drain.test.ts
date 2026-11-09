// #3890: Windows parent-gone false positive — a LIVE parent pid (opencode-cli.exe)
// was judged dead by the watchdog and the proxy force-exited 12× in 2.5h, each
// time cutting in-flight upstream streams. Two mechanisms are pinned here:
//   (1) a kill-0 death verdict now requires WATCHER_DEAD_CONFIRM_TICKS
//       CONSECUTIVE failed probes (tickWatchedPid — pure, unit-tested below);
//       one transient OpenProcess failure can no longer kill the proxy;
//       heartbeat expiry for a live pid got its own consecutive confirmation
//       in #4994 (was immediate — behavior change, see
//       tests/issue4994-watchdog-heartbeat-confirm.test.ts);
//   (2) the shutdown backstop RE-ARMS its grace window while connections are
//       still alive (bounded passes) instead of force-exiting at 10s and
//       yanking in-flight streams (live child-process test — pre-fix behavior
//       exits mid-drain).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tickWatchedPid } from "../src/server.ts";
import type { PidProbe } from "../src/instance.ts";
import { rmrf } from "./tmp-rm.ts";

const OPTS = { heartbeatGraceMs: 15_000, confirmTicks: 3, heartbeatConfirmTicks: 5 };
const NOW = 1_000_000;
const dead = (code = "ESRCH"): PidProbe => ({ alive: false, errCode: code });
const aliveProbe: PidProbe = { alive: true };

test("#3890 tickWatchedPid: one failed probe does NOT remove the pid", () => {
    const d = tickWatchedPid(dead(), undefined, NOW, undefined, undefined, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: false, streak: 1, hbStreak: 0 }, "a single flaky probe is not conclusive");
});

test("#3890 tickWatchedPid: blip shorter than confirmTicks survives; a live probe resets the streak", () => {
    let d = tickWatchedPid(dead(), undefined, NOW, undefined, undefined, OPTS);
    assert.equal(d.removed, false);
    d = tickWatchedPid(dead(), undefined, NOW + 2_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false);
    assert.equal(d.streak, 2);
    d = tickWatchedPid(aliveProbe, undefined, NOW + 4_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false);
    assert.equal(d.streak, 0, "the live probe clears the pending death");
    d = tickWatchedPid(dead(), undefined, NOW + 6_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.streak, 1, "a later episode starts from zero again");
});

test("#3890 tickWatchedPid: confirmTicks consecutive failures remove the pid", () => {
    let d = tickWatchedPid(dead(), undefined, NOW, undefined, undefined, OPTS);
    d = tickWatchedPid(dead(), undefined, NOW + 2_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false, "two failures are not yet conclusive");
    d = tickWatchedPid(dead(), undefined, NOW + 4_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, true, "the third consecutive failure confirms death");
    assert.equal(d.staleHeartbeat, false);
});

test("#3890 tickWatchedPid: live pids keep legacy semantics (no heartbeat record ⇒ never removed)", () => {
    assert.deepEqual(tickWatchedPid(aliveProbe, undefined, NOW, undefined, undefined, OPTS), { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 });
});

test("#3890/#4994 tickWatchedPid: heartbeat expiry for a LIVE pid now requires confirmation (was immediate)", () => {
    assert.deepEqual(tickWatchedPid(aliveProbe, NOW - 1_000, NOW, undefined, undefined, OPTS), { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 }, "fresh beat keeps it");
    const stale = tickWatchedPid(aliveProbe, NOW - 16_000, NOW, undefined, undefined, OPTS);
    assert.equal(stale.removed, false, "#4994 behavior change: one stale reading no longer marks the slot dead immediately — a busy-but-alive parent must get a re-beat chance");
    assert.equal(stale.staleHeartbeat, true);
    assert.equal(stale.hbStreak, 1);
});

test("#3890 tickWatchedPid: a DEAD pid never takes the heartbeat fast path", () => {
    let d = tickWatchedPid(dead("ESRCH"), NOW - 60_000, NOW, undefined, undefined, OPTS);
    assert.equal(d.removed, false, "stale lastSeen does not shortcut kill-0 confirmation");
    d = tickWatchedPid(dead("ESRCH"), NOW - 60_000, NOW, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false);
    d = tickWatchedPid(dead("ESRCH"), NOW - 60_000, NOW, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, true);
    assert.equal(d.staleHeartbeat, false, "removal via kill-0 confirmation is never tagged stale-heartbeat");
});

// ── live drain backstop (child process — finishShutdown ends in process.exit) ──

const FIXTURE = fileURLToPath(new URL("./fixtures/issue3890-drain-bili.mts", import.meta.url));
const READY_TIMEOUT_MS = 30_000;
// The pre-fix hard backstop force-exited 10s after shutdown() regardless of
// live connections. The fixed proxy must still be ALIVE well past that point
// while a connection is held, and exit promptly once it drains.
const HOLD_CHECK_MS = 13_000;
const EXIT_GRACE_MS = 20_000;

test("#3890 shutdown backstop extends while a connection is alive, then exits when it drains", { timeout: 120_000 }, async () => {
    const root = path.join(tmpdir(), `bili-3890drain-${process.pid}-${Date.now()}`);
    const env = { ...process.env };
    env.XDG_CONFIG_HOME = path.join(root, "cfg");
    env.XDG_STATE_HOME = path.join(root, "state");
    env.XDG_CACHE_HOME = path.join(root, "cache");
    for (const d of [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) mkdirSync(d, { recursive: true });
    delete env.BILI_PARENT_PID;
    delete env.BILLION_CONTEXT_PROXY;
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += String(c); });
    child.stderr!.on("data", (c) => { stderr += String(c); });
    let exitInfo: { code: number | null } | null = null;
    child.on("exit", (code) => { exitInfo = { code }; });
    let held: net.Socket | null = null;
    try {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let port = 0;
        while (!port && Date.now() < deadline) {
            const m = /^READY (\d+)$/m.exec(stdout);
            if (m) port = Number(m[1]);
            else await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(port > 0, `fixture reported READY (stderr tail: ${stderr.slice(-500)})`);
        // A bare held socket: registered in connRecords, never requests, never
        // FINs until destroyed — deterministic liveConns≥1 without depending on
        // keep-alive reaper timing.
        held = new net.Socket();
        held.connect(port, "127.0.0.1");
        await once(held, "connect");
        const res = await fetch(`http://127.0.0.1:${port}/__bili/shutdown`, { method: "POST" });
        assert.equal(res.status, 202, "admin shutdown accepted");
        // Pre-fix: force-exit at ~10s with liveConns=1. Post-fix: the window
        // re-arms and the proxy stays up serving/draining.
        const checkDeadline = Date.now() + HOLD_CHECK_MS;
        while (Date.now() < checkDeadline) {
            if (exitInfo !== null) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(exitInfo, null, `proxy must stay alive ${HOLD_CHECK_MS}ms into the shutdown drain while a connection is open — pre-#3890 behavior force-exited at 10s (stderr tail: ${stderr.slice(-500)})`);
        assert.match(stderr, /extending drain \d+\/\d+/, "the extension is logged, not an accidental slowdown");
        held.destroy();
        held = null;
        const exitDeadline = Date.now() + EXIT_GRACE_MS;
        while (exitInfo === null && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 250));
        if (exitInfo === null) throw new Error(`proxy exits once the last connection drains — still up after ${EXIT_GRACE_MS}ms (stderr tail: ${stderr.slice(-500)})`);
        assert.equal(exitInfo.code, 0, "clean exit code after drain");
    } finally {
        held?.destroy();
        if (exitInfo === null && child.pid) {
            child.kill("SIGKILL");
            await once(child, "exit").catch(() => {});
        }
        try { rmrf(root); } catch {}
    }
});
