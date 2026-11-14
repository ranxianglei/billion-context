import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
    apply, maybeRetryForTest, _resetRegisterForTest, _settleNativeForTest, _nativeStateForTest,
    _registerStateForTest, _stateToolsReadyForTest, _stateHeadersForTest,
    type PluginContext,
} from "../src/agent/dsh-native.ts";

const names = ["compress", "decompress", "search_context", "acp_status", "acp_cache", "bili_status"];
type Definition = Parameters<PluginContext["tools"]["register"]>[0];
const manifest = (toolNames = names) => Response.json({ tools: { anthropic: toolNames.map((name) => ({
    name, description: name, input_schema: { type: "object", properties: {} },
})) } });
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

function host() {
    const definitions = new Map<string, Definition>();
    const listeners = new Set<() => void>();
    const changed = () => { for (const listener of listeners) listener(); };
    function owner() {
        const disposers: Array<() => void> = [];
        const ctx: PluginContext = {
            tools: {
                get: (name) => definitions.get(name),
                register: (definition) => {
                    if (definitions.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
                    definitions.set(definition.name, definition);
                    const dispose = () => {
                        if (definitions.get(definition.name) !== definition) return;
                        definitions.delete(definition.name);
                        changed();
                    };
                    disposers.push(dispose);
                    changed();
                    return dispose;
                },
            },
            commands: { register() {} },
            agents: { currentInitiator: () => ({ session: { id: "lifetime-session" } }) },
            inject() {},
            effect: (effect) => { const dispose = effect(); if (dispose) disposers.push(dispose); },
            on: (event, listener) => {
                if (event !== "tools/change") return;
                const changedListener = listener as () => void;
                listeners.add(changedListener);
                disposers.push(() => { listeners.delete(changedListener); });
            },
        };
        return { ctx, dispose: () => { for (const dispose of disposers.splice(0)) dispose(); } };
    }
    return { definitions, owner };
}

function reset() {
    _resetRegisterForTest("http://bili-lifetime.invalid");
    _nativeStateForTest().ready = Promise.resolve("http://bili-lifetime.invalid");
}

afterEach(() => {
    mock.restoreAll();
    void _settleNativeForTest();
    _resetRegisterForTest(undefined);
});

test("same-context restart re-registers all tools and disposal clears readiness", async () => {
    const registry = host();
    const owner = registry.owner();
    let requests = 0;
    mock.method(globalThis, "fetch", async () => { requests++; return manifest(); });
    reset();
    await apply(owner.ctx);
    await _stateToolsReadyForTest();
    assert.deepEqual([...registry.definitions.keys()], names);
    owner.dispose();
    assert.equal(_registerStateForTest().toolsReady, false);
    assert.equal(registry.definitions.size, 0);
    await apply(owner.ctx);
    await _stateToolsReadyForTest();
    assert.equal(requests, 2);
    assert.deepEqual([...registry.definitions.keys()], names);
    assert.equal(_stateHeadersForTest()?.("http://model.invalid/v1/messages")?.["x-bili-plugin"], "dsh");
    owner.dispose();
    maybeRetryForTest(owner.ctx);
    assert.equal(registry.definitions.size, 0, "disposed activation must never resurrect its tools");
});

test("borrowed registrations survive new-owner disposal and heal after old-owner disposal", async () => {
    const registry = host();
    const oldOwner = registry.owner();
    const newOwner = registry.owner();
    mock.method(globalThis, "fetch", async () => manifest());
    reset();
    await apply(oldOwner.ctx);
    await _stateToolsReadyForTest();
    const borrowed = registry.definitions.get("compress");
    await apply(newOwner.ctx);
    await _stateToolsReadyForTest();
    assert.equal(registry.definitions.get("compress"), borrowed);
    oldOwner.dispose();
    assert.deepEqual([...registry.definitions.keys()].sort(), [...names].sort());
    assert.notEqual(registry.definitions.get("compress"), borrowed);
    assert.equal(_registerStateForTest().toolsReady, true);
    const foreignOwner = registry.owner();
    const definition = registry.definitions.get("compress");
    assert.ok(definition);
    newOwner.dispose();
    foreignOwner.ctx.tools.register(definition);
    const borrowingOwner = registry.owner();
    await apply(borrowingOwner.ctx);
    await _stateToolsReadyForTest();
    assert.equal(registry.definitions.get("compress"), definition);
    borrowingOwner.dispose();
    assert.equal(registry.definitions.get("compress"), definition, "foreign registration keeps its original lifetime");
    foreignOwner.dispose();
    assert.equal(registry.definitions.size, 0);
});

test("a late old manifest cannot register tools or clear the new activation's pending flight", async () => {
    const registry = host();
    const owner = registry.owner();
    const entered = [deferred(), deferred()];
    const held = [deferred(), deferred()];
    let requests = 0;
    mock.method(globalThis, "fetch", async () => {
        const index = requests++;
        assert.ok(index < 2, "new activation must retain its single-flight latch");
        entered[index].resolve();
        await held[index].promise;
        return manifest(index === 0 ? ["stale_tool"] : names);
    });
    reset();
    await apply(owner.ctx);
    await entered[0].promise;
    const oldGate = _stateToolsReadyForTest();
    owner.dispose();
    await apply(owner.ctx);
    await entered[1].promise;
    held[0].resolve();
    await oldGate;
    assert.equal(registry.definitions.size, 0, "old manifest must not pollute the new activation");
    assert.equal(_registerStateForTest().toolsReady, false);
    maybeRetryForTest(owner.ctx);
    held[1].resolve();
    await _stateToolsReadyForTest();
    assert.equal(requests, 2);
    assert.deepEqual([...registry.definitions.keys()], names);
    assert.equal(_registerStateForTest().toolsReady, true);
    owner.dispose();
});

// #6702: the mock owners above cannot reproduce the failure orderings that
// caused the bug — Cordis restarts reuse one context while its effect-owned
// registrations die — so the final scenario runs against a real fiber with the
// `@deepseek-ai/cordis` dev dependency. TestTools mirrors the real
// ToolsService ownership: extending cordis Service makes `this.ctx` resolve to
// the CALLING plugin's context, so each registration is held by that fiber's
// effect and teardown emits tools/change.
import { Context, Service, type Plugin } from "@deepseek-ai/cordis";

class TestTools extends Service {
    definitions = new Map<string, Definition>();

    constructor(ctx: Context) {
        super(ctx, "tools");
    }

    get(name: string) {
        return this.definitions.get(name);
    }

    register(definition: Definition) {
        if (this.definitions.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
        return this.ctx.effect(() => {
            this.definitions.set(definition.name, definition);
            return () => {
                if (this.definitions.get(definition.name) !== definition) return;
                this.definitions.delete(definition.name);
                this.ctx.events.emit("tools/change");
            };
        }, `bili-test: ${definition.name}`);
    }
}

test("#6702 real Cordis fibers own registration lifetime across restart, adoption and teardown", async () => {
    const ctx = new Context();
    const owners: PluginContext[] = [];
    let tools: TestTools | undefined;
    const liveNames = () => names.filter((name) => tools?.definitions.get(name) !== undefined);
    const biliPlugin = {
        inject: ["tools", "commands", "agents"],
        apply(owner: PluginContext) {
            owners.push(owner);
            return apply(owner);
        },
    };
    try {
        await ctx.plugin({ apply(owner) {
            owner.provide("commands", { register() {} });
            owner.provide("agents", { currentInitiator: () => ({ session: { id: "lifetime-session" } }) });
            tools = new TestTools(owner);
        } });
        const load = (plugin: unknown) => ctx.plugin(plugin as Plugin.Object);

        // Same-context restart: one context, two activations, each owning its
        // own registrations — the reused context never inherits the stale
        // ready stamp, and the old activation's registrations die with it.
        reset();
        let requests = 0;
        mock.method(globalThis, "fetch", async () => { requests++; return manifest(); });
        const first = await load(biliPlugin);
        await _stateToolsReadyForTest();
        assert.deepEqual(liveNames(), names);
        assert.equal(_registerStateForTest().toolsReady, true);
        await first.restart();
        await _stateToolsReadyForTest();
        assert.equal(owners[0], owners[1], "a Cordis restart reuses one context");
        assert.equal(requests, 2, "the reused context re-registers instead of trusting the stale latch");
        assert.deepEqual(liveNames(), names);
        assert.equal(_registerStateForTest().toolsReady, true);
        await first.dispose();
        assert.deepEqual(liveNames(), [], "disposing the fiber removes its own registrations");
        assert.equal(_registerStateForTest().toolsReady, false);

        // A same-named registration held by another fiber keeps its original
        // lifetime: adopting it must not transfer ownership to bili, and the
        // borrower's disposal must not remove it.
        reset();
        const foreignDefinition: Definition = {
            name: "compress",
            description: "foreign",
            parameters: { type: "object", properties: {} },
            output: { schema: {}, render: () => [{ type: "text", text: "foreign" }] },
            execute: async () => "foreign",
        };
        const foreign = await ctx.plugin({ inject: ["tools"], apply(owner) {
            (owner as Context & { tools: TestTools }).tools.register(foreignDefinition);
        } });
        const borrower = await load(biliPlugin);
        await _stateToolsReadyForTest();
        assert.deepEqual(liveNames(), names, "the new activation registers around the adopted foreign tool");
        await borrower.dispose();
        assert.deepEqual(liveNames(), ["compress"], "disposing the borrower keeps the foreign registration");
        assert.equal(_registerStateForTest().toolsReady, false);
        const replacementBorrower = await load(biliPlugin);
        await _stateToolsReadyForTest();
        await foreign.dispose();
        assert.deepEqual(liveNames(), names, "the active borrower restores registrations removed with the old owner");
        assert.notEqual(tools?.get("compress"), foreignDefinition);
        await replacementBorrower.dispose();
        assert.deepEqual(liveNames(), [], "the replacement registrations belong to the active borrower");

        // A late old manifest must not pollute the next activation or clear
        // its single-flight latch.
        reset();
        const entered = [deferred(), deferred()];
        const held = [deferred(), deferred()];
        let index = 0;
        mock.method(globalThis, "fetch", async () => {
            const i = index++;
            assert.ok(i < 2, "the new activation must retain its single-flight latch");
            entered[i].resolve();
            await held[i].promise;
            return manifest(i === 0 ? ["stale_tool"] : names);
        });
        const pending = await load(biliPlugin);
        await entered[0].promise;
        const oldGate = _stateToolsReadyForTest();
        await pending.restart();
        await entered[1].promise;
        held[0].resolve();
        await oldGate;
        assert.deepEqual(liveNames(), [], "the old manifest must not pollute the new activation");
        assert.equal(_registerStateForTest().toolsReady, false);
        maybeRetryForTest(owners.at(-1)!);
        held[1].resolve();
        await _stateToolsReadyForTest();
        assert.equal(index, 2);
        assert.deepEqual(liveNames(), names);
        await pending.dispose();
        assert.deepEqual(liveNames(), [], "final disposal leaves no registrations behind");
    } finally {
        await ctx.fiber.dispose();
    }
});
