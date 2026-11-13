// #4125: the "proxy respawn gave up" client event must name WHY nothing was
// routable — the bare sentence left users unable to self-diagnose which
// branch failed (dead proxy / saturated proxy / failed spawn / send failure
// with no replacement). Two halves of the contract are pinned here:
//  - the interceptor writes state.lastUnavailableReason immediately BEFORE
//    firing onGiveUp (and records "bootstrap-failed" without firing when no
//    origin was ever held);
//  - the dsh lane's give-up seam appends ": <reason>" to the persisted
//    client-event line and keeps the original bare wording when no reason
//    is present.

import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, _resetRegisterForTest, _setSpawnForTest, _settleNativeForTest, _stateOnGiveUpForTest, _nativeStateForTest, _registerStateForTest } from "../src/agent/dsh-native.ts";
import { createLiveOriginResolver, installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { rmrf } from "./tmp-rm.ts";

// Hermetic log capture: every host-side event in this file lands in a
// throwaway bili.log (node --test runs each file in its own process).
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4125-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const CLIENT_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    rmrf(STATE_ROOT);
});

function giveUpLines(): string[] {
    if (!fs.existsSync(CLIENT_LOG_FILE)) return [];
    return fs.readFileSync(CLIENT_LOG_FILE, "utf8").split("\n").filter((l) => l.includes("proxy respawn gave up"));
}

afterEach(() => { void _settleNativeForTest(); });

type HostCtx = Parameters<typeof apply>[0];

function mockCtx() {
    const tools: unknown[] = [];
    const commands: unknown[] = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: unknown) => { tools.push(t); } },
        commands: { register: (c: unknown) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

// Ambient proxy env must never leak into this suite (#2260(F)): an inherited
// BILI_PROVIDER_REWRITES flips the plan off and the arming under test never
// happens.
const SEALED_PROXY_ENV = ["BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "NODE_EXTRA_CA_CERTS"];

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of SEALED_PROXY_ENV) {
        if (!(k in env)) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    }
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** A port that is definitely closed right now: bind-then-release (no fixed-
 *  port luck, #360). */
async function deadLoopbackPort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const p = (srv.address() as { port: number }).port;
            srv.close(() => resolve(p));
        });
    });
}

test("#4125 dsh give-up line names the unavailability reason (bare wording when none)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4125-dsh-"));
    const port = await deadLoopbackPort();
    try {
        await withEnv(
            {
                DSH_HOME: home,
                // Attach plan against a provably-dead target: the attach arm
                // sets the give-up seam synchronously (no NODE_TEST_CONTEXT
                // gate) and the flight settles base-less via the failing spawn stub.
                BILLION_CONTEXT_PROXY: `http://127.0.0.1:${port}`,
                BILI_ATTACH_EVIDENCE_GRACE_MS: "1",
                BILI_DSH_RECOVERY_INTERVAL_MS: "20",
                BILI_DSH_RETRY_INTERVAL_MS: "20",
            },
            async () => {
                _resetRegisterForTest(undefined);
                _setSpawnForTest(() => Promise.resolve(undefined));
                try {
                    const ctx = mockCtx();
                    ctx.setInitiator({ session: { id: "dsh-4125-session" } });
                    apply(ctx);
                    await _settleNativeForTest();
                    const st = _nativeStateForTest();
                    const fire = _stateOnGiveUpForTest();
                    assert.notEqual(fire, undefined);
                    const before = giveUpLines().length;
                    st.lastUnavailableReason = "dead";
                    fire!();
                    st.lastUnavailableReason = "send-failed";
                    fire!();
                    st.lastUnavailableReason = undefined;
                    fire!();
                    const lines = giveUpLines().slice(before);
                    assert.equal(lines.length, 3);
                    assert.match(lines[0], /\[warn\] \[v=[^\]]+\] \[dsh-client\] proxy respawn gave up — model traffic goes direct \(uncompressed\): dead$/);
                    assert.match(lines[1], /\[warn\] \[v=[^\]]+\] \[dsh-client\] proxy respawn gave up — model traffic goes direct \(uncompressed\): send-failed$/);
                    assert.match(lines[2], /\[warn\] \[v=[^\]]+\] \[dsh-client\] proxy respawn gave up — model traffic goes direct \(uncompressed\)$/);
                    assert.equal(_registerStateForTest().base, undefined);
                } finally {
                    _setSpawnForTest(undefined);
                }
            },
        );
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#4125 interceptor: losing the held origin fires give-up with 'dead' captured at fire time", async () => {
    let fired = 0;
    let seenAtFire: string | undefined;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:41001",
        ready: Promise.resolve(undefined),
        readyTimeoutMs: 300,
        respawn: () => Promise.resolve(undefined),
        onGiveUp: () => { fired += 1; seenAtFire = state.lastUnavailableReason; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: () => Promise.resolve({ state: "dead", detail: "refused" }),
        probeTtlMs: 1,
        respawnCooldownMs: 0,
    });
    assert.equal(await resolve(), undefined);
    assert.equal(fired, 1);
    assert.equal(seenAtFire, "dead");
    assert.equal(state.lastUnavailableReason, "dead");
});

