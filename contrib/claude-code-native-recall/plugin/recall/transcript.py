"""Claude Code transcript parsing and per-session archive of conversation turns."""
import json
import os
import pathlib
import re

SOFT = int(os.environ.get('RECALL_SOFT', 150_000))
STEP = int(os.environ.get('RECALL_STEP', 50_000))
HARD = int(os.environ.get('RECALL_HARD', 300_000))
HARD_HAIKU = int(os.environ.get('RECALL_HARD_HAIKU', 180_000))  # Haiku's 200K window: HARD would never be reached
ABSORB_MIN_TOKENS = 4_000  # acp-kernel absorb.minToolTokens
KEEP_TURNS = 5
BLOCK_CHARS = 9_500  # Claude Code inlines at most ~10k chars per hook output; more gets saved to a file.
TAIL_BYTES = 4 * 1024 * 1024
READY_SUFFIX = '__compact_ready'


def archive_root():
    return pathlib.Path(os.environ.get('RECALL_HOME') or pathlib.Path.home() / '.claude' / 'recall')


def session_dir(session_id):
    import archive
    return archive.session_dir(session_id)


def read_entries(path, tail_bytes=None):
    """Yield parsed JSONL entries; with tail_bytes, only the last complete lines within that many bytes."""
    with open(path, 'rb') as f:
        if tail_bytes:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size > tail_bytes:
                f.seek(size - tail_bytes)
                f.readline()  # drop the partial first line
            else:
                f.seek(0)
        for raw in f:
            if not raw.endswith(b'\n'):
                continue
            try:
                yield json.loads(raw)
            except ValueError:
                continue


def _main(entries):
    return (e for e in entries if not e.get('isSidechain'))


def _api_error(e):
    """Synthetic entry Claude Code writes when a request fails; its usage is all zeros and its model '<synthetic>'."""
    return e.get('type') == 'assistant' and bool(e.get('isApiErrorMessage'))


def context_tokens(entries):
    """Context size as of the last main-chain model reply (input + cache read + cache write)."""
    tokens = 0
    for e in _main(entries):
        msg = e.get('message')
        if e.get('type') == 'assistant' and not _api_error(e) and isinstance(msg, dict) and msg.get('usage'):
            u = msg['usage']
            tokens = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
    return tokens


def current_model(entries):
    model = ''
    for e in _main(entries):
        msg = e.get('message')
        if e.get('type') == 'assistant' and not _api_error(e) and isinstance(msg, dict) and msg.get('model'):
            model = msg['model']
    return model


def limits(entries):
    """(hard, pressure, emergency) for the model of the latest main-chain reply."""
    hard = HARD_HAIKU if 'haiku' in current_model(entries).lower() else HARD
    return hard, hard * 75 // 100, hard * 95 // 100


def overflowed(entries):
    """True if the latest main-chain reply since the last compaction is a 'Prompt is too long' API error.

    The window was hit before the hard line (e.g. a 200K model under the default 300k), so compaction must pass.
    """
    last = None
    for e in _main(entries):
        if _is_boundary(e):
            last = None
        elif e.get('type') == 'assistant':
            last = e
    return last is not None and _api_error(last) and 'too long' in _text_of((last.get('message') or {}).get('content')).lower()


def _is_boundary(e):
    return e.get('type') == 'system' and e.get('subtype') == 'compact_boundary'


def tool_uses(entries, suffix=None, since_boundary=False):
    """Real tool_use blocks on the main chain, oldest first; text that merely mentions a tool never counts."""
    found = []
    for e in _main(entries):
        if _is_boundary(e) and since_boundary:
            found = []
        elif e.get('type') == 'assistant':
            content = (e.get('message') or {}).get('content')
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get('type') == 'tool_use' and (
                        suffix is None or str(b.get('name', '')).endswith(suffix)):
                    found.append(b)
    return found


def _cc_result_status(block):
    # A matching native result is an observed terminal result. The established
    # tool_result convention defaults an absent is_error to false, not absence
    # of the result itself. This does not assert the whole host lifecycle ended.
    return 'failed' if block.get('is_error') is True else 'completed'


def _cc_resolved_entries(entries):
    grouped, order = {}, []
    for pos, entry in enumerate(_main(entries)):
        if not isinstance(entry, dict) or entry.get('agentId') not in (None, '', 'main'):
            continue
        key = ('uuid', entry['uuid']) if isinstance(entry.get('uuid'), str) and entry['uuid'] else ('position', pos)
        if key not in grouped:
            grouped[key] = []; order.append(key)
        grouped[key].append(entry)
    return [(key, entry) for key in order for entry in _cc_versions(grouped[key])]


