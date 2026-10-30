// #5103: after a forced power loss the DSH-spawned child died on EPERM before
// binding (CA bundle rebuild), while a manually started proxy holding the lane
// port made DSH wait for its own child for 11 hours — the user saw only an
// [info] "waiting for the spawned instance" line and a silent attachUrl
// rejection. Failure paths must be self-contained AND actionable: name the
// squatter pid WITH its remedy, say why an explicit attach target was refused,
// and warn on the FIRST silent-degrade strike of the unified store (which used
// to stay quiet until the third). All probes go through injected seams — no
// real network I/O, hermetic registry/config.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, SPAWN_BUDGET_MS, type ProbeOutcome, type SpawnFn } from "../src/launcher.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import type { CoreMessage } from "acp-kernel";

// Hermeticity pins: a developer/CI machine with native.attach* or
// storage.unified in its REAL config must not leak into these decisions.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5103-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;

const PORT = 47832;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function fakeClock() {
    let ticks = 0;
    return {
        now: () => ticks * 1000,
        sleep: () => {
            ticks += 1;
            return Promise.resolve();
        },
    };
}

function livingChildSpawn(pid: number): SpawnFn {
    return (() => ({ pid, unref() {}, kill() { return true; }, on() {} })) as SpawnFn;
}

/** A registry candidate whose origin matches `attachUrl` but whose code
 *  fingerprint differs — the exact #5103 shape: global install upgraded under
 *  a host-managed copy that still runs the old bytes. */
function incompatiblePeer(): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "peer-instance",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: PORT,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
        codeFingerprint: "deadbeef-not-our-bytes",
    };
}

async function runToTimeout(deps: Record<string, unknown>): Promise<{ err: Error; stderrLines: string[]; diags: string[] }> {
    const stderrLines: string[] = [];
    const diags: string[] = [];
    const realError = console.error.bind(console);
    console.error = (...args: unknown[]) => { stderrLines.push(args.join(" ")); };
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                listRegistryInstances: () => [],
                attachDiag: (m: string) => { diags.push(m); },
                spawnImpl: livingChildSpawn(42471),
                ...deps,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        return { err: e as Error, stderrLines, diags };
    } finally {
        console.error = realError;
    }
}

test("#5103: explicit attachUrl target found but build-incompatible — refusal named with reason and remedy", async () => {
    const clock = fakeClock();
    const { err, stderrLines, diags } = await runToTimeout({
        fetchHealthInfo: async () => ({ ok: true, pid: process.pid }),
        fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: true }),
        readInstanceFile: () => incompatiblePeer(),
        resolveAttachUrl: () => ORIGIN,
        now: clock.now,
        sleep: clock.sleep,
    });
    // The bring-up still falls through to the spawn ladder (and times out on
    // the fake clock) — the point is WHAT was said about the target.
    assert.match(err.message, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    const notice = stderrLines.find((l) => l.includes(`explicit attach target ${ORIGIN}`));
    assert.ok(notice, "the visible channel must name the refused explicit target");
    assert.ok(notice!.includes("code-fingerprint-mismatch"), notice);
    assert.ok(notice!.includes("restart the host once its copy converges to the same version"), notice);
    assert.ok(diags.some((d) => d.includes(`explicit attach target ${ORIGIN}`)), "the durable log gets the same line");
});

test("#5103: negative gate — without attachUrl no explicit-target notice fires", async () => {
    const clock = fakeClock();
    const { stderrLines, diags } = await runToTimeout({
        fetchHealthInfo: async () => ({ ok: true, pid: process.pid }),
        fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: true }),
        readInstanceFile: () => incompatiblePeer(),
        now: clock.now,
        sleep: clock.sleep,
    });
    assert.ok(!stderrLines.some((l) => l.includes("explicit attach target")), "notice must require the explicit field");
    assert.ok(!diags.some((d) => d.includes("explicit attach target")));
});

