"""Read DSH 0.2.0-rc.2 turn facts without folding away replaced history.

Live events are host observations; resume snapshots may contain host repair
events. Origin labels are retained, and no reconstructed bytes are called a
verbatim physical DSH log. Unknown event types remain in their enclosing turn.
"""
import json


def project_records(records):
    by_seq = {}
    for record in records:
        observation = record['entry']
        if observation.get('kind') != 'event':
            continue
        event = observation.get('payload', {})
        seq = event.get('seq')
        if type(seq) is not int or seq < 0:
            continue
        by_seq.setdefault(seq, []).append((event, record))
    turns = []
    current = None
    for seq in sorted(by_seq):
        variants = by_seq[seq]
        event, record = variants[0]
        kind = event.get('type')
        if kind == 'turn/start':
            current = {'n': len(turns) + 1, 'host': 'dsh', 'events': [],
                       'native_message_ids': [], 'event_ids': [], 'conflicts': [],
                       'completion': 'unknown', 'native_turn': event.get('data', {}).get('turn')}
            turns.append(current)
        if current is None:
            continue
        # Standalone compaction and subsequent maintenance belong to no turn.
        if current['completion'] != 'unknown':
            continue
        current['events'].append({'origin': record['source'].get('origin'), 'event': event})
        current['event_ids'].append(record['event_id'])
        if len({json.dumps(e, sort_keys=True, ensure_ascii=False) for e, _ in variants}) > 1:
            current['conflicts'].append('contradictory_native_seq')
        if kind == 'user/message' and event.get('surfaceOp') == 'append' and not current['native_message_ids']:
            current['native_message_ids'].append('seq:' + str(seq))
        if kind == 'turn/end':
            current['completion'] = event.get('data', {}).get('reason', {}).get('kind', 'unknown')
    for turn in turns:
        turn['pending_prompt'] = not turn['native_message_ids']
        turn['text'] = json.dumps({'format': 'dsh-turn-v1', 'native_turn': turn['native_turn'],
                                  'events': turn.pop('events')}, ensure_ascii=False,
                                 sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n'
    return turns
