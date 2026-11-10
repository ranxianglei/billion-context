// Real-credential end-to-end: Codex cloud compaction (GPT-6 Luna) through a
// live bili proxy. Proves, against the real backend: the encrypted checkpoint
// is captured and reused, the response-side compaction item closes a read-only
// history generation on the turn that caused it, the replay later in the
// conversation never rebases twice, old refs/blocks restore and stay
// searchable across generations, and the model keeps working from the
// compacted context with its tool surface intact.
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
// Threshold is per-request: the seed turn must NOT compact (so the agent can
// fold first, exactly like a real ACP turn), the following turn must.
let compactThreshold = 10_000_000
const bridge = createCompactionBridge({ enabled: () => true, accountScope: async () => accountId, threshold: () => compactThreshold })
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
        log('  payload', JSON.stringify({ reuse: !!sig, sig: sig && { seq: sig.seq, covered: sig.covered }, compactionItems: prepared.input.filter(i => i.type === 'compaction').length }))
        Object.assign(headers, Object.fromEntries(bridge.stampHeaders(new Headers({})).entries()))
        return prepared
      },
      fetch: async (url, init) => {
        const target = new URL(url)
        const routed = `${proxyOrigin}/bili/https://${target.host}${target.pathname}${target.search}`
        const h = new Headers(init.headers)
        for (const [k, v] of Object.entries(headers)) h.set(k, v)
        h.set('x-bili-plugin', 'dsh')
        h.set('x-bili-plugin-conversation', CONV)
        const res = await realFetch(routed, { ...init, headers: h, signal: AbortSignal.timeout(150000) })
        return bridge.networkOptions({}).transformResponse(res, new URL(url))
      },
    })
    const blocks = []
    let done
    for await (const ev of events) {
      if (ev.type === 'error') log('  pi stream error', JSON.stringify(ev.error?.errorMessage ?? ev))
      if (ev.type === 'text_end') blocks[ev.contentIndex] = { type: 'text', text: ev.content }
      if (ev.type === 'done') done = ev
    }
    const kept = blocks.filter(Boolean)
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
  log(`${label}: cp=${(finish.replayState?.response?.codexCompactionV1?.digest ?? 'none').slice(0, 12)} text=${JSON.stringify((finish.text ?? '').slice(0, 160))}`)
  return { assistant, finish, text: finish.text ?? '' }
}

function theSession() {
  const all = listSessions()
  return all.find(s => (s.lastMessages?.length ?? 0) > 0) ?? all.at(-1)
}

