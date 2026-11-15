import test, {after} from 'node:test';
import {tmpdir} from 'node:os';
// Synthetic, loopback-only characterization. No private sessions or API keys.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(tmpdir(),'responses-overflow-evidence-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
process.env.BILI_CONFIG_FILE=path.join(root,'absent-config.json');
process.env.BILI_STORAGE_UNIFIED='full';process.env.BILI_STORAGE_JSON_WRITER='off';
process.env.BILI_SESSIONS_DIR=path.join(root,'unused-default');
for(const key of ['DATA','STATE','CACHE','CONFIG'])process.env[`XDG_${key}_HOME`]=path.join(root,key.toLowerCase());
const evidence:unknown[]=[];
const { defaultConfig } = await import('../kernel/dist/index.js');
const { startServer } = await import('../src/server.js');
import type { ProxyOptions } from '../src/config.js';
const { SessionStore, _setStoreForTest } = await import('../src/persist.js');
const { _setForTest: setRegistryForTest } = await import('../src/registry.js');
const { listSessions } = await import('../src/session.js');

const history = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Synthetic turn ${i}: ` + `retain_${i}_payload `.repeat(1500),
}));
const summary = 'Synthetic summary: retained all decisions and reference anchors. '.repeat(20);
const overflow = { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 13000 tokens." };
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const completed = () => sse('response.completed', { type: 'response.completed', response: {
    id: 'resp_probe', object: 'response', status: 'completed', output: [],
    usage: { input_tokens: 1000, output_tokens: 1, total_tokens: 1001 },
} });

test('ordinary Responses terminal errors preserve wire and arm only explicit overflow',async()=>{
for (const shape of ['response.failed', 'response.error', 'generic', 'incomplete'] as const) {
    let gptRequests = 0;
    let summaryRequests = 0; let errorFrame=""; let beforeError: {source:unknown;tokens:unknown}|undefined;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.stream === false) {
                summaryRequests++;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(req.url?.includes('responses') ? {
                    id: 'resp_summary', object: 'response', status: 'completed',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: summary }] }],
                    usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
                } : {
                    id: 'msg_summary', type: 'message', role: 'assistant', model: 'claude-test',
                    content: [{ type: 'text', text: summary }], stop_reason: 'end_turn',
                    usage: { input_tokens: 500, output_tokens: 100 },
                }));
            } else if (req.url?.includes('messages')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(sse('message_start', { type: 'message_start', message: { id: 'msg_seed', role: 'assistant', usage: { input_tokens: 125667 } } }) +
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
                    sse('message_stop', { type: 'message_stop' }));
            } else {
                gptRequests++;
                if (gptRequests > 1) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.end(completed());
                } else {
                    const session=listSessions().find(s=>s.id===`ses_switch_overflow_${shape}`);
                    assert(session);beforeError={source:session.stats.lastInputTokensSource,tokens:session.stats.lastInputTokens};
                    const error=shape==='generic'?{code:'rate_limit_exceeded',message:'Rate limit reached'}:overflow;
                    errorFrame=shape==='incomplete'?sse('response.incomplete',{type:'response.incomplete',response:{id:'resp_failed',status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}}):shape==='response.error'?sse('response.error',{type:'response.error',error}):sse('response.failed',{type:'response.failed',response:{id:'resp_failed',status:'failed',error}});
                    res.writeHead(200,{'content-type':'text/event-stream'});res.end(errorFrame);
                }
            }
        });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store=new SessionStore({dir:path.join(root,shape,'sessions'),enabled:true});
    _setStoreForTest(store);
    setRegistryForTest({});
    const options = {
        port: 0, host: '127.0.0.1', upstream: origin,
        routes: { [origin]: { models: { 'claude-test': { context: 1000000 }, 'gpt-test': { context: 1050000 } } } },
        modelContextLimit: 1050000, kernelConfig: defaultConfig(1050000),
        compress: { injectTool: true, injectNudge: true }, compat: { roles: {} },
        streamErrorShape: 'protocol', passthroughSource: null, autoRestartOnUpdate: false,
        updateTag: 'latest', advisoryCheck: false, releaseNotesCheck: false,
        promptCache: { routing: 'auto' }, sessionHeader: 'x-acp-session',
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
    const proxy = await startServer(options);
    await once(proxy, 'listening');
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/bili/${origin}`;
    const id = `ses_switch_overflow_${shape}`;
    const headers = { 'content-type': 'application/json', 'x-acp-session': id, 'x-opencode-session-id': id };
    try {
        const seed = await fetch(`${base}/v1/messages`, { method: 'POST', headers,
            body: JSON.stringify({ model: 'claude-test', max_tokens: 1024, stream: true, messages: history, tools: [{name: "read",description:"Read a fixture file",input_schema:{type:"object",properties:{path:{type:"string"}},required:["path"]}}] }) });
        assert.equal(seed.status, 200);
        await seed.text();
        const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers,
            body: JSON.stringify({ model: 'gpt-test', max_output_tokens: 1024, stream: true, input: history }) });
        const text = await response.text();
        const session = listSessions().find(s => s.id === id);
        assert(gptRequests>0&&session&&session.stats.requests>0,'Both requests must reach the main kernel path');
        const result={shape,status:response.status,gptRequests,summaryRequests,requests:session.stats.requests,
            failedEvent:text.includes('response.failed'),completedEvent:text.includes('response.completed'),
            inputTokens:session.stats.lastInputTokens,overflowArm:session.stats.overflowArmTokens??null,
            migrationQualified:false,scope:'Synthetic direct HTTP Claude-to-GPT/error-envelope characterization, not actual OpenCode or historical incident proof'};
        assert.equal(gptRequests,1,'Observing overflow evidence must not introduce a retry');
        assert(text.endsWith(errorFrame),'Terminal upstream bytes must reach the client unchanged');
        assert(!text.includes('response.completed'),'An upstream failure cannot become successful completion');
        if(shape==='response.failed'||shape==='response.error')assert.equal(result.overflowArm,8192,'Ordinary Responses error evidence must arm recovery');
        else{assert.equal(result.overflowArm,null,'Generic failures and incomplete streams must not arm overflow');assert.deepEqual({source:session.stats.lastInputTokensSource,tokens:session.stats.lastInputTokens},beforeError,'Non-overflow terminal frames preserve the pre-forward baseline');}
        evidence.push(result);fs.writeFileSync(path.join(root,shape+'.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
        console.log(JSON.stringify(result));
    } finally {
        proxy.close(); proxy.closeIdleConnections?.(); await once(proxy, 'close');
        upstream.close(); upstream.closeIdleConnections?.(); await once(upstream, 'close');
        store.cancelAll();store.closeQuietly();
    }
}

fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify({cases:evidence,migrationQualified:false},null,2),{flag:'wx',mode:0o600});
});
