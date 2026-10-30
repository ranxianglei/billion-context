import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The module-level guard reads NODE_TEST_CONTEXT while the module EVALUATES,
// and static imports hoist above any assignment — so the value must be set
// first and the module loaded dynamically.
process.env.NODE_TEST_CONTEXT = "1";
// #1365: legacy dead-attach suites must not pay the 5s routed-evidence grace
// default (same waitFor-cap race as dsh-native.test.ts). Pinned-path tests
// override per-test.
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";

// #2831: route diagnostics now land in the shared bili.log instead of the
// terminal the live TUI renders over — hermetic like native-intercept-selfheal.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc-native-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const NATIVE_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

import type { NativeInterceptState } from "../src/agent/native-intercept.ts";
import type { V2HttpRequestEvent, V2PluginContext, V2State } from "../src/agent/opencode-v2.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";

const { shouldBootstrapNativeOpencode, createNativeRoute, planNativeOpencode, armNativeOpencode, verifyAttachAndRecover, wireBodyMediaBytes, _resetNativeStateForTest, _setSpawnForTest, _stateRespawnForTest, _noteRoutedForTest } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");
const { markNativeHost, nativeAttachOrigin } = await import("../src/agent/native-bootstrap.ts");
const nativeDefault = (await import("../src/agent/opencode-native.ts")).default;

const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// #3501: a dev shell running opencode through a launcher exports a live attach
// target; verifyAttachAndRecover reads BILLION_CONTEXT_ATTACH explicitly, so
// every suite below must start from a clean slate or it silently binds to the
// real proxy instead of the mock it set up.
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

// The diagnostic contract: the marker reaches bili.log AND nothing carrying it
// reaches any terminal surface (console.* or raw stdout/stderr).
async function withLogCapture<T>(fn: () => Promise<T>, marker: string): Promise<{ result: T; file: string[]; terminal: string[] }> {
    const termLines: string[] = [];
    const origError = console.error, origWarn = console.warn, origLog = console.log;
    const sink = (...args: unknown[]) => { termLines.push(args.map(String).join(" ")); };
    console.error = sink;
    console.warn = sink;
    console.log = sink;
    const before = fs.existsSync(NATIVE_LOG_FILE) ? fs.readFileSync(NATIVE_LOG_FILE, "utf8") : "";
    let result!: T;
    try {
        result = await fn();
    } finally {
        console.error = origError;
        console.warn = origWarn;
        console.log = origLog;
    }
    const after = fs.readFileSync(NATIVE_LOG_FILE, "utf8");
    return {
        result,
        file: after.slice(before.length).split("\n").filter((l) => l.length > 0 && l.includes(marker)),
        terminal: termLines.filter((l) => l.includes(marker)),
    };
}

test("shouldBootstrapNativeOpencode: true in a bare host with no bili env", () => {
    assert.equal(shouldBootstrapNativeOpencode({}), true);
});

test("shouldBootstrapNativeOpencode: false when the plugin or native mode is opted out", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), false);
});

test("shouldBootstrapNativeOpencode: false when a bili launch already owns a proxy", () => {
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }), false);
    assert.equal(shouldBootstrapNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }), true);
    assert.equal(shouldBootstrapNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), false);
});

test("native entry exports an OpenCode 2.x plugin object", () => {
    assert.equal(nativeDefault.id, "billion-context-opencode-native");
    assert.equal(typeof nativeDefault.setup, "function");
});

// #820 coexistence: the standalone opencode-acp extension must see this marker
// at its action-time check even though our bootstrap writes BILLION_CONTEXT_PROXY
// only later (async) and its /bili/ baseUrl check never sees our rewrite.
test("module evaluation marks the process as a native opencode host", () => {
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "opencode");
});

test("markNativeHost: sets when unset, first writer wins", () => {
    const env: NodeJS.ProcessEnv = {};
    markNativeHost(env, "pi");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    markNativeHost(env, "opencode");
    assert.equal(env.BILLION_CONTEXT_NATIVE, "pi");
    const blank: NodeJS.ProcessEnv = { BILLION_CONTEXT_NATIVE: "" };
    markNativeHost(blank, "omp");
    assert.equal(blank.BILLION_CONTEXT_NATIVE, "omp");
});

test("route: healthy origin rewrites the request reference and records proxyBase", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const body = JSON.stringify({ messages: [] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_1",
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body }),
    };
    await route(e, s);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.method, "POST");
    assert.equal(out.headers.get("authorization"), "Bearer x");
    assert.equal(await out.text(), body);
    assert.equal(s.proxyBase, origin);
});

