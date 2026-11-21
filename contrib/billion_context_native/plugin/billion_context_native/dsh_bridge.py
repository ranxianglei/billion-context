"""Bounded JSON subprocess interface to shared Recall storage and native reads."""
import json
import sys

import archive
import native_read

MAX_ENVELOPE = 32 * 1024 * 1024


def handle(request):
    if not isinstance(request, dict):
        raise ValueError('Request must be an object')
    sid = request.get('session_id')
    archive.session_dir(sid)
    operation = request.get('operation')
    if operation == 'append':
        records = request.get('records')
        if not isinstance(records, list):
            raise ValueError('records must be an array')
        for item in records:
            event = item.get('payload', {})
            if item.get('kind') == 'event':
                if type(event.get('seq')) is not int or event['seq'] < 0 or not isinstance(event.get('type'), str):
                    raise ValueError('Invalid DSH event envelope')
                if not isinstance(event.get('data'), dict):
                    raise ValueError('Invalid DSH event data')
        return {'ok': True, **archive.append_native(sid, request.get('project'), records, host='dsh')}
    if native_read.archive_host(sid) != 'dsh':
        raise ValueError('No DSH archive for this session')
    if operation == 'search':
        args = request.get('arguments', {})
        result = native_read.search(sid, args.get('query'), limit=args.get('limit', 8),
                                   byte_limit=args.get('byte_limit', 65536), cursor=args.get('cursor'), host='dsh')
    elif operation == 'get':
        args = request.get('arguments', {})
        locator = args.get('locator')
        if not isinstance(locator, dict) or locator.get('session_id') != sid or locator.get('host') != 'dsh':
            raise ValueError('Locator belongs to another session or host')
        result = native_read.get(locator_value=locator, session_id=sid, host='dsh',
                                 byte_offset=args.get('byte_offset', 0), byte_limit=args.get('byte_limit', 65536))
    elif operation == 'status':
        facts = archive.records(sid)
        result = {'host': 'dsh', 'session_id': sid, 'durable_facts': len(facts),
                  'latest_archive_seq': facts[-1]['seq'] if facts else 0}
    else:
        raise ValueError('Unknown DSH bridge operation')
    return {'ok': True, 'result': result}


def main():
    try:
        data = sys.stdin.buffer.read(MAX_ENVELOPE + 1)
        if len(data) > MAX_ENVELOPE:
            raise ValueError('Request exceeds byte limit')
        response = handle(json.loads(data))
        code = 0
    except Exception as error:
        # Diagnostics expose a stable type/code only, never payload or exception text.
        response = {'ok': False, 'error': getattr(error, 'code', type(error).__name__)}
        code = 1
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n')
    return code


if __name__ == '__main__':
    sys.exit(main())
