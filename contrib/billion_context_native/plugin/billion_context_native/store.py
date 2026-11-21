"""Per-session state derived at compaction time: model summaries, rules, the latest todo list."""
import json
import os
import re

import prompts as pr
import transcript as tr

RULE_SUFFIX = '__recall_rule'
MAX_RULES, MAX_RULE_CHARS = 50, 300  # acp-kernel DEFAULT_RULE_LIMITS
RULE_RESET_ACK = 'Cleared all rules and unresolved rule conflicts. Previous rule IDs remain reserved.'
DIGEST_AT = tr.BLOCK_CHARS * 3 // 4  # ask for a digest once the restore slot is this full, before it overflows


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, path)


def _read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


# --- summaries -----------------------------------------------------------------------------------

def load_summaries(sid):
    p = tr.session_dir(sid) / 'summaries.jsonl'
    return [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines() if l.strip()] if p.exists() else []


def _append_summary(sid, rec):
    d = tr.session_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / 'summaries.jsonl', 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def active_summaries(recs):
    """Records not replaced by a later digest; replaced originals stay on disk for search."""
    covered = {i for r in recs for i in r.get('covers', [])}
    return [r for r in recs if r['id'] not in covered]


def save_summary(sid, entries, turns):
    """Store the latest compact_ready summary (and prior_digest) of this compaction. Returns new ids."""
    call = tr.latest_ready(entries, sid=sid)
    inp = (call or {}).get('input') or {}
    recs = load_summaries(sid)
    if not call or not str(inp.get('summary', '')).strip() or any(r.get('call') == call.get('id') for r in recs):
        return []
    epoch = tr.compactions(entries)
    own = [t['n'] for t in turns if t.get('epoch') == epoch]
    first, last = (own[0], own[-1]) if own else (None, None)
    ts = next((t['ts'] for t in reversed(turns) if t.get('epoch') == epoch), '')
    new, n = [], len(recs)
    digest = str(inp.get('prior_digest', '')).strip()
    active = active_summaries(recs)
    if digest and active:
        n += 1
        new.append({'id': f's{n}', 'tier': min(3, max(r['tier'] for r in active) + 1), 'from': active[0]['from'],
                    'to': active[-1]['to'], 'ts': ts, 'text': digest, 'covers': [r['id'] for r in active],
                    'call': call.get('id')})
    n += 1
    new.append({'id': f's{n}', 'tier': 1, 'from': first, 'to': last, 'ts': ts, 'text': inp['summary'].strip(),
                'focus': inp.get('focus', ''), 'call': call.get('id')})
    for r in new:
        _append_summary(sid, r)
    return [r['id'] for r in new]


def _span(r):
    if r.get('from') is None:
        return 'no turns'
    return f"turns #{r['from']}–#{r['to']}"


def render_summary(r, sid):
    # acp-kernel renderSummary / acp_status drilldown: header line, summary body, then a locator line.
    get = f', recall_get(session_id="{sid}", turn={r["from"]}, to_turn={r["to"]})' if r.get('from') is not None else ''
    return (f"{pr.SUMMARY_HEADER} — {_span(r)}\n{r['text']}\n\n"
            f"[{r['id']} | {_span(r)} | tier {r['tier']}{get}]")


def summaries_block(sid, budget):
    """Active summaries oldest→newest; the newest that fit are shown in full, older ones as locator lines."""
    active = active_summaries(load_summaries(sid))
    shown, used, full_ok = [], 0, True
    for r in reversed(active):
        full = render_summary(r, sid) + '\n\n'
        full_ok = full_ok and used + len(full) <= budget
        if full_ok:
            shown.append(full)
        else:
            shown.append(f"[{r['id']} | {_span(r)} | not shown — recall_search(query, session_id=\"{sid}\") finds it]\n")
        used += len(shown[-1])
    return ''.join(reversed(shown))


def digest_needed(sid):
    """(tier, targets) when the active summaries would overflow their restore slot, else None.

    acp-kernel triggers tier 2 when tier-1 summary mass exceeds the threshold, tier 3 when tier-2 mass does and
    also exceeds tier-1; here the mass is characters against the restore slot.
    """
    active = active_summaries(load_summaries(sid))
    size = sum(len(render_summary(r, sid)) for r in active)
    if len(active) < 2 or size < DIGEST_AT:
        return None
    t1 = sum(len(r['text']) for r in active if r['tier'] == 1)
    t2 = sum(len(r['text']) for r in active if r['tier'] >= 2)
    return (3 if t2 > t1 else 2), active