test("route: non-model-API and already-routed URLs are left untouched", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const plain = new Request("https://github.com/repos");
    const e1: V2HttpRequestEvent = { request: plain };
    await route(e1, s);
    assert.equal(e1.request, plain);
    const routed = new Request(`${origin}/bili/${MODEL_URL}`);
    const e2: V2HttpRequestEvent = { request: routed };
    await route(e2, s);
    assert.equal(e2.request, routed);
    assert.equal(s.proxyBase, undefined);
});

test("route: waits for a pending bootstrap before routing", async () => {
    let release!: (o: string) => void;
    const state: NativeInterceptState = { origin: undefined, ready: new Promise<string | undefined>((r) => (release = r)) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    const pending = route(e, s);
    release("http://127.0.0.1:4321");
    await pending;
    assert.equal((e.request as Request).url, `http://127.0.0.1:4321/bili/${MODEL_URL}`);
});

test("route: failed bootstrap sends direct with a single warning (no respawn wired)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const { file, terminal } = await withLogCapture(async () => {
        const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e1, s);
        assert.equal((e1.request as Request).url, MODEL_URL);
        const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e2, s);
        assert.equal((e2.request as Request).url, MODEL_URL);
        assert.equal(s.proxyBase, undefined);
    }, "bili-native-opencode");
    assert.equal(file.length, 1);
    assert.equal(terminal.length, 0, "#2831: the diagnostic must not reach the terminal surface");
});

test("route: dead origin respawns once and routes to the replacement", async () => {
    const dead = "http://127.0.0.1:1111";
    const live = "http://127.0.0.1:2222";
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            state.origin = live;
            return live;
        },
    };
    const route = createNativeRoute(state, { probe: async (o) => o === live });
    const s: V2State = {};
    const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${live}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, live);
});

test("route: failed respawn fires onGiveUp once and holds direct (cooldown suppresses re-spawn)", async () => {
    const dead = "http://127.0.0.1:1111";
    let gaveUp = 0;
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => {
            respawns++;
            return undefined;
        },
        onGiveUp: () => {
            gaveUp++;
        },
    };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal((e1.request as Request).url, MODEL_URL);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(gaveUp, 1);
    assert.equal(respawns, 1);
});

test("route: load-time bootstrap failure retries after the cooldown only", async () => {
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        respawn: async () => {
            respawns++;
            return undefined;
        },
    };
    const route = createNativeRoute(state, { probe: async () => true, respawnCooldownMs: 10 });
    const s: V2State = {};
    const e1: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e1, s);
    assert.equal(respawns, 1);
    const e2: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e2, s);
    assert.equal(respawns, 1);
    await sleep(15);
    const e3: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(e3, s);
    assert.equal(respawns, 2);
});

test("setup(route): header stamping applies to the REPLACED request, tools register natively", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }> = [];
    const tools: string[] = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (name, cb) => {
                hooks.push({ name, cb });
                return Promise.resolve({ dispose() {} });
            },
        },
        tool: {
            transform: (add) => {
                add({ add: (t) => tools.push(t.name) });
                return Promise.resolve({ dispose() {} });
            },
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    assert.deepEqual(hooks.map((h) => h.name), ["http.request", "experimental.ws.handshake"]);
    assert.deepEqual(tools.sort(), [...EXPECTED_TOOLS].sort());
    const e: V2HttpRequestEvent = {
        sessionID: "ses_abc",
        model: { providerID: "anthropic", id: "claude-x" },
        request: new Request(MODEL_URL, { method: "POST" }),
    };
    await hooks[0].cb(e);
    const out = e.request as Request;
    assert.equal(out.url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(out.headers.get("x-bili-plugin-conversation"), "ses_abc");
    assert.equal(out.headers.get("x-bili-plugin"), "opencode");
    cleanup();
});

test("setup(route): kill switch keeps the hook fully inert", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const hooks: Array<(e: V2HttpRequestEvent) => void | Promise<void>> = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (_name, cb) => {
                hooks.push(cb);
                return Promise.resolve({ dispose() {} });
            },
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) });
    const cleanup = await setup(ctx);
    process.env.BILLION_CONTEXT_PLUGIN = "0";
    try {
        const req = new Request(MODEL_URL);
        const e: V2HttpRequestEvent = { sessionID: "ses_x", request: req };
        await hooks[0](e);
        assert.equal(e.request, req);
    } finally {
        delete process.env.BILLION_CONTEXT_PLUGIN;
        cleanup();
    }
});

test("nativeAttachOrigin: unset/blank/malformed/non-http(s) all resolve to undefined", () => {
    assert.equal(nativeAttachOrigin({}), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "   " }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "not a url" }), undefined);
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "ftp://127.0.0.1:21" }), undefined);
});