def tool_outcomes(entries, sid=None, since_boundary=False):
    """Observed call/result evidence; missing, failed or ambiguous is not success.

    Optional sid adds only durable direct-hook evidence for an already identified
    native call. Callers must not hold archive._locked while requesting sid.
    """
    entries = list(entries)
    if since_boundary:
        boundary = max((i for i, e in enumerate(entries) if isinstance(e, dict) and _is_boundary(e)), default=-1)
        entries = entries[boundary + 1:]
    resolved = _cc_resolved_entries(entries)
    outcomes = {}
    owners_by_payload = {}
    for owner, entry in resolved:
        owners_by_payload.setdefault(_native_json(entry), set()).add(owner)
    hooks = [e for e in entries if isinstance(e, dict) and e.get('type') == 'cc_hook_observation']
    for owner, entry in resolved:
        message = entry.get('message')
        content = message.get('content') if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get('type') != 'tool_use' or entry.get('type') != 'assistant':
                continue
            cid = block.get('id')
            if not isinstance(cid, str) or not cid:
                continue
            out = outcomes.setdefault(cid, {'call': dict(block), 'owners': set(), 'calls': set(),
                'states': set(), 'native_results': {}, 'hook_results': {}, 'hook_inputs': {}})
            out['owners'].add(owner); out['calls'].add(_native_json(block))
    if sid is not None:
        import archive
        for rec in archive.records(sid):
            if rec.get('identity', {}).get('host') != 'claude-code':
                continue
            entry = rec['entry']
            if entry.get('type') == 'cc_hook_observation':
                hooks.append(entry)
            elif entry.get('type') == 'assistant' and rec.get('identity', {}).get('branch') == 'main':
                message = entry.get('message')
                for block in (message.get('content') or []) if isinstance(message, dict) else []:
                    if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('id') in outcomes:
                        owners = {('uuid', entry['uuid'])} if isinstance(entry.get('uuid'), str) and entry['uuid'] else owners_by_payload.get(_native_json(entry), {('archive_event', rec['event_id'])})
                        outcomes[block['id']]['owners'].update(owners)
    for _, entry in resolved:
        message = entry.get('message')
        content = message.get('content') if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get('type') != 'tool_result' or entry.get('type') != 'user':
                continue
            out = outcomes.get(block.get('tool_use_id'))
            if out is not None:
                out['states'].add(_cc_result_status(block))
                out['native_results'][_native_json({'status': _cc_result_status(block), 'content': block.get('content')})] = block.get('content')
    for observation in hooks:
        data = observation.get('data') or {}; out = outcomes.get(data.get('tool_use_id'))
        if out is None:
            continue  # Hook observations never invent calls or message anchors.
        event = observation.get('hook_event_name')
        if 'tool_input' in data:
            out['hook_inputs'][_native_json(data['tool_input'])] = data['tool_input']
        if event == 'PostToolUse' and 'tool_response' in data:
            out['states'].add('completed')
            out['hook_results'][_native_json(data['tool_response'])] = data['tool_response']
        elif event == 'PostToolUseFailure':
            out['states'].add('failed')
    result = {}
    for cid, out in outcomes.items():
        ambiguous = (len(out['owners']) != 1 or len(out['calls']) != 1
                     or len(out['native_results']) > 1 or len(out['hook_results']) > 1 or len(out['hook_inputs']) > 1
                     or len(out['states']) > 1)
        call = out['call']
        if out['hook_inputs']:
            native_input = next(iter(out['hook_inputs'].values()))
            if not _native_dominates(native_input, call.get('input', {})):
                ambiguous = True
            else:
                call = {**call, 'input': native_input}
        status = 'conflict' if ambiguous else next(iter(out['states']), 'unknown')
        values = out['hook_results'] or out['native_results']
        result[cid] = {'status': status, 'call': call,
                       'result': next(iter(values.values()), None) if status == 'completed' else None,
                       'completion_basis': 'observed_call_result_evidence' if out['states'] else 'no_observed_result'}
    return result


def successful_tool_uses(entries, suffix=None, since_boundary=False, sid=None):
    return [out['call'] for out in tool_outcomes(entries, sid=sid, since_boundary=since_boundary).values()
            if out['status'] == 'completed' and (suffix is None or str(out['call'].get('name', '')).endswith(suffix))]


def tool_results(entries, completed_only=False, sid=None):
    """Result text; state-changing consumers must request completed_only."""
    if completed_only:
        return {cid: _native_content(out['result']) for cid, out in tool_outcomes(entries, sid=sid).items()
                if out['status'] == 'completed'}
    out = {}
    for e in _main(entries):
        content = (e.get('message') or {}).get('content') if e.get('type') == 'user' else None
        for b in content if isinstance(content, list) else []:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                out[b.get('tool_use_id')] = _text_of(b.get('content'))
    return out


