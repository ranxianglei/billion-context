"""Claude Code transcript parsing and per-session archive of conversation turns."""
import json
import os
import pathlib
import re

SOFT = int(os.environ.get('RECALL_SOFT', 150_000))
STEP = int(os.environ.get('RECALL_STEP', 50_000))
HARD = int(os.environ.get('RECALL_HARD', 300_000))
PRESSURE = HARD * 75 // 100  # remind on every hook call from here
EMERGENCY = HARD * 95 // 100  # emergency text from here
ABSORB_MIN_TOKENS = 4_000  # acp-kernel absorb.minToolTokens
KEEP_TURNS = 5
BLOCK_CHARS = 9_500  # Claude Code inlines at most ~10k chars per hook output; more gets saved to a file.
TAIL_BYTES = 4 * 1024 * 1024
READY_SUFFIX = '__compact_ready'


def archive_root():
    return pathlib.Path(os.environ.get('RECALL_HOME') or pathlib.Path.home() / '.claude' / 'recall')


def session_dir(session_id):
    return archive_root() / session_id


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
            try:
                yield json.loads(raw)
            except ValueError:
                continue


def _main(entries):
    return (e for e in entries if not e.get('isSidechain'))


def context_tokens(entries):
    """Context size as of the last main-chain model reply (input + cache read + cache write)."""
    tokens = 0
    for e in _main(entries):
        msg = e.get('message')
        if e.get('type') == 'assistant' and isinstance(msg, dict) and msg.get('usage'):
            u = msg['usage']
            tokens = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
    return tokens


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


def tool_results(entries):
    """tool_use_id -> result text for every tool result on the main chain."""
    out = {}
    for e in _main(entries):
        content = (e.get('message') or {}).get('content') if e.get('type') == 'user' else None
        for b in content if isinstance(content, list) else []:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                out[b.get('tool_use_id')] = _text_of(b.get('content'))
    return out


def latest_ready(entries):
    """The model's latest compact_ready call after the most recent compaction, or None."""
    calls = tool_uses(entries, READY_SUFFIX, since_boundary=True)
    return calls[-1] if calls else None


def ready_since_boundary(entries):
    """True if the model called compact_ready after the most recent compaction."""
    return latest_ready(entries) is not None


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
    content = (e.get('message') or {}).get('content')
    if isinstance(content, list) and not any(isinstance(b, dict) and b.get('type') == 'text' for b in content):
        return False  # tool results only
    text = _text_of(content).lstrip()
    return bool(text) and not text.startswith(('<local-command', '<command-', '[Request interrupted'))


def _render(e, files, tools):
    content = (e.get('message') or {}).get('content')
    if e.get('type') == 'user':
        if isinstance(content, str):
            return ['【用户】' + content]
        out = []
        for b in content or []:
            if b.get('type') == 'text':
                out.append('【用户】' + b.get('text', ''))
            elif b.get('type') == 'tool_result':
                out.append('【结果】' + _text_of(b.get('content')))
        return out
    out = []
    for b in content if isinstance(content, list) else []:
        if b.get('type') == 'text':
            out.append('【助手】' + b.get('text', ''))
        elif b.get('type') == 'tool_use':
            inp = b.get('input') or {}
            tools[b.get('name', '?')] = tools.get(b.get('name', '?'), 0) + 1
            for k in ('file_path', 'path', 'notebook_path'):
                if isinstance(inp.get(k), str):
                    files.append(inp[k])
            out.append(f"【调用 {b.get('name')}】" + json.dumps(inp, ensure_ascii=False)[:2000])
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


def write_archive(session_id, transcript_path):
    d = session_dir(session_id)
    d.mkdir(parents=True, exist_ok=True)
    data = ''.join(json.dumps(t, ensure_ascii=False) + '\n' for t in turns(read_entries(transcript_path)))
    tmp = d / 'turns.jsonl.tmp'
    tmp.write_text(data, encoding='utf-8')
    os.replace(tmp, d / 'turns.jsonl')


def load_archive(session_id):
    p = session_dir(session_id) / 'turns.jsonl'
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding='utf-8').splitlines() if line.strip()]


def latest_session():
    root = archive_root()
    dirs = [d for d in root.iterdir() if (d / 'turns.jsonl').exists()] if root.exists() else []
    return max(dirs, key=lambda d: (d / 'turns.jsonl').stat().st_mtime).name if dirs else None


def all_sessions():
    root = archive_root()
    return sorted(d.name for d in root.iterdir() if (d / 'turns.jsonl').exists()) if root.exists() else []


def projects_root():
    return pathlib.Path(os.environ.get('RECALL_PROJECTS') or pathlib.Path.home() / '.claude' / 'projects')


def find_transcript(session_id=None):
    """Transcript of session_id, or else the newest transcript of the project the MCP server was started in.

    Claude Code starts MCP servers in the project directory and names the project folder after the path with
    every non-alphanumeric character replaced by '-'. Two live sessions in one project are told apart only by
    passing session_id.
    """
    root = projects_root()
    if session_id:
        hits = list(root.glob(f'*/{session_id}.jsonl'))
        return hits[0] if hits else None
    cwd = os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()
    files = list((root / re.sub(r'[^A-Za-z0-9]', '-', cwd)).glob('*.jsonl'))
    return max(files, key=lambda f: f.stat().st_mtime) if files else None
