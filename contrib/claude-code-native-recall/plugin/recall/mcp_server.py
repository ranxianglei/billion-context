"""Stdio MCP server exposing recall_search, recall_get, compact_ready, recall_status and recall_rule."""
import json
import sys
import time

import prompts as pr
import store
import transcript as tr

SID = {'type': 'string', 'description': '会话 id；省略则用最近一次存档的会话'}
LIVE_SID = {'type': 'string', 'description': '会话 id；省略则取本项目最新的会话记录（同一项目并行多个会话时请显式传入）'}
EXPORT_CHARS = 10_000  # recall_get ranges longer than this go to a file
EXPORT_KEEP = 50
TOOLS = [
    {'name': 'recall_search',
     'description': '在压缩前的对话存档和 compact_ready 摘要里按关键词或文件名搜索（空格分隔，全部命中才算），返回轮次编号与片段。'
                    'scope="all" 搜索所有会话，命中项标注会话 id 与日期。',
     'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}, 'session_id': SID,
                                                      'scope': {'type': 'string', 'enum': ['session', 'all'], 'default': 'session'},
                                                      'limit': {'type': 'integer', 'default': 8}}, 'required': ['query']}},
    {'name': 'recall_get',
     'description': '取回存档中某一轮的原文，从 offset 字符开始，最多 length 字符。给 to_turn 则取回 turn..to_turn 整段原文；'
                    f'超过 {EXPORT_CHARS} 字符时写入文件并返回路径、开头片段和总大小。',
     'inputSchema': {'type': 'object', 'properties': {'turn': {'type': 'integer'}, 'to_turn': {'type': 'integer'},
                                                      'session_id': SID,
                                                      'offset': {'type': 'integer', 'default': 0},
                                                      'length': {'type': 'integer', 'default': 8000}}, 'required': ['turn']}},
    {'name': 'compact_ready',
     'description': pr.READY_DESCRIPTION,
     'inputSchema': {'type': 'object', 'properties': {
         'summary': {'type': 'string', 'description': 'Self-contained summary of every turn since the previous compaction (REQUIRED).'},
         'focus': {'type': 'string', 'description': '压缩摘要必须保留的内容'},
         'prior_digest': {'type': 'string', 'description': 'Only when a TIER 2/3 trigger asks for it: the distilled replacement for the listed earlier summaries.'}},
         'required': ['summary']}},
    {'name': 'recall_status',
     'description': '查看当前会话的上下文用量、阈值、是否已调用 compact_ready、压缩次数、存档轮数、摘要与规则数量。',
     'inputSchema': {'type': 'object', 'properties': {'session_id': LIVE_SID}}},
    {'name': 'recall_rule',
     'description': pr.RULE_DESCRIPTION,
     'inputSchema': {'type': 'object', 'properties': {
         'action': {'type': 'string', 'enum': ['add', 'list', 'delete', 'clear'], 'default': 'list'},
         'text': {'type': 'string', 'description': 'Rule text for add (max 300 chars).'},
         'id': {'type': 'string', 'description': 'Rule id for delete, e.g. rule3.'},
         'session_id': LIVE_SID}}},
]


def _session(args):
    sid = args.get('session_id') or tr.latest_session()
    if not sid:
        raise ValueError('还没有任何存档（尚未发生过压缩）。')
    turns = tr.load_archive(sid)
    if not turns:
        raise ValueError(f'会话 {sid} 没有存档。')
    return sid, turns


def _live(args):
    path = tr.find_transcript(args.get('session_id'))
    if not path:
        raise ValueError('找不到当前会话的记录文件，请传入 session_id。')
    return path.stem, list(tr.read_entries(str(path)))


def _search_one(sid, turns, terms, label):
    hits = []
    for r in reversed(store.load_summaries(sid)):
        low = r['text'].lower()
        if all(term in low for term in terms):
            i = low.find(terms[0])
            span = f"#{r['from']}–#{r['to']}" if r.get('from') is not None else '无轮次'
            hits.append(f"{label}摘要 {r['id']} (tier {r['tier']}, 轮次 {span}) [{r.get('ts', '')[:16]}]\n"
                        f"  …{r['text'][max(0, i - 150): i + 250].replace(chr(10), ' ')}…")
    for t in reversed(turns):
        low = t['text'].lower()
        if all(term in low for term in terms):
            i = low.find(terms[0])
            snippet = t['text'][max(0, i - 150): i + 250].replace('\n', ' ')
            hits.append(f"{label}#{t['n']} [{t['ts'][:16]}] {t['user'][:100]}\n  …{snippet}…  (offset≈{max(0, i - 150)}, 全长 {len(t['text'])})")
    return hits


