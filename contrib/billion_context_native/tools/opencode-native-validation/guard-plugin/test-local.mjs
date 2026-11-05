// No network, credential, environment, or real budget access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import plugin from './index.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-guard-unit-'));
const results = [];
const base = () => ({ requests_sent: 1, actual_tokens: 16, reserved_unknown_tokens: 0, stop: false, limit_requests: 12, limit_tokens: 100000 });
async function fixture(state = base()) {
  const dir = fs.mkdtempSync(path.join(temp, 'case-')); const file = path.join(dir, 'budget.json');
  fs.writeFileSync(file, JSON.stringify(state)); const hooks = {};
  await plugin.setup({ options: { budgetPath: file }, mcp: { list: async () => [] }, tool: { list: async () => ['billion_context_native_recall_search','billion_context_native_recall_get'].map(id => ({id})) }, session: { hook: async (name, fn) => { hooks[name] = fn; } } });
  return { hooks, file, state: () => JSON.parse(fs.readFileSync(file)), audit: () => fs.readFileSync(path.join(dir, 'guard-audit.jsonl'), 'utf8') };
}
function event(body = {}) {
  return { sessionID: 'synthetic', agent: 'recallbench', model: { providerID: 'deponia', id: 'deepseek-v4.1-flash' }, kind: 'primary', request: new Request('https://www.deponia.me/v1/chat/completions', { method: 'POST', body: JSON.stringify({model: 'deepseek-v4.1-flash', max_tokens: 1024, messages: [{role:'user',content:'synthetic'}], tools: ['billion_context_native_recall_search','billion_context_native_recall_get'].map(name => ({type:'function',function:{name,parameters:{type:'object',properties:{}}}})), ...body}) }) };
}
{
 const f=await fixture();const e=event();const req=e.request;await f.hooks['http.request'](e);assert.equal(e.request,req);assert.equal(f.state().requests_sent,2);assert.equal(f.state().reserved_unknown_tokens,34816);
 await f.hooks['http.response']({...e,response:new Response('data: {"usage":{"prompt_tokens":30,"completion_tokens":5,"total_tokens":35}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
 assert.equal(f.state().actual_tokens,51);assert.equal(f.state().reserved_unknown_tokens,0);assert(f.audit().includes('"event":"loaded"'));results.push('request identity preserved, loaded trace, SSE usage releases reservation');
}
{
 const s=base();s.requests_sent=12;const f=await fixture(s);await assert.rejects(f.hooks['http.request'](event()));assert.equal(f.state().requests_sent,12);assert(f.state().stop);results.push('12 request cap before send');
}
{
 const s=base();s.actual_tokens=70000;const f=await fixture(s);await assert.rejects(f.hooks['http.request'](event()));assert.equal(f.state().requests_sent,1);assert(f.state().stop);results.push('100000 token worst-case admission cap');
}
{
 const f=await fixture();const e=event();await f.hooks['http.request'](e);await f.hooks['http.response']({...e,response:new Response('synthetic failure',{status:403})});assert(f.state().stop);assert.equal(f.state().reserved_unknown_tokens,34816);await assert.rejects(f.hooks['http.request'](event()));results.push('403 latches stop and retains unknown reserve');
}
{
 const f=await fixture();const e={model:{providerID:'deponia'},attempt:2,error:{status:429},decision:{retry:true,delay:0}};f.hooks.retry(e);assert.equal(e.decision.retry,false);assert(f.state().stop);results.push('retry veto and stop latch');
}
{
 const f=await fixture();await assert.rejects(f.hooks['http.request'](event({max_tokens:4096})));assert.equal(f.state().requests_sent,1);assert(f.state().stop);results.push('output max_tokens guard before send');
}
{
 const f=await fixture();const e=event();e.model.providerID='other';await assert.rejects(f.hooks['http.request'](e));assert.equal(f.state().requests_sent,1);results.push('unexpected provider blocked');
}
{
 const f=await fixture();const e={model:{providerID:'deponia',id:'deepseek-v4.1-flash'},options:{},tools:{skill:{},billion_context_native_recall_search:{},billion_context_native_recall_get:{}}};f.hooks.context(e);assert.deepEqual(Object.keys(e.tools).sort(),['billion_context_native_recall_get','billion_context_native_recall_search']);assert.equal(e.options.maxTokens,2048);const title={};f.hooks.title(title);assert.equal(title.result,'Synthetic Recall audit');results.push('context limit and no-model title');
}
{
 const f=await fixture();await assert.rejects(f.hooks['http.request'](event({tools:[{type:'function',function:{name:'skill'}}]})));assert.equal(f.state().requests_sent,1);assert.equal(f.state().reserved_unknown_tokens,0);assert.equal(f.state().stop,false);assert(f.audit().includes('blocked_tools_before_send'));results.push('missing or extra tool gate blocks uncharged and remains recoverable');
}
{
 const f=await fixture();const before=f.state();await f.hooks.prompt({});assert.deepEqual(f.state(),before);assert(f.audit().includes('prompt_tools_ready'));results.push('prompt readiness barrier awaits stable native names without touching budget');
}
{
 const f=await fixture();const e=event();await f.hooks['http.request'](e);
 const data='data: '+JSON.stringify({error:{code:'upstream_invalid',message:'safe diagnostic Bearer SYNTHETIC_FAKE_TOKEN',headers:{authorization:'MUST_NOT_LOG'}}})+'\n\n';
 await assert.rejects(f.hooks['http.response']({...e,response:new Response(data,{headers:{'content-type':'text/event-stream'}})}));
 assert(f.state().stop);assert(f.audit().includes('safe diagnostic'));assert(!f.audit().includes('SYNTHETIC_FAKE_TOKEN'));assert(!f.audit().includes('MUST_NOT_LOG'));results.push('provider error message recorded with credentials and headers redacted');
}
{
 const f=await fixture();const e=event();await f.hooks['http.request'](e);
 await assert.rejects(f.hooks['http.response']({...e,response:new Response('data: {"error":"synthetic stream error"}\n\n',{headers:{'content-type':'text/event-stream'}})}));
 assert(f.audit().includes('synthetic stream error'));assert(f.state().stop);results.push('string error envelope distinguished from JSON/SSE parsing failure');
}
console.log(JSON.stringify({status:'PASS',network_requests:0,real_budget_modified:false,cases:results},null,2));
fs.rmSync(temp,{recursive:true});