test("#5103: explicit attachUrl with no live instance registered there — says so instead of waiting silently", async () => {
    const clock = fakeClock();
    const { stderrLines } = await runToTimeout({
        fetchHealthInfo: async () => undefined,
        fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
        readInstanceFile: () => undefined,
        resolveAttachUrl: () => ORIGIN,
        now: clock.now,
        sleep: clock.sleep,
    });
    const notice = stderrLines.find((l) => l.includes(`explicit attach target ${ORIGIN}`));
    assert.ok(notice, "a dead/absent target must be announced");
    assert.ok(notice!.includes("no live instance registered"), notice);
});

test("#5103: foreign healthy responder — info line AND final error carry the remedy", async () => {
    const clock = fakeClock();
    const { err, diags } = await runToTimeout({
        fetchHealthInfo: async () => ({ ok: true, pid: 99999 }),
        fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: true }),
        readInstanceFile: () => undefined,
        now: clock.now,
        sleep: clock.sleep,
    });
    assert.match(err.message, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    assert.ok(err.message.includes(`port ${PORT} is held by a different process (pid 99999) — the spawned child never bound it`), err.message);
    assert.ok(err.message.includes("Kill that process (kill 99999)"), "final error must name the kill remedy");
    assert.ok(err.message.includes("native.attachExternal=true"), "final error must name the attach opt-in");
    const infoLine = diags.find((d) => d.includes("answers health (pid 99999) but is not the proxy this launcher spawned"));
    assert.ok(infoLine, "the waiting info line still fires");
    assert.ok(infoLine!.includes("kill pid 99999"), "the waiting info line must carry the remedy too");
    assert.ok(infoLine!.includes("native.attachExternal=true"), infoLine);
});

// ---------------------------------------------------------------------------
// F4: unified-store first-failure visibility (was silent until strike three)
// ---------------------------------------------------------------------------

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

test("#5103: first ingest failure warns immediately with the db path; disable warning keeps naming it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5103-shadow-"));
    try {
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "shadow mode sidecar must open");
        shadow.record(mkLegacy("s1", [msg(1)]));
        assert.equal(shadow.stats.ingests, 1, "first ingest lands before the refusal");
        // The #5103 field shape: the db opens fine but every WRITE is refused
        // ("attempt to write a readonly database"). An open SQLite connection
        // keeps its file descriptors, so post-open chmod cannot simulate this
        // cross-platform — refuse at the store seam both record() paths
        // (delta + full) route through instead.
        const store = (shadow as unknown as { sync: { ingestSession: (...args: never[]) => boolean } }).sync;
        const readonlyRefusal = () => { throw new Error("attempt to write a readonly database"); };
        store.ingestSession = readonlyRefusal as typeof store.ingestSession;

        const captured: Array<{ level: string; msg: string }> = [];
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            shadow.record(mkLegacy("s1", [msg(1), msg(2)]));
            const firstWarn = captured.find((c) => c.level === "warn" && c.msg.includes("failed to ingest"));
            assert.ok(firstWarn, "the FIRST failure must warn (before #5103 strikes one and two were silent)");
            assert.ok(firstWarn!.msg.includes(path.join(dir, "index.db")), "warning must name the database file");
            if (process.platform === "win32") {
                assert.ok(firstWarn!.msg.includes("(win32:"), "win32 runner carries the OS-level hint");
            }
            assert.equal(shadow.stats.disabled, false, "one failure must not disable yet");

            shadow.record(mkLegacy("s1", [msg(1), msg(2), msg(3)]));
            assert.equal(shadow.stats.disabled, false, "two failures must not disable yet");
            shadow.record(mkLegacy("s1", [msg(1), msg(2), msg(3), msg(4)]));
            const disableWarn = captured.find((c) => c.level === "warn" && c.msg.includes("disabled after 3 consecutive failures"));
            assert.ok(disableWarn, "third consecutive failure disables with a loud warning");
            assert.ok(disableWarn!.msg.includes(path.join(dir, "index.db")), "disable warning must keep naming the file");
            assert.equal(shadow.stats.disabled, true);
        } finally {
            setLogCapture(null);
        }
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* leaked tmp dir is harmless */ }
    }
});
