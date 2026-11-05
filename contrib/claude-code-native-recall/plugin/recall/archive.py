"""Append-only host records; SQLite is a disposable cursor and identity index."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import stat
import tempfile
import time

VERSION = 1


class UnsupportedArchiveVersion(ValueError):
    pass


def root():
    return pathlib.Path(os.environ.get('RECALL_HOME') or pathlib.Path.home() / '.claude' / 'recall')


def session_dir(sid):
    if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', sid) or sid in ('.', '..'):
        raise ValueError('Unsafe session_id')
    base = root().resolve()
    path = base / sid
    if path.is_symlink():
        raise ValueError('Session directory must not be a symlink')
    return path


def _regular(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or path.suffix != '.jsonl':
        raise ValueError('Transcript must be an absolute .jsonl path')
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise ValueError('Transcript symlinks are not allowed')
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError('Transcript must be a regular file')
    return path.resolve()


def _safe_file(path):
    if path.is_symlink():
        raise ValueError('Archive files must not be symlinks')


def _fsync_dir(path):
    if os.name == 'nt':
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_bytes(path, data):
    _safe_file(path)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        _fsync_dir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def _locked(sid):
    d = session_dir(sid)
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = d / 'archive.lock'
    _safe_file(lock)
    with open(lock, 'a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            if stream.seek(0, os.SEEK_END) == 0:
                stream.write(b'0')
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield d
        finally:
            if os.name == 'nt':
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def _encode(obj):
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def _digest(obj):
    return hashlib.sha256(_encode(obj)).hexdigest()


def _connect(d):
    path = d / 'index.sqlite3'
    _safe_file(path)
    for suffix in ('-journal', '-wal', '-shm'):
        _safe_file(d / ('index.sqlite3' + suffix))
    try:
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=DELETE')
        db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, seq INTEGER NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, state TEXT NOT NULL)')
        db.execute('SELECT count(*) FROM events').fetchone()
        return db
    except sqlite3.DatabaseError:
        try:
            db.close()
        except UnboundLocalError:
            pass
        os.replace(path, d / ('index.corrupt.' + str(time.time_ns()) + '.sqlite3'))
        return _connect(d)


def _meta(db, key, default=None):
    row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set_meta(db, key, value):
    db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))


def _commit_index(db):
    db.commit()


def _append_record(stream, record):
    stream.write(_encode(record))


def _tail_digest(path, offset):
    if not offset:
        return hashlib.sha256(b'').hexdigest()
    with open(path, 'rb') as stream:
        stream.seek(max(0, offset - 4096))
        return hashlib.sha256(stream.read(min(offset, 4096))).hexdigest()


def _recover(d, db):
    path = d / 'events.jsonl'
    _safe_file(path)
    size = path.stat().st_size if path.exists() else 0
    offset = _meta(db, 'archive_offset', 0)
    if offset > size or (offset and _meta(db, 'archive_tail') != _tail_digest(path, offset)):
        db.execute('DELETE FROM events')
        db.execute('DELETE FROM sources')
        db.execute('DELETE FROM meta')
        offset = 0
    if not path.exists():
        return
    if offset and _meta(db, 'host') is None:
        # Existing phase-one indexes predate the host binding. Recover it from
        # the durable first fact rather than treating that archive as unbound.
        with open(path, 'rb') as first:
            record = json.loads(first.readline())
        if isinstance(record, dict) and record.get('identity', {}).get('host'):
            _set_meta(db, 'host', record['identity']['host'])
            if record['identity']['host'] == 'opencode':
                _set_meta(db, 'native_parent', record['identity'].get('parent_session'))
    with open(path, 'r+b') as stream:
        stream.seek(offset)
        while True:
            pos = stream.tell()
            raw = stream.readline()
            if not raw:
                break
            try:
                if not raw.endswith(b'\n'):
                    raise ValueError('incomplete archive line')
                rec = json.loads(raw)
                if isinstance(rec, dict) and isinstance(rec.get('version'), int) and rec['version'] > VERSION:
                    raise UnsupportedArchiveVersion('Archive requires a newer recall version; file left unchanged')
                if (not isinstance(rec, dict) or rec.get('version') != VERSION
                        or not isinstance(rec.get('seq'), int) or rec['seq'] < 1
                        or not isinstance(rec.get('event_id'), str) or not rec['event_id']
                        or rec.get('kind') not in ('event', 'legacy_turn')
                        or not isinstance(rec.get('entry'), dict)
                        or not isinstance(rec.get('identity'), dict)
                        or not isinstance(rec.get('source'), dict)
                        or rec['identity'].get('session') != d.name
                        or not isinstance(rec['source'].get('path'), str)):
                    raise ValueError('invalid archive envelope')
            except UnsupportedArchiveVersion:
                raise
            except (ValueError, UnicodeDecodeError, AttributeError):
                rest = raw + stream.read()
                _atomic_bytes(d / ('events.corrupt.' + str(time.time_ns()) + '.bin'), rest)
                stream.seek(pos)
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
                break
            db.execute('INSERT OR IGNORE INTO events VALUES (?,?)', (rec['event_id'], rec['seq']))
            _set_meta(db, 'seq', max(_meta(db, 'seq', 0), rec['seq']))
            if rec.get('identity', {}).get('project'):
                _set_meta(db, 'project', rec['identity']['project'])
            if rec.get('identity', {}).get('host'):
                _set_meta(db, 'host', rec['identity']['host'])
            if rec.get('identity', {}).get('host') == 'opencode':
                _set_meta(db, 'native_parent', rec['identity'].get('parent_session'))
            src = rec.get('source', {})
            if src.get('checkpoint'):
                db.execute('INSERT OR REPLACE INTO sources VALUES (?,?)', (src['path'], json.dumps(src['checkpoint'])))
            if rec.get('legacy_migration_complete'):
                _set_meta(db, 'legacy_migrated', True)
            offset = stream.tell()
    _set_meta(db, 'archive_offset', offset)
    _set_meta(db, 'archive_tail', _tail_digest(path, offset))
    db.commit()


def _attachments(entry):
    found = []
    def visit(value):
        if isinstance(value, dict):
            if value.get('type') in ('image', 'document', 'file', 'attachment', 'input_image', 'input_file'):
                source = value.get('source') or {}
                if isinstance(source, dict) and (source.get('data') is not None or source.get('type') == 'base64'):
                    status = 'embedded_in_record'
                elif any(k in value for k in ('url', 'file_id', 'path', 'file_url')) or (isinstance(source, dict) and any(k in source for k in ('url', 'path', 'file_id'))):
                    status = 'reference_only_not_fetched'
                else:
                    status = 'content_unavailable'
                found.append({'type': value.get('type'), 'status': status})
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(entry)
    return found


def _migrate(d, db, sid, out):
    if _meta(db, 'legacy_migrated', False):
        return 0
    old = d / 'turns.jsonl'
    if not old.exists():
        _set_meta(db, 'legacy_migrated', True)
        return 0
    _safe_file(old)
    backup = d / 'turns.legacy-v0.jsonl'
    _safe_file(backup)
    if not backup.exists():
        _atomic_bytes(backup, old.read_bytes())
    count = 0
    valid = []
    for i, line in enumerate(backup.read_bytes().splitlines()):
        if not line.strip():
            continue
        try:
            turn = json.loads(line)
            if not isinstance(turn, dict):
                continue
        except (ValueError, UnicodeDecodeError):
            continue
        valid.append((i, line, turn))
    for row, (i, line, turn) in enumerate(valid):
        key = 'legacy:' + str(i) + ':' + hashlib.sha256(line).hexdigest()
        if db.execute('SELECT 1 FROM events WHERE key=?', (key,)).fetchone():
            continue
        seq = _meta(db, 'seq', 0) + 1
        rec = {'version': VERSION, 'seq': seq, 'event_id': key, 'kind': 'legacy_turn',
               'identity': {'host': 'claude-code', 'session': sid, 'project': None, 'branch': 'legacy'},
               'source': {'path': str(backup), 'line': i + 1}, 'entry': turn,
               'legacy': True, 'completeness': 'derived_v0_possibly_truncated_missing_nontext',
               'legacy_migration_complete': row == len(valid) - 1}
        _append_record(out, rec)
        db.execute('INSERT INTO events VALUES (?,?)', (key, seq))
        _set_meta(db, 'seq', seq)
        count += 1
    _set_meta(db, 'legacy_migrated', True)
    return count


def sync(sid, transcript_path):
    """Save complete source lines before committing cursors; never replace historical events.

    A changed prefix creates a source generation. Without native UUIDs, changed-generation
    records are retained conservatively because equal text cannot prove equal events.
    """
    path = _regular(transcript_path)
    with _locked(sid) as d:
        db = _connect(d)
        try:
            _recover(d, db)
            if _meta(db, 'host') not in (None, 'claude-code'):
                raise ValueError('Session already belongs to another host')
            project = str(path.parent)
            bound = _meta(db, 'project')
            if bound is not None and bound != project:
                raise ValueError('Session already belongs to another transcript project')
            _set_meta(db, 'project', project)
            _set_meta(db, 'host', 'claude-code')
            row = db.execute('SELECT state FROM sources WHERE path=?', (str(path),)).fetchone()
            prev = json.loads(row[0]) if row else None
            offset = (prev or {}).get('offset', 0)
            generation = (prev or {}).get('generation', 0)
            consumed = hashlib.sha256()
            bytes_read = 0
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            with os.fdopen(descriptor, 'rb') as source:
                stat_before = os.fstat(source.fileno())
                # Verifying the consumed prefix detects arbitrary in-place rewrites, including
                # same-size middle edits; source reads can be O(n), archive writes are O(delta).
                remaining = offset
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    consumed.update(chunk)
                    remaining -= len(chunk)
                    bytes_read += len(chunk)
                if prev and (remaining or consumed.hexdigest() != prev['digest']
                             or prev.get('inode') != stat_before.st_ino or prev.get('device') != stat_before.st_dev):
                    generation += 1
                    offset = 0
                    source.seek(0)
                    consumed = hashlib.sha256()
                line_no = prev.get('line', 0) if prev and offset else 0
                turn_id = prev.get('turn_id') if prev and offset else None
                turn_start = prev.get('turn_start') if prev and offset else None
                epoch = prev.get('epoch', 0) if prev and offset else 0
                branch_states = prev.get('branches', {}) if prev and offset else {}
                deferred = None
                archive_path = d / 'events.jsonl'
                _safe_file(archive_path)
                with open(archive_path, 'ab') as out:
                    appended = _migrate(d, db, sid, out)
                    while True:
                        start = source.tell()
                        raw = source.readline()
                        bytes_read += len(raw)
                        if not raw or not raw.endswith(b'\n'):
                            if raw:
                                deferred = {'offset': start, 'reason': 'incomplete_last_line'}
                            break
                        try:
                            entry = json.loads(raw)
                            if not isinstance(entry, dict):
                                raise ValueError('Source entry must be an object')
                        except (ValueError, UnicodeDecodeError):
                            deferred = {'offset': start, 'reason': 'malformed_source_line'}
                            # Do not skip a malformed line: it may be an asynchronous write.
                            # Preserve the unread bytes in the source and retry next sync.
                            break
                        line_no += 1
                        consumed.update(raw)
                        offset = source.tell()
                        branch = str(entry.get('agentId') or ('sidechain' if entry.get('isSidechain') else 'main'))
                        context = branch_states.get(branch, {})
                        turn_id, turn_start, epoch = context.get('turn_id'), context.get('turn_start'), context.get('epoch', 0)
                        native = entry.get('uuid')
                        if entry.get('sessionId') and entry['sessionId'] != sid:
                            raise ValueError('Source record sessionId does not match target session')
                        if entry.get('type') == 'system' and entry.get('subtype') == 'compact_boundary':
                            epoch += 1
                            turn_id = None
                            turn_start = None
                        message = entry.get('message')
                        content = message.get('content') if isinstance(message, dict) else None
                        texts = content if isinstance(content, str) else '\n'.join(
                            str(b.get('text', '')) for b in content if isinstance(b, dict) and b.get('type') == 'text'
                        ) if isinstance(content, list) else ''
                        has_attachment = isinstance(content, list) and any(
                            isinstance(b, dict) and b.get('type') not in ('text', 'tool_result') for b in content)
                        if (entry.get('type') == 'user' and not entry.get('isMeta') and not entry.get('isCompactSummary')
                                and (texts.strip() or has_attachment) and not texts.lstrip().startswith(('<local-command', '<command-', '[Request interrupted'))):
                            turn_id = _digest([sid, branch, native or [str(path), stat_before.st_dev, stat_before.st_ino, line_no, entry]])
                            turn_start = entry
                        branch_states[branch] = {'turn_id': turn_id, 'turn_start': turn_start, 'epoch': epoch}
                        identity = {'host': 'claude-code', 'project': project, 'session': sid, 'branch': branch}
                        if native:
                            key = _digest([identity, 'uuid', native, entry])
                        else:
                            key = _digest([identity, 'position', str(path), generation, start, entry])
                        checkpoint = {'offset': offset, 'line': line_no, 'generation': generation,
                                      'digest': consumed.hexdigest(), 'inode': stat_before.st_ino, 'device': stat_before.st_dev,
                                      'turn_id': turn_id, 'turn_start': turn_start, 'epoch': epoch, 'branches': branch_states}
                        if not db.execute('SELECT 1 FROM events WHERE key=?', (key,)).fetchone():
                            seq = _meta(db, 'seq', 0) + 1
                            rec = {'version': VERSION, 'seq': seq, 'event_id': key, 'kind': 'event',
                                   'identity': identity, 'source': {'path': str(path), 'generation': generation,
                                   'offset': start, 'line': line_no, 'checkpoint': checkpoint,
                                   'inode': stat_before.st_ino, 'device': stat_before.st_dev,
                                   'turn_id': turn_id, 'turn_start': turn_start, 'epoch': epoch},
                                   'entry': entry, 'attachments': _attachments(entry), 'legacy_migration_complete': True}
                            _append_record(out, rec)
                            db.execute('INSERT INTO events VALUES (?,?)', (key, seq))
                            _set_meta(db, 'seq', seq)
                            appended += 1
                    out.flush()
                    os.fsync(out.fileno())
                    _set_meta(db, 'archive_offset', out.tell())
                    _set_meta(db, 'archive_tail', _tail_digest(archive_path, out.tell()))
                    _fsync_dir(d)
            checkpoint = {'offset': offset, 'line': line_no, 'generation': generation,
                          'digest': consumed.hexdigest(), 'inode': stat_before.st_ino, 'device': stat_before.st_dev,
                                      'turn_id': turn_id, 'turn_start': turn_start, 'epoch': epoch, 'branches': branch_states}
            db.execute('INSERT OR REPLACE INTO sources VALUES (?,?)', (str(path), json.dumps(checkpoint)))
            _commit_index(db)
            return {'appended': appended, 'bytes_read': bytes_read, 'generation': generation,
                    'count': _meta(db, 'seq', 0), 'offset': offset, 'deferred': deferred,
                    'source_digest': consumed.hexdigest(), 'device': stat_before.st_dev,
                    'inode': stat_before.st_ino, 'completeness': 'durable_complete_source_prefix_only'}
        finally:
            db.close()



CC_HOOK_FIELDS = frozenset({
    'session_id', 'transcript_path', 'hook_event_name', 'tool_name', 'tool_use_id',
    'tool_input', 'tool_response', 'error', 'is_interrupt', 'last_assistant_message',
    'stop_hook_active', 'trigger', 'custom_instructions', 'source', 'prompt',
    'agent_id', 'agent_type', 'compact_summary',
})
CC_HOOK_EVENTS = frozenset({'PostToolUse', 'PostToolUseFailure', 'Stop',
                            'PreCompact', 'PostCompact', 'StopFailure', 'SessionStart', 'UserPromptSubmit'})


def _cc_hook_source(transcript_path):
    """Validate a host-supplied reference, also before its first async JSONL write."""
    path = pathlib.Path(transcript_path)
    if not path.is_absolute() or path.suffix != '.jsonl':
        raise ValueError('Transcript must be an absolute .jsonl path')
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise ValueError('Transcript symlinks are not allowed')
    if path.exists():
        return _regular(str(path))
    if not path.parent.is_dir():
        raise ValueError('Transcript parent must already exist')
    return path.resolve()


def append_cc_hook(sid, transcript_path, hook_event, data):
    """Append selected original hook fields, never invent a transcript message.

    Hooks can arrive before the source JSONL. A tool_use_id is only a tool identity,
    not a turn anchor: the reading projector must find exactly one native call.
    Stop and other observations without one are deliberately unanchored receipts.
    """
    session_dir(sid)
    path = _cc_hook_source(transcript_path)
    if hook_event not in CC_HOOK_EVENTS or not isinstance(data, dict):
        raise ValueError('Unknown CC hook observation')
    if data.get('session_id') not in (None, sid):
        raise ValueError('Hook session_id does not match target session')
    if data.get('hook_event_name') not in (None, hook_event):
        raise ValueError('Hook event name does not match observation')
    if data.get('transcript_path') is not None and _cc_hook_source(data['transcript_path']) != path:
        raise ValueError('Hook transcript_path does not match source reference')
    native = {key: value for key, value in data.items() if key in CC_HOOK_FIELDS}
    json.dumps(native, allow_nan=False)
    cid = native.get('tool_use_id')
    if not isinstance(cid, str) or not cid:
        cid = None
    status = ('success_observed' if hook_event == 'PostToolUse' and 'tool_response' in native
              else 'failure_observed' if hook_event in ('PostToolUseFailure', 'StopFailure')
              else 'stop_observed' if hook_event == 'Stop' else 'unknown')
    observation = {'type': 'cc_hook_observation', 'hook_event_name': hook_event,
                   'data': native, 'observation_status': status,
                   'completeness': 'direct_hook_observation_only',
                   'association': 'requires_unique_native_tool_use' if cid else 'unanchored_no_native_message_id'}
    project = str(path.parent)
    with _locked(sid) as d:
        db = _connect(d)
        try:
            _recover(d, db)
            if _meta(db, 'host') not in (None, 'claude-code'):
                raise ValueError('Session already belongs to another host')
            if _meta(db, 'project') not in (None, project):
                raise ValueError('Session already belongs to another transcript project')
            identity = {'host': 'claude-code', 'project': project, 'session': sid,
                        'branch': 'hook-observation'}
            if cid:
                identity['tool_use_id'] = cid
            # A missing native identifier cannot establish duplicate delivery.
            # The sequence discriminator is an archive receipt, not a fake UUID.
            discriminator = ['tool_use_id', cid] if cid else ['unanchored_receipt', _meta(db, 'seq', 0) + 1]
            key = _digest([identity, hook_event, discriminator, observation])
            appended = 0
            archive_path = d / 'events.jsonl'
            _safe_file(archive_path)
            with open(archive_path, 'ab') as out:
                appended += _migrate(d, db, sid, out)
                if not db.execute('SELECT 1 FROM events WHERE key=?', (key,)).fetchone():
                    seq = _meta(db, 'seq', 0) + 1
                    rec = {'version': VERSION, 'seq': seq, 'event_id': key, 'kind': 'event',
                           'identity': identity, 'source': {'path': str(path), 'kind': 'cc_hook',
                               'hook_event': hook_event, 'association': observation['association']},
                           'entry': observation, 'attachments': _attachments(native),
                           'legacy_migration_complete': True}
                    _append_record(out, rec)
                    db.execute('INSERT INTO events VALUES (?,?)', (key, seq))
                    _set_meta(db, 'seq', seq)
                    appended += 1
                out.flush()
                os.fsync(out.fileno())
                _set_meta(db, 'archive_offset', out.tell())
                _set_meta(db, 'archive_tail', _tail_digest(archive_path, out.tell()))
                _fsync_dir(d)
            _set_meta(db, 'host', 'claude-code')
            _set_meta(db, 'project', project)
            _set_meta(db, 'legacy_migrated', True)
            _commit_index(db)
            return {'appended': appended, 'count': _meta(db, 'seq', 0), 'durable': True,
                    'host': 'claude-code', 'session_id': sid,
                    'completeness': 'direct_hook_observation_only',
                    'association': observation['association'],
                    'source_prefix_only': True, 'source_was_read': False}
        finally:
            db.close()

def records(sid):
    with _locked(sid) as d:
        db = _connect(d)
        try:
            _recover(d, db)
            path = d / 'events.jsonl'
            if not path.exists():
                return []
            return [json.loads(line) for line in path.read_bytes().splitlines() if line]
        finally:
            db.close()


def entries(sid):
    return [r['entry'] for r in records(sid) if r['kind'] == 'event']


def append_native(sid, project, observations, parent_id=None):
    """Persist JSON-serializable OpenCode V2 observations without rewriting them.

    Observation timestamps are provenance, never a native revision. Identity plus
    native revision plus payload is the deduplication key; contradictory values at
    the same revision remain separate facts. The caller explicitly opts in and
    supplies one session only; this function never scans host data or attachments.
    """
    session_dir(sid)
    if not isinstance(project, str) or not pathlib.Path(project).is_absolute():
        raise ValueError('OpenCode project must be an absolute canonical path')
    if str(pathlib.Path(project).resolve()) != project:
        raise ValueError('OpenCode project must be canonical')
    if parent_id is not None:
        session_dir(parent_id)
    if not isinstance(observations, list):
        raise ValueError('records must be an array')
    prepared = []
    for observation in observations:
        if not isinstance(observation, dict) or observation.get('kind') not in (
                'event', 'message', 'part', 'tool.raw', 'prompt', 'barrier'):
            raise ValueError('Unknown OpenCode observation kind')
        payload = observation.get('payload')
        if not isinstance(payload, dict):
            raise ValueError('Native payload must be an object')
        identity = observation.get('identity') or {}
        revision = observation.get('revision') or {}
        if not isinstance(identity, dict) or not isinstance(revision, dict):
            raise ValueError('Native identity/revision must be objects')
        for value in [payload, payload.get('data', {})]:
            if isinstance(value, dict) and value.get('sessionID') not in (None, sid):
                raise ValueError('Native observation session mismatch')
        # Enforce actual JSON semantics (no NaN, bytes, or lossy default=str).
        json.dumps(observation, allow_nan=False)
        prepared.append((observation, identity, revision))
    with _locked(sid) as d:
        db = _connect(d)
        try:
            _recover(d, db)
            if _meta(db, 'host') not in (None, 'opencode'):
                raise ValueError('Session already belongs to another host')
            if _meta(db, 'project') not in (None, project):
                raise ValueError('Session already belongs to another project')
            if _meta(db, 'host') == 'opencode' and _meta(db, 'native_parent') != parent_id:
                raise ValueError('Session parent identity cannot change')
            _set_meta(db, 'host', 'opencode')
            _set_meta(db, 'project', project)
            _set_meta(db, 'native_parent', parent_id)
            archive_path = d / 'events.jsonl'
            _safe_file(archive_path)
            appended = 0
            with open(archive_path, 'ab') as out:
                for observation, entity, revision in prepared:
                    identity = {'host': 'opencode', 'project': project, 'session': sid,
                                'branch': 'main' if parent_id is None else 'child',
                                'parent_session': parent_id, **entity}
                    # Caller fields cannot replace the scoped host identity.
                    identity.update(host='opencode', project=project, session=sid,
                                    branch='main' if parent_id is None else 'child', parent_session=parent_id)
                    key = _digest([identity, observation['kind'], revision, observation['payload']])
                    if db.execute('SELECT 1 FROM events WHERE key=?', (key,)).fetchone():
                        continue
                    seq = _meta(db, 'seq', 0) + 1
                    record = {'version': VERSION, 'seq': seq, 'event_id': key, 'kind': 'event',
                              'identity': identity,
                              'source': {'path': 'opencode://' + sid, 'native_revision': revision,
                                         'origin': observation.get('origin'),
                                         'observed_at': observation.get('observed_at')},
                              'entry': observation, 'attachments': _attachments(observation['payload']),
                              'legacy_migration_complete': True}
                    _append_record(out, record)
                    db.execute('INSERT INTO events VALUES (?,?)', (key, seq))
                    _set_meta(db, 'seq', seq)
                    appended += 1
                out.flush()
                os.fsync(out.fileno())
                _set_meta(db, 'archive_offset', out.tell())
                _set_meta(db, 'archive_tail', _tail_digest(archive_path, out.tell()))
                _fsync_dir(d)
            _set_meta(db, 'legacy_migrated', True)
            _commit_index(db)
            return {'session_id': sid, 'appended': appended, 'count': _meta(db, 'seq', 0),
                    'durable': True, 'host': 'opencode', 'main_session': parent_id is None}
        finally:
            db.close()


def legacy_turns(sid):
    return [{**r['entry'], 'legacy': True, 'completeness': r['completeness']}
            for r in records(sid) if r['kind'] == 'legacy_turn']
