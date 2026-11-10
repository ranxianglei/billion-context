// Real-credential end-to-end: Codex cloud compaction (GPT-6 Luna) through a
// live bili proxy. Proves: real encrypted_content checkpoint is captured and
// reused, the checkpoint header closes a read-only history generation, old
// refs/blocks restore after compaction, a second compaction never rebases
// twice, and the model keeps working from the compacted context.
//
//   node --import ./tests/preload-test-env.mjs --import tsx tests/manual/real-cloud-compaction.e2e.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { defaultConfig } from 'acp-kernel'
import { startServer } from '../../src/server.ts'
import { SessionStore, _setStoreForTest } from '../../src/persist.ts'
import { _setForTest as setRegistryForTest } from '../../src/registry.ts'
import { listSessions, _resetSessionsForTest } from '../../src/session.ts'
import { _resetPluginStateForTest } from '../../src/plugin.ts'
import { historyIndex } from '../../src/history-generations.ts'

// The counterpart plugin lives in its own repository; point at your checkout
// with BILI_CODEX_PLUGIN_DIR (defaults to a sibling checkout) and optionally
// BILI_CODEX_AUTH for the Codex credential file.
const PLUGIN_DIR = process.env.BILI_CODEX_PLUGIN_DIR
  ?? fileURLToPath(new URL('../../../dsh-codex-subscription', import.meta.url))
const authPath = process.env.BILI_CODEX_AUTH ?? join(process.env.HOME ?? '', '.codex/auth.json')
if (!fs.existsSync(authPath)) {
  console.error(`[real-e2e] no Codex credential at ${authPath} — run \`codex login\` or set BILI_CODEX_AUTH`)
  process.exit(2)
}
const pluginModule = (rel) => import(pathToFileURL(join(PLUGIN_DIR, rel)).href)
const { openaiCodexProvider } = await pluginModule('node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js')
const { createCompactionBridge } = await pluginModule('src/subscription-compaction.js')

const MODEL = 'gpt-6-luna'
const WINDOW = 200_000
const CONV = `real-cloud-${Date.now()}`
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
const token = auth.tokens.access_token
const accountId = auth.tokens.account_id
const log = (...a) => console.log('[real-e2e]', ...a)
process.on('unhandledRejection', e => { log('UNHANDLED', e?.stack ?? String(e)); process.exit(1) })
process.on('uncaughtException', e => { log('UNCAUGHT', e?.stack ?? String(e)); process.exit(1) })
const realFetch = globalThis.fetch

_setStoreForTest(new SessionStore({ enabled: false }))
setRegistryForTest({})
_resetSessionsForTest()
_resetPluginStateForTest()

const upstreamBodies = []
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.startsWith('https://chatgpt.com/backend-api/codex/responses') && init?.body) upstreamBodies.push(String(init.body))
  return realFetch(input, init)
}

const proxy = await startServer({
  port: 0, host: '127.0.0.1', upstream: 'https://chatgpt.com',
  routes: { 'https://chatgpt.com': { models: { [MODEL]: { context: WINDOW } } } },
  modelContextLimit: WINDOW, kernelConfig: defaultConfig(WINDOW),
  compress: { injectTool: true, injectNudge: true }, promptCache: { routing: 'auto' },
  sessionHeader: 'x-acp-session', log: false, debug: false, passthrough: false, autoUpdate: false,
  compat: { roles: {} }, streamErrorShape: 'protocol', passthroughSource: null,
  autoRestartOnUpdate: false, updateTag: 'latest', advisoryCheck: false, releaseNotesCheck: false,
  mitm: { enabled: false, domains: [] },
})
await once(proxy, 'listening')
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`
const toolUrl = `${proxyOrigin}/__bili/plugin/tool`

const provider = openaiCodexProvider()
const baseModel = (await provider.getModels()).find(m => m.id === 'gpt-5.6-luna')
const model = { ...baseModel, id: MODEL, name: 'GPT-6 Luna', contextWindow: WINDOW, maxTokens: 32000 }
const bridge = createCompactionBridge({ enabled: () => true, accountScope: async () => accountId, threshold: () => 5000 })
const adapter = bridge.wrapAdapter({
  async prepareCall() {
    return { model, stream: options => piStream(options) }
  },
})

function piStream(options) {
  return (async function* () {
    const headers = {}
    const events = provider.stream({ ...model, id: options.model }, { messages: options.messages }, {
      apiKey: token, transport: 'sse', sessionId: CONV, cacheRetention: 'none',
      onPayload: payload => {
        const prepared = bridge.preparePayload(payload, WINDOW, undefined)
        const sig = bridge.checkpointSignal()
        log('  payload', JSON.stringify({ reuse: !!sig, sig: sig && { seq: sig.seq, covered: sig.covered }, fullHistory: JSON.stringify(prepared.input).includes('history 0 lorem'), inputItems: prepared.input.length, compactionItems: prepared.input.filter(i => i.type === 'compaction').length }))
        Object.assign(headers, Object.fromEntries(bridge.stampHeaders(new Headers({})).entries()))
        return prepared
      },
      fetch: async (url, init) => {
        log('  upstream fetch', new URL(url).pathname)
        const target = new URL(url)
        const routed = `${proxyOrigin}/bili/https://${target.host}${target.pathname}${target.search}`
        const h = new Headers(init.headers)
        for (const [k, v] of Object.entries(headers)) h.set(k, v)
        h.set('x-bili-plugin', 'dsh')
        h.set('x-bili-plugin-conversation', CONV)
        const res = await realFetch(routed, { ...init, headers: h, signal: AbortSignal.timeout(150000) })
        log('  proxy response', res.status)
        return bridge.networkOptions({}).transformResponse(res, new URL(url))
      },
    })
    log('  pi stream started')
    const blocks = []
    let done
    for await (const ev of events) {
      if (ev.type === 'error') log('  pi stream error', JSON.stringify(ev.error?.errorMessage ?? ev))
      if (ev.type === 'text_end') blocks[ev.contentIndex] = { type: 'text', text: ev.content }
      if (ev.type === 'done') done = ev
    }
    const kept = blocks.filter(Boolean)
    kept.forEach((block, index) => { blocks[index] = block })
    for (let i = 0; i < kept.length; i++) yield { type: 'block-end', index: i, block: kept[i] }
    yield {
      type: 'finish',
      reason: { kind: done?.reason === 'toolUse' ? 'tool-calls' : 'stop' },
      replayState: { response: { kind: 'pi-ai', version: 2 }, blocks: kept },
      text: kept.map(b => b.text ?? '').join(''),
    }
  })()
}