test("nativeAttachOrigin: normalizes a valid http(s) origin (trailing slash stripped)", () => {
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787///" }), "http://127.0.0.1:8787");
    assert.equal(nativeAttachOrigin({ BILLION_CONTEXT_ATTACH: "  https://proxy.example.com/ " }), "https://proxy.example.com");
});

test("planNativeOpencode: default is inline; opt-out and /bili/ launches are off", () => {
    // #3278 port: the opencode lane defaults to in-process compression (same
    // flip as the pi lane) — spawn only survives as an explicit opt-out.
    assert.deepEqual(planNativeOpencode({}), { mode: "spawn" }, "default stays spawn (no default flip — owner decision on #4687)");
    assert.deepEqual(planNativeOpencode({}, false), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({}, true), { mode: "inline" });
    assert.deepEqual(planNativeOpencode({ BILI_OPENCODE_INLINE: "1" }, false), { mode: "inline" });
    assert.deepEqual(planNativeOpencode({ BILI_OPENCODE_INLINE: "yes" }), { mode: "inline" });
    for (const off of ["", "0", "false", "no", "off"]) {
        assert.deepEqual(planNativeOpencode({ BILI_OPENCODE_INLINE: off }, true), { mode: "spawn" }, `BILI_OPENCODE_INLINE=${JSON.stringify(off)}`);
    }
    // a garbage env value is a PRESENCE choice for inline (never silently off)
    assert.deepEqual(planNativeOpencode({ BILI_OPENCODE_INLINE: "garbage" }), { mode: "inline" });
    assert.deepEqual(planNativeOpencode({ BILI_OPENCODE_INLINE: "0" }), { mode: "spawn" }, "explicit off without attach target ⇒ spawn");
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_NATIVE_OPENCODE: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), { mode: "off" });
});

test("planNativeOpencode: a preset BILLION_CONTEXT_PROXY is an attach target, not a stand-down", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    // kill switches and a /bili/ launch still win over the preset
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // an announced attach target beats the DEFAULT inline, but an explicit
    // inline choice (env or file) always wins over attach
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_OPENCODE_INLINE: "1" }), { mode: "inline" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }, true), { mode: "inline" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_OPENCODE_INLINE: "0" }), { mode: "attach", attachOrigin: "http://127.0.0.1:36485" }, "inline opted out + announced target ⇒ attach");
    // a garbage preset falls back to self-management — inline by default now —
    // rather than dead-off
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "garbage" }), { mode: "spawn" });
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_PROXY: "  " }, false), { mode: "spawn" });
});

test("planNativeOpencode: attach wins over spawn when no launcher owns the proxy", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000/" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
    assert.deepEqual(planNativeOpencode({ BILLION_CONTEXT_ATTACH: "garbage" }), { mode: "spawn" });
});

