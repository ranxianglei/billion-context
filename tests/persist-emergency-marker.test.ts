import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInitialState} from 'acp-kernel';
import {SessionStore} from '../src/persist.ts';
import type {Session} from '../src/session.ts';
import {rmrf} from './tmp-rm.ts';

for(const mode of ['legacy','full']){
 for(const armed of [true,false]){
  test(`failure-shrink status evidence survives ${mode} restart (armed=${armed})`,async()=>{
   process.env.BILI_STORAGE_UNIFIED=mode;
   process.env.BILI_PERSIST_ZSTD='0';
   const dir=mkdtempSync(path.join(tmpdir(),'bili-shrink-marker-test-'));
   process.env.BILI_CONFIG_FILE=path.join(dir,'absent-config');
   const session:Session={id:'synthetic-shrink-marker',meta:{protocol:'anthropic',upstreamOrigin:'http://synthetic.invalid'},
    stats:{requests:1,tokensSaved:0,inputTokens:1000,cachedTokens:0,outputTokens:5,cacheSamples:0,
     lastInputTokens:10000,lastInputTokensSource:armed?'estimate':'usage',contextTokens:10000,compressCreditTokens:0,
     rangeRestores:0,
     ...(armed?{emergencyShrinkAt:1700000000000,emergencyShrinkEstimate:10000}:{})},metadata:{},
    createdAt:1700000000000,lastSeen:1700000001000,state:createInitialState(),blockContents:new Map(),
    inFlight:0,persisted:false,pendingRetrievals:[]};
   let store=new SessionStore({dir,enabled:true,debounceMs:1});
   try{
    await store.writeNow(session);store.closeQuietly();store=new SessionStore({dir,enabled:true,debounceMs:1});
    const restored=store.loadSync(session.id,session.meta);assert.ok(restored);
    assert.equal(restored.stats.emergencyShrinkAt,armed?1700000000000:undefined);
    assert.equal(restored.stats.emergencyShrinkEstimate,armed?10000:undefined);
    assert.equal(restored.stats.lastInputTokens,10000);
    assert.equal(restored.stats.lastInputTokensSource,armed?'estimate':'usage');
    delete restored.stats.emergencyShrinkAt;delete restored.stats.emergencyShrinkEstimate;
    await store.writeNow(restored);store.closeQuietly();store=new SessionStore({dir,enabled:true,debounceMs:1});
    const cleared=store.loadSync(session.id,session.meta);assert.ok(cleared);
    assert.equal(cleared.stats.emergencyShrinkAt,undefined);
    assert.equal(cleared.stats.emergencyShrinkEstimate,undefined);
   }finally{store.closeQuietly();rmrf(dir);}
  });
 }
}