test("#4125 interceptor: losing the held origin to a saturated busy window fires give-up with 'busy-exhausted'", async () => {
    let fired = 0;
    let seenAtFire: string | undefined;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:41002",
        ready: Promise.resolve(undefined),
        readyTimeoutMs: 300,
        respawn: () => Promise.resolve(undefined),
        onGiveUp: () => { fired += 1; seenAtFire = state.lastUnavailableReason; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: () => Promise.resolve({ state: "busy", detail: "no health answer" }),
        probeTtlMs: 1,
        respawnCooldownMs: 0,
        busyWaitCapMs: 60,
        busyReprobeBaseMs: 10,
    });
    const t0 = Date.now();
    assert.equal(await resolve(), undefined);
    assert.ok(Date.now() - t0 >= 50, "the busy window must actually elapse before giving up");
    assert.equal(fired, 1);
    assert.equal(seenAtFire, "busy-exhausted");
    assert.equal(state.lastUnavailableReason, "busy-exhausted");
});

test("#4125 interceptor: a never-held origin records 'bootstrap-failed' without firing give-up", async () => {
    let fired = 0;
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        readyTimeoutMs: 300,
        onGiveUp: () => { fired += 1; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: () => Promise.resolve({ state: "dead" as const }),
        probeTtlMs: 1,
        respawnCooldownMs: 0,
    });
    assert.equal(await resolve(), undefined);
    assert.equal(fired, 0);
    assert.equal(state.lastUnavailableReason, "bootstrap-failed");
});

test("#4125 interceptor: a send failure with no replacement fires give-up with 'send-failed' and still sends direct", async () => {
    const origin = "http://127.0.0.1:41003";
    const saved = globalThis.fetch;
    const seen: string[] = [];
    const anchor = (async (input: string | URL | Request, _init?: RequestInit) => {
        const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        seen.push(u);
        if (u.startsWith(`${origin}/bili/`)) throw new TypeError("other side closed");
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let fired = 0;
    let seenAtFire: string | undefined;
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        readyTimeoutMs: 300,
        respawn: () => Promise.resolve(undefined),
        onGiveUp: () => { fired += 1; seenAtFire = state.lastUnavailableReason; },
    };
    _resetForTest({ anchor });
    globalThis.fetch = anchor;
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
        assert.deepEqual(seen, [`${origin}/bili/http://127.0.0.1:8199/v1/messages`, "http://127.0.0.1:8199/v1/messages"]);
        assert.equal(fired, 1);
        assert.equal(seenAtFire, "send-failed");
        assert.equal(state.lastUnavailableReason, "send-failed");
    } finally {
        _resetForTest();
        globalThis.fetch = saved;
    }
});