def latest_ready(entries, sid=None):
    calls = successful_tool_uses(entries, READY_SUFFIX, since_boundary=True, sid=sid)
    return calls[-1] if calls else None


def ready_since_boundary(entries, sid=None):
    return latest_ready(entries, sid=sid) is not None


def compactions(entries):
    return sum(1 for e in _main(entries) if _is_boundary(e))


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def _starts_turn(e):
    if e.get('type') != 'user' or e.get('isMeta') or e.get('isCompactSummary'):
        return False
    message = e.get('message')
    if not isinstance(message, dict):
        return False
    content = message.get('content')
    if isinstance(content, list) and not any(isinstance(b, dict) and b.get('type') != 'tool_result' for b in content):
        return False  # tool results only
    if isinstance(content, list) and not _text_of(content).strip():
        return bool(content)
    text = _text_of(content).lstrip()
    return bool(text) and not text.startswith(('<local-command', '<command-', '[Request interrupted'))


def _block_text(block):
    if not isinstance(block, dict):
        return json.dumps(block, ensure_ascii=False)
    kind = block.get('type', 'unknown')
    if kind == 'text':
        return str(block.get('text', ''))
    if kind in ('image', 'document', 'file', 'attachment'):
        source = block.get('source') or {}
        if isinstance(source, dict) and (source.get('data') is not None or source.get('type') == 'base64'):
            availability = 'embedded: content retained in events.jsonl'
        elif any(k in block for k in ('url', 'file_id', 'path', 'file_url')) or (isinstance(source, dict) and any(k in source for k in ('url', 'path', 'file_id'))):
            availability = 'reference_only: target availability unverified; binary not copied'
        else:
            availability = 'content_unavailable: host supplied no embedded data or usable reference'
        return f'[{kind}; {availability}] ' + json.dumps(block, ensure_ascii=False)
    return f'[{kind}] ' + json.dumps(block, ensure_ascii=False)


def _render(e, files, tools):
    message = e.get('message')
    content = message.get('content') if isinstance(message, dict) else None
    label = '【用户】' if e.get('type') == 'user' else '【助手】'
    if isinstance(content, str):
        return [label + content]
    out = []
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            out.append(label + _block_text(b))
        elif b.get('type') == 'tool_result':
            value = b.get('content')
            text = value if isinstance(value, str) else '\n'.join(_block_text(v) for v in value) if isinstance(value, list) else json.dumps(value, ensure_ascii=False)
            out.append('【结果】' + text)
        elif b.get('type') == 'tool_use':
            inp = b.get('input')
            name = str(b.get('name', '?'))
            tools[name] = tools.get(name, 0) + 1
            if isinstance(inp, dict):
                for k in ('file_path', 'path', 'notebook_path'):
                    if isinstance(inp.get(k), str):
                        files.append(inp[k])
            out.append(f'【调用 {name}】' + json.dumps(inp, ensure_ascii=False))
        else:
            out.append(label + _block_text(b))
    return out


def turns(entries):
    """Group the main chain into turns: a real user message plus everything until the next one."""
    result, cur, epoch = [], None, 0
    for e in _main(entries):
        if _is_boundary(e):
            epoch += 1
        if e.get('type') not in ('user', 'assistant') or e.get('isCompactSummary'):
            continue
        if _starts_turn(e):
            cur = {'n': len(result) + 1, 'ts': e.get('timestamp', ''), 'epoch': epoch, 'parts': [], 'files': [], 'tools': {}}
            result.append(cur)
        if cur is not None:
            cur['parts'].extend(_render(e, cur['files'], cur['tools']))
    for t in result:
        t['text'] = '\n'.join(t.pop('parts'))
        t['user'] = t['text'].split('\n', 1)[0][len('【用户】'):][:200]
        t['files'] = list(dict.fromkeys(t['files']))
    return result


def current_turn(entries, first, whole):
    """Number of the current turn, given the first turn since the last compaction.

    None when that cannot be known: entries are only a tail of the transcript (whole=False) and hold no boundary.
    """
    if not whole and not any(_is_boundary(e) for e in _main(entries)):
        return None
    ts = turns(entries)
    n = sum(1 for t in ts if t['epoch'] == ts[-1]['epoch']) if ts else 0
    return first + n - 1 if n else None


def _cc_status(entry):
    """Describe observed markers, not a guarantee of the host's whole lifecycle."""
    msg = entry.get('message')
    msg = msg if isinstance(msg, dict) else {}
    if entry.get('isApiErrorMessage') or msg.get('error'):
        return 'failed', 'observed_error_field'
    marker = msg.get('stop_reason')
    if isinstance(marker, str) and marker:
        return 'completed', 'observed_stop_reason:' + marker
    return 'unknown', 'no_explicit_terminal_marker'


