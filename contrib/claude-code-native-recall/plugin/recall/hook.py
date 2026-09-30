"""Hook entry: nudge | precompact | restore <0-8>. Reads the hook JSON from stdin."""
import datetime
import json
import os
import sys
import time
import traceback

import prompts as pr
import store
import transcript as tr


def emit(event, text):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': text}}, ensure_ascii=False))


def log(sid, event, **fields):
    """Append one JSON line to the session's events.log; logging must never break the hook."""
    try:
        d = tr.session_dir(sid)
        d.mkdir(parents=True, exist_ok=True)
        rec = {'ts': datetime.datetime.now().isoformat(timespec='seconds'), 'event': event, **fields}
        with open(d / 'events.log', 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except OSError:
        pass


GROWTH_ZH = ('[billion-claude-recall] 当前上下文约 {k}k tokens（软线 {soft}k，{hard}k 时强制压缩）。'
             '如果手头任务不在紧要处：先把当前进度、关键决策、待办写进状态锚文件，再调用 compact_ready 工具，'
             'focus 参数写明压缩摘要必须保留的内容；系统会在下一次检查时自动压缩，压缩前原文可用 recall_search / recall_get 找回。'
             '如果正处在关键步骤中，继续工作，告一段落后再调用。')


def reminder(sid, ctx, layer):
    first = len(tr.load_archive(sid)) + 1
    args = (ctx, tr.SOFT, tr.PRESSURE, tr.HARD, first)
    if layer == 'growth':
        text = GROWTH_ZH.format(k=ctx // 1000, soft=tr.SOFT // 1000, hard=tr.HARD // 1000) + '\n\n' + pr.growth_text(*args)
    else:
        text = (pr.emergency_text if layer == 'emergency' else pr.pressure_text)(*args)
    need = store.digest_needed(sid)
    if need:
        text += '\n\n' + pr.digest_request(need[0], need[1], emergency=layer == 'emergency')
    return text


def absorb(data, ctx):
    """Absorb-style note request for a large built-in tool result once context is past the soft line."""
    name = str(data.get('tool_name') or '')
    if data.get('hook_event_name') != 'PostToolUse' or not name or name.startswith('mcp__') or ctx < tr.SOFT:
        return None
    resp = data.get('tool_response')
    size = len(resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False))
    tokens = -(-size // 4)  # acp-kernel estimateTextTokens: ceil(chars / 4)
    if tokens < tr.ABSORB_MIN_TOKENS:
        return None
    log(data['session_id'], 'absorb', ctx=ctx, tool=name, tokens=tokens)
    return pr.absorb_text(tokens, f'turn #{len(tr.load_archive(data["session_id"])) + 1} or later')


def nudge(data):
    sid = data['session_id']
    if not os.path.exists(data['transcript_path']):  # first prompt of a new session: transcript not written yet
        return
    entries = list(tr.read_entries(data['transcript_path'], tr.TAIL_BYTES))
    ctx = tr.context_tokens(entries)
    bucket = (ctx - tr.SOFT) // tr.STEP if ctx >= tr.SOFT else -1
    state_path = tr.session_dir(sid) / 'nudge.json'
    last = json.loads(state_path.read_text(encoding='utf-8'))['bucket'] if state_path.exists() else -1
    if bucket != last:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({'bucket': bucket}), encoding='utf-8')
    layer = None
    if not tr.ready_since_boundary(entries):
        if ctx >= tr.EMERGENCY:
            layer = 'emergency'
        elif ctx >= tr.PRESSURE:
            layer = 'pressure'
        elif bucket > last:
            layer = 'growth'
    parts = []
    if layer:
        log(sid, 'nudge', ctx=ctx, bucket=bucket, layer=layer)
        parts.append(reminder(sid, ctx, layer))
    note = absorb(data, ctx)
    if note:
        parts.append(note)
    if parts:
        emit(data.get('hook_event_name', 'PostToolUse'), '\n\n'.join(parts))


def precompact(data):
    entries = list(tr.read_entries(data['transcript_path'], tr.TAIL_BYTES))
    ctx = tr.context_tokens(entries)
    if data.get('trigger') == 'auto' and ctx < tr.HARD and not tr.ready_since_boundary(entries):
        log(data['session_id'], 'block', ctx=ctx)
        sys.stderr.write(f'[billion-claude-recall] 上下文 {ctx // 1000}k，模型尚未调用 compact_ready，推迟压缩（{tr.HARD // 1000}k 强制）。')
        sys.exit(2)
    sid = data['session_id']
    tr.write_archive(sid, data['transcript_path'])
    full = list(tr.read_entries(data['transcript_path']))
    turns = tr.load_archive(sid)
    log(sid, 'allow', ctx=ctx, trigger=data.get('trigger'),
        reason='manual' if data.get('trigger') != 'auto' else ('hard' if ctx >= tr.HARD else 'ready'),
        turns=len(turns), summaries=store.save_summary(sid, full, turns),
        rules=store.save_rules(sid, full), todos=store.save_todos(sid, full))


def _clip(text, limit, sid, n):
    if len(text) <= limit:
        return text
    head, tail = limit * 55 // 100, limit * 35 // 100
    return (text[:head] + f'\n…[省略 {len(text) - head - tail} 字符，取回：recall_get(session_id="{sid}", turn={n}, offset={head})]…\n'
            + text[-tail:])


def restore(data, slot):
    sid = data['session_id']
    turns = tr.load_archive(sid)
    if not turns:
        tr.write_archive(sid, data['transcript_path'])
        turns = tr.load_archive(sid)
    if not turns:
        return
    recent = turns[-tr.KEEP_TURNS:]
    if slot == 0:
        head = (f'[billion-claude-recall] 刚发生上下文压缩。压缩前的完整对话已存档（session_id="{sid}"，共 {len(turns)} 轮）。'
                f'紧随的 recent-turn 块是最近 {len(recent)} 轮原文，按块内编号从旧到新阅读。'
                '需要更早的细节时，用 recall_search(query, session_id) 搜索、recall_get(session_id, turn, offset) 取原文，不要凭摘要猜。'
                '若之前写过状态锚文件，先重读它。\n更早轮次索引（新→旧）：\n')
        lines, budget = [], tr.BLOCK_CHARS - len(head)
        for t in reversed(turns[:-tr.KEEP_TURNS]):
            line = f"#{t['n']} [{t['ts'][:16]}] {t['user'][:120]}" + (f" | 文件: {', '.join(t['files'][:3])}" if t['files'] else '') + '\n'
            if len(line) > budget:
                break
            lines.append(line)
            budget -= len(line)
        emit('SessionStart', head + ''.join(lines))
        log(sid, 'restore', turns=len(turns), recent=len(recent), indexed=len(lines),
            context_tokens=data.get('context_tokens'))
    elif slot == 6:
        label = f'[billion-claude-recall summaries] 你在 compact_ready 里写的历史摘要（session_id="{sid}"，旧→新）：\n'
        body = store.summaries_block(sid, tr.BLOCK_CHARS - len(label))
        if body:
            emit('SessionStart', label + body)
    elif slot == 7:
        body = store.rules_block(sid)
        if body:
            emit('SessionStart', '[billion-claude-recall rules]\n' + body)
    elif slot == 8:
        body = store.todos_block(sid)
        if body:
            emit('SessionStart', body[:tr.BLOCK_CHARS])
    elif slot <= len(recent):
        t = recent[slot - 1]
        label = f'[billion-claude-recall recent-turn {slot}/{len(recent)}] 第 #{t["n"]} 轮原文（{t["ts"][:16]}）：\n'
        emit('SessionStart', label + _clip(t['text'], tr.BLOCK_CHARS - len(label), sid, t['n']))


def main():
    data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    cmd = sys.argv[1]
    start = time.monotonic()
    try:
        if cmd == 'nudge':
            nudge(data)
        elif cmd == 'precompact':
            precompact(data)
        elif cmd == 'restore':
            restore(data, int(sys.argv[2]))
    except Exception:
        log(data.get('session_id', 'unknown'), 'error', hook=' '.join(sys.argv[1:]),
            ms=int((time.monotonic() - start) * 1000), trace=traceback.format_exc()[-2000:])
        raise


if __name__ == '__main__':
    main()
