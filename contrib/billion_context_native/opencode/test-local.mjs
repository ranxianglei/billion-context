// Synthetic no-network checks for the product plugin's lifecycle/diagnostics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import plugin from './index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-native-plugin-'));
const results = [];
const sid = 'ses_synthetic_local';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ mode = 'ok', empty = false, get, homeVariable = 'BILLION_CONTEXT_NATIVE_HOME' } = {}) {
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  const home = path.join(project, 'archive');
  const bridge = path.join(project, 'fake-bridge.cjs');
  fs.writeFileSync(bridge, `const fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const r=JSON.parse(input),h=process.env['${homeVariable}'];const p=path.join(h,'requests.jsonl');fs.appendFileSync(p,JSON.stringify({...r,child_has_provider_key:'deponia_key' in process.env,home_aliases_match:process.env.RECALL_HOME===process.env.BILLION_CONTEXT_NATIVE_HOME})+'\\n');if('${mode}'==='reject'){process.stderr.write('PRIVATE_SYNTHETIC_STDERR');console.log(JSON.stringify({ok:false,durable:false,error:'OSError',message:'PRIVATE_SYNTHETIC_MESSAGE'}));process.exitCode=1;return;}const c=path.join(h,'fake-count');const n=(fs.existsSync(c)?Number(fs.readFileSync(c)):0)+r.records.length;fs.writeFileSync(c,String(n));console.log(JSON.stringify({ok:true,durable:true,session_id:'${mode}'==='wrong-session'?'ses_other':r.session_id,host:'opencode',main_session:true,count:n,appended:r.records.length}));});`);
  const hooks = {}, toolHooks = {};
  const ctx = {
    options: { enabled: true, projects: [project], sessions: [sid], archiveHome: home, python: process.execPath, bridgePath: bridge },
    app: { version: '2.2.5' }, location: { directory: project },
    session: { hook: async (name, fn) => { hooks[name] = fn; }, get: get ?? (async () => ({ id: sid, location: { directory: project } })), context: async () => empty ? [] : [{id:'msg_synthetic',type:'user',text:'Synthetic local content',time:{created:1}}] },
    tool: { hook: async (name, fn) => { toolHooks[name] = fn; } },
    event: { subscribe: ({signal}) => ({ async *[Symbol.asyncIterator]() { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true})); } }) },
  };
  return {ctx,hooks,toolHooks,home,project,requests:()=>fs.existsSync(path.join(home,'requests.jsonl'))?fs.readFileSync(path.join(home,'requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
try {
  assert.equal(await plugin.setup({options:{}}), undefined);
  results.push('disabled adapter is a strict no-op');
  {
    const f=fixture({empty:true});const cleanup=await plugin.setup(f.ctx);
    await f.hooks.prompt({sessionID:sid,messageID:'msg_pending',prompt:{text:'Synthetic first user prompt'},delivery:{}});
    const rows=f.requests();const firstBarrier=rows.findIndex(r=>r.operation==='barrier');const prompt=rows.findIndex(r=>r.records.some(x=>x.kind==='prompt'));
    assert(prompt>=0 && prompt<firstBarrier);assert(rows.every(r=>r.child_has_provider_key===false && r.home_aliases_match));await cleanup();
    results.push('empty new session archives before-admission prompt before barrier; bridge has no provider key');
  }
  {
    const previous = { old: process.env.RECALL_HOME, current: process.env.BILLION_CONTEXT_NATIVE_HOME };
    process.env.RECALL_HOME = '/unselected-ambient-legacy';
    process.env.BILLION_CONTEXT_NATIVE_HOME = '/unselected-ambient-canonical';
    try {
      const f=fixture({homeVariable:'RECALL_HOME'});const cleanup=await plugin.setup(f.ctx);
      await f.hooks.prompt({sessionID:sid,messageID:'msg_legacy_bridge',prompt:{text:'Synthetic compatibility check'},delivery:{}});
      await cleanup();
      assert(f.requests().length>0);assert(f.requests().every(r=>r.home_aliases_match));
      results.push('legacy custom bridge receives the same explicit archiveHome as canonical bridge, never ambient homes');
    } finally {
      previous.old===undefined?delete process.env.RECALL_HOME:process.env.RECALL_HOME=previous.old;
      previous.current===undefined?delete process.env.BILLION_CONTEXT_NATIVE_HOME:process.env.BILLION_CONTEXT_NATIVE_HOME=previous.current;
    }
  }
  {
    const f=fixture({mode:'reject'});const cleanup=await plugin.setup(f.ctx);
    await assert.doesNotReject(f.hooks.compaction({sessionID:sid}));await cleanup();
    const status=fs.readFileSync(path.join(f.home,'opencode-adapter-status.jsonl'),'utf8');
    assert(status.includes('"reason":"bridge_rejected"'));assert(status.includes('"bridge_error_type":"OSError"'));
    assert(!status.includes('PRIVATE_SYNTHETIC'));assert(!status.includes('\"event\":\"durable_ack\"'));results.push('bridge rejection keeps Recall unready/degraded while host hook resolves; safe diagnostics suppress private text');
  }
  {
    let resolveInfo;
    const pending = new Promise(resolve=>{resolveInfo=resolve;});
    const f=fixture({get:async()=>pending});const cleanup=await plugin.setup(f.ctx);
    await tick();await cleanup();resolveInfo({id:sid,location:{directory:f.project}});await tick();await tick();
    assert.equal(f.requests().length,0);results.push('deferred activation cannot start snapshot after disposal');
  }
  {
    const f=fixture({mode:'wrong-session'});const cleanup=await plugin.setup(f.ctx);
    await assert.doesNotReject(f.hooks.compaction({sessionID:sid}));await cleanup();
    const status=fs.readFileSync(path.join(f.home,'opencode-adapter-status.jsonl'),'utf8');assert(status.includes('"reason":"invalid_ack_identity"'));assert(!status.includes('\"event\":\"durable_ack\"'));results.push('wrong-session ACK is rejected by Recall without rejecting host compaction hook');
  }

  {
    const f=fixture();
    f.ctx.event.subscribe=()=>({async *[Symbol.asyncIterator](){}});
    const cleanup=await plugin.setup(f.ctx);await tick();
    const event={sessionID:sid,result:{summary:'HOST_RESULT_UNCHANGED'}};
    await assert.doesNotReject(f.hooks.compaction(event));
    assert.deepEqual(event.result,{summary:'HOST_RESULT_UNCHANGED'});
    await cleanup();
    const status=fs.readFileSync(path.join(f.home,'opencode-adapter-status.jsonl'),'utf8');
    assert(status.includes('event_stream_closed'));
    assert(!f.requests().some(r=>r.operation==='barrier'));
    results.push('closed event stream leaves Recall degraded/not ready without blocking or changing host compaction');
  }
  {
    const f=fixture({get:async()=>{throw new Error('PRIVATE_LOOKUP_MESSAGE');}});
    const cleanup=await plugin.setup(f.ctx);
    await assert.doesNotReject(f.hooks.prompt({sessionID:sid,messageID:'msg_unresolved',prompt:{text:'synthetic'}}));
    await assert.doesNotReject(f.toolHooks['execute.before']({sessionID:sid,messageID:'msg_unresolved',id:'call_synthetic',tool:'synthetic',input:{}}));
    await cleanup();
    const status=fs.readFileSync(path.join(f.home,'opencode-adapter-status.jsonl'),'utf8');
    assert(status.includes('degraded'));assert(!status.includes('PRIVATE_LOOKUP_MESSAGE'));assert.equal(f.requests().length,0);
    results.push('session lookup failure is contained: host prompt/tool continue and Recall emits no ACK');
  }
  console.log(JSON.stringify({status:'PASS',network_requests:0,model_requests:0,cases:results},null,2));
} finally { fs.rmSync(root,{recursive:true,force:true}); }