def _cc_semantic(entry):
    msg = entry.get('message')
    if not isinstance(msg, dict):
        return {'type': entry.get('type'), 'opaque_message': msg}
    return {'type': entry.get('type'), 'message': {k: v for k, v in msg.items()
            if k not in ('usage', 'stop_reason', 'stop_sequence')}}


def _cc_versions(entries):
    """Select semantic streaming extensions; never pick a conflicting latest row."""
    unique = {_native_json(e): e for e in entries}
    def dominates(new, old):
        ns, nb = _cc_status(new); os_, ob = _cc_status(old)
        if os_ != 'unknown' and (ns != os_ or nb != ob):
            return False
        new_value, old_value = _cc_semantic(new), _cc_semantic(old)
        if os_ != 'unknown' and new_value != old_value:
            return False  # Two different terminal observations are not streaming.
        return _native_dominates(new_value, old_value)
    return [value for key, value in sorted(unique.items()) if not any(
        other_key != key and dominates(other, value)
        and (not dominates(value, other) or other_key < key)
        for other_key, other in unique.items())]


def _project_records(records):
    if any(r.get('identity', {}).get('host') == 'opencode' for r in records):
        return _project_opencode_records(records)
    result, groups, entities, hooks = [], {}, {}, []
    def group(tid, rec):
        if tid not in groups:
            e, src = rec['entry'], rec.get('source', {})
            groups[tid] = {'n': len(result) + 1, 'ts': (src.get('turn_start') or e).get('timestamp', ''),
                'epoch': src.get('epoch', 0), 'files': [], 'tools': {}, 'parts': [], 'event_ids': [],
                'branch': rec.get('identity', {}).get('branch', 'main'), 'conflicts': [],
                'message_status': {}, 'tool_status': {}, 'hook_observations': []}
            result.append(groups[tid])
        return groups[tid]
    for rec in records:
        if rec.get('kind') == 'legacy_turn':
            t = dict(rec['entry'])
            t.update(n=len(result) + 1, legacy=True,
                     completeness=rec.get('completeness', 'legacy_possibly_incomplete'))
            t['text'] = '[legacy: derived record; original may be truncated or missing nontext]\n' + t.get('text', '')
            result.append(t)
            continue
        e, src = rec['entry'], rec.get('source', {})
        if e.get('type') == 'cc_hook_observation':
            hooks.append(rec)
            continue
        if e.get('type') not in ('user', 'assistant') or e.get('isCompactSummary') or e.get('isSidechain'):
            continue
        branch = rec.get('identity', {}).get('branch', 'main')
        uuid = e.get('uuid')
        native = isinstance(uuid, str) and bool(uuid)
        entity = (branch, 'uuid', uuid) if native else (branch, 'position', src.get('path'),
            src.get('device'), src.get('inode'), src.get('generation'), src.get('line'), src.get('offset'))
        if entity not in entities:
            tid = src.get('turn_id') or ('orphan', src.get('path'), src.get('generation'), branch, src.get('epoch'))
            entities[entity] = {'turn': group(tid, rec), 'records': [], 'id': uuid if native else 'position:' + rec['event_id']}
        ent = entities[entity]
        ent['records'].append(rec)
        # Native UUID identity stays bound to its first archived user context.
        # A replacement source cannot rebind an old response to a new question.
        ent['turn']['event_ids'].append(rec['event_id'])

    calls = {}
    for entity, ent in entities.items():
        t = ent['turn']; variants = _cc_versions([r['entry'] for r in ent['records']])
        ent['variants'] = variants
        statuses = [_cc_status(e) for e in variants if e.get('type') == 'assistant']
        state = 'conflict' if len(variants) > 1 else statuses[0][0] if statuses else 'unknown'
        basis = statuses[0][1] if len(statuses) == 1 else 'multiple_incompatible_versions' if statuses else 'user_observation'
        t['message_status'][ent['id']] = {'status': state, 'version_count': len(variants), 'completion_basis': basis}
        if len(variants) > 1:
            t['conflicts'].append('message:' + ent['id'])
        for variant in variants:
            message = variant.get('message')
            content = message.get('content') if isinstance(message, dict) else None
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and isinstance(block.get('id'), str):
                    # Ownership is the entity, not its source's latest checkpoint.
                    calls.setdefault(block['id'], set()).add(entity)

    attached = {}
    for rec in hooks:
        e = rec['entry']; data = e.get('data') or {}; cid = data.get('tool_use_id')
        owners = calls.get(cid, set())
        if len(owners) == 1:
            owner = next(iter(owners)); ent = entities[owner]
            attached.setdefault(cid, []).append(rec)
            ent['turn']['event_ids'].append(rec['event_id'])
            ent['turn']['hook_observations'].append({'event_id': rec['event_id'], 'tool_use_id': cid,
                'hook_event_name': e.get('hook_event_name'), 'status': e.get('observation_status', 'unknown'),
                'completeness': 'direct_hook_observation_only'})
        elif len(owners) > 1:
            for owner in owners:
                t = entities[owner]['turn']; t['conflicts'].append('ambiguous_tool_use_id:' + cid)
                t['event_ids'].append(rec['event_id'])
                t['parts'].append('【工具hook归属 ambiguous；相同call id对应多个原生消息，未选择最新归属】')
        # No native call: preserve the raw observation but invent no turn/anchor.

    rendered_hooks, counted_calls = set(), set()
    for entity, ent in entities.items():
        t = ent['turn']; variants = ent['variants']
        if len(variants) > 1:
            t['parts'].append('【宿主冲突版本 conflict；并列保留，不代表多次完整执行】')
        for number, e in enumerate(variants, 1):
            if len(variants) > 1:
                t['parts'].append('【冲突版本 ' + str(number) + '/' + str(len(variants)) + '】')
            if e.get('type') == 'assistant':
                state, basis = _cc_status(e)
                t['parts'].append('【助手观察状态 ' + state + '；' + basis + '】')
            message = e.get('message')
            if not isinstance(message, dict):
                t['parts'].append('【未知宿主消息结构 unknown；未解释为完成】' + json.dumps(message, ensure_ascii=False))
                continue
            content = message.get('content')
            if not isinstance(content, list):
                t['parts'].extend(_render(e, t['files'], t['tools']))
                continue
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    cid = block.get('id'); name = str(block.get('name', '?'))
                    call_key = (entity, cid, name)
                    counters = t['tools'] if call_key not in counted_calls else {}
                    counted_calls.add(call_key)
                    t['parts'].extend(_render({**e, 'message': {'content': [block]}}, t['files'], counters))
                    t['tool_status'].setdefault(cid, {'status': 'unknown', 'completion_basis': 'no_result_terminal_marker'})
                    if cid not in rendered_hooks and len(calls.get(cid, set())) == 1:
                        rendered_hooks.add(cid)
                        observations = attached.get(cid, [])
                        seen_payload = set(); observed_states = set(); outputs_seen = set(); inputs_seen = set()
                        for hook in observations:
                            he = hook['entry']; data = he.get('data') or {}; event = he.get('hook_event_name')
                            if 'tool_input' in data:
                                inputs_seen.add(_native_json(data['tool_input']))
                            if 'tool_input' in data and data['tool_input'] != block.get('input'):
                                t['parts'].append('【hook工具输入原始观测；不替换transcript版本】' + json.dumps(data['tool_input'], ensure_ascii=False))
                            field = 'tool_response' if event == 'PostToolUse' else 'error' if event == 'PostToolUseFailure' else None
                            if event == 'PostToolUseFailure':
                                observed_states.add('failed')
                            if field and field in data:
                                key = (event, _native_json(data[field]))
                                if key not in seen_payload:
                                    seen_payload.add(key)
                                    t['parts'].append(('【工具成功hook观测】' if field == 'tool_response' else '【工具失败hook观测】') + _native_content(data[field]))
                                observed_states.add('completed' if field == 'tool_response' else 'failed')
                                if field == 'tool_response': outputs_seen.add(_native_json(data[field]))
                        if observed_states:
                            state = 'conflict' if len(observed_states) > 1 or len(outputs_seen) > 1 or len(inputs_seen) > 1 else next(iter(observed_states))
                            t['tool_status'][cid] = {'status': state, 'completion_basis': 'direct_tool_hook_observation'}
                            if state == 'conflict': t['conflicts'].append('tool_status:' + str(cid))
                elif isinstance(block, dict) and block.get('type') == 'tool_result':
                    cid = block.get('tool_use_id')
                    state = _cc_result_status(block)
                    prior = t['tool_status'].get(cid, {})
                    if prior.get('status') in ('completed', 'failed') and state in ('completed', 'failed') and prior['status'] != state:
                        state = 'conflict'; t['conflicts'].append('tool_status:' + str(cid))
                    if state == 'unknown' and prior.get('status') in ('completed', 'failed', 'conflict'):
                        state = prior['status']
                    t['tool_status'][cid] = {'status': state, 'completion_basis': 'observed_tool_result_default_success' if 'is_error' not in block else 'observed_is_error_field'}
                    t['parts'].append('【工具结果观察状态 ' + state + '】')
                    t['parts'].extend(_render({**e, 'message': {'content': [block]}}, t['files'], t['tools']))
                else:
                    t['parts'].extend(_render({**e, 'message': {'content': [block]}}, t['files'], t['tools']))
    for t in result:
        if 'parts' not in t:
            continue
        states = [v['status'] for v in t['message_status'].values() if v['completion_basis'] != 'user_observation']
        states.extend(v['status'] for v in t['tool_status'].values())
        t['conflicts'] = sorted(set(t['conflicts']))
        state = 'conflict' if t['conflicts'] else 'failed' if 'failed' in states else 'unknown' if not states or 'unknown' in states else 'completed'
        t['projection_status'] = state
        t['completeness'] = 'conflicting_versions' if state == 'conflict' else 'completion_unknown' if state == 'unknown' else 'observed_terminal_marker'
        t['text'] = '\n'.join(t.pop('parts'))
        t['user'] = next((e['entry'].get('message', {}).get('content') for ent in entities.values() if ent['turn'] is t for e in ent['records'] if _starts_turn(e['entry'])), '')
        if not isinstance(t['user'], str): t['user'] = _text_of(t['user'])
        t['user'] = t['user'][:200]
        t['files'] = list(dict.fromkeys(t['files']))
        t['event_ids'] = list(dict.fromkeys(t['event_ids']))
    return result