async function turn(messages, label) {
  const events = []
  for await (const ev of adapter.stream({ provider: 'openai-codex', model: MODEL, messages, maxTokens: 32000 })) events.push(ev)
  const finish = events.find(e => e.type === 'finish')
  const blocks = events.filter(e => e.type === 'block-end').map(e => e.block)
  const assistant = { role: 'assistant', content: blocks, source: { kind: 'pi-ai', provider: 'openai-codex', model: MODEL, replayState: finish.replayState } }
  const usage = messages.length
  log(`${label}: cp=${(finish.replayState?.response?.codexCompactionV1?.digest ?? 'none').slice(0, 12)} blocks=${blocks.length} text=${JSON.stringify((finish.text ?? '').slice(0, 160))} upstreamBodies=${upstreamBodies.length}`)
  return { assistant, finish, text: finish.text ?? '' }
}

function theSession() {
  const all = listSessions()
  return all.find(s => (s.lastMessages?.length ?? 0) > 0) ?? all.at(-1)
}

// ── turn 1: large real request, server-side compaction ───────────────────
const history = Array.from({ length: 12 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `history ${i} ` + ('lorem ipsum dolor sit amet ' + i + ' ').repeat(333) }],
}))
const messages1 = [...history, { role: 'user', content: [{ type: 'text', text: 'Remember this token: REAL-COMPACT-TOKEN-9. Reply with exactly: SEEDED' }] }]
const t1 = await turn(messages1, 'turn1 (compaction)')
const s1 = theSession()
const blocksBefore = s1.state.blocks.filter(b => b.active).map(b => b.blockId)
log('session', s1.id, 'refs', Object.keys(s1.state.messageRefs.byRaw).length, 'blocks', JSON.stringify(blocksBefore), 'generations', historyIndex(s1).length)
assert.ok(t1.finish.replayState?.response?.codexCompactionV1?.items?.[0]?.encrypted_content, 'turn1 must persist a real encrypted checkpoint')

// fold the head through the plugin tool endpoint (the agent's ACP compression)
const fold = await realFetch(toolUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: s1.id, tool: 'compress', args: { content: [{ startId: 'm00001', endId: 'm00007', topic: 'folded head', summary: 'FOLDED-SUMMARY real e2e head: twelve seeded turns; the user assigned token REAL-COMPACT-TOKEN-9 and asked for a SEEDED reply.' }] } }),
})
const foldText = await fold.text()
log('fold', fold.status, foldText.slice(0, 160))
assert.ok(fold.status === 200 && !foldText.includes('no-op'), `fold must fold: ${foldText.slice(0, 300)}`)
const folded = theSession().state.blocks.filter(b => b.active).map(b => b.blockId)
log('folded blocks', JSON.stringify(folded))

// ── turn 2: checkpoint reuse -> authoritative boundary ───────────────────
const messages2 = [...messages1, t1.assistant, { role: 'user', content: [{ type: 'text', text: 'What token did I ask you to remember? Reply with the token only.' }] }]
const beforeBodyCount = upstreamBodies.length
const t2 = await turn(messages2, 'turn2 (reuse)')
const s2 = theSession()
const gens = historyIndex(s2)
log('generations', gens.length, JSON.stringify(gens.map(g => ({ n: g.generation, cause: g.cause, cp: g.checkpointId?.slice(0, 12), blocks: g.blockIds, refs: [g.firstRef, g.lastRef] }))))
log('nextBlockId', s2.state.nextBlockId, 'checkpoint record', JSON.stringify(s2.metadata.codexCloudCheckpoint ?? null))

