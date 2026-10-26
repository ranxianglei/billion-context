import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { apply, _resetRegisterForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// The node:test runner sets NODE_TEST_CONTEXT itself (see tests/e2e/README.md);
// set it defensively so a direct single-file run also stands down the spawn
// bootstrap and the global fetch intercept.
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function startManifestProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "").startsWith("/__bili/plugin/manifest")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.166", tools: { anthropic: [] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

// #3373: hermetic config isolation — the relay gate reads the real config
// file unless pointed elsewhere; a machine with security.adminRelay on must
// not flip these tests.
function emptyConfigFile(home: string): string {
    const file = path.join(home, "bili-config.json");
    fs.writeFileSync(file, "{}");
    return file;
}

type InjectRow = { kind: string; name?: string; value?: unknown };
type InjectListener = (table: InjectRow[]) => void;

function uiCtx(listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1590" } }) },
        inject: (_deps: readonly string[], _cb: (sub: unknown) => void) => {},
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1590: webserver/index-inject publishes __BILI__ while an origin is known (attach mode)", async () => {
    const proxy = await startManifestProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(proxy.origin);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            // attach mode binds register.base synchronously before the async
            // liveness probe, so a startup-time collection already sees it.
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            // #4237: the payload carries the Context-tab face flags — default
            // (empty config) keeps the tab on, no label key.
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: proxy.origin, contextTab: true } }]);
        });
    } finally {
        proxy.close();
        rmrf(home);
    }
});

test("#1590: index-inject stays silent when no origin is known yet (spawn mode)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(undefined);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, []);
        });
    } finally {
        rmrf(home);
    }
});

type RouteRow = { kind: string; path: string; handler: (req: unknown, res: FakeRes) => void | Promise<void> };

class FakeRes {
    status?: number;
    headers?: Record<string, string>;
    body = "";
    writeHead(status: number, headers?: Record<string, string>): void {
        this.status = status;
        this.headers = headers;
    }
    end(body?: string): void {
        this.body = body ?? "";
    }
}

function routeCtx(routes: RouteRow[], listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
        inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
            cb({ webServer: { register: (r: RouteRow) => routes.push(r) } });
        },
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1809: live /bili/origin route reflects the bound origin", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            // #3373: the panel now registers two routes — the origin probe and
            // the /__bili admin relay (fail-closed while the gate is off).
            assert.equal(routes.length, 2);
            const originRoute = routes.find((r) => r.path === "/bili/origin")!;
            const relayRoute = routes.find((r) => r.path === "/__bili")!;
            assert.equal(originRoute.kind, "exact");
            assert.equal(relayRoute.kind, "prefix");
            const res = new FakeRes();
            await originRoute.handler({}, res);
            assert.equal(res.status, 200);
            assert.equal(res.headers?.["content-type"], "application/json");
            // #4237: same face flags as the snapshot row — default keeps the tab on.
            assert.deepEqual(JSON.parse(res.body), { origin: "http://127.0.0.1:8787", contextTab: true });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: /bili/origin answers null before binding", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(undefined);
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 2);
            const originRoute = routes.find((r) => r.path === "/bili/origin")!;
            const res = new FakeRes();
            await originRoute.handler({}, res);
            // #4237: face flags ride along even before binding.
            assert.deepEqual(JSON.parse(res.body), { origin: null, contextTab: true });
        });
    } finally {
        rmrf(home);
    }
});

test("#4237: __BILI__ snapshot and /bili/origin carry the Context-tab face flags from config", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        const cfgFile = path.join(home, "bili-config.json");
        fs.writeFileSync(cfgFile, JSON.stringify({ dsh: { contextTab: false, contextTabLabel: "压缩账本" } }));
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILI_CONFIG_FILE: cfgFile }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            const listeners: InjectListener[] = [];
            apply(routeCtx(routes, listeners) as Parameters<typeof apply>[0]);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: "http://127.0.0.1:8787", contextTab: false, contextTabLabel: "压缩账本" } }]);
            const res = new FakeRes();
            await routes.find((r) => r.path === "/bili/origin")!.handler({}, res);
            assert.deepEqual(JSON.parse(res.body), { origin: "http://127.0.0.1:8787", contextTab: false, contextTabLabel: "压缩账本" });
        });
    } finally {
        rmrf(home);
    }
});

test("#4237: BILI_DSH_CONTEXT_TAB env overrides the file tier in both directions; blank label falls back to none", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        // file says hide, env says show ⇒ env wins.
        const offFile = path.join(home, "off.json");
        fs.writeFileSync(offFile, JSON.stringify({ dsh: { contextTab: false, contextTabLabel: "   " } }));
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILI_CONFIG_FILE: offFile, BILI_DSH_CONTEXT_TAB: "1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            const listeners: InjectListener[] = [];
            apply(routeCtx(routes, listeners) as Parameters<typeof apply>[0]);
            const table: InjectRow[] = [];
            listeners[0](table);
            // whitespace label normalizes away — no key in the payload.
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: "http://127.0.0.1:8787", contextTab: true } }]);
        });
        // file silent, env says hide ⇒ env wins.
        const onFile = path.join(home, "on.json");
        fs.writeFileSync(onFile, "{}");
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILI_CONFIG_FILE: onFile, BILI_DSH_CONTEXT_TAB: "0" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            const listeners: InjectListener[] = [];
            apply(routeCtx(routes, listeners) as Parameters<typeof apply>[0]);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: "http://127.0.0.1:8787", contextTab: false } }]);
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: route registration rides the injected context's effect lifecycle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            let disposed = 0;
            const effects: Array<{ fn: () => void | (() => void); label?: string }> = [];
            const ctx = {
                tools: { register: (_t: unknown) => {} },
                commands: { register: (_c: unknown) => {} },
                agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
                inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
                    cb({
                        webServer: {
                            register: (r: RouteRow) => {
                                routes.push(r);
                                return (): void => { disposed += 1; };
                            },
                        },
                        effect: (fn: () => void | (() => void), label?: string) => {
                            effects.push({ fn, label });
                        },
                    });
                },
                on: (_event: string, _listener: InjectListener) => {},
            };
            apply(ctx as Parameters<typeof apply>[0]);
            assert.equal(effects.length, 1, "registration must be wrapped in the context effect");
            assert.equal(effects[0].label, "bili: panel routes (origin + admin relay)");
            const cleanup = effects[0].fn();
            assert.equal(routes.length, 2);
            // #3373 review: the effect fn must hand back a combined disposer —
            // dsh calls it on re-run to un-register BOTH routes; returning
            // undefined lets stale duplicates accumulate in the router table.
            assert.equal(typeof cleanup, "function", "the combined disposer doubles as the effect cleanup");
            (cleanup as () => void)();
            assert.equal(disposed, 2);
        });
    } finally {
        rmrf(home);
    }
});

type ElementNode = { type: string; props: Record<string, unknown> | null; children: unknown[] };

function collectText(node: unknown, out: string[]): void {
    if (typeof node === "string") {
        out.push(node);
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return;
    }
    if (node !== null && typeof node === "object") {
        for (const child of (node as ElementNode).children ?? []) collectText(child, out);
    }
}

// The #2321 tab bar passes an ARRAY of buttons as one child, so every walker
// must descend into array children like collectText already does.
function findButton(node: unknown): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findButton(child);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === "button") return el;
        for (const child of el.children ?? []) {
            const hit = findButton(child);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

function findTag(node: unknown, type: string): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findTag(child, type);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === type) return el;
        for (const child of el.children ?? []) {
            const hit = findTag(child, type);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

function collectButtons(node: unknown, out: ElementNode[] = []): ElementNode[] {
    if (Array.isArray(node)) {
        for (const child of node) collectButtons(child, out);
        return out;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === "button") out.push(el);
        for (const child of el.children ?? []) collectButtons(child, out);
    }
    return out;
}

function collectEls(node: unknown, out: ElementNode[] = []): ElementNode[] {
    if (Array.isArray(node)) {
        for (const child of node) collectEls(child, out);
        return out;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        out.push(el);
        for (const child of el.children ?? []) collectEls(child, out);
    }
    return out;
}

