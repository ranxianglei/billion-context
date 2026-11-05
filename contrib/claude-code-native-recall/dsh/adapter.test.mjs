import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from './index.mjs';

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-dsh-test-'));
  const effects = [], handlers = new Map(), tools = new Map();
  const ctx = { eventRows: [], logger: { warn() {} }, tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name); } },
    effect(fn) { const out = fn(); if (typeof out === 'function') effects.push(out); },
    on(name, fn) { handlers.set(name, fn); effects.push(() => handlers.delete(name)); },
  };
  const config = { enabled: true, projects: [dir], sessions: ['selected'], archiveHome: path.join(dir, 'archive'),
    python: 'python3', bridgeTimeoutMs: 3000, maxEnvelopeBytes: 33554432, declaredHostVersion: '0.2.0-rc.2', ...overrides };
  const session = { id: 'selected', header: { id: 'selected', version: 4, cwd: dir, isSeeded: false, createdAt: 1 } };
  ctx.sessionQuery = { async observeSession(id, options) {
    assert.equal(id, session.id); assert.equal(options.projectionMode, 'none');
    return { source: 'live', header: session.header, events: ctx.eventRows, [Symbol.dispose]() {} };
  } };
  let disposal;
  const dispose = () => disposal ??= (async () => { for (const fn of [...effects].reverse()) await fn(); })();
  return { dir, ctx, config, session, tools, handlers, dispose, async cleanup() { await dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function gatedBridge(f) {
  const python = path.join(f.dir, 'gated-python');
  fs.writeFileSync(python, `#!/usr/bin/env python3
import json,sys,time,os
from pathlib import Path
root=Path(${JSON.stringify(f.dir)})
r=json.load(sys.stdin)
phase='append' if r['operation']=='append' else 'query'
(root/(phase+'-started')).write_text(str(os.getpid()))
while not (root/('allow-'+phase)).exists(): time.sleep(0.005)
(root/(phase+'-ended')).write_text('done')
print(json.dumps({'ok':True,'durable':True,'host':'dsh','session_id':r['session_id'],'result':{'host':'dsh'}}))
`, { mode: 0o700 });
  f.config.python = python;
  f.config.bridgeTimeoutMs = 2000;
  return {
    allow(phase) { fs.writeFileSync(path.join(f.dir, 'allow-' + phase), 'go'); },
    exists(phase) { return fs.existsSync(path.join(f.dir, phase)); },
    async started(phase) {
      const deadline = Date.now() + 1500;
      while (!fs.existsSync(path.join(f.dir, phase + '-started'))) {
        assert.ok(Date.now() < deadline, phase + ' subprocess did not start');
        await delay(5);
      }
    },
  };
}

test('disabled plugin has no filesystem, tools, or listener effects', async () => {
  const f = fixture({ enabled: false });
  apply(f.ctx, f.config); assert.equal(f.tools.size, 0); assert.equal(f.handlers.size, 0);
  assert.equal(fs.existsSync(f.config.archiveHome), false); await f.cleanup();
});
test('unlisted session tool calls cannot access any archive', async () => {
  const f = fixture(); apply(f.ctx, f.config);
  const session = { ...f.session, id: 'unlisted' };
  await assert.rejects(f.tools.get('recall_search').execute({ query: 'x' }, { agent: { session }, signal: new AbortController().signal }), /not enabled/);
  assert.equal(fs.existsSync(path.join(f.config.archiveHome, 'unlisted')), false); await f.cleanup();
});
test('unlisted projects and child sessions are excluded', async () => {
  const f = fixture(); apply(f.ctx, f.config);
  for (const header of [{ ...f.session.header, cwd: '/' }, { ...f.session.header, origin: 'subagent' }, { ...f.session.header, isSeeded: true }]) {
    await assert.rejects(f.tools.get('recall_status').execute({}, { agent: { session: { ...f.session, header } }, signal: new AbortController().signal }), /not enabled/);
  }
  await f.cleanup();
});
test('bridge startup failure degrades but does not reject host creation or flush', async () => {
  const f = fixture({ python: '/nonexistent/recall-python' }); apply(f.ctx, f.config);
  let injected = false;
  await f.handlers.get('agent/created')({ agent: { session: f.session, inject() { injected = true; } }, source: 'resume' });
  await f.handlers.get('session/flush')(f.session);
  assert.equal(injected, false);
  const log = fs.readFileSync(path.join(f.config.archiveHome, 'dsh-adapter-status.jsonl'), 'utf8');
  assert.match(log, /archive_failed/); assert.match(log, /"degraded":true/); await f.cleanup();
});
test('snapshot ACK precedes native resume index injection', async () => {
  const f = fixture(); apply(f.ctx, f.config); let notice;
  await f.handlers.get('agent/created')({ agent: { session: f.session, inject(v) { notice = v; } }, source: 'resume' });
  assert.ok(fs.existsSync(path.join(f.config.archiveHome, 'selected/events.jsonl')));
  assert.match(notice.content[0].text, /untrusted_historical_data/);
  assert.equal(notice.source.kind, 'recall-archive');
  assert.equal(notice.source.form, 'notice');
  assert.match(notice.content[0].text, /selected/); await f.cleanup();
});
test('waterfall delegates unchanged for unselected sessions', async () => {
  const f = fixture(); apply(f.ctx, f.config);
  const expected = { kind: 'enter', messages: [], startsRequestSeries: true };
  const got = await f.handlers.get('agent/pre-step')({ agent: { session: { ...f.session, id: 'unlisted' } } }, async () => expected);
  assert.equal(got, expected); await f.cleanup();
});
test('disposal removes registrations and listeners and drains subprocess work', async () => {
  const f = fixture(); apply(f.ctx, f.config);
  const pending = f.handlers.get('session/flush')(f.session);
  await f.cleanup(); await pending;
  assert.equal(f.tools.size, 0); assert.equal(f.handlers.size, 0);
});
test('adapter leaves model fetch identity unchanged', async () => {
  const f = fixture(); const original = globalThis.fetch;
  apply(f.ctx, f.config); assert.equal(globalThis.fetch, original); await f.cleanup();
});
test('snapshot splits many events into bounded durable bridge requests', async () => {
  const f = fixture({ maxEnvelopeBytes: 1024 }); apply(f.ctx, f.config);
  const events = Array.from({ length: 12 }, (_, seq) => ({ type: 'synthetic/event', seq, time: seq, data: { text: 'x'.repeat(100) } }));
  f.ctx.eventRows = events;
  const session = f.session;
  await f.handlers.get('session/flush')(session);
  const rows = fs.readFileSync(path.join(f.config.archiveHome, 'selected/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 13);
  assert.deepEqual(rows.filter(r => r.entry.kind === 'event').map(r => r.entry.payload), events);
  await f.cleanup();
});
test('disposal during a tool snapshot settles the call without starting a query', async () => {
  const f = fixture(); const gate = gatedBridge(f); apply(f.ctx, f.config);
  let settled = false;
  const pending = f.tools.get('recall_status').execute({}, { agent: { session: f.session }, signal: new AbortController().signal })
    .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  let shutdown;
  try {
    await gate.started('append');
    shutdown = f.dispose();
    gate.allow('append');
    await shutdown;
    assert.equal(settled, true, 'disposer returned before the admitted tool settled');
    assert.equal(gate.exists('query-started'), false, 'query started after disposal began');
    assert.ok((await pending).error);
  } finally {
    gate.allow('append'); gate.allow('query');
    await Promise.allSettled([pending, shutdown]); await f.cleanup();
  }
});
test('disposal waits for an already started query subprocess to exit', async () => {
  const f = fixture(); const gate = gatedBridge(f); gate.allow('append'); apply(f.ctx, f.config);
  let settled = false, disposed = false;
  const pending = f.tools.get('recall_status').execute({}, { agent: { session: f.session }, signal: new AbortController().signal })
    .then(value => { settled = true; return value; });
  let shutdown;
  try {
    await gate.started('query');
    shutdown = f.dispose().then(() => { disposed = true; });
    await delay(10);
    assert.equal(disposed, false);
    gate.allow('query');
    await shutdown;
    assert.equal(settled, true);
    assert.equal(gate.exists('query-ended'), true);
    assert.equal(f.tools.size, 0); assert.equal(f.handlers.size, 0);
  } finally {
    gate.allow('append'); gate.allow('query');
    await Promise.allSettled([pending, shutdown]); await f.cleanup();
  }
});
test('disposal during resume capture prevents a late index injection', async () => {
  const f = fixture(); const gate = gatedBridge(f); apply(f.ctx, f.config);
  let injected = false, settled = false;
  const pending = f.handlers.get('agent/created')({ agent: { session: f.session, inject() { injected = true; } }, source: 'resume' })
    .then(() => { settled = true; });
  let shutdown;
  try {
    await gate.started('append');
    shutdown = f.dispose(); gate.allow('append'); await shutdown;
    assert.equal(settled, true);
    assert.equal(injected, false, 'resume injected context after disposal began');
  } finally {
    gate.allow('append'); gate.allow('query');
    await Promise.allSettled([pending, shutdown]); await f.cleanup();
  }
});
test('prepared query results are released and refused as live archival snapshots', async () => {
  const f = fixture(); let released = false, injected = false;
  f.ctx.sessionQuery.observeSession = async () => ({ source: 'prepared', header: f.session.header, events: [], [Symbol.dispose]() { released = true; } });
  apply(f.ctx, f.config);
  await f.handlers.get('agent/created')({ agent: { session: f.session, inject() { injected = true; } }, source: 'resume' });
  assert.equal(released, true); assert.equal(injected, false);
  assert.equal(fs.existsSync(path.join(f.config.archiveHome, 'selected/events.jsonl')), false);
  assert.match(fs.readFileSync(path.join(f.config.archiveHome, 'dsh-adapter-status.jsonl'), 'utf8'), /snapshot_failed/);
  await f.cleanup();
});
test('disposal awaits a delayed observation and releases it without bridge dispatch', async () => {
  const f = fixture(); const gate = gatedBridge(f);
  let resolveObservation, released = false, disposed = false, injected = false;
  f.ctx.sessionQuery.observeSession = () => new Promise(resolve => { resolveObservation = resolve; });
  apply(f.ctx, f.config);
  const pending = f.handlers.get('agent/created')({ agent: { session: f.session, inject() { injected = true; } }, source: 'resume' });
  await Promise.resolve();
  assert.equal(typeof resolveObservation, 'function');
  const shutdown = f.dispose().then(() => { disposed = true; });
  await delay(0); assert.equal(disposed, false);
  resolveObservation({ source: 'live', header: f.session.header, events: [], [Symbol.dispose]() { released = true; } });
  await shutdown; await pending;
  assert.equal(released, true); assert.equal(injected, false); assert.equal(gate.exists('append-started'), false);
  await f.cleanup();
});
