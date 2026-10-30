// #4850: config-file `passthrough: true` made every native-lane bootstrap
// deadlock — the instance record carries the CONFIG-MERGED mode while native
// hosts pass a raw hardcoded `passthrough: false` flag, so the attach-side
// shape check rejected every live instance; the spawn fallback then hit the
// #4341 twin early-exit (same config ⇒ same shape ⇒ twin ⇒ exit 3), and the
// twin-adoption path filtered with the SAME mismatched flag — three dead ends,
// `proxy bootstrap failed — model traffic goes direct (uncompressed)`.
//
// Fix: project the caller's flag onto what a spawned child would RECORD
// (resolveRecordedPassthrough, the #3436 discipline applied to the passthrough
// axis). Truth table below asserts BOTH directions (#3617): config-driven
// passthrough instances become attachable AND adoptable, while genuine mode
// isolation (explicit flag vs an instance running the other mode) still
// mismatches.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TWIN_ADOPT_EXIT_CODE } from "../src/listen-policy.ts";
import { ensureProxyRunning, type LauncherDeps, type SpawnChild, type SpawnFn } from "../src/launcher.ts";
import type { ProxyInstanceFile as InstanceFile } from "../src/instance.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-4850-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

const BOX = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4850-"));
const CONFIG_FILE = path.join(BOX, "billion-context.json");
const PREV_STATE = process.env.XDG_STATE_HOME;
const PREV_CONFIG_FILE = process.env.BILI_CONFIG_FILE;
const PREV_ACP_PASSTHROUGH = process.env.ACP_PASSTHROUGH;
process.env.XDG_STATE_HOME = path.join(BOX, "state");
process.env.BILI_CONFIG_FILE = CONFIG_FILE;

before(() => {
    fs.writeFileSync(CONFIG_FILE, "{}\n");
    delete process.env.ACP_PASSTHROUGH;
});

after(() => {
    for (const [key, prev] of [
        ["XDG_STATE_HOME", PREV_STATE],
        ["BILI_CONFIG_FILE", PREV_CONFIG_FILE],
        ["ACP_PASSTHROUGH", PREV_ACP_PASSTHROUGH],
    ] as const) {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    }
    fs.rmSync(BOX, { recursive: true, force: true });
    fs.rmSync(FP_SCRIPT, { force: true });
});

function recordedInstance(over: Partial<InstanceFile> = {}): InstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        lane: "dsh",
        ...over,
    };
}

function makeFastExitChild(code: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid: 48500,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            if (event === "exit") listener(code, null);
        },
    };
}

type Case = {
    configRaw: string;
    envPassthrough?: string;
    flag: boolean;
    record: Partial<InstanceFile>;
};

const DSH_OPTS = { host: "127.0.0.1", port: 8787, debug: false, lane: "dsh" } as const;

function caseDeps(record: Partial<InstanceFile>, spawnCode: number, latePublish = false): { deps: LauncherDeps; childCreations: () => number } {
    const inst = recordedInstance(record);
    let childCreations = 0;
    let reads = 0;
    const spawnImpl: SpawnFn = () => {
        childCreations++;
        return makeFastExitChild(spawnCode);
    };
    let t = 0;
    const deps: LauncherDeps = {
        spawnImpl,
        fetchImpl: async () => ({ ok: true }),
        fetchHealthInfo: async (origin) =>
            origin === inst.origin ? { ok: true, instanceId: inst.instanceId, pid: inst.pid, watchdog: { armed: true } } : undefined,
        readInstanceFile: () => {
            reads++;
            return latePublish && reads <= 1 ? undefined : inst;
        },
        registerWatcher: async () => "ok",
        scriptPath: FP_SCRIPT,
        now: () => t,
        sleep: async (ms) => {
            t += ms;
        },
    };
    return { deps, childCreations: () => childCreations };
}

async function setUpCase(c: Case): Promise<void> {
    fs.writeFileSync(CONFIG_FILE, c.configRaw);
    if (c.envPassthrough === undefined) delete process.env.ACP_PASSTHROUGH;
    else process.env.ACP_PASSTHROUGH = c.envPassthrough;
}

