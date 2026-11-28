import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
if (!process.argv[2]) throw new Error('Usage: node scripts/test-dsh-native-compaction.mjs /path/to/isolated-dsh-runtime');
const root = pathToFileURL(path.resolve(process.argv[2], 'node_modules/@deepseek-ai') + '/');
const load = async name => import(new URL(`${name}/lib/index.js`, root));
const { Context } = await load('cordis');
const { default: Loader } = await load('cordis-plugin-loader');
const { Session, SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { TokenMeter } = await load('dsh-token-meter');
const { createUserMessage, createSystemMessage } = await load('dsh-llm');
const policy = await import('../dist/agent/dsh-native-compaction.js');
policy.configureNativeCompaction([{ model: 'gpt-*' }]);
const config = { auto: true, thresholdRatio: 0.8, headroomTokens: 1000, maxTokens: 200, retainTokens: 1000 };
const catalog = Array.from({ length: 327 }, (_, i) => ({ name: `tool_${i}`, description: 'Synthetic 工具目录 description. '.repeat(40), parameters: { type: 'object', properties: {} } }));
const scenarios = [
    { name: 'below-pressure', repeats: 10, expectedCalls: 0 },
    { name: 'pressure', repeats: 450, expectedCalls: 1 },
    { name: 'native-pressure-repeat', repeats: 450, config: { thresholdRatio: 0.4, retainTokens: 6000 }, longFirst: true, expectedCalls: 2 },
    { name: 'manual', repeats: 200, method: 'manual', expectedCalls: 1 },
    { name: 'region', repeats: 200, method: 'region', expectedCalls: 1 },
    { name: 'model-switch', repeats: 450, previous: 'glm-test', method: 'switch', expectedCalls: 1 },
    { name: 'configured-summary-model', repeats: 450, config: { summarizationProvider: 'summary', summarizationModel: 'glm-summary' }, expectedCalls: 1 },
    { name: 'provider-failure', repeats: 450, fail: true, expectedCalls: 1, error: 'synthetic provider failure' },
    { name: 'retry-after-failure', repeats: 450, fail: true, retry: true, expectedCalls: 2 },
    { name: 'cancelled', repeats: 450, cancel: true, expectedCalls: 0, error: 'synthetic cancellation' },
    { name: 'oversized-history', repeats: 2600, expectedCalls: 1, error: 'provider context window exceeded' },
    { name: 'large-tool-catalog', repeats: 7500, model: 'gpt-luna', tools: catalog, config: { maxTokens: 65536, headroomTokens: 65536, retainTokens: 32245 }, expectedCalls: 1, error: 'provider context window exceeded' },
    { name: 'oversized-tools', repeats: 450, tools: [{ name: 'huge', description: 'x'.repeat(800000), parameters: { type: 'object' } }], expectedCalls: 1, error: 'provider context window exceeded' },
];

async function run(scenario, routed, seed) {
    const ctx = new Context(), calls = [];
    const model = scenario.model ?? 'gpt-test';
    const window = model === 'gpt-luna' ? 272000 : 18000;
    try {
        await ctx.plugin(c => c.reflect.provide('llm', {
            imageRequestPricing: () => undefined,
            resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: 100 }),
            async *stream(options) {
                assert.equal(policy.nativeSummaryActive(), routed);
                calls.push(options);
                if (scenario.fail && (!scenario.retry || calls.length === 1)) throw new Error('synthetic provider failure');
                const tokens = options.messages.reduce((n, m) => n + ctx.tokenMeter.estimateMessage(m), 0);
                const tools = options.tools?.length ? Math.ceil(JSON.stringify(options.tools).length / 4) + 4 : 0;
                if (tokens + tools + options.maxTokens > window) throw new Error('provider context window exceeded');
                yield { type: 'text-delta', index: 0, text: scenario.longFirst && calls.length === 1 ? 'Historical stable fact. '.repeat(400) : 'Facts retained: ROUTE-811; budget 7314; no production changes.' };
                yield { type: 'finish', reason: 'stop' };
            },
        }));
        await ctx.plugin(SessionStore);
        await ctx.plugin(SessionProjectionRegistry);
        await ctx.plugin(TokenMeter);
        await ctx.plugin(Loader, { baseUrl: root.href });
        ctx.loader.builtins.group = await load('cordis-plugin-group');
        await ctx.loader.create({ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
            { name: new URL('dsh-compaction-basic/lib/index.js', root).href, config: { ...config, ...scenario.config } },
            ...(routed ? [{ name: new URL('../dist/agent/dsh-native-compaction.js', import.meta.url).href }] : []),
        ] });
        await ctx.loader.await();
        const engine = ctx.loader.resolveGroup('compaction').ctx.get('compaction');
        assert.ok(engine);
        assert.equal(ctx.get('compaction'), undefined);
        const id = `parity-${scenario.name}`;
        const session = seed ? ctx.sessions.create(id, { seed: seed.events, meta: seed.header }) : ctx.sessions.create(id);
        if (!seed) {
            session.append('system/message', { message: createSystemMessage('Keep the facts.') }, { surfaceOp: 'append' });
            session.append('request/header', { header: { config: { provider: 'fake', model: scenario.previous ?? model, maxTokens: model === 'gpt-luna' ? 70464 : 200 }, ...(scenario.tools ? { tools: scenario.tools } : {}) }, reason: 'initial' });
            for (let i = 0; i < 16; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `fact-${i}: `.repeat(scenario.repeats) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
            if (scenario.method !== 'manual') session.append('turn/start', { turn: 'test-turn' });
            session.append('session/end-seed', {});
        }
        const before = { events: session.snapshotEvents(), header: session.header };
        if (seed) assert.deepEqual(before.events, seed.events, 'both arms start from the exact same event log');
        const nodes = [...session.surface.nodes];
        let current = model;
        const agent = { session, options: { provider: 'fake', model }, model: { current: () => ({ provider: 'fake', model: current }) }, runMaintenance: fn => fn(new AbortController().signal) };
        const controller = new AbortController();
        if (scenario.cancel) controller.abort(new Error('synthetic cancellation'));
        let error;
        try {
            if (scenario.method === 'manual') await engine.compactNow(agent, controller.signal);
            else if (scenario.method === 'region') await engine.compactRegion(2, 7, agent, controller.signal);
            else if (scenario.method === 'switch') await engine.compactPressure(agent, { config: { provider: 'fake', model, maxTokens: 200 } }, controller.signal, true);
            else await engine.compactIfNeeded(agent, 'pressure', controller.signal);
        } catch (e) { error = e.message; }
        if (scenario.retry) {
            assert.equal(error, 'synthetic provider failure');
            assert.deepEqual(session.surface.nodes, nodes);
            assert.equal(session.surface.replaceGeneration, 0);
            await engine.compactIfNeeded(agent, 'pressure', controller.signal);
            error = undefined;
        }
        assert.equal(error, scenario.error, scenario.name);
        assert.equal(calls.length, scenario.expectedCalls, scenario.name);
        assert.deepEqual(session.snapshotEvents().slice(0, before.events.length), before.events);
        if (scenario.error) {
            assert.deepEqual(session.surface.nodes, nodes);
            assert.equal(session.surface.replaceGeneration, 0);
        }
        const nativeNamespace = policy.compactionConversationId(agent, id);
        if (routed) {
            current = 'glm-test';
            const generation = session.surface.replaceGeneration;
            assert.equal(await engine.compactIfNeeded(agent, 'pressure'), null);
            assert.equal(session.surface.replaceGeneration, generation);
            const restored = Session.create(id, session.snapshotEvents(), session.header);
            assert.equal(policy.compactionConversationId({ session: restored }, id), nativeNamespace);
            assert.equal(nativeNamespace, generation ? `${id}|dsh-generation:${generation}` : id);
        }
        const output = {
            calls: calls.map(({ signal, ...rest }) => rest), error,
            generation: session.surface.replaceGeneration,
            tokens: ctx.tokenMeter.measure(session).totalTokens,
            events: session.snapshotEvents().slice(before.events.length).map(e => ({ type: e.type, data: e.data })),
        };
        // Only host-generated IDs differ between independent executions; input and tool IDs stay exact.
        const generated = new Map(), prior = JSON.stringify(before.events);
        function canonical(value, key) {
            if (typeof value === 'string' && (key === 'compactionId' || key === 'id') && !prior.includes(value)) {
                if (!generated.has(value)) generated.set(value, `generated-${generated.size}`);
                return generated.get(value);
            }
            if (Array.isArray(value)) return value.map(v => canonical(v));
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v, k)]));
            return value;
        }
        return { seed: before, output: canonical(output) };
    } finally { await ctx.fiber.dispose(); }
}

const results = [];
for (const scenario of scenarios) {
    const baseline = await run(scenario, false);
    const routed = await run(scenario, true, baseline.seed);
    assert.deepEqual(routed.output, baseline.output, `${scenario.name}: routed native must match stock DSH`);
    results.push({ scenario: scenario.name, callsPerArm: routed.output.calls.length, generation: routed.output.generation, outcome: routed.output.error ?? 'success' });
}
console.log(JSON.stringify({ result: 'passed', realDSH: '0.2.2-rc.1', parityCases: results }));