test("planNativeOpencode: explicit BILLION_CONTEXT_ATTACH wins over the env preset", () => {
    assert.deepEqual(
        planNativeOpencode({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
});

test("native route: attach mode routes model traffic through the external proxy", async () => {
    const origin = "http://10.0.0.5:9000";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin,
        ready: Promise.resolve(origin),
        respawn: async () => {
            respawnCalls++;
            return undefined;
        },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const e: V2HttpRequestEvent = { sessionID: "ses_a", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal((e.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(s.proxyBase, origin);
    assert.equal(respawnCalls, 0);
});

// #1135: the old fail-closed semantics are gone — with no respawn wired the
// dead target degrades to DIRECT sends (session survives, compression lost)
// instead of failing every request forever.
test("native route: attach mode degrades to direct when the external proxy is down and no respawn is wired", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const { file, terminal } = await withLogCapture(async () => {
        const route = createNativeRoute(state, { probe: async () => false });
        await route({ sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) }, s);
        const second: V2HttpRequestEvent = { sessionID: "ses_b", request: new Request(MODEL_URL, { method: "POST" }) };
        await route(second, s);
        assert.equal((second.request as Request).url, MODEL_URL, "dead target without respawn sends direct, not into the dead port");
        assert.equal(s.proxyBase, undefined);
    }, "proxy unavailable");
    assert.equal(file.length, 1, "expected exactly one unavailability diagnostic in bili.log");
    assert.equal(terminal.length, 0, "#2831: the diagnostic must not reach the terminal surface");
});

test("native route: attach mode respawns on runtime death and routes to the replacement (#1135)", async () => {
    const ext = "http://10.0.0.5:9000";
    const spawned = "http://127.0.0.1:4321";
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin: ext,
        ready: Promise.resolve(ext),
        respawn: async () => {
            respawnCalls++;
            state.origin = spawned;
            return spawned;
        },
    };
    const probe = async (o: string) => o !== ext;
    const s: V2State = {};
    const route = createNativeRoute(state, { probe });
    const e: V2HttpRequestEvent = { sessionID: "ses_d", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal(respawnCalls, 1, "one respawn per death");
    assert.equal((e.request as Request).url, `${spawned}/bili/${MODEL_URL}`, "request re-routed to the replacement");
    assert.equal(s.proxyBase, spawned);
    // next request fast-paths through the landed origin
    const e2: V2HttpRequestEvent = { sessionID: "ses_d", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e2, s);
    assert.equal(respawnCalls, 1, "no re-spawn while the replacement is healthy");
    assert.equal((e2.request as Request).url, `${spawned}/bili/${MODEL_URL}`);
});

// #3308: the degrade branch must apply the #2924 ruling — a body that
// provably cannot fit the model's window is refused locally instead of riding
// the direct fallback into a guaranteed upstream 400 (which on an over-window
// session history then repeats on every later turn until restart).
test("route: proxy down + body provably over the model window throws a local refusal", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_ow",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    await assert.rejects(route(e, s), /proxy unavailable/);
    assert.equal((e.request as Request).url, MODEL_URL, "refused request is not rewritten");
    assert.equal(s.proxyBase, undefined);
    assert.equal(await (e.request as Request).text(), body, "measuring through the clone leaves the original body sendable");
});

for (const unavailable of ["dead", "busy-exhausted"] as const) {
    test(`#4121 route: ${unavailable} excludes inline images from the direct-refusal text floor`, async (t) => {
        const b64 = "A".repeat(8_000);
        const dataUrl = `data:image/png;base64,${b64}`;
        const bodies = {
            openai: { messages: [{ role: "user", content: [{ type: "text", text: "Describe this image." }, { type: "image_url", image_url: { url: dataUrl } }] }] },
            responses: { input: [{ role: "user", content: [{ type: "input_text", text: "Describe this image." }, { type: "input_image", image_url: dataUrl }] }] },
            anthropic: { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }] }] },
        };
        for (const [wire, payload] of Object.entries(bodies)) {
            await t.test(wire, async () => {
                const state: NativeInterceptState = { origin: "http://127.0.0.1:1", ready: Promise.resolve(undefined) };
                const route = createNativeRoute(state, { probe: async () => ({ state: unavailable === "busy-exhausted" ? "busy" : "dead" }), busyWaitCapMs: 0 });
                const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
                const body = JSON.stringify(payload);
                assert.ok(Buffer.byteLength(body) / 4 > 1_000, "the raw-byte floor would refuse this image-heavy request");
                const e: V2HttpRequestEvent = {
                    model: { providerID: "prov", id: "model-x" },
                    request: new Request(MODEL_URL, { method: "POST", body }),
                };
                await route(e, s);
                assert.equal(state.lastUnavailableReason, unavailable);
                assert.equal((e.request as Request).url, MODEL_URL);
                assert.equal(s.proxyBase, undefined);
                assert.equal(await (e.request as Request).text(), body, "direct fallback preserves the original body");
            });
        }
    });

    test(`#4121 route: ${unavailable} still refuses over-window text with or without media`, async (t) => {
        const dataUrl = `data:image/png;base64,${"A".repeat(8_000)}`;
        const text = "x".repeat(5_000);
        const bodies = {
            text: JSON.stringify({ messages: [{ role: "user", content: text }] }),
            mixed: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: dataUrl } }] }] }),
            pasted_data_url: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: dataUrl }] }] }),
            malformed: `{"messages":[${text}`,
        };
        for (const [name, body] of Object.entries(bodies)) {
            await t.test(name, async () => {
                const state: NativeInterceptState = { origin: "http://127.0.0.1:1", ready: Promise.resolve(undefined) };
                const route = createNativeRoute(state, { probe: async () => ({ state: unavailable === "busy-exhausted" ? "busy" : "dead" }), busyWaitCapMs: 0 });
                const e: V2HttpRequestEvent = {
                    model: { providerID: "prov", id: "model-x" },
                    request: new Request(MODEL_URL, { method: "POST", body }),
                };
                const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
                await assert.rejects(route(e, s), unavailable === "busy-exhausted" ? /proxy alive but unresponsive/ : /proxy unavailable/);
                assert.equal(state.lastUnavailableReason, unavailable);
                assert.equal((e.request as Request).url, MODEL_URL);
                assert.equal(await (e.request as Request).text(), body);
            });
        }
    });
}

