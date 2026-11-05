// #3436: native-lane bootstraps pass no mitmDomains/modelWindows at all, but
// the spawned child RECORDS its resolved tier (config-file mitm.domains ∪
// inherited BILI_MITM_DOMAINS, gated by the enabled flag; the parsed
// BILI_LAUNCHER_MODEL_* env) in the instance file — so the attach comparison
// wanted []/{} against an instance offering [configured...], never matched,
// and every host process spawned its own proxy (user log: another bili
// instance ×103, 15 instances in 1.5h). The compat check must want exactly
// what the child records (resolveRecordedMitmDomains / recordedModelMap),
// whatever the lane passes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { entryScriptFingerprint } from "../src/instance.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-3436-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP = entryScriptFingerprint(FP_SCRIPT);
assert.ok(FP !== undefined, "fixture script must fingerprint");

const ORIGIN = "http://127.0.0.1:18797";

function tmpHome(): { dir: string; restore: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3436-home-"));
    const prevCfg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = dir;
    return {
        dir,
        restore: () => {
            if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
            if (prevState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevState;
        },
    };
}

function writeConfig(dir: string, cfg: unknown): void {
    fs.mkdirSync(path.join(dir, "billion-context"), { recursive: true });
    fs.writeFileSync(path.join(dir, "billion-context", "billion-context.json"), JSON.stringify(cfg));
}

function liveInstance(
    mitmDomains: string[],
    modelWindows: Record<string, number> = {},
    modelMaxOutputs?: Record<string, number>,
): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "inst-3436",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 18797,
        passthrough: false,
        mitmDomains,
        modelWindows,
        ...(modelMaxOutputs !== undefined && Object.keys(modelMaxOutputs).length > 0 ? { modelMaxOutputs } : {}),
        lane: "dsh",
        codeFingerprint: FP,
    };
}

function makeFakeChild(pid: number): SpawnChild {
    return {
        pid,
        unref() {},
        kill() { return true; },
        on() {},
    };
}

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

/** Native-lane shape bring-up: no mitmDomains unless the case says so. */
async function bringUp(live: ProxyInstanceFile | undefined, passDomains?: string[]) {
    let spawnCalls = 0;
    const clock = fakeClock();
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "dsh", ...(passDomains !== undefined ? { mitmDomains: passDomains } : {}) },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => (live !== undefined && origin === ORIGIN ? { ok: true, watchdog: { armed: true } } : undefined),
            readInstanceFile: () => live,
            listRegistryInstances: () => [],
            spawnImpl: (_cmd: string, _args: readonly string[]) => {
                spawnCalls++;
                return makeFakeChild(42_470);
            },
            now: clock.now,
            sleep: clock.sleep,
            registerWatcher: async () => "ok",
            attachDiag: () => {},
            scriptPath: FP_SCRIPT,
        },
    );
    return { handle, spawnCalls };
}

test("#3436 native lane attaches to its own instance when config-file mitm.domains is set", async () => {
    const home = tmpHome();
    try {
        writeConfig(home.dir, { mitm: { domains: ["api.a.com"] } });
        // The child spawned by a previous dsh process recorded the tier it
        // resolved (file layer, no env override because bootstraps pass
        // nothing → env inherited, empty here).
        const { handle, spawnCalls } = await bringUp(liveInstance(["api.a.com"]));
        assert.equal(spawnCalls, 0, "no new proxy — the existing one is compatible");
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, ORIGIN);
    } finally {
        home.restore();
    }
});

test("#3436 caller-env BILI_MITM_DOMAINS layer is wanted too (native children inherit it)", async () => {
    const home = tmpHome();
    try {
        const prev = process.env.BILI_MITM_DOMAINS;
        process.env.BILI_MITM_DOMAINS = "b1.com,b2.com";
        try {
            const { handle, spawnCalls } = await bringUp(liveInstance(["b1.com", "b2.com"]));
            assert.equal(spawnCalls, 0);
            assert.equal(handle.attached, true);
        } finally {
            if (prev === undefined) delete process.env.BILI_MITM_DOMAINS; else process.env.BILI_MITM_DOMAINS = prev;
        }
    } finally {
        home.restore();
    }
});

