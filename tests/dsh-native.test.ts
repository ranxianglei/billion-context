import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { apply, planNativeDsh, shouldBootstrapNativeDsh, _resetRegisterForTest, _stateHeadersForTest, _adoptOriginForTest, _armSpawnRecoveryForTest } from "../src/agent/dsh-native.ts";
import { dshManagedPatchBlock, dshNativeInstalled, dshProfileDirs, mergeDshManagedPatch, stripDshManagedPatch, dshBundleInstalled, pluginInstall, pluginRemove, pluginStatusAll } from "../src/plugin-install.ts";

test("planNativeDsh: kill-switches > attach > spawn precedence (#941)", () => {
    assert.deepEqual(planNativeDsh({}), { mode: "spawn" });
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a preset BILLION_CONTEXT_PROXY (the `bili dsh` launcher) is an attach
    // target, not a stand-down
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:8787" });
    // explicit BILLION_CONTEXT_ATTACH wins over the preset proxy env
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "attach", attachOrigin: "http://127.0.0.1:9999" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "off" });
});

test("shouldBootstrapNativeDsh: spawn-gated by env shape", () => {
    assert.equal(shouldBootstrapNativeDsh({}), true);
    assert.equal(shouldBootstrapNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), false);
    assert.equal(shouldBootstrapNativeDsh({ BILI_NATIVE_DSH: "0" }), false);
});

// — patch-file text surgery —————————————————————————————————————————

const HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

// Platform-dependent by construction (win32 path shape) — mirror dshManagedPatchBlock, never hardcode a URL literal here.
const pluginUrlOf = (root: string): string => pathToFileURL(path.join(root, "dist", "agent", "dsh-native.js")).href;

test("mergeDshManagedPatch: placeholder [] is replaced, comments survive", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const merged = mergeDshManagedPatch(`${HEADER}[]\n`, block);
    assert.ok(merged.startsWith(HEADER));
    assert.ok(merged.includes(`- insert:\n    - id: bili-native\n      name: ${pluginUrlOf("/opt/bili")}\n`));
    assert.ok(merged.includes("- id: compaction-basic\n  config:\n    auto: false\n"));
    assert.ok(!merged.includes("[]"));
});

test("mergeDshManagedPatch: user entries survive before the managed block", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const user = `${HEADER}[]\n- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n`;
    const merged = mergeDshManagedPatch(user, block);
    const lines = merged.split("\n");
    const userIdx = lines.findIndex((l) => l === "- id: my-thing");
    const biliIdx = lines.findIndex((l) => l.includes("bili begin"));
    assert.ok(userIdx >= 0 && biliIdx > userIdx);
    assert.ok(merged.includes("- id: my-thing"));
});

test("mergeDshManagedPatch/stripDshManagedPatch roundtrip restores the placeholder", () => {
    const block = dshManagedPatchBlock("/opt/bili");
    const merged = mergeDshManagedPatch(`${HEADER}[]\n`, block);
    const stripped = stripDshManagedPatch(merged);
    assert.equal(stripped, HEADER);
    // strip is a no-op without the markers
    assert.equal(stripDshManagedPatch(HEADER), HEADER);
});

test("mergeDshManagedPatch is idempotent and rewrites a moved install path", () => {
    const first = mergeDshManagedPatch(`${HEADER}[]\n`, dshManagedPatchBlock("/old/root"));
    const second = mergeDshManagedPatch(first, dshManagedPatchBlock("/new/root"));
    assert.ok(second.includes(pluginUrlOf("/new/root")));
    assert.ok(!second.includes("/old/root"));
    assert.equal(second.match(/bili begin/g)?.length, 1);
    const third = mergeDshManagedPatch(second, dshManagedPatchBlock("/new/root"));
    assert.equal(third, second);
});

// — installer roundtrip under a fake DSH_HOME ————————————————————————

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
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

