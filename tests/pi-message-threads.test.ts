import assert from "node:assert/strict";
import test from "node:test";
import { createBiliPlugin, type Ctx, type ExtensionAPI } from "../src/agent/pi.ts";

test("Pi routed Anthropic models use full requests without changing registry models or thinking", async () => {
    const savedFetch = globalThis.fetch;
    const keys = ["BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_PLUGIN", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS"];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    delete process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILI_PROVIDER_REWRITES;
    delete process.env.BILI_MITM_HOSTS;
    process.env.BILLION_CONTEXT_PLUGIN = "1";
    try {
        const handlers = new Map<string, Array<(event: never, ctx: Ctx) => unknown>>();
        const emit = async (name: string, ctx: Ctx): Promise<void> => {
            for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx);
        };
        let thinking = "medium";
        let selection: "ok" | "refuse" | "reject" | "redirect" = "ok";
        const changes: Ctx["model"][] = [];
        const registryModel = { id: "claude-test", provider: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9999/bili/https://api.anthropic.com", contextWindow: 200000, compat: { supportsMessageThreads: true, supportsToolChoice: true } };
        const ctx: Ctx = { model: registryModel };
        const pi: ExtensionAPI = {
            on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
            registerTool: () => {},
            getThinkingLevel: () => thinking,
            setThinkingLevel: (level) => { thinking = level; },
            setModel: async (model) => {
                if (selection === "refuse") return false;
                if (selection === "reject") throw new Error("host selection failed");
                assert.ok(changes.length < 10, "model_select does not recurse");
                changes.push(model);
                ctx.model = model;
                thinking = "low";
                await emit("model_select", ctx);
                if (selection === "redirect") {
                    ctx.model = { ...registryModel, api: "openai-responses" };
                    thinking = "high";
                }
                return true;
            },
        };
        createBiliPlugin("pi")(pi);
        await emit("session_start", ctx);
        assert.equal(changes.length, 1);
        assert.equal(thinking, "medium");
        assert.notEqual(ctx.model, registryModel);
        assert.equal(registryModel.compat.supportsMessageThreads, true, "do not mutate shared catalog");
        assert.deepEqual(ctx.model, { ...registryModel, compat: { ...registryModel.compat, supportsMessageThreads: false } });
        await emit("model_select", ctx);
        assert.equal(changes.length, 1, "already-disabled model is idempotent");
        ctx.model = { ...registryModel, id: "another-claude", compat: undefined };
        await emit("model_select", ctx);
        assert.equal(changes.length, 2, "subsequent model choices receive the same compatibility override");
        assert.equal(ctx.model.compat && (ctx.model.compat as Record<string, unknown>).supportsMessageThreads, false);

        const untouched = [
            { ...registryModel, api: "openai-responses" },
            { ...registryModel, api: "pi-virtual", baseUrl: "" },
            { ...registryModel, baseUrl: "claude-bridge" },
            { ...registryModel, baseUrl: "https://api.anthropic.com" },
            { ...registryModel, compat: { supportsMessageThreads: false } },
            { ...registryModel, compat: null },
            { ...registryModel, compat: [] },
            { ...registryModel, compat: 1 },
        ];
        for (const model of untouched) {
            ctx.model = model;
            await emit("model_select", ctx);
            assert.equal(ctx.model, model);
            assert.equal(changes.length, 2);
        }
        const flag = Symbol.for("billion-context.native-fetch-intercept");
        const globals = globalThis as Record<PropertyKey, unknown>;
        const oldFlag = globals[flag];
        try {
            globals[flag] = true;
            process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9999";
            ctx.model = { ...registryModel, baseUrl: "https://api.anthropic.com" };
            await emit("before_agent_start", ctx);
            assert.equal(changes.length, 3, "cold native routing negotiates at turn start even when the tool manifest is unavailable");
            assert.equal(thinking, "medium");
            const overridden = ctx.model;
            process.env.BILLION_CONTEXT_PLUGIN = "0";
            await emit("model_select", ctx);
            assert.equal(ctx.model, overridden, "session override remains until the next model selection; no catalog was mutated");
            process.env.BILLION_CONTEXT_PLUGIN = "1";
            delete process.env.BILLION_CONTEXT_PROXY;
            ctx.model = { ...registryModel, baseUrl: "https://api.anthropic.com" };
            await emit("model_select", ctx);
            assert.equal(changes.length, 3, "stale interceptor flag without a live routing claim is insufficient");
            process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9999";
            globals[flag] = false;
            process.env.BILI_MITM_HOSTS = "api.anthropic.com";
            await emit("model_select", ctx);
            assert.equal(changes.length, 4, "MITM routing also negotiates");
        } finally {
            if (oldFlag === undefined) delete globals[flag];
            else globals[flag] = oldFlag;
            delete process.env.BILLION_CONTEXT_PROXY;
            delete process.env.BILI_MITM_HOSTS;
        }
        ctx.model = registryModel;
        selection = "refuse";
        await emit("model_select", ctx);
        assert.equal(ctx.model, registryModel, "refused selection leaves the active model untouched");
        selection = "reject";
        await assert.rejects(emit("model_select", ctx), /host selection failed/);
        assert.equal(ctx.model, registryModel);
        selection = "redirect";
        await emit("model_select", ctx);
        assert.equal(ctx.model?.api, "openai-responses");
        assert.equal(thinking, "high", "do not restore thinking into a model chosen by another listener");
        selection = "ok";
        const negotiatedCount = changes.length;
        process.env.BILLION_CONTEXT_PLUGIN = "0";
        ctx.model = registryModel;
        await emit("model_select", ctx);
        assert.equal(changes.length, negotiatedCount, "plugin kill switch keeps native threads untouched");
        process.env.BILLION_CONTEXT_PLUGIN = "1";
        const ompHandlers = new Map<string, Array<(event: never, ctx: Ctx) => unknown>>();
        createBiliPlugin("omp")({ ...pi, on: (name, handler) => { ompHandlers.set(name, [...(ompHandlers.get(name) ?? []), handler]); } });
        assert.equal(ompHandlers.has("model_select"), false, "OMP keeps its existing separate negotiation");
        const legacyHandlers = new Map<string, Array<(event: never, ctx: Ctx) => unknown>>();
        const oldPi: ExtensionAPI = { on: (name, handler) => { legacyHandlers.set(name, [...(legacyHandlers.get(name) ?? []), handler]); }, registerTool: () => {} };
        assert.doesNotThrow(() => createBiliPlugin("pi")(oldPi), "older hosts without setModel still load");
        ctx.model = registryModel;
        for (const handler of legacyHandlers.get("model_select") ?? []) await handler({} as never, ctx);
        assert.equal(ctx.model, registryModel, "older hosts safely skip compatibility negotiation");
    } finally {
        globalThis.fetch = savedFetch;
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