test("#3436 explicit (CLI-shape) lists want the file layer prepended, in record order", async () => {
    const home = tmpHome();
    try {
        writeConfig(home.dir, { mitm: { domains: ["a.com"] } });
        // A CLI lane spawns with BILI_MITM_DOMAINS=r.com while the file layer
        // holds a.com → the child records [a.com, r.com] (file first).
        const { handle, spawnCalls } = await bringUp(liveInstance(["a.com", "r.com"]), ["r.com"]);
        assert.equal(spawnCalls, 0);
        assert.equal(handle.attached, true);
    } finally {
        home.restore();
    }
});

test("#3436 mitm disabled records [] and wants [] (configured domains ignored)", async () => {
    const home = tmpHome();
    try {
        writeConfig(home.dir, { mitm: { enabled: false, domains: ["x.com"] } });
        const { handle, spawnCalls } = await bringUp(liveInstance([]));
        assert.equal(spawnCalls, 0);
        assert.equal(handle.attached, true);
    } finally {
        home.restore();
    }
});

test("#3436 default-empty behavior unchanged: no config, no env → wants []", async () => {
    const home = tmpHome();
    try {
        const { handle, spawnCalls } = await bringUp(liveInstance([]));
        assert.equal(spawnCalls, 0);
        assert.equal(handle.attached, true);
    } finally {
        home.restore();
    }
});

test("#3436 genuine mismatch still refuses to attach (spawn path)", async () => {
    const home = tmpHome();
    try {
        // Instance recorded a tier nobody configured anymore (config edited
        // after spawn) — attaching would serve the wrong whitelist.
        await assert.rejects(bringUp(liveInstance(["other.com"])));
    } finally {
        home.restore();
    }
});

test("#3436 native lane attaches when exported BILI_LAUNCHER_MODEL_* match the peer's recorded maps", async () => {
    const home = tmpHome();
    try {
        const prevW = process.env.BILI_LAUNCHER_MODEL_WINDOWS;
        const prevM = process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS;
        process.env.BILI_LAUNCHER_MODEL_WINDOWS = JSON.stringify({ "model-x": 200_000 });
        process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = JSON.stringify({ "model-x": 8192 });
        try {
            // A previous same-lane process inherited the same ambient env and
            // its child recorded exactly these maps (the launcher injects
            // JSON.stringify(opts) only on CLI lanes; native children parse
            // the inherited string).
            const { handle, spawnCalls } = await bringUp(liveInstance([], { "model-x": 200_000 }, { "model-x": 8192 }));
            assert.equal(spawnCalls, 0);
            assert.equal(handle.attached, true);
        } finally {
            if (prevW === undefined) delete process.env.BILI_LAUNCHER_MODEL_WINDOWS; else process.env.BILI_LAUNCHER_MODEL_WINDOWS = prevW;
            if (prevM === undefined) delete process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS; else process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = prevM;
        }
    } finally {
        home.restore();
    }
});

test("#3436 genuine model-windows mismatch still refuses to attach (spawn path)", async () => {
    const home = tmpHome();
    try {
        const prevW = process.env.BILI_LAUNCHER_MODEL_WINDOWS;
        process.env.BILI_LAUNCHER_MODEL_WINDOWS = JSON.stringify({ "model-x": 200_000 });
        try {
            await assert.rejects(bringUp(liveInstance([], { "model-y": 100_000 })));
        } finally {
            if (prevW === undefined) delete process.env.BILI_LAUNCHER_MODEL_WINDOWS; else process.env.BILI_LAUNCHER_MODEL_WINDOWS = prevW;
        }
    } finally {
        home.restore();
    }
});