test("#4850: config passthrough:true instance is attachable by a native host that passed passthrough:false (bug repro)", async () => {
    await setUpCase({ configRaw: '{"passthrough": true}\n', flag: false, record: { passthrough: true } });
    const { deps, childCreations } = caseDeps({ passthrough: true }, 1);
    const handle = await ensureProxyRunning({ ...DSH_OPTS, passthrough: false }, deps);
    assert.equal(childCreations(), 0, "no second proxy spawned");
    assert.equal(handle.attached, true, "attaches to the config-driven passthrough instance instead of going direct");
});

test("#4850: inherited ACP_PASSTHROUGH=1 instance is attachable the same way", async () => {
    await setUpCase({ configRaw: "{}\n", envPassthrough: "1", flag: false, record: { passthrough: true } });
    const { deps, childCreations } = caseDeps({ passthrough: true }, 1);
    const handle = await ensureProxyRunning({ ...DSH_OPTS, passthrough: false }, deps);
    assert.equal(childCreations(), 0);
    assert.equal(handle.attached, true);
});

test("#4850: baseline — no passthrough anywhere still attaches", async () => {
    await setUpCase({ configRaw: "{}\n", flag: false, record: { passthrough: false } });
    const { deps, childCreations } = caseDeps({ passthrough: false }, 1);
    const handle = await ensureProxyRunning({ ...DSH_OPTS, passthrough: false }, deps);
    assert.equal(childCreations(), 0);
    assert.equal(handle.attached, true);
});

test("#4850: explicit --passthrough flag projects to a passthrough record (no config)", async () => {
    await setUpCase({ configRaw: "{}\n", flag: true, record: { passthrough: true } });
    const { deps, childCreations } = caseDeps({ passthrough: true }, 1);
    const handle = await ensureProxyRunning({ ...DSH_OPTS, passthrough: true }, deps);
    assert.equal(childCreations(), 0);
    assert.equal(handle.attached, true);
});

test("#4850: mode isolation preserved — flag-on does NOT attach to a non-passthrough instance (#3617 negative)", async () => {
    await setUpCase({ configRaw: "{}\n", flag: true, record: { passthrough: false } });
    const { deps, childCreations } = caseDeps({ passthrough: false }, 1);
    await assert.rejects(
        ensureProxyRunning({ ...DSH_OPTS, passthrough: true }, deps),
        /exited before becoming healthy|did not become healthy/,
    );
    assert.ok(childCreations() > 0, "spawns its own proxy instead of attaching across modes");
});

test("#4850: a passthrough record with NO config/env source still mismatches a flag-off host (#3617 negative)", async () => {
    await setUpCase({ configRaw: "{}\n", flag: false, record: { passthrough: true } });
    const { deps, childCreations } = caseDeps({ passthrough: true }, 1);
    await assert.rejects(
        ensureProxyRunning({ ...DSH_OPTS, passthrough: false }, deps),
        /exited before becoming healthy|did not become healthy/,
    );
    assert.ok(childCreations() > 0, "an unexplained passthrough record is still not attachable");
});

// The exact production sequence from the 0.1.208 report: discovery misses
// the live instance (late record publish), the spawned child dies with the
// #4341 twin-collision signal because a same-config sibling holds the port,
// and recovery rides serving-twin ADOPTION — which pre-fix filtered out the
// twin with the same mismatched flag (`passthrough: false` ask vs the
// config-driven `true` record) and left the host going direct.
test("#4850: twin adoption after a code-3 child exit recovers when config drives passthrough (log sequence 12:17:41)", async () => {
    await setUpCase({ configRaw: '{"passthrough": true}\n', flag: false, record: { passthrough: true } });
    const { deps, childCreations } = caseDeps({ passthrough: true }, TWIN_ADOPT_EXIT_CODE, true);
    const handle = await ensureProxyRunning({ ...DSH_OPTS, passthrough: false }, deps);
    assert.equal(childCreations(), 1, "one spawn attempt hit the twin collision");
    assert.equal(handle.attached, true, "the serving twin is adopted instead of bootstrap failing to direct traffic");
});