// The element whose DIRECT children (including array children) contain an
// element matching pred — used to pin which row parents a given tab.
function findDivParenting(node: unknown, pred: (el: ElementNode) => boolean): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findDivParenting(child, pred);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        for (const child of el.children ?? []) {
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c !== null && typeof c === "object" && pred(c as ElementNode)) return el;
                }
            } else if (child !== null && typeof child === "object" && pred(child as ElementNode)) {
                return el;
            }
        }
        for (const child of el.children ?? []) {
            const hit = findDivParenting(child, pred);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

// One esbuild pass per test file — every scenario below runs the SAME shipped
// wrapper shape (banner/footer/externals sourced from tsup.config.ts).
let clientCodePromise: Promise<string> | undefined;
async function clientCode(): Promise<string> {
    clientCodePromise ??= (async () => {
        const { build } = await import("esbuild");
        const configs = ((await import("../tsup.config.ts")).default) as unknown as Array<{
            entry: Record<string, string>;
            platform: string;
            target: string;
            external?: string[];
            banner?: { js?: string };
            footer?: { js?: string };
        }>;
        const cfg = configs.find((c) => c.entry["agent/dsh-native-client"] !== undefined);
        assert.ok(cfg !== undefined, "tsup config must keep the dsh client entry");
        const result = await build({
            entryPoints: [cfg.entry["agent/dsh-native-client"]],
            bundle: true,
            format: "cjs",
            platform: cfg.platform as Parameters<typeof build>[0]["platform"],
            target: cfg.target,
            external: cfg.external,
            banner: cfg.banner,
            footer: cfg.footer,
            write: false,
        });
        assert.equal(result.outputFiles!.length, 1);
        return result.outputFiles![0].text;
    })();
    return clientCodePromise;
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

// #3100: what a CURRENT server answers for the exact framed URL — a 200 with
// an HTML content type (older builds answer the query form with a JSON 404).
const htmlOk = () => ({ ok: true, headers: { get: (_k: string) => "text/html; charset=utf-8" } });

type Face = { inject: string[]; apply: (ctx: unknown) => void };

type Mounted = {
    component: () => unknown;
    resetHooks: () => void;
    runCleanups: () => void;
    pendingTimers: () => number;
    inject: string[];
    slotsOrder: string[];
    optionsBySlot: Map<string, Record<string, unknown>>;
    dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }>;
};

// #4432: mounts whose owning test throws never reach runCleanups(); this
// drain runs after EVERY test so an abandoned mount's clock/effects release
// and a failing assertion can never hang the file process.
const liveMounts = new Set<Mounted>();
const drainAbandonedMounts = (): void => {
    for (const m of [...liveMounts]) m.runCleanups();
};
after(() => drainAbandonedMounts());

// Mounts the client bundle in a fresh vm realm (one page load) with the given
// globals. React hooks are emulated with per-mount state: useState persists
// across renders, useEffect follows React semantics (#2288) — run on mount,
// re-run only when their deps change (prior cleanup first).
async function mountClient(extra: Record<string, unknown>, slotName = "settings.section", renderProps?: unknown): Promise<Mounted> {
    const code = await clientCode();
    const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
    const sandbox: Record<string, unknown> = {};
    sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
    // #4432: the mounted client schedules HOST timers through the injected
    // sandbox clock (origin-probe slow phase, etc.). A test that fails
    // mid-flight never reaches its runCleanups() call, and the abandoned
    // chain kept the file process alive forever — every CI leg holding this
    // file hung to the job timeout. Wrap the clock so every handle is
    // tracked and released on cleanup; the file-level drain guarantees the
    // release even when the owning test throws.
    const hostSetTimeout = (typeof extra.setTimeout === "function" ? extra.setTimeout : setTimeout) as (fn: () => void, ms?: number) => NodeJS.Timeout;
    const hostClearTimeout = (typeof extra.clearTimeout === "function" ? extra.clearTimeout : clearTimeout) as (h?: NodeJS.Timeout) => void;
    const sandboxTimers = new Set<NodeJS.Timeout>();
    const trackedSetTimeout = (fn: (...a: unknown[]) => unknown, ms?: number): NodeJS.Timeout => {
        const handle: NodeJS.Timeout = hostSetTimeout(() => {
            sandboxTimers.delete(handle);
            fn();
        }, ms);
        sandboxTimers.add(handle);
        return handle;
    };
    const trackedClearTimeout = (h?: NodeJS.Timeout): void => {
        if (h !== undefined) sandboxTimers.delete(h);
        hostClearTimeout(h);
    };
    Object.assign(sandbox, extra, { setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout });
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
    assert.equal(registrations.length, 1);
    // Must equal the loader entry name the scanner keys its graph row by.
    assert.equal(registrations[0].id, "billion-context");
    type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };
    let hookStates: unknown[] = [];
    let hookIndex = 0;
    let effectSlots: EffectSlot[] = [];
    const reactStub = {
        createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => ({ type, props, children }),
        useState: (init: unknown): [unknown, (v: unknown) => void] => {
            const i = hookIndex++;
            if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
            // React's setState also takes an updater function — emulate it, or
            // components using setX(x => x+1) would store the closure itself.
            return [hookStates[i], (v: unknown) => { hookStates[i] = typeof v === "function" ? (v as (prev: unknown) => unknown)(hookStates[i]) : v; }];
        },
        useEffect: (fn: () => unknown | (() => void), deps?: readonly unknown[]): void => {
            const i = hookIndex++;
            const prev = effectSlots[i];
            const prevDeps = prev?.deps;
            const unchanged = prevDeps !== undefined && deps !== undefined &&
                deps.length === prevDeps.length && deps.every((d, j) => Object.is(d, prevDeps[j]));
            if (unchanged) return;
            prev?.cleanup?.();
            const r = fn();
            effectSlots[i] = { deps, cleanup: typeof r === "function" ? (r as () => void) : undefined };
        },
    };
    const requireStub = (spec: string): unknown => {
        if (spec === "react") return reactStub;
        throw new Error(`unexpected external require: ${spec}`);
    };
    const face = registrations[0].factory(requireStub) as Face;
    // Re-materialize in the host realm: vm-context arrays carry the sandbox's
    // Array.prototype, which deepStrictEqual rejects.
    const inject = Array.from(face.inject);
    assert.equal(typeof face.apply, "function");
    const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
    const slotsOrder: string[] = [];
    const optionsBySlot = new Map<string, Record<string, unknown>>();
    const components = new Map<string, () => unknown>();
    let current: string | undefined;
    face.apply({
        effect: (fn: () => void) => fn(),
        locale: {
            register: (ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }) => {
                dicts[ns] = dict;
            },
            bind: (ns: string) => (key: string) => dicts[ns]?.zh?.[key] ?? key,
        },
        slots: {
            inject: (name: string, p: () => void) => {
                slotsOrder.push(name);
                current = name;
                p();
            },
            register: (opts: Record<string, unknown>, comp: () => unknown) => {
                optionsBySlot.set(current!, opts);
                components.set(current!, comp);
            },
        },
    });
    assert.ok(components.has(slotName), `slot ${slotName} must be registered`);
    const bound = components.get(slotName)!;
    const mounted: Mounted = {
        // Hook indices restart on every render (React matches hooks by
        // position within a single render). The host passes the conversation
        // identity as the entry's props; the test may mirror that explicitly.
        component: (): unknown => {
            hookIndex = 0;
            return renderProps === undefined
                ? bound()
                : (bound as unknown as (props: unknown) => unknown)(renderProps);
        },
        resetHooks: () => {
            hookStates = [];
            hookIndex = 0;
            effectSlots = [];
        },
        runCleanups: () => {
            // #4432: release the sandbox clock first — the poll chains the
            // effect cleanups may themselves clearTimeout are tracked here.
            for (const h of sandboxTimers) hostClearTimeout(h);
            sandboxTimers.clear();
            liveMounts.delete(mounted);
            // Positions held by non-effect hooks (useState) stay as holes.
            for (const slot of effectSlots.splice(0)) slot?.cleanup?.();
        },
        pendingTimers: () => sandboxTimers.size,
        inject,
        slotsOrder,
        optionsBySlot,
        dicts,
    };
    liveMounts.add(mounted);
    return mounted;
}

