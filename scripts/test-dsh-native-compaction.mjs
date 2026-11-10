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
const { BasicCompactionEngine } = await load('dsh-compaction-basic');
const { createUserMessage, createSystemMessage } = await load('dsh-llm');
const policy = await import('../dist/agent/dsh-native-compaction.js');
policy.configureNativeCompaction([{ model: 'gpt-*' }]);
const ctx = new Context();
const calls = [];
let fail = false;
await ctx.plugin(c => c.reflect.provide('llm', {
    imageRequestPricing: () => undefined,
    resolveModelInfo: async () => ({ context: { contextWindow: 18000 }, defaultMaxTokens: 100 }),
    async *stream(options) {
        assert.equal(policy.nativeSummaryActive(), true);
        const cost = options.messages.reduce((n, m) => n + ctx.tokenMeter.estimateMessage(m), 0);
        assert.ok(cost + options.maxTokens < 18000, `summary overflow: ${cost}`);
        calls.push(options);
        if (fail) throw new Error('synthetic provider failure');
        yield { type: 'text-delta', index: 0, text: 'Facts retained: checkpoint integration verified.' };
        yield { type: 'finish', reason: 'stop' };
    }
}));
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(TokenMeter);
await ctx.plugin(Loader, { baseUrl: root.href });
ctx.loader.builtins.group = await load('cordis-plugin-group');
await ctx.loader.create({ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
    { name: new URL('dsh-compaction-basic/lib/index.js', root).href, config: { auto: true, thresholdRatio: 0.8, headroomTokens: 1000, maxTokens: 200, retainTokens: 1000 } },
    { name: new URL('../dist/agent/dsh-native-compaction.js', import.meta.url).href },
] });
await ctx.loader.await();
const engine = ctx.loader.resolveGroup('compaction').ctx.get('compaction');
assert.ok(engine, 'isolated preset group provides its compaction engine');
assert.equal(ctx.get('compaction'), undefined, 'preset engine does not leak to the host plane');
function fixture(id, model, count = 16) {
    const session = ctx.sessions.create(id);
    session.append('system/message', { message: createSystemMessage('Keep the facts.') }, { surfaceOp: 'append' });
    session.append('request/header', { header: { config: { provider: 'fake', model, maxTokens: 200 } }, reason: 'initial' });
    for (let i = 0; i < count; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `fact-${i}: `.repeat(2600) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('turn/start', { turn: 'test-turn' });
    return { session, options: { provider: 'fake', model }, model: { current: () => ({ provider: 'fake', model }), select: next => { model = next; } } };
}
try {
    const bili = fixture('bili-test', 'kimi');
    const before = bili.session.surface.replaceGeneration;
    assert.equal(await engine.compactIfNeeded(bili, 'pressure'), null);
    assert.equal(bili.session.surface.replaceGeneration, before);
    const agent = fixture('switch-test', 'kimi');
    agent.model.select('gpt-5');
    const old = agent.session.snapshotEvents();
    const originalCount = agent.session.surface.nodes.length;
    const result = await engine.compactPressure(agent, { config: { provider: 'fake', model: 'gpt-5', maxTokens: 200 } }, undefined, true);
    assert.ok(result);
    assert.ok(calls.length > 1, 'oversized handoff uses multiple bounded native calls');
    assert.ok(agent.session.surface.nodes.length < originalCount);
    assert.ok(agent.session.surface.replaceGeneration > 0);
    assert.deepEqual(agent.session.snapshotEvents().slice(0, old.length), old, 'raw log remains immutable');
    const resumed = Session.create(agent.session.id, agent.session.snapshotEvents(), agent.session.header);
    assert.equal(policy.compactionConversationId({ session: resumed }, resumed.id), policy.compactionConversationId(agent, agent.session.id));
    agent.model.select('kimi');
    const generation = agent.session.surface.replaceGeneration;
    assert.equal(await engine.compactIfNeeded(agent, 'pressure'), null);
    assert.equal(agent.session.surface.replaceGeneration, generation);
    const broken = fixture('failed-test', 'gpt-5');
    const nodes = [...broken.session.surface.nodes];
    fail = true;
    await assert.rejects(engine.compactIfNeeded(broken, 'pressure'), /synthetic provider failure/);
    assert.deepEqual(broken.session.surface.nodes, nodes);
    assert.equal(broken.session.surface.replaceGeneration, 0);
    console.log(JSON.stringify({ result: 'passed', realDSH: '0.2.2-rc.1', summaryCalls: calls.length, originalSurfaceNodes: originalCount, finalSurfaceNodes: agent.session.surface.nodes.length, generation: agent.session.surface.replaceGeneration }));
} finally { await ctx.fiber.dispose(); }