def _native_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def _native_dominates(new, old):
    """Semantic extension, not arrival order. Incompatible completed values conflict."""
    if new == old:
        return True
    if isinstance(new, str) and isinstance(old, str):
        return new.startswith(old)
    if isinstance(new, dict) and isinstance(old, dict):
        for key, value in old.items():
            if key == 'metadata':
                continue  # UI/progress metadata stays in facts, not the text view.
            if key not in new:
                return False
            if key == 'status':
                order = {'streaming': 0, 'running': 1, 'completed': 2, 'error': 2}
                if new[key] != value and order.get(new[key], -1) > order.get(value, -1):
                    continue
            if not _native_dominates(new[key], value):
                return False
        return True
    if isinstance(new, list) and isinstance(old, list):
        return len(new) >= len(old) and all(_native_dominates(a, b) for a, b in zip(new, old))
    return False


def _native_versions(values):
    unique = {_native_json(v): v for v in values}
    # Strict semantic maxima. Equal native revisions with contradictory content
    # are all displayed; the complete original observations remain in facts.
    return [v for key, v in sorted(unique.items()) if not any(
        other_key != key and _native_dominates(other, v)
        and (not _native_dominates(v, other) or other_key < key)
        for other_key, other in unique.items())]


def _native_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(_block_text(v) for v in value)
    return _native_json(value)