test("dsh install/remove/status roundtrip under a fake DSH_HOME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            // no profiles yet → the installer says run dsh first
            assert.throws(() => pluginInstall("dsh"), /run dsh once/);
            assert.equal(dshNativeInstalled(), false);

            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}[]\n`);
            // web/ has no patch file yet — the installer materializes it

            const msg = pluginInstall("dsh");
            assert.match(msg, /2 dsh profile/);
            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.startsWith(HEADER));
            assert.ok(headlessTxt.includes("dsh-native.js"));
            assert.ok(headlessTxt.includes("auto: false"));
            const webTxt = fs.readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
            assert.ok(webTxt.includes("dsh-native.js"));

            assert.equal(pluginStatusAll().find((r) => r.agent === "dsh")?.status, "installed");
            assert.equal(dshNativeInstalled(), true);

            const removed = pluginRemove("dsh");
            assert.match(removed, /2 dsh profile/); // install wrote both files
            const after = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.equal(after, `${HEADER}[]\n`);
            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /not installed/);
            assert.equal(dshNativeInstalled(), false);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshNativeInstalled: true iff any profile carries the managed block", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-installed-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            assert.equal(dshNativeInstalled(), false);
            fs.writeFileSync(
                path.join(home, "profiles", "headless", "cordis.patch.yml"),
                mergeDshManagedPatch(`${HEADER}[]\n`, dshManagedPatchBlock(home)),
            );
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshBundleInstalled: true iff the profile manifest lists billion-context as a bundle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-bundle-"));
    try {
        fs.mkdirSync(path.join(home, "web"), { recursive: true });
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no manifest
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ name: "dsh-profile" }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no dsh block
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["something-else"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false);
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), true);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dsh install/remove/status skip bundle-installed profiles, dshNativeInstalled recognizes them", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-bundle-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}[]\n`);
            // web/ installed billion-context via `dsh plugin add` — manifest carries the bundle
            fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));

            // the bundle profile already provides bili-native
            assert.equal(dshNativeInstalled(), true);

            // install only touches the non-bundle profile and says so
            const msg = pluginInstall("dsh");
            assert.match(msg, /1 dsh profile/);
            assert.match(msg, /web: skipped \(installed as a dsh bundle/);
            assert.ok(!fs.existsSync(path.join(home, "profiles", "web", "cordis.patch.yml")));
            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.includes("dsh-native.js"));

            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /installed as a dsh bundle in 1\/2 profiles/);

            // remove also skips the bundle profile with a pointer to the dsh-side command
            const removed = pluginRemove("dsh");
            assert.match(removed, /1 dsh profile/);
            assert.match(removed, /dsh plugin --profile web remove billion-context/);
            const after = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.equal(after, `${HEADER}[]\n`);
            // web/ still counts as installed via its bundle
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("dshProfileDirs: skips node_modules, errors when profiles root is absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-dirs-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            assert.throws(() => dshProfileDirs(), /run dsh once/);
            fs.mkdirSync(path.join(home, "profiles", "node_modules"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            const dirs = dshProfileDirs();
            assert.equal(dirs.length, 1);
            assert.ok(dirs[0].endsWith("headless"));
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// — apply() integration against a mock proxy ——————————————————————————

type MockTool = { name: string; description?: string; inputSchema: unknown };

function startMockProxy(toolCalls: Array<{ conversationId: string; tool: string; args: unknown }>, statusResponder?: (url: string) => unknown | undefined): Promise<{ origin: string; close: () => void }> {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" }, range: { type: "string" } }, required: ["summary"] },
        },
    ];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            return;
        }
        if (url.startsWith("/__bili/plugin/tool")) {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const parsed = JSON.parse(body) as { conversationId?: string; tool?: string; args?: unknown };
                toolCalls.push({ conversationId: parsed.conversationId ?? "", tool: parsed.tool ?? "", args: parsed.args });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: "compressed 42 tokens" }));
            });
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            const body = statusResponder === undefined ? { panel: "PANEL-OK" } : statusResponder(url);
            if (body === undefined) {
                res.writeHead(404);
                res.end("{}");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

/** Poll until cond() holds (10ms ticks, 5s cap) — a fixed sleep races on
 *  slow CI runners (windows loopback fetch can outlast 50ms). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    // #955 runtime-info sources: tests can attach llm/agentDefaultModel and
    // replay them through the same dynamic ctx.inject path production uses.
    let llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined = undefined;
    let agentDefaultModel: { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (deps: readonly string[], callback: (sub: unknown) => void) => {
            if (deps.includes("llm") && deps.includes("agentDefaultModel") && llm !== undefined && agentDefaultModel !== undefined) {
                callback({ llm, agentDefaultModel });
            }
        },
        setModelServices: (l: typeof llm, a: typeof agentDefaultModel) => {
            llm = l;
            agentDefaultModel = a;
        },
    };
}

test("apply() attach mode: registers manifest tools verbatim, gates headers, forwards with the session id", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-apply-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // under node:test the fetch patch is deliberately NOT installed
            assert.equal(ctx.registeredCommands.length, 1);
            assert.equal(ctx.registeredCommands[0].name, "acp");

            // headers gate on toolsReady — no session, no headers; and before
            // registration completes nothing is stamped
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ctx)");
            const tool = ctx.registeredTools[0];
            assert.equal(tool.name, "compress");
            // parameters pass through verbatim (the manifest's JSON Schema)
            assert.deepEqual(tool.parameters, {
                type: "object",
                properties: { summary: { type: "string" }, range: { type: "string" } },
                required: ["summary"],
            });
            assert.deepEqual(tool.output.schema, { type: "string" });

            // execute forwards with the owning agent's session id
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const proxy2 = { origin: "", close: () => {} };
            void proxy2;
            // direct execute path (fresh proxy capturing calls):
            const cap = await startMockProxy(calls);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx2 = mockCtx();
                apply(ctx2);
                await waitFor(() => ctx2.registeredTools.length === 1, "manifest tool registration (ctx2)");
                const t2 = ctx2.registeredTools[0];
                const out = await t2.execute({ summary: "s" }, { agent: { session: { id: "session-7" } } });
                assert.equal(out, "compressed 42 tokens");
                assert.deepEqual(calls, [{ conversationId: "session-7", tool: "compress", args: { summary: "s" } }]);
                // agentless execution fails loudly
                await assert.rejects(() => t2.execute({ summary: "s" }, {}), /requires an owning agent session/);
            } finally {
                cap.close();
                _resetRegisterForTest(proxy.origin);
                process.env.BILLION_CONTEXT_PROXY = proxy.origin;
            }

            // /acp prefers the initiator's session, falls back to latest
            ctx.setInitiator({ session: { id: "session-7" } });
            const ok = await ctx.registeredCommands[0].handler();
            assert.equal(ok.kind, "success");
            assert.ok(ok.text.includes("PANEL-OK") || ok.text.includes("billion-context@"));
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() inactive-context registration failure is silent and terminal (dsh 0.1.5+ teardown)", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inactive-"));
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // simulate cordis teardown: the plugin context is inactive, so
            // every service access rejects with cordis's inactive-context error
            const inactive = new Error('cannot get required service "tools" in inactive context');
            ctx.tools.register = () => {
                throw inactive;
            };
            apply(ctx);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(ctx.registeredTools.length, 0);
            // teardown noise is suppressed — no retry log, no wire-mode warning
            assert.equal(errors.length, 0);
            // a later nudge (headersFor) must not resurrect retries either
            const stamp = _stateHeadersForTest();
            stamp?.("http://example.test/v1/messages");
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(errors.length, 0);
        });
    } finally {
        console.error = origErr;
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() is a no-op under the kill switches", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-off-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PLUGIN: "0" }, () => {
            _resetRegisterForTest(undefined);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(ctx.registeredCommands.length, 0);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("apply() runtime-info (#955): model services stamp model/window/max-output headers", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ri-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            ctx.setModelServices(
                {
                    resolveModelInfo: async (provider, model) => {
                        assert.equal(provider, "deepseek");
                        assert.equal(model, "qwen-ri");
                        return { context: { contextWindow: 262144 }, defaultMaxTokens: 32768 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ri" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ri)");
            ctx.setInitiator({ session: { id: "session-ri" } });
            // First stamp may fire before the async resolveModelInfo lands —
            // poll until the window header shows up.
            await waitFor(() => {
                const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
                return headers?.["x-bili-plugin-context-window"] === "262144";
            }, "model-info refresh stamped headers");
            const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            assert.equal(headers?.["x-bili-plugin"], "dsh");
            assert.equal(headers?.["x-bili-plugin-conversation"], "session-ri");
            assert.equal(headers?.["x-bili-plugin-model"], "qwen-ri");
            assert.equal(headers?.["x-bili-plugin-context-window"], "262144");
            assert.equal(headers?.["x-bili-plugin-max-output"], "32768");
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#956): a mid-resolve model switch discards the stale resolve", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-race-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // mutable live selection: A at startup, switched to B mid-resolve
            let selection = { provider: "deepseek", model: "qwen-a" };
            type ModelInfoLike = { context?: { contextWindow?: number }; defaultMaxTokens?: number };
            let releaseA: ((v: ModelInfoLike) => void) | undefined;
            const gateA = new Promise<ModelInfoLike>((r) => {
                releaseA = r;
            });
            ctx.setModelServices(
                {
                    resolveModelInfo: async (_provider, model) =>
                        model === "qwen-a" ? gateA : { context: { contextWindow: 12345 }, defaultMaxTokens: 4096 },
                },
                { currentSelection: () => selection },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (race)");
            ctx.setInitiator({ session: { id: "session-race" } });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // apply()'s inject already started A's async resolve (gated, in flight)
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            // switch the LIVE selection to B while A is still resolving
            selection = { provider: "deepseek", model: "qwen-b" };
            releaseA?.({ context: { contextWindow: 999999 }, defaultMaxTokens: 8888 });
            await new Promise((r) => setTimeout(r, 20));
            // the stale A result must NOT have been committed or stamped
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            assert.notEqual(stamp()?.["x-bili-plugin-model"], "qwen-a");
            // self-heal: the next refresh re-resolves the LIVE selection (B)
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "12345", "post-switch re-resolve stamped B");
            assert.equal(stamp()?.["x-bili-plugin-model"], "qwen-b");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "4096");
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("self-spawn adoption does not freeze BILLION_CONTEXT_PROXY (#983): re-plan stays spawn", async () => {
    await withEnv(
        { BILLION_CONTEXT_PROXY: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_PROVIDER_REWRITES: undefined },
        () => {
            _resetRegisterForTest(undefined);
            const adopted = _adoptOriginForTest("http://127.0.0.1:49999");
            assert.equal(adopted, "http://127.0.0.1:49999");
            // #983 root cause: a self-spawned ephemeral origin was written into the
            // attach-trusted env var, so a later in-process plan mis-read it as an
            // attach target with no liveness check → every tool fetch-failed until
            // the host restarted. Adoption must route in-process only.
            assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined);
            assert.deepEqual(planNativeDsh(process.env), { mode: "spawn" });
        },
    );
});

test("give-up → recovered proxy re-registers tools without a host restart (#983)", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-giveup-"));
    try {
        await withEnv(
            { DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_PROVIDER_REWRITES: undefined },
            async () => {
                _resetRegisterForTest(proxy.origin);
                const ctx = mockCtx();
                apply(ctx); // spawn plan under node:test → sets headersFor, no fetch intercept
                const recovery = _armSpawnRecoveryForTest(async () => {
                    _adoptOriginForTest(proxy.origin); // simulate the recovered proxy being re-adopted
                    return proxy.origin;
                });
                ctx.setInitiator({ session: { id: "s-giveup" } });

                // first model request drives initial registration
                void _stateHeadersForTest()?.("https://api.deepseek.com/chat/completions");
                await waitFor(() => ctx.registeredTools.length === 1, "initial tool registration");
                assert.equal(_stateHeadersForTest()?.("https://api.deepseek.com/chat/completions")?.["x-bili-plugin"], "dsh");

                // proxy died and the last respawn failed → give-up clears routing state
                recovery.giveUp();
                // backoff is armed immediately: a request in the window must NOT recover yet
                assert.equal(_stateHeadersForTest()?.("https://api.deepseek.com/chat/completions"), undefined);

                // the proxy recovers; past the backoff the next request re-bootstraps
                // and re-registers instead of bricking until the host restarts
                recovery.clearBackoff();
                void _stateHeadersForTest()?.("https://api.deepseek.com/chat/completions");
                await waitFor(() => ctx.registeredTools.length === 2, "post-give-up re-registration");
                assert.equal(_stateHeadersForTest()?.("https://api.deepseek.com/chat/completions")?.["x-bili-plugin"], "dsh");
            },
        );
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp pre-first-request (#955): renders the runtime-table entry before any model request", async () => {
    const pre = {
        ok: true,
        conversationId: "dsh",
        phase: "pre-first-request",
        model: "qwen-ri",
        contextLimit: 262144,
        runtimeInfo: { agent: "dsh", model: "qwen-ri", contextWindow: 262144, maxOutput: 32768, source: "client-config" },
        panel: null,
    };
    // no initiator session → statusOutcome takes the fetchStatusLatest path
    // (conversationId=dsh&fallback=latest), which the proxy answers from the
    // agent-keyed runtime table pre-first-request
    const proxy = await startMockProxy([], (url) => (url.includes("conversationId=dsh&fallback=latest") ? pre : undefined));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-pre-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredCommands.length, 1);
            const out = await ctx.registeredCommands[0].handler();
            assert.equal(out.kind, "success");
            assert.match(out.text, /model=qwen-ri/);
            assert.match(out.text, /window=262144/);
            assert.match(out.text, /maxOut=32768/);
            assert.match(out.text, /client-config/);
        });
    } finally {
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
});
