import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInitialState} from 'acp-kernel';
import {SessionStore} from '../src/persist.ts';
import type {Session} from '../src/session.ts';
import {CALIBRATION_PROVENANCE_TEXT_ONLY, currentCalibrationFactor} from '../src/util.ts';
import {rmrf} from './tmp-rm.ts';

process.env.BILI_CONFIG_FILE = path.join(tmpdir(), 'calibration-model-no-config.json');
process.env.BILI_PERSIST_ZSTD = '0';

function session(id: string, model?: string): Session {
  return {id, meta:{protocol:'anthropic',upstreamOrigin:'http://synthetic.invalid'},
    stats:{requests:3,tokensSaved:0,inputTokens:10,cachedTokens:0,outputTokens:5,
      cacheSamples:0,lastInputTokens:10,contextTokens:1000,compressCreditTokens:0,
      retrieveCalls:0,retrieveHits:0,retrieveMisses:0,storedBytes:0,storeBytesSaved:0,rangeRestores:0,
      calibratedEstimate:0.8,calibratedEstimateOrigin:'http://synthetic.invalid',
      calibratedEstimateModel:model,
      // #5952: the seeded factor is text-only evidence, so it may decide.
      calibratedEstimateProvenance:CALIBRATION_PROVENANCE_TEXT_ONLY,
      calibrationRing:{origin:'http://synthetic.invalid',...(model === undefined ? {} : {model}),values:[0.8,0.8]}},
    metadata:{},createdAt:1700000000000,lastSeen:1700000001000,state:createInitialState(),
    blockContents:new Map(),inFlight:0,persisted:false,pendingRetrievals:[]};
}

for (const mode of ['legacy','full']) {
  for (const model of ['synthetic-model-a', undefined]) {
    test(`calibration provenance survives ${mode} cold load (${model ?? 'legacy unknown model'})`, async () => {
      process.env.BILI_STORAGE_UNIFIED = mode;
      const dir = mkdtempSync(path.join(tmpdir(),'bili-calibration-model-'));
      const original = session('calibration-roundtrip',model);
      let store = new SessionStore({dir,enabled:true,debounceMs:1});
      try {
        await store.writeNow(original);
        store.closeQuietly();
        store = new SessionStore({dir,enabled:true,debounceMs:1});
        const restored = store.loadSync(original.id,original.meta);
        assert.ok(restored);
        assert.deepEqual(restored.stats.calibrationRing,original.stats.calibrationRing,
          'Cold load must retain the ring including its exact model provenance');
        assert.equal(restored.stats.calibratedEstimateModel,model);
        assert.equal(currentCalibrationFactor(restored.stats,'synthetic-model-a'),0.8);
        assert.equal(currentCalibrationFactor(restored.stats,'synthetic-model-b'),
          model === undefined ? 0.8 : undefined,
          'Known-model factors must not cross a model switch; unknown legacy models retain existing behavior');
      } finally {store.closeQuietly();rmrf(dir);}
    });
  }
}

for (const invalid of [123,'   ',{},null]) {
  test(`invalid persisted model provenance is rejected (${JSON.stringify(invalid)})`, async () => {
    process.env.BILI_STORAGE_UNIFIED = 'legacy';
    const dir = mkdtempSync(path.join(tmpdir(),'bili-calibration-invalid-model-'));
    const original = session('invalid-provenance','synthetic-model-a');
    let store = new SessionStore({dir,enabled:true,debounceMs:1});
    try {
      await store.writeNow(original);
      store.closeQuietly();
      const files = readdirSync(dir,{recursive:true}).filter(x => typeof x === 'string' && x.endsWith('.json'));
      const file = files.map(x => path.join(dir,String(x))).find(x => {
        const raw = JSON.parse(readFileSync(x,'utf8'));
        return (raw.payload ?? raw).id === original.id;
      });
      assert.ok(file,'Fixture must have written its session envelope');
      const raw = JSON.parse(readFileSync(file,'utf8'));
      const payload = raw.payload ?? raw;
      payload.stats.calibrationRing.model = invalid;
      payload.stats.calibratedEstimateModel = invalid;
      writeFileSync(file,JSON.stringify(raw));
      store = new SessionStore({dir,enabled:true,debounceMs:1});
      const restored = store.loadSync(original.id,original.meta);
      assert.ok(restored);
      assert.equal(restored.stats.calibrationRing?.model,undefined);
      assert.equal(restored.stats.calibratedEstimateModel,undefined);
      assert.deepEqual(restored.stats.calibrationRing?.values,[0.8,0.8]);
    } finally {store.closeQuietly();rmrf(dir);}
  });
}
