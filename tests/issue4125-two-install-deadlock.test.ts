// #4125: two-copy deadlock — an out-of-band updated copy (global npm tree vs
// host-managed copy) wedged onto a lane's port deadlocks the OLDER generation
// forever: attach rejects it (fingerprint differs — #1225), rotation only
// reaches strictly OLDER residents (#3544), and every new spawn loses the bind
// race behind it — model traffic goes direct uncompressed until someone
// manually kills the holder. This suite pins both halves of the fix:
//   P1 fingerprint parity — one bring-up carries ONE digest: the spawner's,
//      passed down (BILI_SPAWN_FINGERPRINT) and honored over a re-hash
//      (#1225 lesson: trust only well-formed values, never self-reports);
//   P2 upward adoption — a resident that PROVES itself strictly NEWER through
//      a live answered health probe is safe to ride; every other guard stays
//      intact (same declared lane, not user-zone, shape-compatible), so both
//      generations' decision surfaces map "newer holder" onto the existing
//      adopt signal instead of the dead-end skip/throw/wait trio.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";
import {
    entryScriptFingerprint,
    resolveOwnFingerprint,
    SPAWN_FINGERPRINT_ENV,
    type ProxyInstanceFile as InstanceFile,
} from "../src/instance.ts";
import { probeOwnerInfo } from "../src/port-owner.ts";
import {
    isNewerSameLaneHolder,
    findLiveAttachableInstance,
    ensureProxyRunning,
    type LauncherDeps,
} from "../src/launcher.ts";
import { VERSION } from "../src/version.ts";

// ---------- fixtures ----------