def search(args):
    terms = [t.lower() for t in args['query'].split()]
    limit = int(args.get('limit') or 8)
    if not terms:
        return '无匹配。'
    if args.get('scope') == 'all':
        sids = tr.all_sessions()
        if not sids:
            raise ValueError('还没有任何存档（尚未发生过压缩）。')
        hits = []
        for sid in sids:
            turns = tr.load_archive(sid)
            date = turns[-1]['ts'][:10] if turns else ''
            hits += _search_one(sid, turns, terms, f'[{sid} {date}] ')
        return f'scope=all（{len(sids)} 个会话）\n' + ('\n'.join(hits[:limit]) if hits else '无匹配。')
    sid, turns = _session(args)
    hits = _search_one(sid, turns, terms, '')
    return f'session_id={sid}\n' + ('\n'.join(hits[:limit]) if hits else '无匹配。')


def _export(sid, first, last, text):
    d = tr.archive_root() / 'tmp'
    d.mkdir(parents=True, exist_ok=True)
    path = d / f'{sid}-turns-{first}-{last}-{time.strftime("%Y%m%d%H%M%S")}.md'
    path.write_text(text, encoding='utf-8')
    for old in sorted(d.glob('*.md'), key=lambda f: f.stat().st_mtime)[:-EXPORT_KEEP]:
        old.unlink()
    return path


def get(args):
    sid, turns = _session(args)
    first = int(args['turn'])
    if args.get('to_turn') is not None:
        last = int(args['to_turn'])
        sel = [t for t in turns if first <= t['n'] <= last]
        if not sel:
            raise ValueError(f'会话 {sid} 没有第 {first}–{last} 轮（共 {len(turns)} 轮）。')
        text = '\n\n'.join(f"===== 第 #{t['n']} 轮 [{t['ts'][:16]}] =====\n{t['text']}" for t in sel)
        if len(text) <= EXPORT_CHARS:
            return text
        path = _export(sid, first, last, text)
        return (pr.retrieval_pointer(first, last, len(text), text.count('\n') + 1, path)
                + f'\n\n开头片段：\n{text[:2000]}\n…')
    t = next((t for t in turns if t['n'] == first), None)
    if t is None:
        raise ValueError(f'会话 {sid} 没有第 {args["turn"]} 轮（共 {len(turns)} 轮）。')
    off, length = int(args.get('offset') or 0), int(args.get('length') or 8000)
    chunk = t['text'][off: off + length]
    rest = len(t['text']) - off - len(chunk)
    return chunk + (f'\n…[还剩 {rest} 字符，继续取 offset={off + len(chunk)}]' if rest > 0 else '')


def status(args):
    sid, entries = _live(args)
    ctx = tr.context_tokens(entries)
    layer = ('emergency' if ctx >= tr.EMERGENCY else 'pressure' if ctx >= tr.PRESSURE
             else 'growth' if ctx >= tr.SOFT else 'below soft')
    recs = store.load_summaries(sid)
    need = store.digest_needed(sid)
    return '\n'.join([
        f'session_id={sid}',
        pr.breakdown(ctx, tr.SOFT, tr.PRESSURE, tr.HARD) + f' — {layer}',
        f'compact_ready 已调用（本次压缩周期内）: {"是" if tr.ready_since_boundary(entries) else "否"}',
        f'已压缩次数: {tr.compactions(entries)}，存档轮数: {len(tr.load_archive(sid))}',
        f'摘要: {len(store.active_summaries(recs))} 条生效 / {len(recs)} 条存档'
        + (f'，需要 tier {need[0]} 汇总' if need else ''),
        f'规则: {len(store.replay_rules(entries, completed_only=True)["rules"])} 条'])


def rule(args):
    _, entries = _live(args)
    state = store.replay_rules(entries, completed_only=True)
    return store.apply_rule(state, args)


def call(name, args):
    if name == 'recall_search':
        return search(args)
    if name == 'recall_get':
        return get(args)
    if name == 'compact_ready':
        if not str(args.get('summary') or '').strip():
            raise ValueError('compact_ready 必须带 summary（覆盖上次压缩以来所有轮次的自包含摘要）。')
        return '已记录。系统会在下一次自动压缩检查时压缩上下文，压缩后会补回最近 5 轮原文和你的摘要。'
    if name == 'recall_status':
        return status(args)
    if name == 'recall_rule':
        return rule(args)
    raise ValueError(f'未知工具 {name}')


def handle(req):
    method, params = req.get('method'), req.get('params') or {}
    if method == 'initialize':
        return {'protocolVersion': params.get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'recall', 'version': '0.2.0'}}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        try:
            return {'content': [{'type': 'text', 'text': call(params['name'], params.get('arguments') or {})}]}
        except Exception as e:
            return {'content': [{'type': 'text', 'text': f'错误：{e}'}], 'isError': True}
    if method == 'ping':
        return {}
    raise LookupError(method)


def main():
    out = sys.stdout
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        if 'id' not in req:
            continue  # notification
        try:
            resp = {'jsonrpc': '2.0', 'id': req['id'], 'result': handle(req)}
        except LookupError as e:
            resp = {'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -32601, 'message': f'Method not found: {e}'}}
        out.write(json.dumps(resp, ensure_ascii=False) + '\n')
        out.flush()


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    main()