def _project_opencode_records(records):
    """Rebuild a main-session reading view from raw V2 observations.

    Raw host events/snapshots are the facts. No generated CC-shaped transcript is
    ingested. Native sequence numbers order durable events; observed_at and
    archive arrival order never select a winner. Missing/conflicting versions are
    labelled rather than silently replaced.
    """
    messages, event_messages, tools, prompts = {}, {}, {}, {}
    valid = [r for r in records if r.get('identity', {}).get('host') == 'opencode'
             and r['identity'].get('branch') == 'main']
    def add(mid, message):
        if isinstance(mid, str) and isinstance(message, dict):
            messages.setdefault(mid, []).append(message)
    def tool(mid, cid):
        return tools.setdefault((mid, cid), {'names': [], 'inputs': [], 'raw_inputs': [],
                                             'raw_results': [], 'results': [], 'errors': []})
    def event_rank(rec):
        entry = rec['entry']; payload = entry.get('payload', {})
        revision = entry.get('revision') or payload.get('durable') or {}
        seq = revision.get('seq', payload.get('seq', -1))
        return (seq if isinstance(seq, (int, float)) else -1, rec['event_id'])
    for rec in sorted(valid, key=event_rank):
        entry = rec['entry']; kind = entry.get('kind'); payload = entry.get('payload', {})
        identity = entry.get('identity') or {}
        mid = identity.get('message_id') or payload.get('messageID') or payload.get('id')
        if kind == 'message':
            add(payload.get('id'), payload)
        elif kind == 'prompt':
            prompt = payload.get('prompt') or {}
            prompts.setdefault(payload.get('messageID') or mid, []).append({'id': payload.get('messageID') or mid,
                'type': 'user', 'text': prompt.get('text', ''),
                **{k: prompt[k] for k in ('files', 'agents', 'skills') if k in prompt}})
        elif kind == 'tool.raw':
            cid = identity.get('tool_call_id') or payload.get('id')
            mid = identity.get('message_id') or payload.get('messageID')
            if not mid or not cid:
                continue
            event_messages.setdefault(mid, {'id': mid, 'type': 'assistant', 'content': [], '_blocks': {}})
            t = tool(mid, cid)
            if payload.get('tool'):
                t['names'].append(payload['tool'])
            if 'input' in payload:
                t['inputs'].append(payload['input'])
            if payload.get('status') == 'completed':
                result = payload.get('result') or {}
                # output, when present, is the official hook's original value;
                # content may later have host normalisation/truncation applied.
                t['raw_results'].append(result.get('output', result.get('content', [])))
            elif payload.get('status') == 'error':
                t['errors'].append(payload.get('error'))
        elif kind == 'event':
            name = payload.get('type'); data = payload.get('data') or {}
            mid = data.get('assistantMessageID') or data.get('messageID') or identity.get('message_id')
            if name == 'session.inbox.enqueued':
                item = data.get('item') or {}
                if item.get('type') == 'user':
                    user = item.get('payload') or {}
                    add(data.get('inboxID'), {'id': data.get('inboxID'), 'type': 'user',
                        'text': user.get('text', ''), **{k: user[k] for k in ('files', 'agents', 'skills') if k in user}})
                continue
            if not mid:
                continue
            em = event_messages.setdefault(mid, {'id': mid, 'type': 'assistant', 'content': [], '_blocks': {}})
            if name == 'session.step.started':
                em['time'] = {'created': data.get('started', payload.get('created', ''))}
            elif name in ('session.text.ended', 'session.reasoning.ended'):
                key = (name, data.get('ordinal', 0))
                em['_blocks'].setdefault(key, []).append({'type': 'text' if name == 'session.text.ended' else 'reasoning', 'text': data.get('text', '')})
            elif isinstance(name, str) and name.startswith('session.tool.'):
                cid = data.get('id')
                if not cid:
                    continue
                t = tool(mid, cid)
                if data.get('name'):
                    t['names'].append(data['name'])
                if name == 'session.tool.input.ended':
                    t['raw_inputs'].append(data.get('text', ''))
                elif name == 'session.tool.called' and 'input' in data:
                    t['inputs'].append(data['input'])
                elif name == 'session.tool.success':
                    t['results'].append(data.get('content', []))
                elif name == 'session.tool.failed':
                    t['errors'].append(data.get('error'))
    pending_prompts = set()
    for mid, values in prompts.items():
        if mid not in messages:
            pending_prompts.add(mid)
            for value in values:
                add(mid, value)
    for mid, message in event_messages.items():
        # Full snapshots carry ordering and metadata unavailable from isolated
        # events. Use events as a fallback, not a second duplicate transcript.
        if mid not in messages:
            blocks = message.pop('_blocks')
            for key in sorted(blocks, key=lambda k: (k[1], k[0])):
                message['content'].extend(_native_versions(blocks[key]))
            for (tool_mid, cid), t in sorted(tools.items()):
                if tool_mid == mid:
                    message['content'].append({'type': 'tool', 'id': cid,
                        'name': t['names'][-1] if t['names'] else '?', 'state': {}})
            add(mid, message)
    ordered = []
    for mid, versions in messages.items():
        maxima = _native_versions(versions)
        # Preserve native creation metadata for inspection. Logical message IDs
        # order a fixed fact set; numeric turn positions are not stable locators
        # when an older missing user message is discovered later.
        times = [v.get('time', {}).get('created') for v in maxima if isinstance(v.get('time'), dict)]
        created = min((str(t) for t in times if t is not None), default='')
        ordered.append((created, mid, maxima))
    # V2 SessionMessage.ID.create uses the official ascending identifier. It is
    # also available on raw prompt observations, before time.created exists.
    ordered.sort(key=lambda item: item[1])
    result, current = [], None
    for created, mid, versions in ordered:
        types = {v.get('type') for v in versions}
        if types == {'user'}:
            current = {'n': len(result) + 1, 'ts': created, 'epoch': 0, 'files': [], 'tools': {},
                       'parts': [], 'event_ids': [], 'branch': 'main', 'host': 'opencode',
                       'native_message_ids': [], 'conflicts': [], 'pending_prompt': mid in pending_prompts}
            result.append(current)
        if current is None:
            # Raw orphans remain accessible in events.jsonl, not invented turns.
            continue
        if len(versions) > 1:
            current['conflicts'].append(mid)
            current['parts'].append('【宿主冲突版本；以下均保留，不按到达顺序覆盖】')
        current['native_message_ids'].append(mid)
        for message in versions:
            kind = message.get('type')
            if kind == 'user':
                label = '【待准入用户输入；仅hook观察，未证实已入宿主对话】' if mid in pending_prompts else '【用户】'
                current['parts'].append(label + str(message.get('text', '')))
                for attachment in message.get('files') or []:
                    current['parts'].append(_block_text({'type': 'attachment', 'source': attachment}))
            elif kind == 'assistant':
                for block in message.get('content') or []:
                    if block.get('type') != 'tool':
                        current['parts'].append('【助手】' + _block_text(block))
                        continue
                    cid = block.get('id'); state = block.get('state') or {}; t = tools.get((mid, cid), {})
                    name = block.get('name') or next(iter(t.get('names') or []), '?')
                    current['tools'][name] = current['tools'].get(name, 0) + 1
                    arguments = _native_versions(t.get('raw_inputs') or t.get('inputs') or [state.get('input', {})])
                    if len(arguments) > 1:
                        current['conflicts'].append(str(cid) + ':input')
                        current['parts'].append('【工具参数冲突版本；全部保留】')
                    for argument in arguments:
                        current['parts'].append('【调用 ' + name + '】' + (argument if isinstance(argument, str) else json.dumps(argument, ensure_ascii=False)))
                    outputs = t.get('raw_results') or t.get('results') or ([state['content']] if 'content' in state else [])
                    outputs = _native_versions(outputs)
                    if len(outputs) > 1:
                        current['conflicts'].append(str(cid) + ':output')
                        current['parts'].append('【工具输出冲突版本；全部保留】')
                    for output in outputs:
                        current['parts'].append('【结果】' + _native_content(output))
                    for error in _native_versions(t.get('errors') or ([state['error']] if 'error' in state else [])):
                        current['parts'].append('【工具错误】' + _native_content(error))
            elif kind in ('system', 'synthetic'):
                current['parts'].append('【宿主 ' + kind + '】' + str(message.get('text', '')))
    for turn in result:
        turn['text'] = '\n'.join(turn.pop('parts'))
        turn['user'] = turn['text'].split('\n', 1)[0].removeprefix('【用户】')[:200]
        turn['event_ids'] = [r['event_id'] for r in valid if
            (r['entry'].get('identity') or {}).get('message_id') in turn['native_message_ids']]
    return result