const FP_SCRIPT = path.join(os.tmpdir(), `bili-4125-fp-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// #4125 fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

const FOREIGN_FP = "deadbeef".repeat(8); // any digest ≠ ours
assert.notEqual(FOREIGN_FP, FP_HASH);

// strictly newer than whatever version this checkout reports (bump minor)
const [VER_MAJ, VER_MIN] = VERSION.split(".").map((p) => Number(p));
const NEWER_VERSION = `${VER_MAJ}.${VER_MIN + 1}.0`;

function rec(over: Partial<InstanceFile> = {}): InstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-1",
        pid: process.pid, // alive — a dead pid is dropped before compatibility
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        ...over,
    };
}

type FastExitListener = (...args: unknown[]) => void;
function makeFastExitChild(code: number) {
    const handlers = new Map<string, FastExitListener[]>();
    return {
        pid: 42491,
        unref() {},
        kill() {
            return true;
        },
        on(event: string, listener: FastExitListener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            // synchronous emit: death lands before any poll loop's first tick
            if (event === "exit") listener(code, null);
        },
    };
}

// sandbox HOME/XDG so the registry view never sees THIS machine's live peers
const sandboxes: string[] = [];
after(async () => {
    await Promise.all(sandboxes.map((d) => rmrf(d)));
});
function sandboxHome(prefix: string): Map<string, string | undefined> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sandboxes.push(home);
    const prev = new Map<string, string | undefined>();
    const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;
    for (const key of keys) prev.set(key, process.env[key]);
    process.env.HOME = home;
    if (process.env.USERPROFILE !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    return prev;
}
function restoreHome(prev: Map<string, string | undefined>): void {
    for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

// ---------- P1: spawner-passed fingerprint wins ----------

test("resolveOwnFingerprint: a well-formed spawner digest wins over the local re-hash (#4125)", () => {
    assert.equal(resolveOwnFingerprint(FOREIGN_FP, FP_SCRIPT), FOREIGN_FP, "spawner's digest is the canonical view");
    assert.equal(resolveOwnFingerprint(` ${FOREIGN_FP} `, FP_SCRIPT), FOREIGN_FP, "whitespace tolerated");
});

test("resolveOwnFingerprint: malformed or absent env falls back to the local hash", () => {
    for (const bad of [undefined, "", "xyz", "ab".repeat(31), "AB".repeat(32)]) {
        assert.equal(resolveOwnFingerprint(bad, FP_SCRIPT), FP_HASH, `bad=${JSON.stringify(bad)}`);
    }
    assert.equal(resolveOwnFingerprint(undefined, undefined), undefined, "no script, no env → no fingerprint");
});

// ---------- P2: the upward-adoption predicate ----------

test("isNewerSameLaneHolder decision table (#4125)", () => {
    const inst = { lane: "pi" };
    assert.equal(isNewerSameLaneHolder(inst, "pi", NEWER_VERSION, VERSION, false), true);
    assert.equal(isNewerSameLaneHolder(inst, "pi", VERSION, VERSION, false), false, "same version is NOT newer");
    assert.equal(isNewerSameLaneHolder(inst, "pi", "0.0.1", VERSION, false), false, "older stays rejected");
    assert.equal(isNewerSameLaneHolder(inst, undefined, NEWER_VERSION, VERSION, false), false, "no lane on our side");
    assert.equal(isNewerSameLaneHolder({ lane: "opencode" }, "pi", NEWER_VERSION, VERSION, false), false, "cross-lane stays forbidden regardless of version (#2905)");
    assert.equal(isNewerSameLaneHolder({ lane: undefined }, undefined, NEWER_VERSION, VERSION, false), false, "user-zone manual daemon stays user-managed (#1660)");
    assert.equal(isNewerSameLaneHolder(inst, "pi", undefined, VERSION, false), false, "a silent/BUSY holder proves nothing");
});

test("probeOwnerInfo surfaces the holder's reported build version (#4125)", async () => {
    const info = await probeOwnerInfo(
        "http://127.0.0.1:8787",
        async () =>
            ({
                ok: true,
                json: async () => ({ ok: true, pid: 4242, instanceId: "i1", version: "9.9.9" }),
            }) as unknown as Response,
    );
    assert.deepEqual(info, { pid: 4242, instanceId: "i1", version: "9.9.9" });

    const silent = await probeOwnerInfo(
        "http://127.0.0.1:8787",
        async () =>
            ({
                ok: true,
                json: async () => ({ ok: true, pid: 4242, instanceId: "i1" }),
            }) as unknown as Response,
    );
    assert.deepEqual(silent, { pid: 4242, instanceId: "i1" }, "no version claim on older builds — nothing to adopt");
});

// ---------- P2 parent-side: discovery rides a proven newer holder ----------

async function findUpward(depsVersion: string, over: Partial<InstanceFile> = {}) {
    const diag: string[] = [];
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", version: depsVersion, watchdog: { armed: true } }),
            readInstanceFile: () => rec({ lane: "pi", codeFingerprint: FOREIGN_FP, ...over }),
            attachDiag: (m) => diag.push(m),
            scriptPath: FP_SCRIPT,
        },
    );
    return { inst, diag };
}

test("findLiveAttachableInstance: a strictly-newer same-lane holder attaches despite fingerprint drift (#4125)", async () => {
    const prev = sandboxHome("bili-4125-a-");
    try {
        const { inst, diag } = await findUpward(NEWER_VERSION);
        assert.ok(inst, "the newer holder must be attachable");
        assert.equal(inst!.origin, "http://127.0.0.1:8787");
        assert.ok(diag.some((m) => m.includes("strictly NEWER")), `diag was: ${JSON.stringify(diag)}`);
    } finally {
        restoreHome(prev);
    }
});

test("findLiveAttachableInstance: same-or-older versions keep the fingerprint rejection (#4125)", async () => {
    const prev = sandboxHome("bili-4125-b-");
    try {
        for (const version of [VERSION, "0.0.1"]) {
            const { inst, diag } = await findUpward(version);
            assert.equal(inst, undefined, `v${version} must NOT be adopted`);
            assert.ok(diag.some((m) => m.includes("code-fingerprint-mismatch")), `diag was: ${JSON.stringify(diag)}`);
        }
    } finally {
        restoreHome(prev);
    }
});

test("findLiveAttachableInstance: cross-lane or user-zone holders stay rejected even when newer (#4125)", async () => {
    const prev = sandboxHome("bili-4125-c-");
    try {
        const crossLane = await findUpward(NEWER_VERSION, { lane: "opencode" });
        assert.equal(crossLane.inst, undefined, "cross-lane stays forbidden (#2905)");

        const userZone = await findUpward(NEWER_VERSION, { lane: undefined });
        assert.equal(userZone.inst, undefined, "manual daemon stays user-managed (#1660)");
    } finally {
        restoreHome(prev);
    }
});

test("findLiveAttachableInstance: a strictly-newer holder with a drifted config shape stays rejected (#4125)", async () => {
    const prev = sandboxHome("bili-4125-d-");
    try {
        // Newer AND same-lane, but the holder recorded a model window our
        // launch doesn't want — upward adoption lifts ONLY the fingerprint
        // veto; the config-shape guard must survive it (a foreign-bytes holder
        // masks its shape behind the fp reason in instanceCompatible).
        const { inst, diag } = await findUpward(NEWER_VERSION, { modelWindows: { "claude-opus": 200000 } });
        assert.equal(inst, undefined, "newer-but-shape-drifted holder must NOT be adopted");
        assert.ok(diag.some((m) => m.includes("model-windows-mismatch")), `diag was: ${JSON.stringify(diag)}`);
    } finally {
        restoreHome(prev);
    }
});

// ---------- P2: the adopt-signal round trip (child exit 3 → parent adopts) ----------

test("ensureProxyRunning: a twin-collision exit against a PROVEN newer holder is adopted, not failed (#4125)", async () => {
    const prev = sandboxHome("bili-4125-d-");
    const diag: string[] = [];
    let spawnCalls = 0;
    let t = 0;
    try {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFastExitChild(3); // the child refused to fight the port and signaled adopt
                },
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async (origin: string) =>
                    origin === "http://127.0.0.1:8787"
                        ? { ok: true, instanceId: "inst-1", pid: process.pid, version: NEWER_VERSION, watchdog: { armed: true } }
                        : { ok: false },
                readInstanceFile: () => undefined, // holder publishes late: invisible to one-shot discovery
                listAdoptCandidates: () => [rec({ lane: "pi", codeFingerprint: FOREIGN_FP })],
                isConnectable: async () => true,
                now: () => t,
                sleep: async (ms) => {
                    t += ms;
                },
                registerWatcher: async () => "ok",
                attachDiag: (m) => diag.push(m),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true, `must attach to the newer holder; diag was: ${JSON.stringify(diag)}`);
        assert.equal(handle.origin, "http://127.0.0.1:8787");
        assert.equal(handle.child, undefined, "no spawned child survives adoption");
        assert.equal(spawnCalls, 1);
        assert.ok(
            diag.some((m) => m.includes("adopting serving twin") && m.includes("strictly NEWER")),
            `diag was: ${JSON.stringify(diag)}`,
        );
    } finally {
        restoreHome(prev);
    }
});

// ---------- P1 transport: the spawner's digest crosses the spawn boundary ----------

function makeAliveChild(pid: number) {
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on() {},
    };
}

test("ensureProxyRunning: own code fingerprint is passed to the child; ambient copies never leak (#4125/#2195)", async () => {
    const prevEnv = process.env[SPAWN_FINGERPRINT_ENV];
    process.env[SPAWN_FINGERPRINT_ENV] = FOREIGN_FP; // stale copy in the launcher's own env
    const prevHome = sandboxHome("bili-4125-e-");
    try {
        let spawnEnv: NodeJS.ProcessEnv | undefined;
        const healthyDeps = (scriptPath: string): LauncherDeps => ({
            spawnImpl: (_cmd: unknown, _args: unknown, options: { env?: NodeJS.ProcessEnv }) => {
                spawnEnv = options.env ?? {};
                return makeAliveChild(42492);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42492 }),
            readInstanceFile: () => undefined,
            sleep: () => Promise.resolve(),
            registerWatcher: async () => "ok",
            scriptPath,
        });

        // known fingerprint: THIS launch's own hash crosses the boundary —
        // never the stale copy inherited from the launcher's own environment.
        await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "codex" },
            healthyDeps(FP_SCRIPT),
        );
        assert.equal(spawnEnv?.[SPAWN_FINGERPRINT_ENV], FP_HASH, "own hash wins over the ambient stale one");

        // unknown fingerprint (script unreadable): nothing may cross — an
        // ambient BILI_SPAWN_FINGERPRINT must be stripped like every other
        // launcher→child channel (#2195).
        await ensureProxyRunning(
            { host: "127.0.0.1", port: 8788, passthrough: false, debug: false, lane: "codex" },
            healthyDeps(path.join(os.tmpdir(), "bili-4125-missing.js")),
        );
        assert.equal(spawnEnv?.[SPAWN_FINGERPRINT_ENV], undefined, "an unresolvable fingerprint sends nothing — no ambient leak");
    } finally {
        restoreHome(prevHome);
        if (prevEnv === undefined) delete process.env[SPAWN_FINGERPRINT_ENV];
        else process.env[SPAWN_FINGERPRINT_ENV] = prevEnv;
    }
});