# --- rules (acp-kernel rules.ts semantics, replayed from the transcript) --------------------------

def apply_rule(state, inp, rule_id=None):
    """Apply one recall_rule call to state {'rules': [...], 'next': n}; returns the tool result text."""
    action = str(inp.get('action') or ('add' if inp.get('text') else 'list'))
    rules = state['rules']
    if state.get('conflict'):
        if action == 'clear':
            state['rules'] = []
            state.pop('conflict')
            return RULE_RESET_ACK
        return f'Error: {rule_conflict_notice(state)}'
    if action == 'add':
        text = str(inp.get('text') or '').strip()
        if not text:
            return 'Error: rule text is empty — provide the reminder to record.'
        if len(text) > MAX_RULE_CHARS:
            return f'Error: {len(text)} chars exceeds the {MAX_RULE_CHARS}-char limit — keep rules short and principle-level.'
        dup = next((r for r in rules if r['text'] == text), None)
        if dup:
            return f"Error: identical rule already exists ({dup['id']}) — no change."
        if len(rules) >= MAX_RULES:
            return f'Error: rule limit reached ({MAX_RULES}) — remove or clear outdated rules first.'
        rule = {'id': rule_id or f"rule{state['next']}", 'text': text}
        state['rules'] = rules + [rule]
        state['next'] += 1
        return f"Recorded [{rule['id']}] {text}"
    if action == 'delete':
        rid = str(inp.get('id') or '').strip()
        target = next((r for r in rules if r['id'] == rid), None)
        if not target:
            return f'Error: no rule with id "{rid}" — list current rules first (action "list").'
        state['rules'] = [r for r in rules if r['id'] != rid]
        return f"Deleted [{rid}] {target['text']}"
    if action == 'clear':
        state['rules'] = []
        return f'Cleared {len(rules)} rules.'
    return '\n'.join(f"{i + 1}. [{r['id']}] {r['text']}" for i, r in enumerate(rules)) or 'No rules recorded.'


def rule_conflict_notice(state):
    return ('rule_conflict: ' + state['conflict']
            + '. Rules are suspended; use recall_rule(action="clear") to reset unresolved rule history.')


def replay_rules(entries, completed_only=False, sid=None):
    """Rule state from every recall_rule call in the transcript, oldest first."""
    entries = list(entries)
    state = {'rules': [], 'next': 1}
    outcomes = tr.tool_outcomes(entries, sid=sid)
    calls = ([out['call'] for out in outcomes.values() if out['status'] == 'completed'
              and str(out['call'].get('name', '')).endswith(RULE_SUFFIX)] if completed_only
             else tr.tool_uses(entries, RULE_SUFFIX))
    acknowledged = {}
    def conflict(message):
        state['rules'] = []
        state.setdefault('conflict', message)

    for call in calls:
        inp = call.get('input') or {}
        outcome = outcomes.get(call.get('id'), {})
        result = outcome.get('result') if outcome.get('status') == 'completed' else None
        if isinstance(result, dict):
            if result.get('isError') is True:
                continue
            result = tr._text_of(result.get('content'))
        elif isinstance(result, list):
            result = tr._text_of(result)
        if isinstance(result, str) and result.startswith('Error:'):
            continue
        action = str(inp.get('action') or ('add' if inp.get('text') else 'list'))
        if action == 'clear':
            if outcome.get('status') != 'completed':
                continue
            positive = isinstance(result, str) and (result == RULE_RESET_ACK or re.fullmatch(r'Cleared \d+ rules\.', result))
            if not state.get('conflict') or positive:
                apply_rule(state, inp)
            continue
        if action == 'add' and isinstance(result, str) and result.startswith('Recorded ['):
            match = re.fullmatch(r'Recorded \[(rule[1-9]\d*)\] (.+)', result, re.DOTALL)
            text = str(inp.get('text') or '').strip()
            if not match or match[2] != text:
                possible = re.match(r'Recorded \[(rule[1-9]\d*)\]', result)
                if possible:
                    acknowledged.setdefault(possible[1], call.get('id'))
                state['next'] += 1
                conflict('Invalid recall_rule acknowledgment')
                continue
            rid = match[1]
            if rid in acknowledged:
                if acknowledged[rid] != call.get('id'):
                    state['next'] += 1
                    conflict(f'Conflicting recall_rule acknowledgment for {rid}')
                continue
            if any(rule['id'] == rid for rule in state['rules']):
                conflict(f'Conflicting recall_rule acknowledgment for {rid}')
            acknowledged[rid] = call.get('id')
            # Parallel calls can all succeed against the same pre-persistence view.
            # Their confirmed IDs survive replay even across the preview limits.
            if not state.get('conflict'):
                state['rules'].append({'id': rid, 'text': text})
            state['next'] += 1
        else:
            while action == 'add' and f"rule{state['next']}" in acknowledged:
                state['next'] += 1
            if state.get('conflict'):
                if action == 'add':
                    acknowledged[f"rule{state['next']}"] = call.get('id')
                    state['next'] += 1
                continue
            applied = apply_rule(state, inp)
            if action == 'add' and applied.startswith('Recorded ['):
                rid = state['rules'][-1]['id']
                if rid in acknowledged:
                    conflict(f'Conflicting recall_rule acknowledgment for {rid}')
                acknowledged[rid] = call.get('id')
    return state


