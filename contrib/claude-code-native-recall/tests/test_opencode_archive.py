"""Native V2 observation durability and reading-view regressions; synthetic only."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'recall'
sys.path.insert(0, str(PLUGIN))
import archive
import opencode_bridge as bridge
import transcript


def observation(payload, kind='message', **extra):
    identity = {'message_id': payload.get('id')} if kind == 'message' else {}
    return {'kind': kind, 'identity': identity, 'revision': {}, 'payload': payload,
            'origin': 'synthetic-official-shape', **extra}


def user(text='native marker'):
    return observation({'id': 'msg_001', 'type': 'user', 'text': text, 'time': {'created': 1}})


def assistant(text='native answer'):
    return observation({'id': 'msg_002', 'type': 'assistant', 'content': [{'type': 'text', 'text': text}],
                        'time': {'created': 2, 'completed': 3}})


class OpenCodeArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.project = self.root / 'explicit-project'
        self.project.mkdir()
        self.sid = 'ses_native-main'
        self.env = {'RECALL_HOME': str(self.root / 'archive'), 'RECALL_PROJECTS': str(self.root / 'none')}
        self.patch = patch.dict(os.environ, self.env)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def append(self, records, **options):
        return archive.append_native(self.sid, str(self.project), records, **options)

    def text(self):
        return '\n'.join(t['text'] for t in transcript.load_archive(self.sid))

    def test_native_objects_and_large_values_survive_mcp_restart(self):
        argument = '甲' * 2500 + 'ARG_RANDOM_END'
        output = '乙' * 13000 + 'OUT_RANDOM_END'
        native = assistant()['payload']
        native['content'].append({'type': 'tool', 'id': 'call1', 'name': 'SyntheticAudit',
            'state': {'status': 'completed', 'input': {'payload': argument},
                      'content': [{'type': 'text', 'text': output}]}})
        records = [user(), observation(native)]
        self.append(records)
        self.assertEqual([r['entry'] for r in archive.records(self.sid)], records)
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': 'recall_get', 'arguments': {'session_id': self.sid, 'turn': 1, 'length': 50000}}}
        child = subprocess.run([sys.executable, str(PLUGIN / 'mcp_server.py')],
            input=json.dumps(request) + '\n', text=True, capture_output=True,
            env=dict(os.environ), check=True)
        response = json.loads(child.stdout)['result']
        self.assertFalse(response.get('isError'))
        text = response['content'][0]['text']
        self.assertIn(argument, text)
        self.assertIn(output, text)

    def test_duplicates_ignore_observation_clock_and_origin(self):
        record = user()
        self.assertEqual(self.append([record])['appended'], 1)
        duplicate = {**record, 'observed_at': 'a later clock', 'origin': 'snapshot-again'}
        self.assertEqual(self.append([duplicate])['appended'], 0)
        self.assertEqual(len(archive.records(self.sid)), 1)

    def test_late_streaming_value_does_not_replace_final_or_duplicate_text(self):
        partial = assistant('hello')
        partial['payload']['time'].pop('completed')
        final = assistant('hello, full final answer')
        self.append([user(), final, partial])
        self.assertEqual(self.text().count('hello'), 1)
        self.assertIn('full final answer', self.text())
        self.assertEqual(len(archive.records(self.sid)), 3)

    def test_equal_revision_conflicting_values_are_retained_and_labelled(self):
        a, b = assistant('FIRST'), assistant('SECOND')
        a['revision'] = b['revision'] = {'seq': 5, 'version': 1}
        self.append([user(), a, b])
        self.assertIn('FIRST', self.text())
        self.assertIn('SECOND', self.text())
        self.assertTrue(transcript.load_archive(self.sid)[0]['conflicts'])
        before = self.text()
        self.append([b, a])
        self.assertEqual(before, self.text())

    def test_ui_metadata_only_variants_do_not_erase_the_reading_view(self):
        first = assistant('metadata independent text')
        second = copy.deepcopy(first)
        first['payload']['metadata'] = {'progress': 'one'}
        second['payload']['metadata'] = {'progress': 'two'}
        self.append([user(), first, second])
        self.assertEqual(self.text().count('metadata independent text'), 1)
        self.assertEqual(len(archive.records(self.sid)), 3)

    def test_pre_normalization_tool_hook_preserves_full_output(self):
        full = 'RAW' * 5000 + 'PRE_TRUNCATION_END'
        message = assistant()['payload']
        message['content'].append({'type': 'tool', 'id': 'call1', 'name': 'SyntheticAudit',
            'state': {'status': 'completed', 'input': {'payload': 'X' * 2500},
                      'content': [{'type': 'text', 'text': 'HOST BOUNDED VIEW'}]}})
        raw = observation({'sessionID': self.sid, 'messageID': 'msg_002', 'id': 'call1',
            'tool': 'SyntheticAudit', 'input': {'payload': 'X' * 2500}, 'status': 'completed',
            'result': {'content': [{'type': 'text', 'text': full}]}}, 'tool.raw',
            identity={'message_id': 'msg_002', 'tool_call_id': 'call1'})
        self.append([user(), observation(message), raw])
        self.assertIn(full, self.text())
        self.assertNotIn('HOST BOUNDED VIEW', self.text())

    def test_before_admission_prompt_is_pending_until_native_user_exists(self):
        pending = observation({'sessionID': self.sid, 'messageID': 'msg_001',
            'prompt': {'text': 'PENDING_ONLY'}}, 'prompt', identity={'message_id': 'msg_001'})
        self.append([pending])
        self.assertTrue(transcript.load_archive(self.sid)[0]['pending_prompt'])
        self.assertIn('未证实已入宿主对话', self.text())
        self.append([user('PENDING_ONLY')])
        self.assertFalse(transcript.load_archive(self.sid)[0]['pending_prompt'])
        self.assertNotIn('未证实已入宿主对话', self.text())

    def test_raw_tool_observation_is_projected_without_snapshot_cache(self):
        raw = observation({'sessionID': self.sid, 'messageID': 'msg_002', 'id': 'call1',
            'tool': 'Audit', 'input': {'x': 'INPUT_ONLY_RAW'}, 'status': 'completed',
            'result': {'content': [{'type': 'text', 'text': 'OUTPUT_ONLY_RAW'}]}}, 'tool.raw',
            identity={'message_id': 'msg_002', 'tool_call_id': 'call1'})
        self.append([user(), raw])
        self.assertIn('INPUT_ONLY_RAW', self.text())
        self.assertIn('OUTPUT_ONLY_RAW', self.text())

    def test_durable_events_can_rebuild_without_message_snapshot(self):
        def event(name, data, seq):
            return observation({'id': 'evt_' + str(seq), 'type': name,
                'durable': {'aggregateID': self.sid, 'seq': seq, 'version': 1},
                'data': {'sessionID': self.sid, **data}}, 'event')
        records = [event('session.inbox.enqueued', {'inboxID': 'msg_001',
            'item': {'type': 'user', 'payload': {'text': 'EVENT_USER'}}}, 0),
            event('session.text.ended', {'assistantMessageID': 'msg_002', 'ordinal': 0, 'text': 'EVENT_ANSWER'}, 2),
            event('session.tool.input.started', {'assistantMessageID': 'msg_002', 'id': 'call1', 'name': 'Audit'}, 3),
            event('session.tool.input.ended', {'assistantMessageID': 'msg_002', 'id': 'call1', 'text': '{ "raw": "preserved" }'}, 4),
            event('session.tool.success', {'assistantMessageID': 'msg_002', 'id': 'call1', 'content': [{'type': 'text', 'text': 'EVENT_OUTPUT'}]}, 5)]
        self.append(list(reversed(records)))
        self.assertIn('EVENT_USER', self.text())
        self.assertIn('EVENT_ANSWER', self.text())
        self.assertIn('{ "raw": "preserved" }', self.text())
        self.assertIn('EVENT_OUTPUT', self.text())

    def test_raw_facts_recover_after_index_deleted_and_commit_failure(self):
        self.append([user()])
        with patch.object(archive, '_commit_index', side_effect=OSError('synthetic index commit failure')):
            with self.assertRaises(OSError):
                self.append([assistant()])
        (archive.session_dir(self.sid) / 'index.sqlite3').unlink()
        self.assertEqual(self.append([assistant()])['appended'], 0)
        self.assertIn('native answer', self.text())

    def test_fsync_failure_never_returns_success_ack(self):
        request = {'operation': 'append', 'session_id': self.sid, 'project': str(self.project), 'records': [user()]}
        with patch.object(archive.os, 'fsync', side_effect=OSError('synthetic fsync failure')):
            with self.assertRaises(OSError):
                bridge.handle(request)

    def test_parallel_duplicate_append_is_idempotent(self):
        request = json.dumps({'operation': 'append', 'session_id': self.sid,
                              'project': str(self.project), 'records': [user(), assistant()]})
        children = [subprocess.Popen([sys.executable, str(PLUGIN / 'opencode_bridge.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=dict(os.environ)) for _ in range(4)]
        for child in children:
            out, err = child.communicate(request, timeout=20)
            self.assertEqual(child.returncode, 0, err + out)
            self.assertTrue(json.loads(out)['durable'])
        self.assertEqual(len(archive.records(self.sid)), 2)

    def test_session_project_parent_and_payload_isolation(self):
        self.append([user()])
        other = self.root / 'other'
        other.mkdir()
        with self.assertRaises(ValueError):
            archive.append_native(self.sid, str(other), [assistant()])
        with self.assertRaises(ValueError):
            self.append([assistant()], parent_id='ses_parent')
        invalid = user()
        invalid['payload']['sessionID'] = 'ses_other'
        with self.assertRaises(ValueError):
            self.append([invalid])

    def test_child_raw_records_are_not_in_main_reading_view(self):
        self.append([user('CHILD_SECRET')], parent_id='ses_parent')
        self.assertEqual(len(archive.records(self.sid)), 1)
        self.assertEqual(transcript.load_archive(self.sid), [])

    def test_phase_one_index_cannot_let_other_host_claim_existing_session(self):
        source = self.project / (self.sid + '.jsonl')
        source.write_text(json.dumps({'type': 'user', 'sessionId': self.sid, 'uuid': 'cc-user',
            'message': {'content': 'CC_ONLY'}}) + '\n')
        archive.sync(self.sid, str(source))
        import sqlite3
        with sqlite3.connect(archive.session_dir(self.sid) / 'index.sqlite3') as db:
            db.execute("DELETE FROM meta WHERE key='host'")  # phase-one disposable index
        with self.assertRaises(ValueError):
            self.append([user('OPENCODE_OTHER_HOST')])
        self.assertIn('CC_ONLY', self.text())
        self.assertNotIn('OPENCODE_OTHER_HOST', self.text())

    def test_unknown_or_empty_barrier_does_not_claim_ready(self):
        request = {'session_id': self.sid, 'project': str(self.project), 'records': []}
        for operation in ['status', 'barrier']:
            with self.assertRaises(ValueError):
                bridge.handle({**request, 'operation': operation})
        self.append([])
        with self.assertRaises(ValueError):
            bridge.handle({**request, 'operation': 'barrier'})

    def test_unsafe_or_non_json_records_rejected_before_archive(self):
        with self.assertRaises(ValueError):
            archive.append_native('../escape', str(self.project), [user()])
        invalid = user()
        invalid['payload']['number'] = float('nan')
        with self.assertRaises(ValueError):
            self.append([invalid])
        self.assertFalse((archive.session_dir(self.sid) / 'events.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
