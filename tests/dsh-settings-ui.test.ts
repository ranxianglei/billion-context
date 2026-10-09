import test from "node:test";
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
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            // attach mode binds register.base synchronously before the async
            // liveness probe, so a startup-time collection already sees it.
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: proxy.origin } }]);
        });
    } finally {
        proxy.close();
        rmrf(home);
    }
});

test("#1590: index-inject stays silent when no origin is known yet (spawn mode)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
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
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 1);
            assert.equal(routes[0].kind, "exact");
            assert.equal(routes[0].path, "/bili/origin");
            const res = new FakeRes();
            await routes[0].handler({}, res);
            assert.equal(res.status, 200);
            assert.equal(res.headers?.["content-type"], "application/json");
            assert.deepEqual(JSON.parse(res.body), { origin: "http://127.0.0.1:8787" });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: /bili/origin answers null before binding", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest(undefined);
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 1);
            const res = new FakeRes();
            await routes[0].handler({}, res);
            assert.deepEqual(JSON.parse(res.body), { origin: null });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: route registration rides the injected context's effect lifecycle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
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
            assert.equal(effects[0].label, "bili: /bili/origin route");
            const cleanup = effects[0].fn();
            assert.equal(routes.length, 1);
            assert.equal(typeof cleanup, "function", "the disposer doubles as the effect cleanup");
            (cleanup as () => void)();
            assert.equal(disposed, 1);
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

