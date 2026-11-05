"""One bounded stdin request -> durable shared Recall archive ACK. No host DB reads."""
import json
import sys

import archive


def handle(request):
    if not isinstance(request, dict):
        raise ValueError('Bridge request must be an object')
    operation = request.get('operation', request.get('op'))
    sid = request.get('session_id')
    directory = archive.session_dir(sid)
    if operation == 'status':
        if not (directory / 'events.jsonl').is_file():
            raise ValueError('No archive exists for this session')
        records = archive.records(sid)
        if not records or any(r['identity'].get('host') != 'opencode' for r in records):
            raise ValueError('No OpenCode archive exists for this session')
        return {'ok': True, 'durable': True, 'session_id': sid, 'count': len(records)}
    if operation not in ('append', 'snapshot', 'barrier'):
        raise ValueError('Unknown bridge operation')
    observations = request.get('records', [])
    if operation == 'barrier' and not observations and not (directory / 'events.jsonl').is_file():
        raise ValueError('Cannot acknowledge a missing archive')
    result = archive.append_native(sid, request.get('project'), observations, request.get('parent_id'))
    if operation == 'barrier' and not result['count']:
        raise ValueError('Cannot acknowledge an empty archive')
    return {'ok': True, **result}


def main():
    try:
        request = json.load(sys.stdin)
        result = handle(request)
    except Exception as error:
        # Never echo the input, which can contain private transcript data.
        result = {'ok': False, 'durable': False, 'error': type(error).__name__, 'message': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
