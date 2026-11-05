import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// V2 Plugin.define is an identity function. This dependency-free object implements
// the same { id, setup } contract in @opencode/plugin v2.2.5.
export default {
  id: 'recall.validation-budget',
  async setup(ctx) {
    const budgetPath = ctx.options?.budgetPath;
    if (typeof budgetPath !== 'string' || !path.isAbsolute(budgetPath))
      throw new Error('Recall guard requires an absolute budgetPath');
    const auditPath = path.join(path.dirname(budgetPath), 'guard-audit.jsonl');
    const reservations = new WeakMap();
    const scope = { providerID: 'deponia' };
    const allowedURL = 'https://www.deponia.me/v1/chat/completions';
    const allowedModel = 'deepseek-v4.1-flash';
    function activeTools(kind) {
      if (kind === 'compaction') return [];
      const mode = ctx.options?.controlPath ? JSON.parse(fs.readFileSync(ctx.options.controlPath, 'utf8')).mode : 'recall';
      return mode === 'seed' ? ['synthetic_archive'] : ['recall_recall_search', 'recall_recall_get'];
    }
    const integer = (x) => Number.isSafeInteger(x) && x >= 0;
    function sanitizedProviderError(value, depth=0) {
      if (depth>3 || value==null) return null;
      if (typeof value==='number') return Number.isFinite(value)?value:null;
      if (typeof value==='string') {
        let clean=value; const secret=process.env.deponia_key;
        if (secret) clean=clean.split(secret).join('[REDACTED]');
        clean=clean.replace(/Bearer\s+[^\s\"']+/gi,'Bearer [REDACTED]').replace(/\bsk-[^\s\"']+/g,'[REDACTED]').replace(/[A-Za-z0-9_+\/=-]{24,}/g,'[LONG_IDENTIFIER_REDACTED]');
        return clean.slice(0,1600);
      }
      if (typeof value==='object' && !Array.isArray(value)) {
        return Object.fromEntries(['type','code','status','message','detail','reason','error'].filter(k=>value[k]!==undefined).map(k=>[k,sanitizedProviderError(value[k],depth+1)]));
      }
      return String(typeof value);
    }
    function audit(event) {
      fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    }
    function transaction(update) {
      // Fail closed on concurrent writers. The orchestration driver must await
      // smoke completion and serialize model runs, and use the same lock if writing.
      const lockPath = budgetPath + '.lock';
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      let temporary;
      try {
        const state = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
        for (const key of ['requests_sent', 'actual_tokens', 'reserved_unknown_tokens', 'limit_requests', 'limit_tokens'])
          if (!integer(state[key])) throw new Error('Invalid Recall budget state');
        if (typeof state.stop !== 'boolean' || state.limit_requests > 20 || state.limit_tokens > 200000)
          throw new Error('Invalid Recall budget limits');
        const result = update(state);
        temporary = budgetPath + '.tmp-' + crypto.randomUUID();
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, budgetPath);
        return result;
      } finally {
        if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      }
    }
    function stop(reason) {
      transaction(s => { s.stop = true; });
      audit({ event: 'stop', reason });
    }
    audit({ event: 'loaded', plugin: 'recall.validation-budget', version: '1', max_requests: 20, max_tokens_total: 200000 });
    await ctx.session.hook('prompt', async () => {
      // Admission precedes SessionContext's executable tool snapshot. Only wait;
      // never edit the prompt, create tools, or replace native MCP executors.
      const deadline = Date.now() + 15000;
      const required = activeTools('primary');
      async function bounded(promise) {
        let timer;
        try {
          return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Recall MCP readiness deadline')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      }
      try {
        await bounded(ctx.mcp.list());
        let stableSince = null;
        let last = [];
        while (Date.now() < deadline) {
          const tools = await bounded(ctx.tool.list());
          const names = tools.map(t => t.id).filter(n => typeof n === 'string').sort();
          last = names;
          if (required.every(n => names.includes(n))) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= 100) {
              audit({ event: 'prompt_tools_ready', tool_names: names });
              return;
            }
          } else stableSince = null;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
        }
        audit({ event: 'prompt_tools_not_ready', tool_names: last });
      } catch {
        audit({ event: 'prompt_tools_readiness_failed' });
      }
      // Config/readiness failure is recoverable: preserve budget and stop latch.
      throw new Error('Recall native MCP tools not ready before prompt admission');
    });
    await ctx.session.hook('title', event => { event.result = 'Synthetic Recall audit'; });
    await ctx.session.hook('context', event => {
      if (event.model.providerID !== 'deponia' || event.model.id !== allowedModel) {
        stop('unexpected_context_model');
        throw new Error('Recall guard blocked unexpected session model');
      }
      event.options.maxTokens = 2048;
      for (const name of Object.keys(event.tools ?? {})) {
        if (!activeTools('primary').includes(name)) delete event.tools[name];
      }
    });
    await ctx.session.hook('compaction', event => {
      event.options.maxTokens = 2048;
      for (const name of Object.keys(event.tools ?? {})) delete event.tools[name];
    });
    await ctx.session.hook('http.request', async event => {
      // Never log, copy to disk, or inspect request headers (which carry the key).
      if (event.model.providerID !== 'deponia') {
        stop('unexpected_provider_request');
        throw new Error('Recall guard blocked unexpected provider');
      }
      if (event.request.url !== allowedURL || event.request.method !== 'POST' || event.model.id !== allowedModel) {
        stop('unexpected_request_target');
        throw new Error('Recall guard blocked unexpected model request');
      }
      const bodyBytes = new Uint8Array(await event.request.clone().arrayBuffer());
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bodyBytes)); }
      catch { stop('non_json_request'); throw new Error('Recall guard requires JSON'); }
      if (body.model !== allowedModel || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 2048 ||
          (body.max_completion_tokens !== undefined && body.max_completion_tokens !== body.max_tokens) ||
          (body.n !== undefined && body.n !== 1)) {
        stop('unexpected_model_or_output_limit');
        throw new Error('Recall guard blocked model or output limit');
      }
      // Reserve at least a full configured 32768-token context plus 1024 output.
      // UTF-8 bytes + protocol allowance is an additional conservative bound.
      // No claim is made that this estimates actual provider tokenization.
      const names = Array.isArray(body.tools) ? body.tools.map(t => t?.function?.name ?? t?.name).filter(n => typeof n === 'string') : [];
      const allowedTools = activeTools(event.kind);
      if (names.length !== allowedTools.length || !allowedTools.every(n => names.includes(n))) {
        // Recoverable configuration failure; no request count, reservation or stop change.
        audit({ event: 'blocked_tools_before_send', tool_names: names, kind: event.kind });
        throw new Error('Recall guard requires exactly native Recall search/get tools');
      }
      const reserve = Math.max(32768 + 2048, bodyBytes.byteLength + 4096 + body.max_tokens);
      const admission = transaction(s => {
        if (s.stop) return { allowed: false, reason: 'latched_stop' };
        if (s.requests_sent >= s.limit_requests || s.actual_tokens + s.reserved_unknown_tokens + reserve > s.limit_tokens) {
          s.stop = true;
          return { allowed: false, reason: 'request_or_token_budget' };
        }
        s.requests_sent += 1;
        s.reserved_unknown_tokens += reserve;
        return { allowed: true, request: s.requests_sent };
      });
      if (!admission.allowed) {
        audit({ event: 'blocked_before_send', reason: admission.reason });
        throw new Error('Recall guard stopped before HTTP send');
      }
      reservations.set(event.request, { reserve, request: admission.request });
      audit({ event: 'reserved_before_send', session_id: event.sessionID, request: admission.request, kind: event.kind, body_bytes: bodyBytes.byteLength, max_tokens: body.max_tokens, reserved_tokens: reserve });
      // Preserve exact Request identity, URL, body, and authentication headers.
    });

    await ctx.session.hook('http.response', async event => {
      if (event.model.providerID !== 'deponia') return;
      const reservation = reservations.get(event.request);
      if (!reservation) { stop('response_without_reservation'); throw new Error('Unreserved response'); }
      const status = event.response.status;
      if (status < 200 || status >= 300) {
        stop('http_status_' + status);
        audit({ event: 'response_error', request: reservation.request, status, reserve_retained: true });
        return;
      }
      // Await full tee consumption before core receives the response and can
      // continue to another model step. Only aggregate numeric usage is logged.
      try {
        const reader = event.response.clone().body?.getReader();
        if (!reader) { stop('empty_response'); return; }
        const decoder = new TextDecoder();
        let text = '', bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            void reader.cancel();
            stop('response_exceeds_guard_capture_bound');
            throw new Error('Guard response bound exceeded');
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        let usage;
        function inspect(value) {
          if (value?.error) {
            const err = new Error('Provider error payload');
            err.guardReason = 'provider_error_payload';
            audit({event:'provider_stream_error',request:reservation.request,status,error:sanitizedProviderError(value.error)});
            throw err;
          }
          const u = value?.usage;
          if (u && integer(u.prompt_tokens) && integer(u.completion_tokens)) {
            const total = integer(u.total_tokens) ? u.total_tokens : u.prompt_tokens + u.completion_tokens;
            if (total < u.prompt_tokens + u.completion_tokens) throw new Error('Invalid usage total');
            usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: total };
          }
        }
        if (text.trimStart().startsWith('{')) inspect(JSON.parse(text));
        else for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw && raw !== '[DONE]') inspect(JSON.parse(raw));
        }
        if (usage) {
          transaction(s => {
            if (s.reserved_unknown_tokens < reservation.reserve) throw new Error('Reservation accounting mismatch');
            s.reserved_unknown_tokens -= reservation.reserve;
            s.actual_tokens += usage.total_tokens;
            if (usage.total_tokens > reservation.reserve || s.actual_tokens + s.reserved_unknown_tokens > s.limit_tokens) s.stop = true;
          });
          audit({ event: 'reported_usage', session_id: event.sessionID, kind: event.kind, request: reservation.request, status, usage });
        } else {
          audit({ event: 'usage_missing', request: reservation.request, status, reserve_retained: true });
        }
        reservations.delete(event.request);
      } catch (error) {
        audit({event:'response_failure_classification',request:reservation.request,status,reason:error?.guardReason ?? (error instanceof SyntaxError ? 'invalid_json_or_sse_data' : 'stream_or_accounting_failure'),error_name:typeof error?.name==='string' ? error.name.slice(0,60) : 'unknown'});
        stop('response_parse_or_transport_uncertain');
        audit({ event: 'uncertain_response', request: reservation.request, status, reserve_retained: true });
        throw new Error('Recall guard could not verify response usage');
      }
      // event.response is deliberately left unchanged.
    }, scope);
    await ctx.session.hook('retry', event => {
      if (event.model.providerID !== 'deponia') return;
      event.decision = { retry: false };
      stop('provider_failure_no_retry');
      audit({ event: 'retry_veto', attempt: event.attempt, status: event.error.status ?? null });
    }, scope);
  },
};