// #4912: a body past V8's max string length (~536MB; #3128 admits up to 5GiB)
// cannot be decoded — the RangeError used to escape the route handler. Now an
// undecodable body gets no media credit (all-core-text pricing, the same
// convention as non-JSON bodies) and the arm refuses cleanly. The decoder is
// injectable so the seam is testable without allocating a multi-GB buffer.
test("#4912 wireBodyMediaBytes: decodable body still credits inline media", () => {
    const b64 = "A".repeat(8_000);
    const raw = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }] });
    const buf = new TextEncoder().encode(raw).buffer as ArrayBuffer;
    assert.equal(wireBodyMediaBytes(buf), Buffer.byteLength(`data:image/png;base64,${b64}`));
});

test("#4912 wireBodyMediaBytes: undecodable body credits no media instead of throwing", () => {
    const buf = new ArrayBuffer(16);
    assert.equal(wireBodyMediaBytes(buf, () => { throw new RangeError("Invalid string length"); }), 0);
    assert.equal(wireBodyMediaBytes(buf, () => { throw new TypeError("boom"); }), 0);
});

test("#4912 route: undecodable over-window body refuses cleanly instead of escaping a RangeError", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_4912",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    const RealTextDecoder = globalThis.TextDecoder;
    globalThis.TextDecoder = class {
        decode(): string { throw new RangeError("Invalid string length"); }
    } as unknown as typeof TextDecoder;
    try {
        await assert.rejects(route(e, s), (err: unknown) => {
            assert.ok(err instanceof Error && !(err instanceof RangeError), "clean local refusal Error, not the escaped RangeError");
            assert.match(err.message, /proxy unavailable/);
            return true;
        });
    } finally {
        globalThis.TextDecoder = RealTextDecoder;
    }
    assert.equal(s.proxyBase, undefined);
    assert.equal(await (e.request as Request).text(), body, "measuring through the clone leaves the original body sendable");
});

test("route: proxy down + under-window body keeps the fail-open direct send", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => false });
    const s: V2State = { windows: new Map([["prov/model-x", 1_000_000]]) };
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const e: V2HttpRequestEvent = {
        sessionID: "ses_uw",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
    };
    await route(e, s);
    assert.equal((e.request as Request).url, MODEL_URL);
    assert.equal(s.proxyBase, undefined);
});

test("route: proxy down + unknown or mismatched window keeps the fail-open direct send (no false refusal)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const route = createNativeRoute(state, { probe: async () => false });
    const bigBody = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
    // no window map at all (bootstrap never landed, catalog never harvested)
    const s1: V2State = {};
    const e1: V2HttpRequestEvent = {
        sessionID: "ses_nw",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: bigBody }),
    };
    await route(e1, s1);
    assert.equal((e1.request as Request).url, MODEL_URL);
    // window known for a DIFFERENT model — this model's window is still unknown
    const s2: V2State = { windows: new Map([["other/model-y", 1_000]]) };
    const e2: V2HttpRequestEvent = {
        sessionID: "ses_mm",
        model: { providerID: "prov", id: "model-x" },
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: bigBody }),
    };
    await route(e2, s2);
    assert.equal((e2.request as Request).url, MODEL_URL);
    // no model info on the event — cannot attribute a window
    const s3: V2State = { windows: new Map([["prov/model-x", 1_000]]) };
    const e3: V2HttpRequestEvent = {
        sessionID: "ses_nm",
        request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: bigBody }),
    };
    await route(e3, s3);
    assert.equal((e3.request as Request).url, MODEL_URL);
});

test("setup(route): window priming before the route arms the refusal on a fresh degraded session", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }> = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (name, cb) => {
                hooks.push({ name, cb });
                return Promise.resolve({ dispose() {} });
            },
        },
        model: {
            list: () => Promise.resolve({ data: [{ providerID: "prov", id: "model-x", limit: { context: 1_000 } }] }),
        },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => false }) });
    const cleanup = await setup(ctx);
    try {
        const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
        const e: V2HttpRequestEvent = {
            sessionID: "ses_prim",
            model: { providerID: "prov", id: "model-x" },
            request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
        };
        // The harvest commits on microtasks ahead of the route's own awaits,
        // so even the FIRST request of a never-bootstrapped session is refused
        // once the catalog answers fast (#3308 priming order).
        await assert.rejects(async () => { await hooks[0].cb(e); }, /proxy unavailable/);
        assert.equal((e.request as Request).url, MODEL_URL);
    } finally {
        cleanup();
    }
});