def save_rules(sid, entries):
    state = current_rule_state(sid, entries)
    _write_json(tr.session_dir(sid) / 'rules.json', state)
    return len(state['rules'])


def current_rule_state(sid, entries):
    import archive
    archived = archive.entries(sid)
    source = archived if _has_rule_calls(archived) else entries
    if not _has_rule_calls(source):
        saved = _read_json(tr.session_dir(sid) / 'rules.json', {'rules': [], 'next': 1})
        if saved.get('conflict'):
            return saved
    return replay_rules(source, completed_only=True, sid=sid)


def _has_rule_calls(entries):
    return any(str(out['call'].get('name', '')).endswith(RULE_SUFFIX)
               for out in tr.tool_outcomes(entries).values())


def load_rules(sid):
    return _read_json(tr.session_dir(sid) / 'rules.json', {'rules': []})['rules']


def rules_block(sid):
    import archive
    state = _read_json(tr.session_dir(sid) / 'rules.json', {'rules': []})
    entries = archive.entries(sid)
    if _has_rule_calls(entries):
        state = replay_rules(entries, completed_only=True, sid=sid)
        _write_json(tr.session_dir(sid) / 'rules.json', state)
    if state.get('conflict'):
        return rule_conflict_notice(state)
    rules = state['rules']
    return '\n'.join([pr.RULES_HEADER] + [f"- [{r['id']}] {r['text']}" for r in rules]) if rules else ''


# --- latest todo list --------------------------------------------------------------------------

def latest_todos(entries, sid=None):
    """Latest TodoWrite list, or the TaskCreate/TaskUpdate state if those were used last."""
    results = tr.tool_results(entries, completed_only=True, sid=sid)
    todos, tasks, last = [], {}, None
    for call in tr.successful_tool_uses(entries, sid=sid):
        name, inp = call.get('name'), call.get('input') or {}
        if name == 'TodoWrite':
            todos = [{'content': t.get('content', ''), 'status': t.get('status', '')} for t in inp.get('todos') or []]
            last = 'todo'
        elif name == 'TaskCreate':
            m = re.search(r'#(\d+)', results.get(call.get('id'), ''))
            if m:
                tasks[m.group(1)] = {'content': inp.get('subject', ''), 'status': 'pending'}
                last = 'task'
        elif name == 'TaskUpdate' and str(inp.get('taskId')) in tasks:
            t = tasks[str(inp['taskId'])]
            if inp.get('status') == 'deleted':
                del tasks[str(inp['taskId'])]
            else:
                t['status'] = inp.get('status') or t['status']
                t['content'] = inp.get('subject') or t['content']
            last = 'task'
    return list(tasks.values()) if last == 'task' else todos


def save_todos(sid, entries):
    todos = latest_todos(entries, sid=sid)
    _write_json(tr.session_dir(sid) / 'todos.json', todos)
    return len(todos)


def todos_block(sid):
    todos = _read_json(tr.session_dir(sid) / 'todos.json', [])
    if not any(t['status'] != 'completed' for t in todos):
        return ''
    return ('[billion_context_native todos] 压缩前最新的待办清单（来自 TodoWrite / TaskCreate / TaskUpdate）；继续工作时用待办工具重建：\n'
            + '\n'.join(f"- [{t['status']}] {t['content']}" for t in todos))
