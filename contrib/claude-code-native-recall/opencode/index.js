import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const EVENT_TYPES = [
  'session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled',
  'session.synthetic', 'session.message.content.updated',
  'session.text.ended', 'session.reasoning.ended',
  'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called',
  'session.tool.success', 'session.tool.failed',
  'session.step.started', 'session.step.streamed', 'session.step.ended', 'session.step.failed',
  'session.compaction.started', 'session.compaction.ended', 'session.compaction.failed',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
];
const SAFE_ENV = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'];

function canonical(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Recall requires absolute project paths');
  return fs.realpathSync(directory);
}
function jsonCopy(value) {
  // Preserve the official JSON representation; never silently stringify unknown
  // binary/runtime objects or omit a BigInt/function supplied by another plugin.
  return JSON.parse(JSON.stringify(value, (_, item) => {
    if ((typeof item === 'number' && !Number.isFinite(item)) || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol')
      throw new Error('Recall cannot archive a non-JSON host value');
    return item;
  }));
}
function revision(event) {
  if (event.durable && typeof event.durable === 'object') return jsonCopy(event.durable);
  const result = {};
  for (const key of ['aggregateID', 'seq', 'version']) if (event[key] !== undefined) result[key] = event[key];
  return Object.keys(result).length ? result : undefined;
}
function eventIdentity(event) {
  const data = event.data ?? {};
  return {
    ...(data.messageID || data.assistantMessageID ? { message_id: data.messageID ?? data.assistantMessageID } : {}),
    ...(data.id && event.type.startsWith('session.tool.') ? { tool_call_id: data.id } : {}),
    ...(data.ordinal !== undefined ? { part_id: String(data.ordinal) } : {}),
    ...(event.id ? { event_id: event.id } : {}),
  };
}
function sessionProject(info) {
  // Session.Info's location is the host's actual session location. No global
  // listing, user-home discovery, or recent-session heuristic is used.
  return info.location?.directory;
}
function prepareHome(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Recall requires an absolute archiveHome');
  const resolved = path.resolve(directory);
  let cursor = resolved;
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Recall archiveHome must not traverse symlinks');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}
function bridgeFailure(reason, fields = {}) {
  const error = new Error('Recall archive bridge failure: ' + reason);
  error.archiveDiagnostic = { reason, ...fields };
  return error;
}
function invokeBridge(command, args, input, archiveHome, timeout, maxBytes) {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) return Promise.reject(bridgeFailure('envelope_size_bound'));
  const env = Object.fromEntries(SAFE_ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.RECALL_HOME = archiveHome;
  env.PYTHONDONTWRITEBYTECODE = '1';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(bridgeFailure('bridge_timeout_unknown', { acknowledgement_unknown: true })); }, timeout);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.on('error', error => finish(bridgeFailure('bridge_start_failed', { process_error: /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'unknown' })));
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 16384) { child.kill(); finish(bridgeFailure('ack_size_bound', { acknowledgement_unknown: true })); }
    });
    // Errors may contain user text; do not forward or persist bridge stderr.
    child.stderr.on('data', () => {});
    child.on('close', code => {
      if (settled) return;
      let ack;
      try { ack = JSON.parse(output.trim()); } catch {}
      const errorType = typeof ack?.error === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(ack.error) ? ack.error : undefined;
      if (code !== 0) return finish(bridgeFailure('bridge_rejected', { exit_code: Number.isInteger(code) ? code : null, ...(errorType ? { bridge_error_type: errorType } : {}) }));
      if (!ack) return finish(bridgeFailure('invalid_ack_json', { acknowledgement_unknown: true }));
      if (ack.ok !== true || ack.durable !== true) return finish(bridgeFailure('non_durable_ack', { ...(errorType ? { bridge_error_type: errorType } : {}) }));
      if (ack.session_id !== input.session_id || ack.host !== 'opencode' || ack.main_session !== true)
        return finish(bridgeFailure('invalid_ack_identity', { acknowledgement_unknown: true }));
      finish(null, ack);
    });
    child.stdin.on('error', () => finish(bridgeFailure('bridge_input_unknown', { acknowledgement_unknown: true })));
    child.stdin.end(serialized + '\n');
  });
}