test("setup(route): empty catalog keeps the fail-open direct send (no false refusal)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
    const hooks: Array<{ name: string; cb: (e: V2HttpRequestEvent) => void | Promise<void> }> = [];
    const ctx: V2PluginContext = {
        session: {
            hook: (name, cb) => {
                hooks.push({ name, cb });
                return Promise.resolve({ dispose() {} });
            },
        },
        model: { list: () => Promise.resolve({ data: [] }) },
    };
    const setup = createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => false }) });
    const cleanup = await setup(ctx);
    try {
        const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(5_000) }] });
        const e: V2HttpRequestEvent = {
            sessionID: "ses_empty",
            model: { providerID: "prov", id: "model-x" },
            request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body }),
        };
        await hooks[0].cb(e);
        assert.equal((e.request as Request).url, MODEL_URL);
        assert.equal((e.request as Request).headers.get("x-bili-plugin"), null, "degraded request stays unstamped");
    } finally {
        cleanup();
    }
});

test("native route: attach mode transient blip re-attaches to the SAME origin (no migration, #1135)", async () => {
    const ext = "http://10.0.0.5:9000";
    let up = false;
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        attach: true,
        origin: ext,
        ready: Promise.resolve(ext),
        respawn: async () => {
            respawnCalls++;
            up = true;
            state.origin = ext;
            return ext;
        },
    };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => up, probeTtlMs: 0 });
    const e: V2HttpRequestEvent = { sessionID: "ses_e", request: new Request(MODEL_URL, { method: "POST" }) };
    await route(e, s);
    assert.equal(respawnCalls, 1);
    assert.equal((e.request as Request).url, `${ext}/bili/${MODEL_URL}`, "re-attached to the same origin");
    assert.equal(state.origin, ext);
    assert.equal(s.proxyBase, ext);
});

test("native route: attach mode leaves non-model requests untouched", async () => {
    const origin = "http://10.0.0.5:9000";
    const state: NativeInterceptState = { attach: true, origin, ready: Promise.resolve(origin) };
    const s: V2State = {};
    const route = createNativeRoute(state, { probe: async () => true });
    const req = new Request("https://api.anthropic.com/v1/models", { method: "GET" });
    const e: V2HttpRequestEvent = { sessionID: "ses_c", request: req };
    await route(e, s);
    assert.equal(e.request, req);
    assert.equal(s.proxyBase, undefined);
});

test("#1135 wiring: attach arms runtime recovery; a dead target falls back to a spawned proxy", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7777";
        });
        armNativeOpencode({ mode: "attach", attachOrigin: "http://127.0.0.1:9" });
        assert.equal(typeof _stateRespawnForTest(), "function", "respawn seam armed at load");
        // port 9 refuses connections instantly — the manifest probe fails fast,
        // the fallback spawn lands and replaces the env origin
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, "http://127.0.0.1:7777");
        assert.ok(spawned >= 1);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:7777");
    } finally {
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

test("#1135 wiring: a healthy attach target stays attached (no migration, no spawn)", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    const server = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ version: "0.1.134" }));
            return;
        }
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7778";
        });
        armNativeOpencode({ mode: "attach", attachOrigin: `http://127.0.0.1:${port}` });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, `http://127.0.0.1:${port}`, "healthy target resolves to itself");
        assert.equal(spawned, 0, "no fallback spawn for a healthy target");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, `http://127.0.0.1:${port}`);
    } finally {
        server.close();
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

// #928: the health verdict is TTL-cached per origin. Steady-state requests must
// reuse the last result instead of paying a loopback RTT on every request.
test("route: healthy origin triggers a single health probe across N steady-state requests (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return true; }, probeTtlMs: 10_000 });
    const s: V2State = {};
    for (let i = 0; i < 5; i++) {
        const e: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
        await route(e, s);
        assert.equal((e.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    }
    assert.equal(calls, 1, "expected exactly one probe for N requests within the TTL");
});

test("route: re-probes once the probe TTL elapses rather than latching forever (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return true; }, probeTtlMs: 20 });
    const s: V2State = {};
    await route({ request: new Request(MODEL_URL) }, s);
    assert.equal(calls, 1);
    await sleep(45);
    await route({ request: new Request(MODEL_URL) }, s);
    assert.equal(calls, 2, "expected a fresh probe after the TTL elapsed");
});

test("route: a proxy that dies is detected within one TTL and degrades to direct (#928)", async () => {
    const origin = "http://127.0.0.1:9999";
    let alive = true;
    let calls = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => { calls++; return alive; }, probeTtlMs: 30 });
    const s: V2State = {};
    const up: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(up, s);
    assert.equal((up.request as Request).url, `${origin}/bili/${MODEL_URL}`);
    assert.equal(calls, 1);
    alive = false;
    await sleep(45);
    const down: V2HttpRequestEvent = { request: new Request(MODEL_URL) };
    await route(down, s);
    assert.equal((down.request as Request).url, MODEL_URL, "expected an unrewritten (direct) request after the proxy died");
    assert.ok(calls >= 2, "expected a re-probe within one TTL that observed the dead proxy");
});