def _persist_view(session_id, records):
    import archive
    data = _project_records(records)
    encoded = ''.join(json.dumps(t, ensure_ascii=False) + '\n' for t in data).encode('utf-8')
    with archive._locked(session_id) as d:
        path = d / 'turns.jsonl'
        archive._safe_file(path)
        if not path.exists() or path.read_bytes() != encoded:
            archive._atomic_bytes(path, encoded)
    return data


def write_archive(session_id, transcript_path):
    import archive
    stats = archive.sync(session_id, transcript_path)
    _persist_view(session_id, archive.records(session_id))
    return stats


def load_archive(session_id):
    import archive
    d = session_dir(session_id)
    if (d / 'events.jsonl').exists():
        return _project_records(archive.records(session_id))
    p = d / 'turns.jsonl'
    if not p.exists():
        return []
    archive._safe_file(p)
    result = []
    for line in p.read_text(encoding='utf-8').splitlines():
        if line.strip():
            t = dict(json.loads(line), legacy=True, completeness='derived_v0_possibly_incomplete')
            t['text'] = '[legacy: derived record; original may be truncated or missing nontext]\n' + t.get('text', '')
            result.append(t)
    return result


def latest_session():
    sessions = all_sessions()
    if len(sessions) > 1:
        raise ValueError('多个会话可用，请显式传入 session_id；不会按更新时间猜测。')
    return sessions[0] if sessions else None