export default {
  id: 'recall.opencode-native',
  async setup(ctx) {
    const options = ctx.options ?? {};
    // Absence of explicit enablement is a strict no-op: no directory creation,
    // subscriptions, session reads, or hooks that alter host execution.
    if (options.enabled !== true) return;
    if (!Array.isArray(options.projects) || !options.projects.length || !Array.isArray(options.sessions) || !options.sessions.length)
      throw new Error('Recall native adapter requires explicit projects and sessions');
    const project = canonical(ctx.location.directory);
    if (!options.projects.map(canonical).includes(project)) return;
    if (String(ctx.app.version).replace(/^v/, '') !== '2.2.5') throw new Error('Recall native adapter supports verified OpenCode V2.2.5 only');
    const selected = new Set(options.sessions);
    if ([...selected].some(sid => typeof sid !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(sid)))
      throw new Error('Recall native adapter requires explicit native session IDs');
    const archiveHome = prepareHome(options.archiveHome ?? path.join(project, '.recall-opencode'));
    if (options.bridgePath !== undefined && (typeof options.bridgePath !== 'string' || !path.isAbsolute(options.bridgePath))) throw new Error('Recall bridgePath must be absolute');
    const bridge = path.resolve(options.bridgePath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugin/recall/opencode_bridge.py'));
    const python = options.python ?? 'python3';
    if (typeof python !== 'string' || !python || !path.isAbsolute(bridge)) throw new Error('Invalid Recall bridge configuration');
    const timeout = options.bridgeTimeoutMs ?? 20000;
    const maxBytes = options.maxEnvelopeBytes ?? 32 * 1024 * 1024;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024 * 1024)
      throw new Error('Invalid Recall bridge bounds');
    const auditPath = path.join(archiveHome, 'opencode-adapter-status.jsonl');
    if (fs.existsSync(auditPath) && fs.lstatSync(auditPath).isSymbolicLink()) throw new Error('Recall status path must not be a symlink');
    const audit = (event, values = {}) => fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), adapter: 'opencode-v2', event, project, ...values }) + '\n', { mode: 0o600 });
    const queues = new Map();
    const failures = new Map();
    let disposed = false;
    const abort = new AbortController();
    function fail(sid, operation, error) {
      failures.set(sid, operation);
      const errorClass = typeof error?.constructor?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.$]{0,79}$/.test(error.constructor.name) ? error.constructor.name : 'UnknownError';
      const diagnostic = { ...(error?.archiveDiagnostic ?? { reason: 'archive_operation_failed' }), error_class: errorClass };
      try { audit(disposed ? 'shutdown_unacknowledged' : 'degraded', { session_id: sid, operation, ...diagnostic, recovery: 'context_snapshot_cannot_recover_already_discarded_raw_data' }); } catch { /* The memory latch still stops awaitable selected-session operations. */ }
    }
    async function enabled(sid) {
      if (disposed || !selected.has(sid)) return false;
      const info = await ctx.session.get({ sessionID: sid });
      const location = sessionProject(info);
      if ((info.id && info.id !== sid) || info.parentID || (location && canonical(location) !== project)) {
        audit('excluded_session', { session_id: sid, reason: info.parentID ? 'child_session' : 'different_project_or_identity' });
        return false;
      }
      // Recheck on every capture: a native session can move to another project.
      if (!location) throw new Error('Recall cannot verify native session project');
      return true;
    }
    function enqueue(sid, operation, records) {
      if (disposed) return Promise.reject(bridgeFailure('adapter_disposed'));
      const immutable = jsonCopy(records);
      const previous = queues.get(sid) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const ack = await invokeBridge(python, [bridge], { operation, session_id: sid, project, parent_id: null, records: immutable }, archiveHome, timeout, maxBytes);
        audit('durable_ack', { session_id: sid, operation, records: immutable.length, appended: ack.appended ?? 0, count: ack.count });
        return ack;
      });
      queues.set(sid, task);
      task.catch(error => fail(sid, operation, error));
      return task;
    }
    const record = (kind, payload, identity, origin, nativeRevision) => ({ kind, payload: jsonCopy(payload), identity, origin, ...(nativeRevision ? { revision: nativeRevision } : {}), host_version: ctx.app.version, adapter_version: '0.1.0', observed_at: new Date().toISOString() });
    async function snapshot(sid, origin) {
      const messages = await ctx.session.context({ sessionID: sid });
      if (!Array.isArray(messages)) throw new Error('Unexpected OpenCode V2 context response');
      const records = messages.map(message => record('message', message, { message_id: message.id }, origin, message.time));
      return await enqueue(sid, 'snapshot', records);
    }
    async function barrier(sid, origin) {
      // A prior gap is not repaired merely by a later successful snapshot.
      // The host may continue, but Recall must not label this run ready.
      if (failures.has(sid)) throw bridgeFailure('archive_degraded_not_ready');
      const current = await snapshot(sid, origin);
      if (!current.count) throw new Error('Recall cannot acknowledge a missing or empty archive');
      await enqueue(sid, 'barrier', [record('barrier', { reason: origin, completeness: 'native_objects_as_exposed; tools_may_be_prebounded; no_replay_gap_guarantee' }, {}, origin)]);
      if (failures.has(sid)) throw bridgeFailure('archive_degraded_not_ready');
    }
    async function awaited(sid, operation, action) {
      try {
        // Session lookup/project verification can fail too; those failures must
        // never escape a product hook and veto the host's primary operation.
        if (!await enabled(sid)) return;
        await action();
      } catch (error) {
        fail(sid, operation, error);
        // Fail closed only for Recall's own readiness assertion. Do not change
        // host model/tool/compaction results or throw to block host execution.
      }
    }
    audit('enabled', { selected_sessions: [...selected], host_version: ctx.app.version, raw_guarantee: 'official_json_objects_as_received_not_provider_wire_bytes' });

    await ctx.session.hook('prompt', async event => awaited(event.sessionID, 'prompt', async () => {
      // Preserve the exact hook observation first; this is before admission,
      // not evidence that the host has committed/delivered the prompt.
      await enqueue(event.sessionID, 'append', [record('prompt', event, { message_id: event.messageID }, 'session.prompt.before_admission')]);
      await barrier(event.sessionID, 'session.prompt.before');
    }));
    await ctx.session.hook('context', async event => awaited(event.sessionID, 'context', async () => {
      await barrier(event.sessionID, 'session.context.before');
    }));
    await ctx.session.hook('compaction', async event => awaited(event.sessionID, 'compaction', async () => {
      // This is a best-effort durable barrier at the documented model hook,
      // never a host veto. Provider-native compact routes may bypass it.
      await barrier(event.sessionID, 'session.compaction.before_model');
    }));
    await ctx.session.hook('experimental.idle', async event => awaited(event.sessionID, 'idle', async () => {
      await barrier(event.sessionID, 'session.experimental.idle');
    }));
    for (const phase of ['execute.before', 'execute.after']) {
      await ctx.tool.hook(phase, async event => awaited(event.sessionID, `tool.${phase}`, async () => {
        await enqueue(event.sessionID, 'append', [record('tool.raw', event,
          { message_id: event.messageID, tool_call_id: event.id }, `tool.${phase}`)]);
      }));
    }
    // Subscribe only to documented V2 session events. The shared stream is not
    // replayable and its listeners are not transaction participants in the host.
    const consume = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: abort.signal })) {
          if (disposed) break;
          const sid = event.data?.sessionID;
          if (!selected.has(sid)) continue;
          try {
            if (!await enabled(sid) || disposed) continue;
            await enqueue(sid, 'append', [record('event', event, eventIdentity(event), `event.${event.type}`, revision(event))]);
          } catch (error) { fail(sid, 'event_stream', error); }
        }
        if (!disposed) for (const sid of selected) fail(sid, 'event_stream_closed');
      } catch {
        if (!disposed) for (const sid of selected) fail(sid, 'event_stream_interrupted');
      }
    })();
    // Defer host RPCs until setup has returned. The host bus is not an SSE
    // stream and does not emit server.connected; explicitly reconcile only the
    // selected sessions on each plugin activation, never a global session list.
    const startup = (async () => {
      await new Promise(resolve => setImmediate(resolve));
      for (const sid of selected) {
        if (disposed) return;
        let active;
        try { active = await enabled(sid); }
        catch {
          try { if (!disposed) audit('startup_session_not_resolved', { session_id: sid, completeness: 'unknown_until_awaitable_barrier' }); } catch {}
          continue;
        }
        if (active && !disposed) {
          try { await snapshot(sid, 'plugin.activation.selected_session'); }
          catch (error) { fail(sid, 'startup_snapshot', error); }
        }
      }
    })();
    startup.catch(() => { if (!disposed) for (const sid of selected) fail(sid, 'startup_reconciliation'); });
    return async () => {
      disposed = true; abort.abort();
      await Promise.allSettled([...queues.values()]);
      await consume;
      try { audit('disabled', { selected_sessions: [...selected] }); } catch {}
    };
  },
};