// — #1365: pinned model channel — never spawn over a statically-routed target —

async function reserveLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address() as AddressInfo;
            srv.close(() => resolve(addr.port));
        });
        srv.on("error", reject);
    });
}

test("#1365 verifyAttachAndRecover: routed evidence pins the channel — waits the target back, never spawns", async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "0.1.119", tools: {} }));
    });
    let spawnCalls = 0;
    let upTimer: NodeJS.Timeout | undefined;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawnCalls += 1;
            return "http://127.0.0.1:2";
        });
        process.env.BILLION_CONTEXT_PROXY = origin;
        _noteRoutedForTest(`${origin}/bili/${MODEL_URL}`);
        const pending = verifyAttachAndRecover(origin);
        upTimer = setTimeout(() => server.listen(port, "127.0.0.1"), 120);
        const recovered = await pending;
        clearTimeout(upTimer);
        assert.equal(recovered, origin, "recovery lands back on the pinned origin");
        assert.equal(spawnCalls, 0, "no second instance may be spawned over a pinned channel");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the user's target stays frozen");
    } finally {
        clearTimeout(upTimer);
        server.close();
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

test("#1365 route: already-routed /bili/ URLs record pinned-channel evidence before the model-URL gate", async () => {
    const origin = "http://127.0.0.1:9999";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const route = createNativeRoute(state, { probe: async () => true });
    const s: V2State = {};
    const routed = new Request(`${origin}/bili/${MODEL_URL}`);
    const e: V2HttpRequestEvent = { request: routed };
    await route(e, s);
    assert.equal(e.request, routed, "already-routed requests stay untouched");
    assert.equal(state.routedOrigin, origin, "routed traffic records the pinned channel even though isModelApiUrl skips it");
});

test("#1365 verifyAttachAndRecover: persistently dead pinned target — refuses to spawn, keeps the env", async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    let spawnCalls = 0;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawnCalls += 1;
            return "http://127.0.0.1:2";
        });
        process.env.BILLION_CONTEXT_PROXY = origin;
        process.env.BILI_ATTACH_HEALTH_DEADLINE_MS = "150";
        _noteRoutedForTest(`${origin}/bili/${MODEL_URL}`);
        const recovered = await verifyAttachAndRecover(origin);
        assert.equal(recovered, undefined);
        assert.equal(spawnCalls, 0);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the pinned target env must survive");
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
        delete process.env.BILI_ATTACH_HEALTH_DEADLINE_MS;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

// — #3501: an explicit attach endpoint stays authoritative over routed model-origin evidence —