def all_sessions():
    root = archive_root()
    return sorted(d.name for d in root.iterdir() if not d.is_symlink() and d.is_dir()
                  and ((d / 'events.jsonl').exists() or (d / 'turns.jsonl').exists())) if root.exists() else []


def projects_root():
    return pathlib.Path(os.environ.get('RECALL_PROJECTS') or pathlib.Path.home() / '.claude' / 'projects')


def find_transcript(session_id=None):
    """Resolve only in this project; ambiguous implicit sessions require an explicit id."""
    root = projects_root()
    cwd = os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()
    project = root / re.sub(r'[^A-Za-z0-9]', '-', cwd)
    if project.is_symlink():
        raise ValueError('Project transcript directory must not be a symlink')
    if session_id:
        session_dir(session_id)
        path = project / f'{session_id}.jsonl'
        return path if path.is_file() and not path.is_symlink() else None
    files = [p for p in project.glob('*.jsonl') if p.is_file() and not p.is_symlink()]
    if len(files) > 1:
        raise ValueError('本项目有多个会话，请显式传入 session_id。')
    return files[0] if files else None


def implicit_session():
    path = find_transcript()
    if path:
        write_archive(path.stem, str(path.absolute()))
        return path.stem
    sids = all_sessions()
    if os.environ.get('CLAUDE_PROJECT_DIR') or os.environ.get('RECALL_PROJECTS'):
        import archive
        cwd = os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()
        project = str((projects_root() / re.sub(r'[^A-Za-z0-9]', '-', cwd)).absolute())
        sids = [sid for sid in sids if any(r.get('identity', {}).get('project') == project
                                         for r in archive.records(sid))]
    if len(sids) > 1:
        raise ValueError('多个会话可用，请显式传入 session_id；不会按更新时间猜测。')
    return sids[0] if sids else None