test("#1590/#2125: client bundle registers the settings.section entry bili AND the plugins.bundle.config panel (wrapper id, require purity, both render branches)", async () => {
    const opened: string[] = [];
    const extra: Record<string, unknown> = {
        __BILI__: { origin: "http://127.0.0.1:8787" },
        open: (url: string) => opened.push(url),
        // #3100: the embed pre-flight answers HTML here — every build since
        // v0.1.189 serves the query-form UI route.
        fetch: async (url: string) => {
            if (String(url).endsWith("/__bili/?embed=1")) return { ok: true, headers: { get: (_k: string) => "text/html; charset=utf-8" } };
            return { ok: true, json: async () => ({ origin: "http://127.0.0.1:8787" }) };
        },
        // The poll loop schedules its retry through the injected clock — the
        // vm realm has no host globals of its own.
        setTimeout,
        clearTimeout,
    };

    const m = await mountClient(extra);
    assert.deepEqual(Array.from(m.inject), ["slots", "locale"]);
    assert.deepEqual(m.slotsOrder, ["settings.section", "plugins.bundle.config", "conversation.view", "shell.overlay"]);
    assert.equal(m.optionsBySlot.size, 4);
    // #3862: the per-session Context tab sits right of the built-in chat (0) /
    // trajectory (10) faces and any third-party context tab (dsh-context: 20).
    const viewSlot = m.optionsBySlot.get("conversation.view")!;
    assert.equal(viewSlot.name, "conversation.view");
    assert.equal(viewSlot.id, "bili-context");
    assert.equal(viewSlot.order, 30);
    assert.equal(viewSlot.locale, "bili");
    assert.equal(typeof viewSlot.label, "function");
    assert.equal((viewSlot.label as () => string)(), "上下文");
    assert.ok(m.dicts["bili"] !== undefined);
    const settings = m.optionsBySlot.get("settings.section")!;
    assert.equal(settings.name, "settings.section");
    assert.equal(settings.id, "bili");
    assert.equal(settings.order, 100);
    assert.equal(settings.locale, "bili");
    assert.equal(typeof settings.label, "function");
    assert.equal((settings.label as () => string)(), "bili设置");
    const bundle = m.optionsBySlot.get("plugins.bundle.config")!;
    assert.equal(bundle.name, "plugins.bundle.config");
    assert.equal(bundle.key, "billion-context");
    assert.equal(bundle.locale, "bili");
    // Keyed slot: the host matches the key against its own package name — no
    // list-slot fields may ride along.
    assert.deepEqual(Object.keys(bundle).sort(), ["key", "locale", "name"]);
    assert.deepEqual(Object.keys(m.dicts["bili"].zh).sort(), Object.keys(m.dicts["bili"].en).sort());

    m.resetHooks();
    const pendingTree = m.component() as ElementNode;
    assert.equal(findTag(pendingTree, "iframe"), undefined, "#3100: the frame waits for the embed pre-flight verdict");
    await tick();
    const tree = m.component() as ElementNode;
    assert.equal(tree.type, "div");
    assert.notEqual(findTag(tree, "h3"), undefined, "the settings section keeps its own title");
    // #2321: bound state embeds the real web UI — tab bar plus one iframe at
    // the embeddable face, defaulting to the overview page. The stub's locale
    // bind resolves zh, so lang=zh.
    const frame = findTag(tree, "iframe");
    assert.ok(frame !== undefined, "origin present renders the embedded iframe");
    assert.equal(frame.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview");
    assert.equal(
        ((frame.props?.style) as Record<string, unknown> | undefined)?.height,
        "min(640px, 78vh)",
        "#2448: frame height follows the host viewport instead of a flat 640px",
    );
    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 6, "five tabs (versions included, #3719) plus the backup open-in-browser button");
    // #2448: the backup button drops the origin URL from the label (a narrow
    // host panel squeezed the hint row into a sliver) and keeps it in the
    // tooltip instead.
    const openLabel: string[] = [];
    collectText(buttons[5], openLabel);
    assert.deepEqual(openLabel, ["打开 Web UI"], "#2448: backup button label carries no origin URL");
    assert.equal(buttons[5].props?.title, "http://127.0.0.1:8787", "#2448: the origin moves to the tooltip");
    const tabLabels: string[] = [];
    for (const b of buttons.slice(0, 5)) {
        const bt: string[] = [];
        collectText(b, bt);
        tabLabels.push(bt.join(""));
    }
    assert.deepEqual(tabLabels, ["总览", "会话", "配置", "日志", "版本"], "tabs mirror the web UI nav terminology");
    // The open-in-browser action rides the TAB row (right after the logs
    // tab), not the footer below the iframe: the row div that parents the
    // logs tab also parents the action button, and the root's footer row
    // carries no button at all in the embedded state.
    const tabRow = findDivParenting(tree, (el) => {
        const bt: string[] = [];
        collectText(el, bt);
        return bt.join("") === "日志";
    });
    assert.ok(tabRow !== undefined, "logs tab has a parent row");
    const rowButtons = collectButtons(tabRow);
    assert.equal(rowButtons.length, 6, "tab row = five tabs + the open-WebUI action");
    assert.equal(rowButtons[5], buttons[5], "the action is the row's last child, right after the last tab");
    const footerRow = (tree.children ?? []).filter((c) => c !== null && typeof c === "object").at(-1) as ElementNode;
    assert.equal(collectButtons(footerRow).length, 0, "embedded footer carries no button — the action moved up");
    // Tab click moves only the hash — the frame navigates same-document.
    (buttons[1].props!.onClick as () => void)();
    const treeAfterTab = m.component() as ElementNode;
    const frameAfterTab = findTag(treeAfterTab, "iframe");
    assert.ok(frameAfterTab !== undefined);
    assert.equal(frameAfterTab.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/sessions");
    // The backup button keeps the original jump target.
    (buttons[5].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);
    m.runCleanups();

    // #2125: the bundle panel reuses the probe/frame/hint but drops the title
    // — the plugin detail page draws it. A fresh mount is a fresh page load:
    // pending first paint again, verdict cache empty again.
    const bm = await mountClient(extra, "plugins.bundle.config");
    bm.resetHooks();
    bm.component();
    await tick();
    const btree = bm.component() as ElementNode;
    assert.equal(btree.type, "div");
    assert.equal(findTag(btree, "h3"), undefined, "the bundle panel does not repeat the page title");
    const bframe = findTag(btree, "iframe");
    assert.ok(bframe !== undefined, "origin present renders the embedded iframe in the bundle panel");
    assert.equal(bframe.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview");
    const bButtons = collectButtons(btree);
    assert.equal(bButtons.length, 6, "the bundle panel offers the same tabs plus backup button");
    assert.equal(
        bButtons[bButtons.length - 1].props?.title,
        "http://127.0.0.1:8787",
        "bundle backup button tooltip carries the origin",
    );
    opened.length = 0;
    (bButtons[bButtons.length - 1].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);
    bm.runCleanups();

    // Degraded: no snapshot AND a host without the live route (fetch rejects)
    // — the entry stays degraded in BOTH slots.
    for (const slot of ["settings.section", "plugins.bundle.config"]) {
        const dm = await mountClient({ open: (_url: string) => {}, fetch: async () => { throw new Error("no route"); }, setTimeout, clearTimeout }, slot);
        dm.resetHooks();
        const dtree = dm.component() as ElementNode;
        assert.equal(findButton(dtree), undefined, `${slot}: no buttons while degraded`);
        assert.equal(findTag(dtree, "iframe"), undefined, `${slot}: no frame before the origin resolves`);
        const dt: string[] = [];
        collectText(dtree, dt);
        assert.ok(dt.some((x) => x.includes("/acp")), `${slot}: degraded hint points at /acp: ${JSON.stringify(dt)}`);
        dm.runCleanups();
    }
});

test("#3373: relay mode — probe {origin:null,relay:true} binds same-origin; prefix gateways resolve through the base-relative fallback form", async () => {
    {
        // Root relay deployment: no response URL ⇒ base "" (same-origin paths).
        const opened: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: null, relay: true }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        // No snapshot here — first paint is the degraded hint until the first
        // poll resolves (the snapshot path is covered below).
        assert.equal(findTag(first, "iframe"), undefined, "#3100: the frame still waits for the pre-flight verdict");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const ft: string[] = [];
        collectText(second, ft);
        assert.ok(!ft.some((x) => x.includes("/acp")), "relay mode is bound, not degraded");
        const frame = findTag(second, "iframe");
        assert.ok(frame !== undefined, "relay mode renders the frame");
        assert.equal(frame.props?.src, "/__bili/?embed=1&lang=zh#/overview", "same-origin frame under the entry relay");
        const buttons = collectButtons(second);
        (buttons[buttons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["/__bili/"]);
        m.runCleanups();
    }
    {
        // Prefix gateway (fnOS-style /app/dsh/): the absolute probe path misses;
        // the base-relative fallback form carries the prefix and its response
        // URL becomes the absolute UI base.
        const m = await mountClient({
            document: { baseURI: "https://dsh.example/app/dsh/" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                const u = String(url);
                if (u === "/bili/origin") return { ok: false };
                if (u.endsWith("/bili/origin")) return { ok: true, url: u, json: async () => ({ origin: null, relay: true }) };
                if (u.endsWith("/__bili/?embed=1")) return htmlOk();
                throw new Error(`unexpected fetch: ${u}`);
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const frame = findTag(tree, "iframe");
        assert.ok(frame !== undefined, "prefix gateway resolves through the fallback probe form");
        assert.equal(frame.props?.src, "https://dsh.example/app/dsh/__bili/?embed=1&lang=zh#/overview");
        m.runCleanups();
    }
    {
        // Relay snapshot (__BILI__ carries relay:true): first paint is bound.
        const m = await mountClient({
            __BILI__: { origin: null, relay: true },
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: null, relay: true }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        const ft: string[] = [];
        collectText(first, ft);
        assert.ok(!ft.some((x) => x.includes("/acp")), "relay snapshot is bound from first paint");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        assert.ok(findTag(second, "iframe") !== undefined, "relay snapshot + live route renders the frame");
        m.runCleanups();
    }
});

test("#1809/#2125/#2187: client polls /bili/origin while unresolved — upgrades on success, stays degraded and cancels when absent (both slots); slow phase continues past the fast attempts; #2288 corrects a stale boot snapshot and follows mid-session re-binds", async () => {
    // #3100: every fetch stub below dispatches on URL — the host origin route
    // answers JSON, the proxy embed pre-flight answers HTML (htmlOk above).
    {
        const opened: string[] = [];
        const fetched: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                fetched.push(url);
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: first paint before the pre-flight resolves shows no frame");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const frame = findTag(second, "iframe");
        assert.ok(frame !== undefined, "resolved origin upgrades the entry without a reload");
        assert.equal(frame.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const upButtons = collectButtons(second);
        assert.equal(upButtons.length, 6, "the upgraded entry shows tabs plus the backup button");
        (upButtons[upButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        // #2288: resolution no longer STOPs the probe — exactly one fast probe
        // ran so far; the slow follow-up is still pending and gets cancelled
        // by runCleanups below. #3100: the embed pre-flight fired exactly once
        // per distinct origin (in-flight guard dedupes the same-tick re-drives).
        assert.equal(fetched.filter((u) => u === "/bili/origin").length, 1, "resolution took exactly the initial fast probe (slow follow-up still pending)");
        assert.equal(fetched.filter((u) => u.endsWith("/__bili/?embed=1")).length, 1, "#3100: one embed pre-flight per distinct origin");
        m.runCleanups();
    }

    {
        // #2288 regression core: a stale boot snapshot (the attach-mode env
        // origin published at page render, before the host re-bound the proxy)
        // must be corrected in place by the live route — the old guard froze
        // it for the whole session.
        const opened: string[] = [];
        const m = await mountClient({
            __BILI__: { origin: "http://127.0.0.1:8787" },
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18798" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: even a snapshot origin waits for its pre-flight verdict");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const secondButtons = collectButtons(second);
        assert.equal(
            secondButtons[secondButtons.length - 1].props?.title,
            "http://127.0.0.1:18798",
            "stale snapshot upgraded to the live origin (backup button tooltip)",
        );
        const sframe = findTag(second, "iframe");
        assert.ok(sframe !== undefined, "the upgraded entry keeps its frame");
        assert.equal(sframe.props?.src, "http://127.0.0.1:18798/__bili/?embed=1&lang=zh#/overview", "the embedded frame follows the corrected live origin");
        const sButtons = collectButtons(second);
        assert.equal(sButtons.length, 6, "the upgraded entry shows tabs plus the backup button");
        (sButtons[sButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:18798/__bili/"]);
        m.runCleanups();
    }

    {
        // #2288/#2321: after the first resolution the slow phase KEEPS following
        // the live route — a mid-session re-bind (runtime re-spawn, routed-origin
        // convergence) moves the frame and the backup button without a reload.
        // Manual clock as in the #2187 blocks below.
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let polls = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                polls += 1;
                return { ok: true, json: async () => ({ origin: polls < 4 ? "http://127.0.0.1:18798" : "http://127.0.0.1:18800" }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        for (let i = 0; i < 3; i++) {
            await tick();
            if (pending.length === 0) throw new Error("polling stopped after resolution — the entry would freeze on a stale origin");
            const t = pending.shift()!;
            assert.equal(t.delay, 10000, "post-resolution follow-ups use the slow cadence");
            t.fn();
        }
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const treeButtons = collectButtons(tree);
        assert.equal(
            treeButtons[treeButtons.length - 1].props?.title,
            "http://127.0.0.1:18800",
            "mid-session re-bind follows the live origin (backup button tooltip)",
        );
        const rframe = findTag(tree, "iframe");
        assert.ok(rframe !== undefined, "the re-bound entry keeps its frame");
        assert.equal(rframe.props?.src, "http://127.0.0.1:18800/__bili/?embed=1&lang=zh#/overview", "the embedded frame follows the mid-session re-bind");
        m.runCleanups();
    }

    {
        let cleared = 0;
        const m = await mountClient({
            fetch: async () => ({ ok: false, json: async () => ({}) }),
            setTimeout,
            clearTimeout: (t: unknown) => {
                cleared += 1;
                clearTimeout(t as ReturnType<typeof setTimeout>);
            },
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined);
        await tick();
        const second = m.component() as ElementNode;
        assert.equal(findTag(second, "iframe"), undefined, "a host without the route keeps the entry degraded");
        m.runCleanups();
        assert.ok(cleared >= 1, "pending retry timers are cancelled on unmount");
    }

    {
        // #2125: the bundle panel runs the same probe wiring through its own
        // registration.
        const opened: string[] = [];
        const m = await mountClient(
            {
                open: (url: string) => opened.push(url),
                fetch: async (url: string) => {
                    if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                    return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
                },
                setTimeout,
                clearTimeout,
            },
            "plugins.bundle.config",
        );
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: the bundle panel also waits for the pre-flight");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const bframe = findTag(second, "iframe");
        assert.ok(bframe !== undefined, "the bundle panel upgrades on a resolved origin");
        assert.equal(bframe.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const bUpButtons = collectButtons(second);
        assert.equal(bUpButtons.length, 6, "the bundle panel offers tabs plus the backup button");
        (bUpButtons[bUpButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        m.runCleanups();
    }

    {
        // #2187: past the fast phase, probing CONTINUES at the slow cadence
        // instead of stopping — a late-arriving origin (background heal) must
        // still upgrade the entry. Manual clock: capture each scheduled retry
        // and fire it by hand so the test never waits in wall time.
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let polls = 0;
        let landed = false;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                polls += 1;
                if (polls >= 13) landed = true;
                return { ok: true, json: async () => ({ origin: polls >= 13 ? "http://127.0.0.1:9997" : null }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: first paint before the pre-flight resolves shows no frame");
        const delays: number[] = [];
        for (;;) {
            await tick();
            if (landed) break;
            if (pending.length === 0) throw new Error("polling stopped before the origin arrived");
            const t = pending.shift()!;
            delays.push(t.delay);
            t.fn();
        }
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const sframe = findTag(second, "iframe");
        assert.ok(sframe !== undefined, "a late-arriving origin upgrades the entry without a reload");
        assert.equal(sframe.props?.src, "http://127.0.0.1:9997/__bili/?embed=1&lang=zh#/overview");
        assert.deepEqual(delays.slice(0, 9), Array(9).fill(3000), "fast phase keeps the original cadence");
        assert.ok(delays.length > 9, `probing must continue past the fast phase, got ${delays.length} retries`);
        assert.deepEqual(delays.slice(9), Array(delays.length - 9).fill(10000), "slow phase uses the reduced cadence");
        m.runCleanups();
    }

    {
        // #2187: unmount still cancels the pending retry even in the slow phase
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let cleared = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            cleared += 1;
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async () => ({ ok: true, json: async () => ({ origin: null }) }),
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        m.component();
        const delays: number[] = [];
        for (let i = 0; i < 12; i++) {
            await tick();
            if (pending.length === 0) break;
            const t = pending.shift()!;
            delays.push(t.delay);
            t.fn();
        }
        assert.ok(delays.includes(10000), `reached the slow phase, got delays ${JSON.stringify(delays)}`);
        m.runCleanups();
        assert.ok(cleared >= 1, "the pending retry is cancelled on unmount");
        assert.equal(pending.length, 0, "no timers survive unmount");
    }

    {
        // #2559: the host page's actual ground drives the face's palette.
        // The synchronous sample still classifies on FIRST RENDER (fed here
        // through the __BILI__ origin snapshot), so the very first frame that
        // appears already carries &theme=<pin> — #3100 delays that appearance
        // by at most one loopback pre-flight round-trip, never by a re-sample.
        // A light ground pins &theme=light; unpinned sandboxes (all earlier
        // scenarios) keep the old exact srcs above, proving a DOM-less host
        // stays OS-driven.
        const mkDom = (bg: string): Record<string, unknown> => ({
            __BILI__: { origin: "http://127.0.0.1:9998" },
            document: {
                documentElement: {},
                body: { querySelector: (_sel: string): unknown => undefined },
            },
            getComputedStyle: (_el: unknown): unknown => ({ backgroundColor: bg }),
        });
        for (const [bg, theme] of [
            ["rgb(13,17,23)", "dark"],
            ["rgba(22,27,34,0.98)", "dark"],
            ["rgb(247,248,250)", "light"],
        ] as Array<[string, string]>) {
            const m = await mountClient({
                fetch: async (url: string) => {
                    if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                    return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9998" }) };
                },
                setTimeout,
                clearTimeout,
                ...mkDom(bg),
            });
            m.resetHooks();
            const painted = m.component() as ElementNode;
            assert.equal(findTag(painted, "iframe"), undefined, `ground ${bg}: the frame waits for the pre-flight verdict`);
            await tick();
            m.component();
            await tick();
            const settled = m.component() as ElementNode;
            const frame = findTag(settled, "iframe");
            assert.ok(frame !== undefined, `ground ${bg} upgrades once the pre-flight lands`);
            assert.equal(
                frame.props?.src,
                `http://127.0.0.1:9998/__bili/?embed=1&lang=zh&theme=${theme}#/overview`,
                `ground ${bg} classifies ${theme} on first render and carries the pin into the first frame`,
            );
            m.runCleanups();
        }
    }
});

test("#2559: explicit host theme pin overrides the OS palette; #2560 embed frame padding", () => {
    // A framed document only sees the browser/OS color-scheme, while dsh's
    // dark theme is app-level — the host client samples its real ground and
    // pins the face via ?theme= (renderPage → <html data-theme=…>). An
    // explicit pin must OUTRANK the media query, so the OS-driven block
    // narrows to :not([data-theme]) while the pinned palette repeats it.
    // Normalize CRLF first: Git-for-Windows checks .ts out with \r\n (autocrlf
    // default; .gitattributes pins only tests/golden/** to LF), which breaks
    // every mid-string "\n" literal below on Windows CI runs.
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.ok(
        styles.includes("@media (prefers-color-scheme: dark) {\n    :root:not([data-theme]) {"),
        "the OS-driven dark palette stays out of explicitly pinned documents",
    );
    assert.ok(styles.includes(':root[data-theme="dark"] {'), "an explicit dark pin carries the full dark palette");
    {
        // Review finding on #2564: the pinned list had drifted from the
        // OS-driven one (--red-soft green channel 73→46) — CSS cannot share
        // declarations across the media boundary, so drift stays silent.
        // Pin SET-EQUALITY (color-scheme aside): both lists must carry the
        // same declarations verbatim.
        const grab = (open: string): string => {
            const i = styles.indexOf(open);
            assert.ok(i >= 0, `${open} present`);
            return styles.slice(i + open.length, styles.indexOf("}", i));
        };
        const decls = (block: string): string[] =>
            block.split("\n")
                .map((l) => l.trim().replace(/;\s*$/, ""))
                .filter((l) => l !== "" && !l.startsWith("*"));
        const pinned = decls(grab(':root[data-theme="dark"] {'));
        const osDriven = decls(grab(":root:not([data-theme]) {"));
        for (const d of pinned) {
            if (d.startsWith("color-scheme")) continue;
            assert.ok(osDriven.includes(d), `pinned dark declaration missing from the OS-driven list: ${d}`);
        }
        for (const d of osDriven) {
            assert.ok(pinned.includes(d), `OS-driven dark declaration missing from the pin: ${d}`);
        }
    }
    assert.ok(
        styles.includes(':root[data-theme="light"] {\n    color-scheme: light;\n}'),
        "an explicit light pin rebinds the canvas over a dark OS",
    );
    assert.ok(
        styles.includes(".embed main { max-width: none; padding: 8px 10px 16px; }"),
        "the embed face keeps a breathing gutter around the frame edge",
    );
});

test("#2125: the manifest declares no dsh.client.inject (pre-0.2 dsh compat)", () => {
    // dsh < 0.2.x cannot resolve "@deepseek-ai/dsh-client-ui-plugin-manager" and its
    // client-module scanner stalls the whole web UI on an unknown inject target.
    // dsh >= 0.2.0-rc.x ships the slot host inside dsh-web-app, so no injection is
    // required — re-adding it would freeze older clients into an endless spinner.
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        dsh?: { client?: { inject?: unknown } };
    };
    assert.equal(pkg.dsh?.client?.inject ?? null, null, "dsh.client.inject would break pre-0.2 dsh clients");
});

test("#3043: the published manifest exposes ./package.json so dsh's client scanner can locate the package root", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        exports?: Record<string, unknown>;
    };
    // Node's `exports` map is closed once declared — an unlisted subpath throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. dsh's client scanner resolves
    // "<pkg>/package.json" to find the package root before reading dsh.client;
    // the self-mapping below looks redundant but is load-bearing: drop it and
    // the scanner swallows the throw, so the browser half never registers.
    assert.equal(pkg.exports?.["./package.json"], "./package.json");
});

test("#2448: embed face adapts the data tables to a narrow host panel (CSS pins)", () => {
    // The embed iframe lives inside a dsh settings column (400-760px), not a
    // browser tab — the standalone-page table floors (940px/520px + fixed
    // colgroup) crushed the sessions table there (#2448).
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8");
    assert.ok(
        styles.includes(".embed .twide table.data { min-width: 0; }"),
        "embed drops the standalone-page 940px floor",
    );
    assert.ok(
        styles.includes(".embed .tproc table.data { min-width: 0; }"),
        "embed drops the protocol-table 520px floor",
    );
    assert.ok(
        styles.includes(".embed table.data th:nth-child(n + 6), .embed table.data td:nth-child(n + 6) { display: none; }"),
        "embed reuses the phone-compact column set at any panel width",
    );
    // The hidden TDs' <col> tracks still claim their px under table-layout:
    // fixed unless zeroed — otherwise the SESSION column collapses to 0 and
    // rows render double-exposed (title overflowing onto adjacent cells).
    assert.ok(
        styles.includes("\n    table.data colgroup col:nth-child(n + 6) { width: 0 !important; }"),
        "phone-compact releases the hidden <col> tracks",
    );
    assert.ok(
        styles.includes(".embed table.data colgroup col:nth-child(n + 6) { width: 0 !important; }"),
        "embed releases the hidden <col> tracks",
    );
});

test("#2473: the web face keeps its canvas coupled to the color scheme", () => {
    // The ?embed=1 face drops its opaque ground (--bg: transparent) to blend
    // into the host panel. If the document never declares color-scheme, its
    // default canvas stays WHITE regardless of scheme — so under DSH's dark
    // theme (prefers-color-scheme: dark) the light-scheme text (#e6edf3)
    // landed on a white ground and the overview stats went unreadable (#2473).
    // `color-scheme: light dark` on the BASE :root makes the canvas follow the
    // SAME prefers-color-scheme signal that drives the palette, so ground and
    // text stay consistent in BOTH schemes. Pin it in the base block (before
    // the dark @media), not buried inside one scheme's override — that is the
    // exact placement that keeps the coupling symmetric.
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8");
    const declIdx = styles.search(/color-scheme:\s*light\s+dark/);
    const mediaIdx = styles.indexOf("@media (prefers-color-scheme: dark)");
    assert.notEqual(declIdx, -1, "declares color-scheme: light dark on :root");
    assert.ok(
        mediaIdx !== -1 && declIdx < mediaIdx,
        "color-scheme sits in the base :root (before the dark @media) so both schemes inherit it",
    );
});

test("#3100: embed pre-flight — a stale proxy build gets the restart notice instead of a 404 frame; transient failures stay pending; verdicts cache per origin", async () => {
    // The auto-update window: the profile bundle on disk is NEW (this browser
    // half always runs it) while the long-running proxy child still SERVES the
    // old build in memory — its /__bili/ route table predates the query form
    // that landed in v0.1.189 (#2321), so the exact framed URL gets a raw JSON
    // 404 that used to render inside the iframe.
    {
        const opened: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) {
                    return {
                        ok: false,
                        status: 404,
                        headers: { get: (_k: string) => "application/json; charset=utf-8" },
                        json: async () => ({ error: { type: "not_found", message: "no such management endpoint" } }),
                    };
                }
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18796" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        assert.equal(findTag(tree, "iframe"), undefined, "#3100: a non-HTML answer must never be framed");
        const staleText: string[] = [];
        collectText(tree, staleText);
        assert.ok(staleText.join(" ").includes("重新启动 dsh"), "the stale notice points at restarting dsh");
        const btns = collectButtons(tree);
        assert.equal(btns.length, 1, "the stale face keeps only the backup button");
        assert.equal(btns[0].props?.title, "http://127.0.0.1:18796", "the backup button still names the live origin");
        (btns[0].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:18796/__bili/"], "the backup button targets the bare form every build serves");
        m.runCleanups();
    }

    // Transient network errors yield NO verdict: the face stays on the
    // connecting placeholder (never the restart notice) and each origin-poll
    // slot re-drives the probe until one lands; the verdict then caches for
    // the page lifetime (a frozen process cannot gain routes mid-session).
    {
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let embedCalls = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) {
                    embedCalls += 1;
                    if (embedCalls < 3) throw new Error("network down");
                    return htmlOk();
                }
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        const preText: string[] = [];
        collectText(first, preText);
        assert.ok(preText.join(" ").includes("未绑定 bili 代理"), "before any resolution the entry is still degraded");
        await tick();
        const second = m.component() as ElementNode;
        assert.equal(findTag(second, "iframe"), undefined);
        const pendText: string[] = [];
        collectText(second, pendText);
        assert.ok(pendText.join(" ").includes("正在连接 bili 代理"), "#3100: a failed probe reads as connecting, not as stale");
        assert.equal(embedCalls, 2, "the resolution and the origin-change effect each probed once; both failed");
        let upgraded = false;
        for (let i = 0; i < 5 && !upgraded; i++) {
            const mid = m.component() as ElementNode;
            upgraded = findTag(mid, "iframe") !== undefined;
            if (!upgraded) {
                const midText: string[] = [];
                collectText(mid, midText);
                assert.ok(midText.join(" ").includes("正在连接 bili 代理"), `probe slot ${i + 1}: still down reads as connecting, never stale`);
                if (pending.length === 0) throw new Error("the origin poll stopped before the probe could retry");
                const t = pending.shift()!;
                assert.equal(t.delay, 10000, "post-resolution follow-ups use the slow cadence");
                t.fn();
                await tick();
            }
        }
        assert.ok(upgraded, "a recovered probe upgrades the entry without a reload");
        const settled = m.component() as ElementNode;
        const frame = findTag(settled, "iframe");
        assert.ok(frame !== undefined, "the recovered verdict mounts the frame");
        assert.equal(frame.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        assert.equal(embedCalls, 3, "probing stops once a verdict lands (slots 1-2 were the failed attempts)");
        if (pending.length === 0) throw new Error("polling stopped after the verdict");
        pending.shift()!.fn();
        await tick();
        const cached = m.component() as ElementNode;
        assert.ok(findTag(cached, "iframe") !== undefined, "the frame survives the follow-up tick");
        assert.equal(embedCalls, 3, "#3100: a cached verdict is never re-fetched");
        m.runCleanups();
    }
});

test("#3816: remote page + loopback origin (relay off) shows the adminRelay guidance instead of spinning; gate negatives stay unchanged", async () => {
    // Positive: the page is reached through a non-loopback host while the
    // bound origin is the server's loopback — unreachable by construction.
    // The face must explain the fix instead of spinning on "connecting…".
    {
        const opened: string[] = [];
        const copiedTexts: string[] = [];
        const m = await mountClient({
            location: { hostname: "vps.example.com" },
            URL,
            open: (url: string) => { opened.push(String(url)); },
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) throw new Error("connection refused");
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
            },
            navigator: { clipboard: { writeText: async (txt: string) => { copiedTexts.push(String(txt)); } } },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        const joined = texts.join(" ");
        assert.ok(joined.includes("adminRelay"), "the guidance names the adminRelay knob");
        assert.ok(joined.includes("~/.config/billion-context/billion-context.json"), "the guidance names the config file");
        assert.ok(!joined.includes("正在连接"), "the endless connecting state is replaced by actionable guidance");
        assert.equal(findTag(tree, "iframe"), undefined, "no frame while the origin is unreachable by construction");
        // #3816 owner follow-up: the hint offers a jump straight to the panel's
        // config page; the footer backup entry stays hidden (it would open the
        // same dead loopback address). #3693: the raw probe failure proving
        // the unreachability rides underneath with its own copy action.
        const EXPECTED_ERROR = "connection refused (http://127.0.0.1:18787/__bili/?embed=1)";
        const btns = collectButtons(tree);
        assert.equal(btns.length, 2, "exactly two actions: the config-page jump + the error copy");
        const btn = btns[0];
        assert.equal(btn.props?.title, "http://127.0.0.1:18787/__bili/#/config", "the jump targets the panel's config page");
        const label: string[] = [];
        collectText(btn.children, label);
        assert.equal(label.join(""), "打开配置页", "the jump button carries its localized label");
        (btn.props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:18787/__bili/#/config"], "clicking opens the config page in a fresh tab");
        const copyBtn = btns[1];
        assert.equal(copyBtn.props?.title, EXPECTED_ERROR, "the copy button carries the full error line as tooltip");
        const copyLabel: string[] = [];
        collectText(copyBtn.children, copyLabel);
        assert.equal(copyLabel.join(""), "复制", "the copy button carries its localized label");
        (copyBtn.props!.onClick as () => void)();
        await tick();
        assert.deepEqual(copiedTexts, [EXPECTED_ERROR], "clicking copies the exact error line including the URL");
        const afterTree = m.component() as ElementNode;
        const afterTexts: string[] = [];
        collectText(afterTree, afterTexts);
        assert.ok(afterTexts.join("").includes("已复制"), "the label flips to copied on success");
        m.runCleanups();
    }
    // Negative 1: a resolved "ok" verdict outranks the mismatch — same-machine
    // access through a LAN IP still reaches the loopback; never shadow a working frame.
    {
        const m = await mountClient({
            location: { hostname: "192.168.1.50" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        assert.ok(!texts.join(" ").includes("adminRelay"), "no guidance when the panel actually resolves");
        assert.ok(findTag(tree, "iframe") !== undefined, "the working frame stays");
        m.runCleanups();
    }
    // Negative 2: local page (loopback host) + loopback origin — the classic
    // desktop posture keeps the plain connecting state.
    {
        const m = await mountClient({
            location: { hostname: "127.0.0.1" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) throw new Error("connection refused");
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        assert.ok(!texts.join(" ").includes("adminRelay"), "local access gets no remote guidance");
        assert.ok(texts.join(" ").includes("正在连接"), "local posture keeps the connecting state");
        m.runCleanups();
    }
    // Negative 3: remote page + NON-loopback origin — a directly exposed proxy
    // is plausibly reachable; the adminRelay guidance would mislead.
    {
        const m = await mountClient({
            location: { hostname: "vps.example.com" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) throw new Error("connection refused");
                return { ok: true, json: async () => ({ origin: "http://203.0.113.5:18787" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        assert.ok(!texts.join(" ").includes("adminRelay"), "non-loopback origins get no adminRelay guidance");
        assert.ok(texts.join(" ").includes("正在连接"), "falls back to the plain connecting state");
        m.runCleanups();
    }
    // Negative 4: relay mode under a remote page — same-origin paths are
    // reachable by construction; the #3373 flow must not gain a hint.
    {
        const m = await mountClient({
            __BILI__: { origin: null, relay: true },
            location: { hostname: "vps.example.com" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: null, relay: true }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        assert.ok(!texts.join(" ").includes("adminRelay"), "relay mode never shows the opt-in guidance");
        assert.ok(findTag(tree, "iframe") !== undefined, "the relayed frame renders");
        m.runCleanups();
    }
    // Negative 5: remote page + loopback origin + RESOLVED stale verdict —
    // the probe answered, so THIS browser reached the loopback (same machine
    // through a LAN IP): the #3100 restart notice keeps its place and the
    // backup button stays (its loopback link is alive here).
    {
        const m = await mountClient({
            location: { hostname: "192.168.1.50" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) {
                    return {
                        ok: false,
                        status: 404,
                        headers: { get: (_k: string) => "application/json; charset=utf-8" },
                        json: async () => ({ error: { type: "not_found", message: "no such management endpoint" } }),
                    };
                }
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const texts: string[] = [];
        collectText(tree, texts);
        assert.ok(!texts.join(" ").includes("adminRelay"), "a reachable-but-stale proxy keeps its own notice, not the relay guidance");
        assert.ok(texts.join(" ").includes("重新启动 dsh"), "the #3100 stale notice survives the remote-page state");
        const btns = collectButtons(tree);
        assert.equal(btns.length, 1, "the backup button stays — on this machine the loopback link is alive");
        assert.equal(btns[0].props?.title, "http://127.0.0.1:18787", "the backup button names the live origin");
        m.runCleanups();
    }
});

// #3693: a failing probe must never read as endless "connecting…" — the raw
// engine error (plus the failed URL) rides beneath the hint with its own copy
// action. Primary path: navigator.clipboard.writeText.
test("#3693: a failing probe surfaces the raw error verbatim with a working copy action", async () => {
    const copiedTexts: string[] = [];
    const EXPECTED_ERROR = "connect ECONNREFUSED 127.0.0.1:18787 (http://127.0.0.1:18787/__bili/?embed=1)";
    const m = await mountClient({
        location: { hostname: "127.0.0.1" },
        URL,
        open: (_url: string) => {},
        fetch: async (url: string) => {
            if (String(url).endsWith("/__bili/?embed=1")) throw new Error("connect ECONNREFUSED 127.0.0.1:18787");
            return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
        },
        navigator: { clipboard: { writeText: async (txt: string) => { copiedTexts.push(String(txt)); } } },
        setTimeout,
        clearTimeout,
    });
    m.resetHooks();
    m.component();
    await tick();
    m.component();
    await tick();
    let tree = m.component() as ElementNode;
    const texts: string[] = [];
    collectText(tree, texts);
    const joined = texts.join(" ");
    assert.ok(joined.includes("正在连接"), "the connecting headline stays");
    assert.ok(joined.includes(EXPECTED_ERROR), "the raw engine error plus the failed URL are shown");
    assert.equal(findTag(tree, "iframe"), undefined, "no frame while the probe fails");
    const btns = collectButtons(tree);
    assert.equal(btns.length, 2, "the copy action plus the standing footer backup button only");
    const copyBtn = btns.find((b) => b.props?.title === EXPECTED_ERROR);
    assert.ok(copyBtn !== undefined, "the copy button carries the full error line as tooltip");
    (copyBtn!.props!.onClick as () => void)();
    await tick();
    assert.deepEqual(copiedTexts, [EXPECTED_ERROR], "clicking copies the exact error line including the URL");
    tree = m.component() as ElementNode;
    const after: string[] = [];
    collectText(tree, after);
    assert.ok(after.join("").includes("已复制"), "the label flips to copied on success");
    m.runCleanups();
});

// #3693 follow-up: LAN-http pages (the reporter's exact posture) are NOT
// secure contexts — navigator.clipboard is absent there, so the copy must
// fall back to the legacy execCommand path instead of silently doing nothing.
test("#3693: without navigator.clipboard the copy falls back to execCommand", async () => {
    const legacyCopies: string[] = [];
    let ta: { value: string } | undefined;
    const docMock = {
        body: { appendChild: (_n: unknown) => {}, removeChild: (_n: unknown) => {} },
        createElement: (_tag: string) => {
            ta = { value: "" };
            return ta;
        },
        execCommand: (cmd: string) => {
            if (cmd !== "copy" || ta === undefined) return false;
            legacyCopies.push(ta.value);
            return true;
        },
    };
    const EXPECTED_ERROR = "network down (http://127.0.0.1:18787/__bili/?embed=1)";
    const m = await mountClient({
        location: { hostname: "127.0.0.1" },
        URL,
        open: (_url: string) => {},
        fetch: async (url: string) => {
            if (String(url).endsWith("/__bili/?embed=1")) throw new Error("network down");
            return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18787" }) };
        },
        document: docMock,
        setTimeout,
        clearTimeout,
    });
    m.resetHooks();
    m.component();
    await tick();
    m.component();
    await tick();
    const tree = m.component() as ElementNode;
    const texts: string[] = [];
    collectText(tree, texts);
    assert.ok(texts.join(" ").includes(EXPECTED_ERROR), "the error readout renders without any clipboard API");
    const copyBtn = collectButtons(tree).find((b) => b.props?.title === EXPECTED_ERROR);
    assert.ok(copyBtn !== undefined, "the copy action renders regardless of clipboard availability");
    (copyBtn!.props!.onClick as () => void)();
    await tick();
    assert.deepEqual(legacyCopies, [EXPECTED_ERROR], "the execCommand fallback copies the exact error line");
    m.runCleanups();
});

// #3693: the Context tab's status poll swallows its failures too — a dead
// proxy reads as the generic degraded hint forever. Its raw error must ride
// beneath that hint with the same copy action.
test("#3693: the Context tab surfaces status-poll failures verbatim with a copy action", async () => {
    const ORIGIN = "http://127.0.0.1:8787";
    const EXPECTED_ERROR = `ECONNRESET (${ORIGIN}/__bili/plugin/status?conversationId=dsh&fallback=latest)`;
    const copiedTexts: string[] = [];
    const m = await mountClient({
        __BILI__: { origin: ORIGIN },
        open: (_url: string) => {},
        fetch: async (url: string) => {
            const u = String(url);
            if (u.endsWith("/bili/origin")) return { ok: true, json: async () => ({ origin: ORIGIN }) };
            if (u.endsWith("/__bili/plugin/status?conversationId=dsh&fallback=latest")) throw new Error("ECONNRESET");
            if (u.endsWith("/__bili/?embed=1")) return htmlOk();
            throw new Error(`unexpected fetch: ${u}`);
        },
        navigator: { clipboard: { writeText: async (txt: string) => { copiedTexts.push(String(txt)); } } },
        setTimeout,
        clearTimeout,
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: (() => {}) as unknown as typeof clearInterval,
    }, "conversation.view");
    m.resetHooks();
    m.component();
    await tick();
    m.component();
    await tick();
    const tree = m.component() as ElementNode;
    const texts: string[] = [];
    collectText(tree, texts);
    const joined = texts.join(" ");
    assert.ok(joined.includes("/acp"), "the degraded hint stands");
    assert.ok(joined.includes(EXPECTED_ERROR), "the raw poll error names the exact status URL polled");
    assert.equal(findTag(tree, "iframe"), undefined, "never frame while the status poll fails");
    const copyBtn = collectButtons(tree).find((b) => b.props?.title === EXPECTED_ERROR);
    assert.ok(copyBtn !== undefined, "the copy action renders with the error line");
    (copyBtn!.props!.onClick as () => void)();
    await tick();
    assert.deepEqual(copiedTexts, [EXPECTED_ERROR], "clicking copies the exact error line including the URL");
    m.runCleanups();
});

// #3862: the per-session Context tab (conversation.view slot). The tab does
// NOT re-render the data natively (#3886 v1); it EMBEDS the web UI's own
// session page (?embed=1 + #/session/<id>) so compression tree and ledger
// stay in one place — the frame. Pins: the iframe appears only when the
// embed pre-flight verdict is "ok" AND the status poll resolved a session
// id; every other state shows its own honest notice, never an empty or
// stale frame. The frame is bound to THIS conversation: with the host's
// session id in props the poll is exact-id, and a fallback-resolved row from
// a sibling/sub-agent conversation is refused instead of framed.
test("#3862: conversation.view Context tab embeds the web UI session page, polls at 10s, and degrades honestly", async () => {
    const SESSION_ID = "01a152ba-38b9-7611-950c-53b211f0dea6";
    const HOST_CONVERSATION_ID = "conv-dsh-main";
    const ORIGIN = "http://127.0.0.1:8787";
    // Exact-conversation poll: the host named this conversation in props.
    const statusUrl = `/__bili/plugin/status?conversationId=${HOST_CONVERSATION_ID}&fallback=latest`;
    const EXPECTED_SRC = `${ORIGIN}/__bili/?embed=1&lang=zh#/session/${SESSION_ID}`;
    const cannedStatus = { ok: true, panel: "x", sessionId: SESSION_ID, conversationId: HOST_CONVERSATION_ID };
    const opened: string[] = [];
    const intervals: Array<{ id: number; delay: number; fn: () => void }> = [];
    let nextId = 1;
    let statusCalls = 0;
    const fakeSetInterval = ((fn: () => void, delay?: number): unknown => {
        const id = nextId++;
        intervals.push({ id, delay: delay ?? 0, fn });
        return id;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = ((id: unknown): void => {
        const i = intervals.findIndex((p) => p.id === id);
        if (i >= 0) intervals.splice(i, 1);
    }) as unknown as typeof clearInterval;

    const m = await mountClient({
        __BILI__: { origin: ORIGIN },
        open: (url: string) => opened.push(url),
        fetch: async (url: string) => {
            const u = String(url);
            if (u.endsWith("/bili/origin")) return { ok: true, json: async () => ({ origin: ORIGIN }) };
            if (u.endsWith(statusUrl)) {
                statusCalls += 1;
                return { ok: true, json: async () => cannedStatus };
            }
            if (u.endsWith("/__bili/?embed=1")) return htmlOk();
            throw new Error(`unexpected fetch: ${u}`);
        },
        setTimeout,
        clearTimeout,
        setInterval: fakeSetInterval,
        clearInterval: fakeClearInterval,
    }, "conversation.view", { sessionId: HOST_CONVERSATION_ID });

    m.resetHooks();
    m.component();
    // First paint: no verdict yet and no session id ⇒ never an empty/stale frame.
    const first = m.component() as ElementNode;
    assert.equal(findTag(first, "iframe"), undefined, "first paint waits for the pre-flight verdict + session id");
    await tick();
    const tree = m.component() as ElementNode;
    const frame = findTag(tree, "iframe");
    assert.ok(frame !== undefined && frame !== null, "verdict ok + resolved session id ⇒ the session page is framed");
    assert.ok(frame.props !== null, "frame carries props");
    assert.equal(frame.props.src, EXPECTED_SRC, "frame navigates to #/session/<id> on the ?embed=1 face");
    assert.equal(frame.props.title, "billion-context 压缩代理", "frame keeps the shared bili frame title");
    // #4281: the tab FILLS the conversation view — full-height column root
    // with no outer padding, a borderless frame stretched by flex, and the
    // actions riding a slim TOP row instead of a footer below the frame.
    assert.equal(tree.type, "div");
    const rootStyle = (tree.props?.style ?? {}) as Record<string, unknown>;
    assert.equal(rootStyle.height, "100%", "#4281: root fills the conversation view");
    assert.equal(rootStyle.padding, undefined, "#4281: no outer padding");
    const frameStyle = (frame.props?.style ?? {}) as Record<string, unknown>;
    assert.equal(frameStyle.border, "none", "#4281: borderless frame");
    assert.equal(frameStyle.borderRadius, undefined, "#4281: no rounded corners");
    assert.equal(frameStyle.flex, 1, "#4281: frame stretches the remaining height");
    assert.equal(frameStyle.height, "100%");
    // Top-row actions: refresh + the shared open-in-browser action.
    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 2, "refresh + open-WebUI only");
    const refresh = buttons.find((b) => {
        const bt: string[] = [];
        collectText(b, bt);
        return bt.join("") === "刷新";
    });
    assert.ok(refresh !== undefined, "refresh button renders");
    const webBtn = buttons.find((b) => b.props?.title === ORIGIN);
    assert.ok(webBtn !== undefined, "open-WebUI button keeps the origin tooltip");
    // #4281: BOTH actions share one slim row above the frame — nothing rides
    // a footer below it anymore.
    const actionRow = findDivParenting(tree, (el) => {
        const bt: string[] = [];
        collectText(el, bt);
        return bt.join("") === "刷新";
    });
    assert.ok(actionRow !== undefined, "refresh button has a parent row");
    assert.deepEqual(collectButtons(actionRow), buttons, "#4281: refresh + open-WebUI share ONE top row");
    (webBtn!.props!.onClick as () => void)();
    assert.deepEqual(opened, [`${ORIGIN}/__bili/`]);
    // Polling: exactly one loop on the slow cadence — counting STATUS reads
    // only (the embed pre-flight has its own fetches and is not the poll).
    assert.equal(intervals.length, 1, "one poll loop while mounted");
    assert.equal(intervals[0].delay, 10000, "poll cadence is 10s");
    assert.equal(statusCalls, 1, "one status read on mount");
    // Refresh re-fetches immediately and swaps (not stacks) the loop.
    (refresh!.props!.onClick as () => void)();
    await tick();
    m.component();
    assert.equal(statusCalls, 2, "refresh triggers an immediate status reload");
    assert.equal(intervals.length, 1, "reload swaps the loop, does not stack it");
    m.runCleanups();
    assert.deepEqual(intervals, [], "unmount cancels the poll loop");

    // Every non-framed state shows its own honest notice — never an iframe.
    const noopTimers = {
        setTimeout,
        clearTimeout,
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: (() => {}) as unknown as typeof clearInterval,
    };
    const subMount = async (body: unknown, embedRouteResult: unknown = htmlOk()): Promise<ElementNode> => {
        const sm = await mountClient({
            __BILI__: { origin: ORIGIN },
            open: (_url: string) => {},
            fetch: async (url: string) => {
                const u = String(url);
                if (u.endsWith("/bili/origin")) return { ok: true, json: async () => ({ origin: ORIGIN }) };
                // No props here ⇒ legacy hosts keep polling the literal form.
                if (u.endsWith("/__bili/plugin/status?conversationId=dsh&fallback=latest") || u.endsWith(statusUrl)) return { ok: true, json: async () => body };
                if (u.endsWith("/__bili/?embed=1")) return embedRouteResult;
                throw new Error(`unexpected fetch: ${u}`);
            },
            ...noopTimers,
        }, "conversation.view");
        sm.resetHooks();
        sm.component();
        await tick();
        const st = sm.component() as ElementNode;
        sm.runCleanups();
        return st;
    };
    const textOf = (node: ElementNode): string => {
        const out: string[] = [];
        collectText(node, out);
        return out.join(" ");
    };
    {
        // Session row not created yet: waiting is truthful, framing impossible.
        const st = await subMount({ ok: true, phase: "pre-first-request", sessionId: null });
        assert.ok(textOf(st).includes("等待首个模型请求…"), "pre-first-request waits, does not guess");
        assert.equal(findTag(st, "iframe"), undefined);
        // #4281: hint states keep breathing room — with the root padding gone,
        // the content wrapper pads itself (the toolbar row still renders:
        // origin known ⇒ actions available even before the session exists).
        const kids = (st.children ?? []).filter((c) => c !== null && typeof c === "object") as ElementNode[];
        const wrap = kids.at(-1)!;
        assert.equal((wrap.props?.style as Record<string, unknown>).padding, 16, "#4281: hint wrapper carries its own padding");
        assert.equal(collectButtons(wrap).length, 0, "#4281: actions never ride inside the content wrapper");
    }
    {
        // #1357 chain-advisory carries a panel string but NO session id: reads
        // as not-yet data — and can NEVER read as the frozen-build claim.
        const st = await subMount({ ok: true, phase: "chain-advisory", panel: "x" });
        const txt = textOf(st);
        assert.ok(txt.includes("暂无上下文数据"), "chain-advisory reads as not-yet");
        assert.ok(!txt.includes("比已安装的配置文件旧"), "chain-advisory never claims a frozen build");
        assert.equal(findTag(st, "iframe"), undefined);
    }
    {
        // Frozen proxy predates the ?embed=1 route: framing impossible on any page.
        const st = await subMount(cannedStatus, { ok: true, headers: { get: (_k: string) => "application/json" } });
        const txt = textOf(st);
        assert.ok(txt.includes("比已安装的配置文件旧"), "stale-route notice names the frozen proxy");
        assert.ok(!txt.includes("暂无上下文数据"), "stale-route has its own copy, not the not-yet hint");
        assert.equal(findTag(st, "iframe"), undefined, "never frame a host without the route");
    }
    {
        // A concurrently-active sibling/sub-agent session arrives through the
        // fallback pool: with a known host identity the row is not ours ⇒ no
        // frame, the not-yet hint stands (no main↔child flicker).
        const hm = await mountClient({
            __BILI__: { origin: ORIGIN },
            open: (_url: string) => {},
            fetch: async (url: string) => {
                const u = String(url);
                if (u.endsWith("/bili/origin")) return { ok: true, json: async () => ({ origin: ORIGIN }) };
                if (u.endsWith(statusUrl)) return { ok: true, json: async () => ({ ok: true, panel: "x", sessionId: "sub-session-id", conversationId: "some-other-conversation", viaFallback: true }) };
                if (u.endsWith("/__bili/?embed=1")) return htmlOk();
                throw new Error(`unexpected fetch: ${u}`);
            },
            ...noopTimers,
        }, "conversation.view", { sessionId: HOST_CONVERSATION_ID });
        hm.resetHooks();
        hm.component();
        await tick();
        const ht = textOf(hm.component() as ElementNode);
        assert.ok(ht.includes("暂无上下文数据"), "foreign fallback-resolved session never gets framed");
        assert.equal(findTag(hm.component() as ElementNode, "iframe"), undefined, "no frame for someone else's session");
        hm.runCleanups();
    }
    {
        // The URL answered but not with our contract shape: degrade honestly.
        const st = await subMount({ something: "else" });
        assert.ok(textOf(st).includes("/acp"), "unparseable status degrades to the /acp hint");
        assert.equal(findTag(st, "iframe"), undefined);
    }
    {
        // No bili bound at all (/bili/origin unreachable too).
        const dm = await mountClient({
            open: (_url: string) => {},
            fetch: async () => { throw new Error("no route"); },
            ...noopTimers,
        }, "conversation.view");
        dm.resetHooks();
        const dtree = dm.component() as ElementNode;
        const dt = textOf(dtree);
        assert.ok(dt.includes("/acp"), "degraded hint points at /acp");
        assert.equal(collectButtons(dtree).length, 0, "no actions before the origin resolves");
        dm.runCleanups();
    }
});

// #4237: dsh.contextTab=false drops ONLY the conversation.view registration —
// the settings section and the plugin bundle config face stay (they are the
// remaining ledger entry points), and compression itself is untouched.
test("#4237: contextTab=false hides the Context tab; absent field fails open to today's registration", async () => {
    const baseExtra = (): Record<string, unknown> => ({
        open: (_url: string) => {},
        fetch: async () => ({ ok: true, json: async () => ({ origin: "http://127.0.0.1:8787" }) }),
        setTimeout,
        clearTimeout,
    });
    const hidden = await mountClient({ ...baseExtra(), __BILI__: { origin: "http://127.0.0.1:8787", contextTab: false } });
    // #4254: the shell.overlay availability pill is NOT user-hidable — it rides along
    // even when the Context tab is hidden (it is an error surface, not a preference).
    assert.deepEqual(hidden.slotsOrder, ["settings.section", "plugins.bundle.config", "shell.overlay"]);
    assert.equal(hidden.optionsBySlot.size, 3);
    assert.ok(!hidden.optionsBySlot.has("conversation.view"), "hidden tab registers nothing");
    assert.ok(hidden.optionsBySlot.has("shell.overlay"), "the #4254 pill stays registered");
    hidden.runCleanups();
    // relay-mode snapshot carries the gate too.
    const hiddenRelay = await mountClient({ ...baseExtra(), __BILI__: { origin: null, relay: true, contextTab: false } });
    assert.ok(!hiddenRelay.optionsBySlot.has("conversation.view"), "relay snapshot gate applies as well");
    hiddenRelay.runCleanups();
    // explicit on keeps it; (absent-field fail-open is pinned by the #1590/#2125
    // and #3862 tests above, which mount without the field).
    const shown = await mountClient({ ...baseExtra(), __BILI__: { origin: "http://127.0.0.1:8787", contextTab: true } });
    assert.deepEqual(shown.slotsOrder, ["settings.section", "plugins.bundle.config", "conversation.view", "shell.overlay"]);
    shown.runCleanups();
});

test("#4237: contextTabLabel overrides the built-in tab name; blank or non-string falls back", async () => {
    const baseExtra = (): Record<string, unknown> => ({
        open: (_url: string) => {},
        fetch: async () => ({ ok: true, json: async () => ({ origin: "http://127.0.0.1:8787" }) }),
        setTimeout,
        clearTimeout,
    });
    const named = await mountClient({ ...baseExtra(), __BILI__: { origin: "http://127.0.0.1:8787", contextTabLabel: "压缩账本" } });
    const viewSlot = named.optionsBySlot.get("conversation.view")!;
    assert.equal((viewSlot.label as () => string)(), "压缩账本");
    named.runCleanups();
    const blank = await mountClient({ ...baseExtra(), __BILI__: { origin: "http://127.0.0.1:8787", contextTabLabel: "   " } });
    assert.equal((blank.optionsBySlot.get("conversation.view")!.label as () => string)(), "上下文");
    blank.runCleanups();
    const junk = await mountClient({ ...baseExtra(), __BILI__: { origin: "http://127.0.0.1:8787", contextTabLabel: 42 } });
    assert.equal((junk.optionsBySlot.get("conversation.view")!.label as () => string)(), "上下文");
    junk.runCleanups();
});

test("#4432: an abandoned mount's clock is drained after its test — a failing assertion can never hang the file", async () => {
    // Reproduces the CI-stuck shape: a mount whose owning test throws before
    // runCleanups() leaves the client's origin-probe slow phase holding host
    // timers. The file-level after() drain must release them unconditionally.
    const m = await mountClient({
        open: (_url: string) => {},
        fetch: async (url: string) => {
            const u = String(url);
            if (u === "/bili/origin") return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            if (u.endsWith("/__bili/?embed=1")) return htmlOk();
            throw new Error(`unexpected fetch: ${u}`);
        },
        setTimeout,
        clearTimeout,
    });
    m.resetHooks();
    m.component();
    await tick();
    m.component();
    await tick();
    // The slow follow-up is pending exactly as in the #2288 block — a host
    // timer is held by the sandbox clock right now.
    assert.ok(m.pendingTimers() > 0, "the origin-probe slow phase holds a pending host timer");
    // The owning test "fails" here (no runCleanups call) — the drain must
    // still release every tracked timer and deregister the mount.
    drainAbandonedMounts();
    assert.equal(m.pendingTimers(), 0, "the drain released every pending sandbox timer");
    assert.ok(!liveMounts.has(m), "the drain deregistered the abandoned mount");
});

test("#4254: shell.overlay upstream-unavailable pill polls /__bili/upstreams, renders per-host rows, auto-dismisses when healthy", async () => {
    const ORIGIN = "http://127.0.0.1:8787";
    const intervals: Array<{ id: number; delay: number; fn: () => void }> = [];
    let nextId = 1;
    const fakeSetInterval = ((fn: () => void, delay?: number): unknown => {
        const id = nextId++;
        intervals.push({ id, delay: delay ?? 0, fn });
        return id;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = ((id: unknown): void => {
        const i = intervals.findIndex((p) => p.id === id);
        if (i >= 0) intervals.splice(i, 1);
    }) as unknown as typeof clearInterval;
    const textOf = (node: unknown): string => {
        const out: string[] = [];
        collectText(node, out);
        return out.join(" ");
    };
    const mountOverlay = async (upstreams: unknown): Promise<Awaited<ReturnType<typeof mountClient>>> =>
        mountClient({
            __BILI__: { origin: ORIGIN },
            fetch: async (url: string) => {
                const u = String(url);
                if (u.endsWith("/bili/origin")) return { ok: true, json: async () => ({ origin: ORIGIN }) };
                if (u.endsWith("/__bili/upstreams")) return { ok: true, json: async () => ({ upstreams }) };
                throw new Error(`unexpected fetch: ${u}`);
            },
            setTimeout,
            clearTimeout,
            setInterval: fakeSetInterval,
            clearInterval: fakeClearInterval,
        }, "shell.overlay");

    // Populated: one unreachable upstream with an OPEN circuit (retry ETA present).
    const m = await mountOverlay([{ host: "127.0.0.1:7864", kind: "connect-refused", code: "ECONNREFUSED", count: 9, firstSeen: 0, lastSeen: 0, circuit: { state: "open", nextProbeInMs: 60000 } }]);
    m.resetHooks();
    m.component();
    assert.equal(m.component(), null, "first paint is empty until the health report resolves");
    await tick();
    const txt = textOf(m.component());
    assert.ok(txt.includes("127.0.0.1:7864"), "row shows the forwarded host:port");
    assert.ok(txt.includes("connect-refused"), "row shows the failure kind");
    assert.ok(txt.includes("ECONNREFUSED"), "row shows the errno code");
    assert.ok(txt.includes("×9"), "row shows the consecutive-failure tally");
    assert.ok(txt.includes("约 60s 后重试"), "open circuit surfaces the retry ETA (zh)");
    assert.ok(txt.includes("1 个上游不可用"), "singular header for one upstream");
    assert.equal(intervals.length, 1, "one poll loop while mounted");
    assert.equal(intervals[0].delay, 10000, "poll cadence is 10s");
    m.runCleanups();
    assert.deepEqual(intervals, [], "unmount cancels the poll loop");

    // Healthy: empty report ⇒ the banner dismisses (renders null).
    const h = await mountOverlay([]);
    h.resetHooks();
    h.component();
    await tick();
    assert.equal(h.component(), null, "no unreachable upstreams ⇒ no banner");
    h.runCleanups();

    // Multiple: header pluralizes, one row per host, and only the OPEN-circuit
    // host carries a retry ETA (an alert-only host has circuit:null).
    const mm = await mountOverlay([
        { host: "127.0.0.1:7864", kind: "connect-refused", code: "ECONNREFUSED", count: 3, circuit: { state: "open", nextProbeInMs: 30000 } },
        { host: "10.0.0.5:9000", kind: "connect-timeout", count: 2, circuit: null },
    ]);
    mm.resetHooks();
    mm.component();
    await tick();
    const mt = textOf(mm.component());
    assert.ok(mt.includes("2 个上游不可用"), "plural header for two upstreams");
    assert.ok(mt.includes("127.0.0.1:7864") && mt.includes("10.0.0.5:9000"), "one row per unreachable host");
    assert.ok(mt.includes("connect-timeout") && mt.includes("×2"), "alert-only host still lists kind + tally");
    assert.ok(mt.includes("约 30s 后重试"), "open-circuit host surfaces its own retry ETA");
    assert.ok(!mt.includes("×2 · 约"), "alert-only (circuit-null) host carries no retry ETA");
    mm.runCleanups();

    // Defensive parse: malformed entries degrade to fewer rows and never throw —
    // only the well-formed host survives into the banner.
    const g = await mountOverlay([
        { host: "192.168.1.20:8080", kind: "connect-refused", code: "ECONNREFUSED", count: 2 },
        "not-an-object",
        { kind: "no-host-entry" },
        { host: "", code: 42 },
    ]);
    g.resetHooks();
    g.component();
    await tick();
    const gt = textOf(g.component());
    assert.ok(gt.includes("192.168.1.20:8080"), "well-formed entry still renders");
    assert.ok(gt.includes("×2"), "the survivor keeps its tally");
    assert.ok(!gt.includes("no-host-entry") && !gt.includes("not-an-object"), "malformed entries are dropped");
    assert.ok(gt.includes("1 个上游不可用"), "header counts only surviving rows");
    g.runCleanups();
});