test("#3501 verifyAttachAndRecover: planted routed evidence from an admin-gated origin does not displace an explicit attach", async () => {
    const attach = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: {} }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise<void>((r) => attach.listen(0, "127.0.0.1", () => r()));
    const attachOrigin = `http://127.0.0.1:${(attach.address() as AddressInfo).port}`;
    let modelManifestRequests = 0;
    const model = createServer((_req, res) => {
        if (_req.url === "/__bili/plugin/manifest") modelManifestRequests += 1;
        res.writeHead(403);
        res.end("Forbidden");
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", () => r()));
    const modelOrigin = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    let spawnCalls = 0;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawnCalls += 1;
            return "http://127.0.0.1:2";
        });
        process.env.BILLION_CONTEXT_ATTACH = attachOrigin;
        _noteRoutedForTest(`${modelOrigin}/bili/${MODEL_URL}`);
        const recovered = await verifyAttachAndRecover(attachOrigin);
        assert.equal(recovered, attachOrigin, "recovery lands on the explicit endpoint, not the model-only origin");
        assert.equal(spawnCalls, 0, "no second instance over an API-only model route");
        assert.equal(modelManifestRequests, 0, "planted model-route evidence must not override explicit attach");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, attachOrigin);
    } finally {
        attach.closeAllConnections?.();
        attach.close();
        model.closeAllConnections?.();
        model.close();
        delete process.env.BILLION_CONTEXT_ATTACH;
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

test("#3501 wiring: late routed evidence from an admin-gated origin does not rebind away from a healthy explicit attach", async () => {
    const attach = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: {} }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise<void>((r) => attach.listen(0, "127.0.0.1", () => r()));
    const attachOrigin = `http://127.0.0.1:${(attach.address() as AddressInfo).port}`;
    let modelManifestRequests = 0;
    const model = createServer((_req, res) => {
        if (_req.url === "/__bili/plugin/manifest") modelManifestRequests += 1;
        res.writeHead(403);
        res.end("Forbidden");
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", () => r()));
    const modelOrigin = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    let spawned = 0;
    try {
        _resetNativeStateForTest();
        _setSpawnForTest(async () => {
            spawned += 1;
            return "http://127.0.0.1:7777";
        });
        process.env.BILLION_CONTEXT_ATTACH = attachOrigin;
        armNativeOpencode({ mode: "attach", attachOrigin });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, attachOrigin, "healthy explicit target resolves to itself");
        _noteRoutedForTest(`${modelOrigin}/bili/${MODEL_URL}`);
        const deadline = Date.now() + 5000;
        while (modelManifestRequests < 1 && Date.now() < deadline) {
            await sleep(10);
        }
        assert.equal(modelManifestRequests, 1, "the hook liveness-probes the late routed origin exactly once");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, attachOrigin, "a failing probe must not rebind off the healthy explicit endpoint");
        assert.equal(spawned, 0);
    } finally {
        attach.closeAllConnections?.();
        attach.close();
        model.closeAllConnections?.();
        model.close();
        delete process.env.BILLION_CONTEXT_ATTACH;
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

test("#4669 inline arm: state freezes INLINE_ORIGIN and pins the env without spawning anything", async () => {
    const ie = await import("../src/inline-engine.ts");
    ie._setEngineFactoryForTest(async () => { throw new Error("the inline arm must not boot the engine from inside a test"); });
    try {
        _resetNativeStateForTest();
        delete process.env.BILLION_CONTEXT_PROXY;
        armNativeOpencode({ mode: "inline" });
        // The pseudo-origin is published SYNCHRONOUSLY — V2's route and V1's
        // server() resolve it without waiting on a port that does not exist.
        assert.equal(process.env.BILLION_CONTEXT_PROXY, ie.INLINE_ORIGIN);
        assert.equal(typeof _stateRespawnForTest(), "function", "inline mode exposes the engine-boot respawn seam");
        // NODE_TEST_CONTEXT keeps state.ready lazy — the factory above must
        // never have been called (proved by the throw-on-call factory).
        await sleep(50);
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY;
        _resetNativeStateForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#4669 composition: opencode inline chain — rewrites land on the inline engine, never on real DNS", async () => {
    // The production arm (opencode-native.ts module load) installs the inline
    // transport FIRST, then the native fetch intercept ON TOP — the same stack
    // shape as the pi lane (#4527). The intercept rewrites model URLs to
    // `${INLINE_ORIGIN}/bili/<upstream>` and hands them DOWN; the inline link
    // must serve them in-process instead of letting the pseudo-origin hit
    // real DNS (ENOTFOUND billion-context.inline).
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        assert.equal(ni.installNativeFetchIntercept(state), true);
        // A PLAIN model URL — what the opencode host SDK actually calls.
        const r = await fetch(MODEL_URL, { method: "POST", body: "{}" });
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${MODEL_URL}`]);
        // Management URLs take the intercept's control-passthrough branch and
        // must land on the inline engine too (the manifest/status fetches).
        const m = await fetch(`${ie.INLINE_ORIGIN}/__bili/health`);
        assert.equal(m.status, 200);
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${MODEL_URL}`, `${ie.INLINE_ORIGIN}/__bili/health`]);
    } finally {
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ni._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#4669 V2 composition: route rewrite + fetch chain serves INLINE_ORIGIN in-process", async () => {
    // OpenCode 2.x production shape: the http.request route hook REPLACES the
    // outgoing Request's target with `${INLINE_ORIGIN}/bili/<url>`, then the
    // host's own fetch (patched by our chain) sends it. Route rewrite must
    // compose with the inline link exactly like the intercept's own rewrite.
    const ie = await import("../src/inline-engine.ts");
    const ni = await import("../src/agent/native-intercept.ts");
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(input instanceof Request ? input.url : String(input));
            return new Response("inline-ok");
        },
        dispatchHttp: async () => {},
        wsOrigin: Promise.resolve(undefined),
        webOrigin: Promise.resolve(undefined),
    }));
    try {
        ni._resetForTest();
        fc.resetFetchChainForTest();
        piInline._resetInlineTransportForTest();
        piInline.installInlineTransport();
        const state: NativeInterceptState = { origin: ie.INLINE_ORIGIN, ready: Promise.resolve(ie.INLINE_ORIGIN) };
        const route = createNativeRoute(state, { probe: async () => true });
        const e: V2HttpRequestEvent = {
            sessionID: "ses_inline",
            request: new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        };
        await route(e, {});
        assert.equal((e.request as Request).url, `${ie.INLINE_ORIGIN}/bili/${MODEL_URL}`, "route rewrites to the pseudo-origin");
        // The host then sends the rewritten Request through global fetch.
        const r = await fetch(e.request as Request);
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${MODEL_URL}`]);
    } finally {
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ni._resetForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});