const sent2 = upstreamBodies[beforeBodyCount] ?? ''
assert.ok(gens.length === 1, `reuse must close exactly one generation (got ${gens.length})`)
assert.ok(gens[0].blockIds.includes(folded[0]), 'the folded block must be archived in generation 1')
assert.ok(!sent2.includes('history 0 lorem'), 'the reused request must NOT resend the summarized history')
assert.ok(sent2.includes('encrypted_content'), 'the reused request must carry the real encrypted checkpoint')
assert.ok(/REAL-COMPACT-TOKEN-9/.test(t2.text), `model must answer from the compacted context, got ${JSON.stringify(t2.text.slice(0, 200))}`)

// old refs and blocks restore read-only from the generation
const oldRef = gens[0].firstRef
const dec = await realFetch(toolUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: s2.id, tool: 'decompress', args: { blockId: gens[0].blockIds[0], full: true } }),
  signal: AbortSignal.timeout(30000),
})
const decText = await dec.text()
log('decompress', dec.status, decText.slice(0, 200))
const decResult = JSON.parse(decText).result
const decBody = (() => { const m = /written to: (\S+)/.exec(decResult); return m ? fs.readFileSync(m[1], 'utf8') : decResult })()
log('decompressed chars', decBody.length)
assert.ok(decResult.includes('history generation 1'), 'decompress must restore from generation 1')
assert.ok(decBody.includes('history 0 '), 'decompress must restore the original verbatim text')
log('calling search_context')
const search = await realFetch(toolUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: s2.id, tool: 'search_context', args: { query: 'REAL-COMPACT-TOKEN-9' } }),
  signal: AbortSignal.timeout(30000),
})
const searchText = await search.text()
log('search raws', searchText.length)
log('search', search.status, searchText.slice(0, 300))
assert.ok(/generation 1|REAL-COMPACT-TOKEN-9/i.test(searchText), 'search_context must reach the closed generation')

// ── turn 3: a second real server compaction is announced at this boundary ──
const messages3 = [...messages2, t2.assistant, { role: 'user', content: [{ type: 'text', text: 'Now reply with exactly: STILL-ALIVE' }] }]
const beforeBody3 = upstreamBodies.length
const t3 = await turn(messages3, 'turn3 (continue)')
const s3 = theSession()
const gens3 = historyIndex(s3)
log('generations after turn3', gens3.length, JSON.stringify(gens3.map(g => ({ n: g.generation, cp: g.checkpointId?.slice(0, 12), blocks: g.blockIds, refs: [g.firstRef, g.lastRef] }))))
log('checkpoint after turn3', JSON.stringify(s3.metadata.codexCloudCheckpoint ?? null))
assert.ok(/STILL-ALIVE/i.test(t3.text), `turn3 must complete a real request, got ${JSON.stringify(t3.text.slice(0, 200))}`)
assert.ok(gens3.length >= 1, 'turn3 must keep the closed generation')
assert.equal(new Set(gens3.map(g => g.checkpointId)).size, gens3.length, 'each closed generation must carry a distinct checkpoint id')
assert.equal(gens3.at(-1).checkpointId, s3.metadata.codexCloudCheckpoint.id, 'the newest generation must match the announced checkpoint')
assert.ok(!(upstreamBodies[beforeBody3] ?? '').includes('history 0 lorem'), 'turn3 must not resend the summarized history')
assert.deepEqual(gens3[0].blockIds, gens3[0].blockIds.filter(id => folded.includes(id)), 'generation 1 must stay the block archive')

// a duplicate delivery of the same request re-announces the same checkpoint and must not rebase again
const t3b = await turn(messages3, 'turn3 retry (same checkpoint)')
const gens3b = historyIndex(theSession())
log('generations after identical retry', gens3b.length)
assert.equal(gens3b.length, gens3.length, 'a duplicate delivery of the same checkpoint must not close another generation')
assert.ok(/STILL-ALIVE/i.test(t3b.text), `duplicate delivery must still complete, got ${JSON.stringify(t3b.text.slice(0, 200))}`)

// the closed generations remain searchable and the archived block restorable after the second boundary
const dec2 = JSON.parse(await (await realFetch(toolUrl, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: s3.id, tool: 'decompress', args: { blockId: gens3[0].blockIds[0], full: true } }),
  signal: AbortSignal.timeout(30000),
})).text()).result
const dec2Body = (() => { const m = /written to: (\S+)/.exec(dec2); return m ? fs.readFileSync(m[1], 'utf8') : dec2 })()
assert.ok(dec2Body.includes('history 0 '), 'generation 1 must stay restorable after a second boundary')
const search2 = JSON.parse(await (await realFetch(toolUrl, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: s3.id, tool: 'search_context', args: { query: 'STILL-ALIVE' } }),
  signal: AbortSignal.timeout(30000),
})).text()).result
log('search after second boundary', JSON.stringify(search2.slice(0, 200)))
assert.ok(/closed-generation|generation/i.test(search2), 'search_context must reach the closed generations')

log('OK: real cloud compaction reuse + generation restore + consecutive boundaries + continuation verified')
proxy.close()
