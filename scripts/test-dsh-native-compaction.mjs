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
let failAt = Infinity;
await ctx.plugin(c => c.reflect.provide('llm', {
    imageRequestPricing: () => undefined,
    resolveModelInfo: async (_provider, model) => ({ context: { contextWindow: model === 'gpt-luna' ? 272000 : 18000 }, defaultMaxTokens: 100 }),
    async *stream(options) {
        assert.equal(policy.nativeSummaryActive(), true);
        const cost = options.messages.reduce((n, m) => n + ctx.tokenMeter.estimateMessage(m), 0);
        const toolsTokens = options.tools?.length ? Math.ceil(JSON.stringify(options.tools).length / 4) + 4 : 0;
        const window = options.model === 'gpt-luna' ? 272000 : 18000;
        assert.ok(cost + toolsTokens + options.maxTokens < window, `summary overflow: ${cost} + ${toolsTokens}`);
        calls.push(options);
        if (fail || calls.length === failAt) throw new Error('synthetic provider failure');
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
    { name: new URL('dsh-compaction-basic/lib/index.js', root).href, config: { auto: true, thresholdRatio: 0.8, headroomTokens: 1000, maxTokens: 200, retainTokens: 1000, modelPolicies: [{ provider: 'fake', model: 'gpt-luna', headroomTokens: 65536, maxTokens: 65536, retainTokens: 32245 }] } },
    { name: new URL('../dist/agent/dsh-native-compaction.js', import.meta.url).href },
] });
await ctx.loader.await();
const engine = ctx.loader.resolveGroup('compaction').ctx.get('compaction');
assert.ok(engine, 'isolated preset group provides its compaction engine');
assert.equal(ctx.get('compaction'), undefined, 'preset engine does not leak to the host plane');
function fixture(id, model, count = 16, tools = [], repeats = 2600) {
    const session = ctx.sessions.create(id);
    session.append('system/message', { message: createSystemMessage('Keep the facts.') }, { surfaceOp: 'append' });
    session.append('request/header', { header: { config: { provider: 'fake', model, maxTokens: model === 'gpt-luna' ? 70464 : 200 }, ...(tools.length ? { tools } : {}) }, reason: 'initial' });
    for (let i = 0; i < count; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `fact-${i}: `.repeat(repeats) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
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
    const tools = Array.from({ length: 327 }, (_, i) => ({ name: `tool_${i}`, description: 'Synthetic 工具目录 description. '.repeat(40), parameters: { type: 'object', properties: {} } }));
    assert.ok(Buffer.byteLength(JSON.stringify(tools)) > 272000);
    const large = fixture('large-tool-test', 'gpt-luna', 12, tools, 7500);
    const largeHistory = large.session.snapshotEvents();
    const largeBefore = ctx.tokenMeter.measure(large.session).totalTokens;
    const beforeCalls = calls.length;
    assert.ok(await engine.compactIfNeeded(large, 'pressure'));
    const largeCalls = calls.slice(beforeCalls);
    assert.ok(largeCalls.length > 1, 'large catalog still allows bounded multi-batch summary');
    for (const call of largeCalls) assert.deepEqual(call.tools, tools);
    assert.deepEqual(large.session.snapshotEvents().slice(0, largeHistory.length), largeHistory);
    assert.equal(large.session.surface.replaceGeneration, 1);
    assert.ok(ctx.tokenMeter.measure(large.session).totalTokens < 136000, 'native pressure drops below the Luna threshold');
    const oversized = fixture('oversized-tools-test', 'gpt-luna', 16, [{ name: 'too_large', description: 'x'.repeat(800000), parameters: { type: 'object' } }]);
    const oversizedSurface = [...oversized.session.surface.nodes];
    const beforeOversize = calls.length;
    await assert.rejects(engine.compactIfNeeded(oversized, 'pressure'), /insufficient input budget/);
    assert.equal(calls.length, beforeOversize);
    assert.deepEqual(oversized.session.surface.nodes, oversizedSurface);
    assert.equal(oversized.session.surface.replaceGeneration, 0);
    const broken = fixture('failed-test', 'gpt-5');
    const nodes = [...broken.session.surface.nodes];
    fail = true;
    await assert.rejects(engine.compactIfNeeded(broken, 'pressure'), /synthetic provider failure/);
    assert.deepEqual(broken.session.surface.nodes, nodes);
    assert.equal(broken.session.surface.replaceGeneration, 0);
    fail = false;
    const late = fixture('late-failed-test', 'gpt-5');
    const lateNodes = [...late.session.surface.nodes];
    const lateHistory = late.session.snapshotEvents();
    failAt = calls.length + 2;
    await assert.rejects(engine.compactIfNeeded(late, 'pressure'), /synthetic provider failure/);
    assert.equal(calls.length, failAt, 'first batch completed before the second failed');
    assert.deepEqual(late.session.surface.nodes, lateNodes, 'no partial checkpoint becomes visible');
    assert.equal(late.session.surface.replaceGeneration, 0);
    assert.deepEqual(late.session.snapshotEvents().slice(0, lateHistory.length), lateHistory);
    failAt = Infinity;
    assert.ok(await engine.compactIfNeeded(late, 'pressure'), 'the failed session remains retryable');
    assert.equal(late.session.surface.replaceGeneration, 1);
    console.log(JSON.stringify({ result: 'passed', realDSH: '0.2.2-rc.1', summaryCalls: calls.length, originalSurfaceNodes: originalCount, finalSurfaceNodes: agent.session.surface.nodes.length, generation: agent.session.surface.replaceGeneration, largeCatalog: { tools: tools.length, summaryCalls: largeCalls.length, beforeTokens: largeBefore, afterTokens: ctx.tokenMeter.measure(large.session).totalTokens } }));
} finally { await ctx.fiber.dispose(); }
