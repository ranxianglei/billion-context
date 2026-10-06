import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmrf } from "./tmp-rm.ts";

// #2185 方案 A: unit coverage for the self-registration core
// (src/agent/pi-subagent-registry.ts) plus the pi.ts factory wiring
// (session_start registers / session_shutdown disposes). All cases run
// against the REAL globalThis + unique session ids (the exact production
// path — pi-subagents reads Symbol.for("pi-subagents.required-child-extensions.v1"));
// snapshot shape assertions mirror pi-subagents 0.76.0 required-child-extensions.js
// (version===1, bySession Map, frozen [{id,path}] snapshots).
import {
    SUBAGENT_EXTENSION_ID,
    disposeSubagentSelfReg,
    resolveSubagentRegistry,
    selfRegisterForSession,
    type SubagentRegistryRoot,
    type SubagentSelfRegState,
} from "../src/agent/pi-subagent-registry.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
type GlobalWithRegistry = Record<symbol, unknown>;
const G = globalThis as GlobalWithRegistry;

function uniqueSid(): string {
    return `sar-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tempEntryFile(dir: string): string {
    const p = path.join(dir, "entry.js");
    fs.writeFileSync(p, "// bili entry bundle\n");
    return p;
}

interface OptsOverrides {
    env?: Record<string, string | undefined>;
    agent?: string;
    sessionId?: string;
    filePath?: string;
    log?: (m: string) => void;
}

function opts(overrides: OptsOverrides = {}): Parameters<typeof selfRegisterForSession>[1] {
    return {
        env: { BILLION_CONTEXT_PLUGIN: undefined, BILI_NATIVE_PI: undefined, ...overrides.env } as NodeJS.ProcessEnv,
        agent: overrides.agent ?? "pi",
        // "in" (not ??) so an explicit undefined sid stays undefined — the
        // no-session-id cases depend on it reaching the validator as-is.
        sessionId: "sessionId" in overrides ? overrides.sessionId : "sess-test",
        filePath: overrides.filePath ?? "/nonexistent/bili-entry.js",
        log: overrides.log ?? ((_m: string) => {}),
    };
}

function registry(): SubagentRegistryRoot | null {
    return resolveSubagentRegistry();
}

function cleanup(sid: string): void {
    try { (G[REGISTRY_KEY] as SubagentRegistryRoot | undefined)?.bySession?.delete(sid); } catch { /* already clean */ }
}

test("#2185: create-if-absent + registered entry shape (mirrors pi-subagents contract)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const state: SubagentSelfRegState = {};
        const reason = selfRegisterForSession(state, opts({ sessionId: sid, filePath: tempEntryFile(dir) }));
        assert.equal(reason, "registered");
        const reg = registry()!;
        assert.equal(reg.version, 1);
        assert.ok(reg.bySession instanceof Map);
        const snap = reg.bySession.get(sid) as readonly Readonly<{ id: string; path: string }>[];
        assert.equal(snap.length, 1);
        assert.equal(snap[0].id, SUBAGENT_EXTENSION_ID);
        assert.equal(snap[0].path, fs.realpathSync(path.join(dir, "entry.js")));
        assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap[0]), "snapshot must be frozen like pi-subagents stores");
        assert.equal(registry(), reg, "second resolve returns the same store");
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: idempotent re-fire of session_start keeps a single entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const state: SubagentSelfRegState = {};
        const o = opts({ sessionId: sid, filePath: tempEntryFile(dir) });
        assert.equal(selfRegisterForSession(state, o), "registered");
        assert.equal(selfRegisterForSession(state, o), "registered-already");
        assert.equal(registry()!.bySession.size, countEntries());
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

function countEntries(): number {
    return registry()?.bySession.size ?? 0;
}

test("#2185: same-session foreign entry → yield first-wins, never clobber", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const foreign = Object.freeze([Object.freeze({ id: "other-host", path: "/x/other.js" })]);
        registry()!.bySession.set(sid, foreign);
        const state: SubagentSelfRegState = {};
        const reason = selfRegisterForSession(state, opts({ sessionId: sid, filePath: tempEntryFile(dir) }));
        assert.equal(reason, "conflict-first-wins");
        assert.equal(registry()!.bySession.get(sid), foreign);
        assert.equal(state.sid, undefined, "no state recorded when we did not win");
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: kill switches skip registration; launcher mode does not gate; omp never registers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const p = tempEntryFile(dir);
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, env: { BILLION_CONTEXT_PLUGIN: "0" }, filePath: p })), "kill-switch");
        assert.ok(!registry()?.bySession.has(sid));
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, env: { BILI_NATIVE_PI: "0" }, filePath: p })), "kill-switch");
        assert.ok(!registry()?.bySession.has(sid));
        // launcher mode: BILI_PROVIDER_REWRITES present must NOT gate
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, env: { BILI_PROVIDER_REWRITES: "{}" }, filePath: p })), "registered");
        cleanup(sid);
        // omp lane never registers (and must not even create the store)
        const storeBefore = G[REGISTRY_KEY];
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, agent: "omp", filePath: p })), "not-pi");
        assert.ok(!registry()?.bySession.has(sid));
        assert.equal(G[REGISTRY_KEY], storeBefore);
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: invalid session ids and paths degrade without touching the registry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    const before = G[REGISTRY_KEY];
    try {
        const p = tempEntryFile(dir);
        const badIds: Array<[string | undefined, string]> = [
            [undefined, "no-session-id"],
            ["", "no-session-id"],
            ["  ", "no-session-id"],
            ["a".repeat(257), "no-session-id"],
            ["bad\u0000id", "no-session-id"],
        ];
        for (const [badSid, expected] of badIds) {
            assert.equal(selfRegisterForSession({}, opts({ sessionId: badSid, filePath: p })), expected);
        }
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, filePath: path.join(dir, "missing.js") })), "path-invalid");
        assert.equal(selfRegisterForSession({}, opts({ sessionId: sid, filePath: dir })), "path-invalid", "directories are not entries");
        assert.ok(!registry()?.bySession.has(sid));
        assert.equal(G[REGISTRY_KEY], before, "degraded calls leave the global untouched");
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: malformed existing registry → degrade, never clobber foreign shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    const before = G[REGISTRY_KEY];
    try {
        const p = tempEntryFile(dir);
        for (const foreign of [{ version: 2, bySession: new Map() }, { version: 1, bySession: [] }, "junk"]) {
            G[REGISTRY_KEY] = foreign;
            const warnings: string[] = [];
            const reason = selfRegisterForSession({}, opts({ sessionId: sid, filePath: p, log: (m: string) => warnings.push(m) }));
            assert.equal(reason, "registry-malformed");
            assert.equal(G[REGISTRY_KEY], foreign, "foreign shape preserved");
            assert.equal(warnings.length, 1, "degrade logged once");
        }
    } finally {
        G[REGISTRY_KEY] = before;
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: dispose removes only our own entry (identity-checked)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const p = tempEntryFile(dir);
        const state: SubagentSelfRegState = {};
        assert.equal(selfRegisterForSession(state, opts({ sessionId: sid, filePath: p })), "registered");
        assert.ok(registry()!.bySession.has(sid));
        disposeSubagentSelfReg(state);
        assert.ok(!registry()!.bySession.has(sid));
        assert.equal(state.sid, undefined);

        // external replacement → identity mismatch → we must NOT delete theirs
        const state2: SubagentSelfRegState = {};
        assert.equal(selfRegisterForSession(state2, opts({ sessionId: sid, filePath: p })), "registered");
        const replaced = Object.freeze([Object.freeze({ id: "other-host", path: "/x/other.js" })]);
        registry()!.bySession.set(sid, replaced);
        disposeSubagentSelfReg(state2);
        assert.equal(registry()!.bySession.get(sid), replaced, "foreign replacement survives our dispose");

        // double dispose is a no-op
        disposeSubagentSelfReg(state2);
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

test("#2185: symlinked entry path is canonicalized to its realpath target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sar-"));
    const sid = uniqueSid();
    try {
        const real = tempEntryFile(dir);
        const link = path.join(dir, "link-entry.js");
        fs.symlinkSync(real, link);
        const state: SubagentSelfRegState = {};
        assert.equal(selfRegisterForSession(state, opts({ sessionId: sid, filePath: link })), "registered");
        const snap = registry()!.bySession.get(sid) as readonly Readonly<{ path: string }>[];
        assert.equal(snap[0].path, fs.realpathSync(real));
        disposeSubagentSelfReg(state);
    } finally {
        cleanup(sid);
        rmrf(dir);
    }
});

type PiHandler = (event: unknown, ctx: unknown) => unknown;
type FakePi = {
    // Real pi stores an ARRAY of handlers per event name and awaits each in
    // registration order (pi-coding-agent runner.js emit():
    // `for (const handler of handlers)`), so a second registration for the
    // same event (the embedded subagents wiring, #2186) must APPEND, not
    // replace — a Map-of-one silently shadows the factory's own handler (#2234).
    events: Map<string, PiHandler[]>;
    on(event: string, handler: PiHandler): void;
    registerTool(tool: unknown): void;
    registerCommand(name: string, options: unknown): void;
    registerProvider(name: string, config: { baseUrl: string }): void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, PiHandler[]>();
    return {
        events,
        on: (event, handler) => {
            const list = events.get(event);
            if (list) list.push(handler);
            else events.set(event, [handler]);
        },
        registerTool: () => {},
        registerCommand: () => {},
        registerProvider: () => {},
    };
}

test("#2185: factory wiring — session_start self-registers, session_shutdown disposes", async () => {
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    const prevKill1 = process.env.BILLION_CONTEXT_PLUGIN;
    const prevKill2 = process.env.BILI_NATIVE_PI;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:1";
    delete process.env.BILLION_CONTEXT_PLUGIN;
    delete process.env.BILI_NATIVE_PI;
    const sid = uniqueSid();
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const start = pi.events.get("session_start") ?? [];
        const shutdown = pi.events.get("session_shutdown") ?? [];
        assert.ok(start.length > 0 && shutdown.length > 0, "both handlers must be registered");
        for (const handler of start) await handler({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => sid } });
        assert.ok(registry()?.bySession.has(sid), "entry present after session_start");
        const snap = registry()!.bySession.get(sid) as readonly Readonly<{ id: string; path: string }>[];
        assert.equal(snap[0].id, SUBAGENT_EXTENSION_ID);
        assert.ok(fs.existsSync(snap[0].path), "registered path resolves to a real file");
        for (const handler of shutdown) await handler({ type: "session_shutdown", reason: "quit" }, undefined);
        assert.ok(!registry()?.bySession.has(sid), "entry gone after session_shutdown");
    } finally {
        cleanup(sid);
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY; else process.env.BILLION_CONTEXT_PROXY = prevProxy;
        if (prevKill1 === undefined) delete process.env.BILLION_CONTEXT_PLUGIN; else process.env.BILLION_CONTEXT_PLUGIN = prevKill1;
        if (prevKill2 === undefined) delete process.env.BILI_NATIVE_PI; else process.env.BILI_NATIVE_PI = prevKill2;
    }
});

test("#2185: factory wiring — kill switch respected at session_start; omp never registers", async () => {
    const prevKill = process.env.BILLION_CONTEXT_PLUGIN;
    const sid = uniqueSid();
    try {
        process.env.BILLION_CONTEXT_PLUGIN = "0";
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        for (const handler of pi.events.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => sid } });
        assert.ok(!registry()?.bySession.has(sid), "kill switch: no registration");

        delete process.env.BILLION_CONTEXT_PLUGIN;
        const ompPi = makeFakePi();
        createBiliPlugin("omp")(ompPi as never);
        for (const handler of ompPi.events.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => sid } });
        assert.ok(!registry()?.bySession.has(sid), "omp lane must not touch the pi-subagents registry");
    } finally {
        cleanup(sid);
        if (prevKill === undefined) delete process.env.BILLION_CONTEXT_PLUGIN; else process.env.BILLION_CONTEXT_PLUGIN = prevKill;
    }
});