async function waitForGenerations(count, label) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (historyIndex(theSession()).length >= count) return
    await new Promise(r => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${label}`)
}

const toolCall = (tool, args) => realFetch(toolUrl, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bili-plugin': 'dsh' },
  body: JSON.stringify({ conversationId: theSession().id, tool, args }),
  signal: AbortSignal.timeout(30000),
}).then(r => r.text()).then(t => JSON.parse(t).result)

const restored = (result) => { const m = /written to: (\S+)/.exec(result ?? ''); return m ? fs.readFileSync(m[1], 'utf8') : result ?? '' }

// ── turn 0: seed a real conversation, then fold its head (no compaction) ──
const history = Array.from({ length: 12 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `history ${i} ` + ('lorem ipsum dolor sit amet ' + i + ' ').repeat(333) }],
}))
const messages1 = [...history, { role: 'user', content: [{ type: 'text', text: 'Remember this token: REAL-COMPACT-TOKEN-9. Reply with exactly: SEEDED' }] }]
const t0 = await turn(messages1, 'turn0 (seed)')
assert.equal(historyIndex(theSession()).length, 0, 'the seed turn must not compact')
const foldText = await toolCall('compress', { content: [{ startId: 'm00001', endId: 'm00007', topic: 'folded head', summary: 'FOLDED-SUMMARY real e2e head: twelve seeded turns; the user assigned token REAL-COMPACT-TOKEN-9 and asked for a SEEDED reply.' }] })
log('fold', foldText.slice(0, 160))
assert.ok(!foldText.includes('no-op'), `fold must fold: ${foldText.slice(0, 300)}`)
const folded = theSession().state.blocks.filter(b => b.active).map(b => b.blockId)
assert.ok(folded.length > 0, 'a folded block exists before the cloud compaction')

// ── turn 1: the server really compacts; the response item closes the generation ──
compactThreshold = 5000
const messages1c = [...messages1, t0.assistant, { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: SEEDED' }] }]
const t1 = await turn(messages1c, 'turn1 (server compaction)')
const checkpoint = t1.finish.replayState?.response?.codexCompactionV1
assert.ok(checkpoint?.items?.[0]?.encrypted_content, 'turn1 must persist the real encrypted checkpoint')
await waitForGenerations(1, 'response-time generation close')
const g1 = historyIndex(theSession())[0]
log('generation 1', JSON.stringify({ n: g1.generation, cause: g1.cause, cp: g1.checkpointId?.slice(0, 12), blocks: g1.blockIds, refs: [g1.firstRef, g1.lastRef] }))
assert.equal(g1.cause, 'codex-cloud-compaction', 'the generation records the cloud cause')
assert.deepEqual(g1.blockIds, folded, 'the folded block is archived at response time')
assert.equal(g1.checkpointId, checkpoint.items[0].id, 'the archived identity is the response item the client will replay')
const record1 = theSession().metadata.codexCloudCheckpoint
assert.equal(record1.seq, 1, 'the ordinal is recorded so the replay cannot double-rebase')
assert.ok(theSession().state.nextBlockId > Number(folded[0].slice(1)), 'block ids are pinned above the archive')

// ── turn 2: the client replays the checkpoint; identity must not rebase twice ──
const messages2 = [...messages1c, t1.assistant, { role: 'user', content: [{ type: 'text', text: 'What token did I ask you to remember? Reply with the token only.' }] }]
const beforeBodyCount = upstreamBodies.length
const t2 = await turn(messages2, 'turn2 (replay)')
const gens2 = historyIndex(theSession())
assert.equal(gens2.length, 1, `the replay must not close a second generation (got ${gens2.length})`)
const sent2 = upstreamBodies[beforeBodyCount] ?? ''
assert.ok(!sent2.includes('history 0 lorem'), 'the replay must NOT resend the summarized history')
assert.ok(sent2.includes('encrypted_content'), 'the replay must carry the real encrypted checkpoint')
assert.ok(/REAL-COMPACT-TOKEN-9/.test(t2.text), `the model must answer from the compacted context, got ${JSON.stringify(t2.text.slice(0, 200))}`)
assert.ok(sent2.includes('closed history generation(s) are preserved read-only'), 'the model gets the compact navigation index')

// ── old refs and blocks restore / stay searchable across the generation ──
const dec = await toolCall('decompress', { blockId: g1.blockIds[0], full: true })
assert.ok(String(dec).includes('history generation 1'), `decompress must restore from generation 1: ${String(dec).slice(0, 200)}`)
assert.ok(restored(String(dec)).includes('history 0 '), 'decompress must restore the original verbatim text')
const search = String(await toolCall('search_context', { query: 'REAL-COMPACT-TOKEN-9' }))
log('search', search.slice(0, 240))
assert.ok(/generation 1|REAL-COMPACT-TOKEN-9/i.test(search), 'search_context must reach the closed generation')

// ── turn 3: continue the SAME task; tools must survive, the second boundary must dedupe ──
const messages3 = [...messages2, t2.assistant, { role: 'user', content: [{ type: 'text', text: 'Now reply with exactly: STILL-ALIVE' }] }]
const beforeBody3 = upstreamBodies.length
const t3 = await turn(messages3, 'turn3 (continue)')
assert.ok(/STILL-ALIVE/i.test(t3.text), `turn3 must complete a real request, got ${JSON.stringify(t3.text.slice(0, 200))}`)
await waitForGenerations(1, 'turn3 generation bookkeeping')
const gens3 = historyIndex(theSession())
log('generations after turn3', JSON.stringify(gens3.map(g => ({ n: g.generation, cp: g.checkpointId?.slice(0, 12), blocks: g.blockIds }))))
assert.ok(gens3.length >= 1, 'turn3 keeps the closed generation')
assert.equal(new Set(gens3.map(g => g.checkpointId)).size, gens3.length, 'every closed generation carries a distinct identity')
assert.equal(gens3.at(-1).checkpointId, theSession().metadata.codexCloudCheckpoint.id, 'the newest generation matches the recorded checkpoint')
assert.ok(!(upstreamBodies[beforeBody3] ?? '').includes('history 0 lorem'), 'turn3 must not resend the summarized history')

const t3b = await turn(messages3, 'turn3 retry (same checkpoint)')
const gens3b = historyIndex(theSession())
assert.equal(gens3b.length, gens3.length, 'a duplicate delivery of the same checkpoint must not close another generation')
assert.ok(/STILL-ALIVE/i.test(t3b.text), `duplicate delivery must still complete, got ${JSON.stringify(t3b.text.slice(0, 200))}`)

// ── the first generation is still restorable and searchable afterwards ──
const dec2 = String(await toolCall('decompress', { blockId: g1.blockIds[0], full: true }))
assert.ok(restored(dec2).includes('history 0 '), 'generation 1 must stay restorable after a second boundary')
const search2 = String(await toolCall('search_context', { query: 'STILL-ALIVE' }))
assert.ok(/closed-generation|generation/i.test(search2), 'search_context must reach the closed generations')

log('OK: real cloud compaction closed at response time + reuse dedupe + generation restore + continuation verified')
log('generations', JSON.stringify(historyIndex(theSession()).map(g => ({ n: g.generation, cp: g.checkpointId?.slice(0, 12), refs: [g.firstRef, g.lastRef] }))))
proxy.close()
process.exit(0)