test("#1590/#2125: client bundle registers the settings.section entry bili AND the plugins.bundle.config panel (wrapper id, require purity, both render branches)", async () => {
    const { build } = await import("esbuild");
    // Reuse tsup.config.ts as the single source of truth for the wrapper
    // banner/footer and externals so the test cannot drift from the shipped
    // bundle shape.
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
    const code = result.outputFiles![0].text;

    const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
    const sandbox: Record<string, unknown> = {};
    sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
    assert.equal(registrations.length, 1);
    // Must equal the loader entry name the scanner keys its graph row by.
    assert.equal(registrations[0].id, "billion-context");

    const calls: ElementNode[] = [];
    // Minimal hook emulation (#1809): per-mount state persisting across
    // component() re-renders; effects follow React semantics (#2288) — run on
    // mount, re-run only when their deps change (prior cleanup first). The old
    // run-on-every-render stub masked the removed snapshot guard by silently
    // starting duplicate probes on each re-render.
    type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };
    let hookStates: unknown[] = [];
    let hookIndex = 0;
    let effectSlots: EffectSlot[] = [];
    const resetHooks = (): void => {
        hookStates = [];
        hookIndex = 0;
        effectSlots = [];
    };
    const reactStub = {
        createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => {
            const el = { type, props, children };
            calls.push(el);
            return el;
        },
        useState: (init: unknown): [unknown, (v: unknown) => void] => {
            const i = hookIndex++;
            if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
            return [hookStates[i], (v: unknown) => { hookStates[i] = v; }];
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
    const face = registrations[0].factory(requireStub) as { inject: string[]; apply: (ctx: unknown) => void };
    // Re-materialize in the host realm: vm-context arrays carry the sandbox's
    // Array.prototype, which deepStrictEqual rejects.
    assert.deepEqual(Array.from(face.inject), ["slots", "locale"]);
    assert.equal(typeof face.apply, "function");

    type Entry = { options: Record<string, unknown>; component: () => unknown };
    const runApply = (): { slots: string[]; bySlot: Map<string, Entry>; zh: Record<string, string>; en: Record<string, string> } => {
        const effects: Array<() => void> = [];
        const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
        const slots: string[] = [];
        const bySlot = new Map<string, Entry>();
        let current: string | undefined;
        face.apply({
            effect: (fn: () => void, _label?: string) => effects.push(fn),
            locale: {
                register: (ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }) => {
                    dicts[ns] = dict;
                },
                bind: (ns: string) => (key: string) => dicts[ns]?.zh?.[key] ?? key,
            },
            slots: {
                inject: (name: string, p: () => void) => {
                    slots.push(name);
                    current = name;
                    p();
                },
                register: (opts: Record<string, unknown>, comp: () => unknown) => {
                    // Hook indices restart on every render (React matches hooks
                    // by position within a single render), so wrap the entry.
                    bySlot.set(current!, { options: opts, component: (): unknown => { hookIndex = 0; return comp(); } });
                },
            },
        });
        for (const eff of effects) eff();
        assert.deepEqual(slots, ["settings.section", "plugins.bundle.config"]);
        assert.equal(bySlot.size, 2);
        assert.ok(dicts["bili"] !== undefined);
        return { slots, bySlot, zh: dicts["bili"].zh, en: dicts["bili"].en };
    };

    sandbox.__BILI__ = { origin: "http://127.0.0.1:8787" };
    const withOrigin = runApply();
    const settings = withOrigin.bySlot.get("settings.section")!;
    assert.equal(settings.options.name, "settings.section");
    assert.equal(settings.options.id, "bili");
    assert.equal(settings.options.order, 100);
    assert.equal(settings.options.locale, "bili");
    assert.equal(typeof settings.options.label, "function");
    assert.equal((settings.options.label as () => string)(), "bili设置");
    const bundle = withOrigin.bySlot.get("plugins.bundle.config")!;
    assert.equal(bundle.options.name, "plugins.bundle.config");
    assert.equal(bundle.options.key, "billion-context");
    assert.equal(bundle.options.locale, "bili");
    // Keyed slot: the host matches the key against its own package name — no
    // list-slot fields may ride along.
    assert.deepEqual(Object.keys(bundle.options).sort(), ["key", "locale", "name"]);
    assert.deepEqual(Object.keys(withOrigin.zh).sort(), Object.keys(withOrigin.en).sort());
    calls.length = 0;
    resetHooks();
    const tree = settings.component() as ElementNode;
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
    assert.equal(buttons.length, 5, "four tabs plus the backup open-in-browser button");
    // #2448: the backup button drops the origin URL from the label (a narrow
    // host panel squeezed the hint row into a sliver) and keeps it in the
    // tooltip instead.
    const openLabel: string[] = [];
    collectText(buttons[4], openLabel);
    assert.deepEqual(openLabel, ["打开 Web UI"], "#2448: backup button label carries no origin URL");
    assert.equal(buttons[4].props?.title, "http://127.0.0.1:8787", "#2448: the origin moves to the tooltip");
    const tabLabels: string[] = [];
    for (const b of buttons.slice(0, 4)) {
        const bt: string[] = [];
        collectText(b, bt);
        tabLabels.push(bt.join(""));
    }
    assert.deepEqual(tabLabels, ["总览", "会话", "配置", "日志"], "tabs mirror the web UI nav terminology");
    // Tab click moves only the hash — the frame navigates same-document.
    (buttons[1].props!.onClick as () => void)();
    const treeAfterTab = settings.component() as ElementNode;
    const frameAfterTab = findTag(treeAfterTab, "iframe");
    assert.ok(frameAfterTab !== undefined);
    assert.equal(frameAfterTab.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/sessions");
    // The backup button keeps the original jump target.
    const opened: string[] = [];
    sandbox.open = (url: string) => opened.push(url);
    (buttons[4].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);

    // #2125: the bundle panel reuses the probe/frame/hint but drops the title
    // — the plugin detail page draws it.
    calls.length = 0;
    resetHooks();
    const btree = bundle.component() as ElementNode;
    assert.equal(btree.type, "div");
    assert.equal(findTag(btree, "h3"), undefined, "the bundle panel does not repeat the page title");
    const bframe = findTag(btree, "iframe");
    assert.ok(bframe !== undefined, "origin present renders the embedded iframe in the bundle panel");
    assert.equal(bframe.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview");
    const bButtons = collectButtons(btree);
    assert.equal(bButtons.length, 5, "the bundle panel offers the same tabs plus backup button");
    assert.equal(
        bButtons[bButtons.length - 1].props?.title,
        "http://127.0.0.1:8787",
        "bundle backup button tooltip carries the origin",
    );
    opened.length = 0;
    (bButtons[bButtons.length - 1].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);

    delete sandbox.__BILI__;
    const degraded = runApply();
    calls.length = 0;
    resetHooks();
    const degTree = degraded.bySlot.get("settings.section")!.component() as ElementNode;
    assert.equal(findButton(degTree), undefined);
    assert.equal(findTag(degTree, "iframe"), undefined, "no frame before the origin resolves");
    const degTexts: string[] = [];
    collectText(degTree, degTexts);
    assert.ok(degTexts.some((t) => t.includes("/acp")), `degraded hint points at /acp: ${JSON.stringify(degTexts)}`);
    resetHooks();
    const degBundleTree = degraded.bySlot.get("plugins.bundle.config")!.component() as ElementNode;
    assert.equal(findButton(degBundleTree), undefined, "the bundle panel degrades like the settings section");
    assert.equal(findTag(degBundleTree, "iframe"), undefined, "the bundle panel has no frame while degraded");
    const degBundleTexts: string[] = [];
    collectText(degBundleTree, degBundleTexts);
    assert.ok(degBundleTexts.some((t) => t.includes("/acp")), "the bundle degraded hint points at /acp");
});

test("#1809/#2125/#2187: client polls /bili/origin while unresolved — upgrades on success, stays degraded and cancels when absent (both slots); slow phase continues past the fast attempts; #2288 corrects a stale boot snapshot and follows mid-session re-binds", async () => {
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
    const code = result.outputFiles![0].text;

    type Face = { inject: string[]; apply: (ctx: unknown) => void };
    const mount = (extra: Record<string, unknown>, slotName = "settings.section"): { component: () => unknown; resetHooks: () => void; runCleanups: () => void } => {
        const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
        const sandbox: Record<string, unknown> = {};
        sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
        Object.assign(sandbox, extra);
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
        assert.equal(registrations.length, 1);
        const calls: ElementNode[] = [];
        type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };
        let hookStates: unknown[] = [];
        let hookIndex = 0;
        let effectSlots: EffectSlot[] = [];
        const reactStub = {
            createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => {
                const el = { type, props, children };
                calls.push(el);
                return el;
            },
            useState: (init: unknown): [unknown, (v: unknown) => void] => {
                const i = hookIndex++;
                if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
                return [hookStates[i], (v: unknown) => { hookStates[i] = v; }];
            },
            // React semantics (#2288): run on mount, re-run only on dep change.
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
        const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
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
                    current = name;
                    p();
                },
                register: (_opts: Record<string, unknown>, comp: () => unknown) => {
                    components.set(current!, comp);
                },
            },
        });
        assert.ok(components.has(slotName), `slot ${slotName} must be registered`);
        const bound = components.get(slotName)!;
        return {
            // Hook indices restart on every render (React semantics).
            component: (): unknown => { hookIndex = 0; return bound(); },
            resetHooks: () => {
                hookStates = [];
                hookIndex = 0;
                effectSlots = [];
            },
            runCleanups: () => {
                // Positions held by non-effect hooks (useState) stay as holes.
                for (const slot of effectSlots.splice(0)) slot?.cleanup?.();
            },
        };
    };

    const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

    {
        const opened: string[] = [];
        const fetched: string[] = [];
        const m = mount({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                fetched.push(url);
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "first paint before the probe resolves is still degraded");
        await tick();
        const second = m.component() as ElementNode;
        const frame = findTag(second, "iframe");
        assert.ok(frame !== undefined, "resolved origin upgrades the entry without a reload");
        assert.equal(frame.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const upButtons = collectButtons(second);
        assert.equal(upButtons.length, 5, "the upgraded entry shows tabs plus the backup button");
        (upButtons[upButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        // #2288: resolution no longer STOPs the probe — exactly one fast probe
        // ran so far; the slow follow-up is still pending and gets cancelled
        // by runCleanups below.
        assert.equal(fetched.length, 1, "resolution took exactly the initial fast probe (slow follow-up still pending)");
        m.runCleanups();
    }

    {
        // #2288 regression core: a stale boot snapshot (the attach-mode env
        // origin published at page render, before the host re-bound the proxy)
        // must be corrected in place by the live route — the old guard froze
        // it for the whole session.
        const opened: string[] = [];
        const m = mount({
            __BILI__: { origin: "http://127.0.0.1:8787" },
            open: (url: string) => opened.push(url),
            fetch: async () => ({ ok: true, json: async () => ({ origin: "http://127.0.0.1:18798" }) }),
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        const firstFrame = findTag(first, "iframe");
        assert.ok(firstFrame !== undefined, "the snapshot paints immediately (first-paint hint)");
        assert.equal(
            firstFrame.props?.src,
            "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview",
            "the snapshot binds the frame before the live probe lands",
        );
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
        assert.equal(sButtons.length, 5, "the upgraded entry shows tabs plus the backup button");
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
        const m = mount({
            fetch: async () => {
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
        const m = mount({
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
        const m = mount(
            {
                open: (url: string) => opened.push(url),
                fetch: async () => ({ ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) }),
                setTimeout,
                clearTimeout,
            },
            "plugins.bundle.config",
        );
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined);
        await tick();
        const second = m.component() as ElementNode;
        const bframe = findTag(second, "iframe");
        assert.ok(bframe !== undefined, "the bundle panel upgrades on a resolved origin");
        assert.equal(bframe.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const bUpButtons = collectButtons(second);
        assert.equal(bUpButtons.length, 5, "the bundle panel offers tabs plus the backup button");
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
        const m = mount({
            fetch: async () => {
                polls += 1;
                if (polls >= 13) landed = true;
                return { ok: true, json: async () => ({ origin: polls >= 13 ? "http://127.0.0.1:9997" : null }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "first paint before the probe resolves is still degraded");
        const delays: number[] = [];
        for (;;) {
            await tick();
            if (landed) break;
            if (pending.length === 0) throw new Error("polling stopped before the origin arrived");
            const t = pending.shift()!;
            delays.push(t.delay);
            t.fn();
        }
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
        const m = mount({
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

test("#2560: the embed face keeps breathing room inside the frame (CSS pins)", () => {
    // Inside the dsh settings panel the iframe is the whole frame — zero
    // horizontal padding left cards/tables flush against its edge (#2560).
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8");
    assert.ok(
        styles.includes(".embed main { max-width: none; padding: 8px 10px 16px; }"),
        "embed main carries horizontal breathing room (was padding: 4px 0 12px)",
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
