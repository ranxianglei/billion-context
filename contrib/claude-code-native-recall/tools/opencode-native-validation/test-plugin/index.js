import fs from 'node:fs';
import path from 'node:path';

// Synthetic acceptance instrumentation only. Not part of the Recall product.
export default {
  id: 'recall.synthetic-native-validation',
  async setup(ctx) {
    const { evidence, fixturePath, controlPath, seedSession, recallPrompt } = ctx.options;
    if (![evidence, fixturePath, controlPath].every(p => typeof p === 'string' && path.isAbsolute(p)))
      throw new Error('Synthetic validation paths must be absolute');
    fs.mkdirSync(evidence, {recursive:true});
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const auditPath = path.join(evidence, 'native-harness.jsonl');
    const audit = (event, data={}) => fs.appendFileSync(auditPath, JSON.stringify({utc:new Date().toISOString(),event,...data})+'\n',{mode:0o600});
    function control() { return JSON.parse(fs.readFileSync(controlPath,'utf8')); }
    function update(next) {
      const p=controlPath+'.tmp';fs.writeFileSync(p,JSON.stringify({...control(),...next},null,2)+'\n',{mode:0o600});fs.renameSync(p,controlPath);
    }
    const selected = sid => sid === seedSession;
    const state=control();
    let seeded = !!state.seeded;
    let compactRequested = !!state.compact_requested;
    let compactionSeen = !!state.compaction_hook_seen;
    let afterCount=0;
    audit('loaded',{version:ctx.app.version,seed_session:seedSession});
    await ctx.tool.transform(editor => editor.add({
      name:'synthetic_archive',
      description:'Synthetic local archive audit. Call once with fixture native-long-v1. This is a short real model argument. The executor returns a long original NATIVE_RECALL_OUTPUT containing explicitly labelled internal fixture text; after receiving it, reply SEEDED only.',
      options:{codemode:false},
      input:{type:'object',properties:{fixture:{type:'string',enum:['native-long-v1']}},required:['fixture'],additionalProperties:false},
      output:{type:'string'},
      execute:async (input, toolctx) => {
        if (!selected(toolctx.sessionID)) throw new Error('Synthetic tool restricted to explicit seed session');
        if (input.fixture!=='native-long-v1' || Object.keys(input).length!==1) throw new Error('fixture must be native-long-v1');
        const internalInput='I'.repeat(4500);
        const text='NATIVE_RECALL_OUTPUT\nINPUT_FIXTURE_INTERNAL_NOT_TOOL_ARGUMENT\n'+internalInput+'\nOUTPUT_FIXTURE\n'+'O'.repeat(12500)+'\nDETAIL='+fixture.detail+'\nPROOF_A='+fixture.proof_a+'\nPROOF_B='+fixture.proof_b;
        const raw={session_id:toolctx.sessionID,message_id:toolctx.messageID,call_id:toolctx.id,input,tool_argument_kind:'short_real_model_argument',output:text,input_chars:JSON.stringify(input).length,internal_fixture:{kind:'internal_not_tool_argument',input_text:internalInput,input_chars:internalInput.length},output_chars:text.length};
        fs.writeFileSync(path.join(evidence,'synthetic-tool-original.json'),JSON.stringify(raw,null,2)+'\n',{mode:0o600});
        seeded=true;update({seeded:true});audit('synthetic_tool_executed',{session_id:toolctx.sessionID,message_id:toolctx.messageID,call_id:toolctx.id,input_chars:JSON.stringify(input).length,tool_argument_kind:'short_real_model_argument',internal_fixture_chars:4500,output_chars:text.length});
        return {output:text,content:text,metadata:{synthetic:true,untruncated:true}};
      },
    }));
    // Public durable event stream: preserve only the explicitly selected session.
    const abort = new AbortController();
    const stream=(async()=>{
      for await (const e of ctx.event.subscribe({signal:abort.signal})) {
        if (!e.type.startsWith('session.') || !JSON.stringify(e).includes(seedSession)) continue;
        fs.appendFileSync(path.join(evidence,'native-host-events.jsonl'),JSON.stringify(e)+'\n',{mode:0o600});
        if (e.type.includes('compaction')) audit('native_compaction_event',{type:e.type,data:e.data});
      }
    })().catch(err=>{ if(!abort.signal.aborted) audit('event_stream_error',{error:String(err)}); });
    await ctx.session.hook('compaction', event => {
      if (!selected(event.sessionID)) return;
      compactionSeen=true;update({compaction_hook_seen:true});
      // This edits only the synthetic summary instructions, never its result or
      // host request URL. The real summary model request must still execute.
      event.system.push({type:'text',text:'Synthetic verification summary: do not copy opaque PROOF_A, PROOF_B, or DETAIL values, and do not copy the long internal I fixture or long repeated O block. State only that the complete original NATIVE_RECALL_OUTPUT can be retrieved from Recall. This is a summary instruction, not a replacement summary.'});
      event.options.maxTokens=2048;
      fs.writeFileSync(path.join(evidence,'native-compaction-hook-input.json'),JSON.stringify({session_id:event.sessionID,model:event.model,messages:event.messages},null,2)+'\n',{mode:0o600});
      audit('real_compaction_hook',{session_id:event.sessionID,message_count:event.messages.length,result_replaced:false});
    });
    await ctx.session.hook('context', async event => {
      if (!selected(event.sessionID) || !compactionSeen || control().mode!=='recall') return;
      // Only before the first retrieval after compaction; later context should
      // contain the recovered original through the real recall_get response.
      const serial=JSON.stringify({system:event.system,messages:event.messages});
      if (afterCount===0) {
        const proofAbsent=![fixture.proof_a,fixture.proof_b,fixture.detail].some(x=>serial.includes(x));
        const context=await ctx.session.context({sessionID:event.sessionID});
        fs.writeFileSync(path.join(evidence,'native-active-context-after-compaction.json'),JSON.stringify({session_id:event.sessionID,proof_absent:proofAbsent,outgoing_messages:event.messages,host_context:context},null,2)+'\n',{mode:0o600});
        audit('post_compaction_context',{session_id:event.sessionID,proof_absent:proofAbsent,message_count:event.messages.length});
        if (!proofAbsent) throw new Error('Synthetic proof leaked into post-compaction model context');
      }
      afterCount++;
    });
    await ctx.session.hook('experimental.idle', async event => {
      if (!selected(event.sessionID) || !seeded || compactRequested) return;
      compactRequested=true;update({compact_requested:true,mode:'recall'});
      const before=await ctx.session.context({sessionID:event.sessionID});
      fs.writeFileSync(path.join(evidence,'native-context-before-compaction.json'),JSON.stringify(before,null,2)+'\n',{mode:0o600});
      // Official V2 inbox ordering: enqueue inert synthetic follow-up first, then
      // manual compaction (steer priority). Do not wait inside the idle hook.
      const followup=await ctx.session.synthetic({sessionID:event.sessionID,text:recallPrompt,resume:false});
      const compact=await ctx.session.compact({sessionID:event.sessionID});
      audit('native_compaction_enqueued',{session_id:event.sessionID,followup,compact});
    });
    return async()=>{abort.abort();await stream;};
  },
};
