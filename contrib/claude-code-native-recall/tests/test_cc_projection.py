"""Synthetic CC projection and successful-call state regression checks."""
import copy
import json
import os
import pathlib
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'recall'))
import archive
import transcript as tr
import store


class CCProjectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cc-projection-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.project = self.root / 'transcript-project'; self.project.mkdir()
        self.sid = 'cc-projection-synthetic'
        self.source = self.project / (self.sid + '.jsonl')
        self.env = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'archive')})
        self.env.start(); self.addCleanup(self.env.stop)

    def user(self, uuid='u1', text='synthetic question'):
        return {'type': 'user', 'uuid': uuid, 'sessionId': self.sid,
                'message': {'role': 'user', 'content': text}}

    def call(self, cid='call1', name='test__compact_ready', inp=None, uuid='a1'):
        return {'type': 'assistant', 'uuid': uuid, 'sessionId': self.sid,
                'message': {'role': 'assistant', 'content': [
                    {'type': 'tool_use', 'id': cid, 'name': name,
                     'input': inp if inp is not None else {'summary': 'synthetic valid summary'}}]}}

    def result(self, cid='call1', content='observed result', error=None, uuid='r1'):
        block = {'type': 'tool_result', 'tool_use_id': cid, 'content': content}
        if error is not None: block['is_error'] = error
        return {'type': 'user', 'uuid': uuid, 'sessionId': self.sid,
                'message': {'role': 'user', 'content': [block]}}

    def write(self, rows):
        self.source.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')
        return archive.sync(self.sid, str(self.source))

    def hook(self, event='PostToolUse', **data):
        return archive.append_cc_hook(self.sid, str(self.source), event,
            {'session_id': self.sid, 'transcript_path': str(self.source),
             'hook_event_name': event, **data})

    def test_hook_before_source_is_durable_but_unanchored_until_unique_native_call(self):
        output = 'O' * 12501 + 'HIDDEN_OUTPUT_PROOF'
        inp = {'payload': 'I' * 2301 + 'HIDDEN_INPUT_PROOF'}
        ack = self.hook(tool_use_id='call1', tool_name='Synthetic', tool_input=inp,
                        tool_response=output, cwd='/must-not-bind', env={'FAKE': 'must-not-store'})
        self.assertTrue(ack['durable']); self.assertFalse(ack['source_was_read'])
        fact = archive.records(self.sid)[0]
        self.assertEqual(fact['identity']['project'], str(self.project))
        self.assertEqual(fact['identity']['branch'], 'hook-observation')
        self.assertNotIn('uuid', fact['entry']); self.assertNotIn('env', fact['entry']['data'])
        self.assertNotIn('cwd', fact['entry']['data'])
        self.assertEqual(tr.load_archive(self.sid), [])
        self.write([self.user(), self.call(name='Synthetic', inp=inp)])
        turn = tr.load_archive(self.sid)[0]
        self.assertIn(output, turn['text']); self.assertIn(fact['event_id'], turn['event_ids'])
        self.assertEqual(turn['tools']['Synthetic'], 1)
        self.assertEqual(turn['tool_status']['call1']['status'], 'completed')
        again = self.hook(tool_use_id='call1', tool_name='Synthetic', tool_input=inp,
                          tool_response=output, cwd='/different-ignored')
        self.assertEqual(again['appended'], 0)

    def test_stop_without_message_id_stays_raw_observation_not_guessed_answer(self):
        self.write([self.user(), self.call()])
        before = tr.load_archive(self.sid)[0]['text']
        self.hook('Stop', last_assistant_message='UNANCHORED_STOP_ONLY')
        self.hook('Stop', last_assistant_message='UNANCHORED_STOP_ONLY')
        after = tr.load_archive(self.sid)[0]
        self.assertEqual(before, after['text'])
        self.assertNotIn('UNANCHORED_STOP_ONLY', after['text'])
        stops = [r for r in archive.records(self.sid) if r['entry'].get('hook_event_name') == 'Stop']
        self.assertEqual(len(stops), 2)
        self.assertTrue(all('uuid' not in r['entry'] for r in stops))

    def test_hook_identity_collision_does_not_pick_latest_owner(self):
        self.write([self.user('u1', 'first'), self.call(uuid='a1'),
                    self.user('u2', 'second'), self.call(uuid='a2')])
        self.hook(tool_use_id='call1', tool_response='MUST_NOT_ASSIGN_TO_LATEST')
        turns = tr.load_archive(self.sid)
        self.assertTrue(all(t['projection_status'] == 'conflict' for t in turns))
        self.assertTrue(all('MUST_NOT_ASSIGN_TO_LATEST' not in t['text'] for t in turns))
        self.assertFalse(tr.ready_since_boundary(archive.entries(self.sid), sid=self.sid))

    def test_hook_binding_survives_index_rebuild_and_rejects_foreign_project_host(self):
        self.hook(tool_use_id='call1', tool_response='local result')
        directory = archive.session_dir(self.sid)
        before = (directory / 'events.jsonl').read_bytes()
        (directory / 'index.sqlite3').unlink()
        foreign = self.root / 'foreign'; foreign.mkdir()
        with self.assertRaises(ValueError):
            archive.append_cc_hook(self.sid, str(foreign / self.source.name), 'PostToolUse', {'tool_use_id': 'call1'})
        with self.assertRaises(ValueError):
            archive.append_native(self.sid, str(self.project), [])
        self.assertEqual((directory / 'events.jsonl').read_bytes(), before)

    def test_streaming_prefix_final_is_single_projection_and_raw_facts_unchanged(self):
        partial = {'type': 'assistant', 'uuid': 'a1', 'message': {'role': 'assistant', 'content': 'PREFIX'}}
        final = copy.deepcopy(partial); final['message'].update(content='PREFIX_COMPLETE', stop_reason='end_turn')
        self.write([self.user(), partial, final])
        facts = archive.records(self.sid)
        turn = tr.load_archive(self.sid)[0]
        self.assertEqual(turn['projection_status'], 'completed')
        self.assertEqual(turn['text'].count('PREFIX_COMPLETE'), 1)
        self.assertNotIn('【助手】PREFIX\n', turn['text'])
        self.assertEqual([r['entry'] for r in facts], [self.user(), partial, final])
        incompatible = copy.deepcopy(final); incompatible['message']['content'] = 'OTHER_TERMINAL_VALUE'
        with self.source.open('a') as stream: stream.write(json.dumps(incompatible) + '\n')
        archive.sync(self.sid, str(self.source))
        conflict = tr.load_archive(self.sid)[0]
        self.assertEqual(conflict['projection_status'], 'conflict')
        self.assertIn('PREFIX_COMPLETE', conflict['text']); self.assertIn('OTHER_TERMINAL_VALUE', conflict['text'])

    def test_unknown_message_shape_does_not_erase_other_history(self):
        self.write([self.user(), {'type': 'assistant', 'uuid': 'opaque', 'message': 'host-extension'}])
        turn = tr.load_archive(self.sid)[0]
        self.assertEqual(turn['projection_status'], 'unknown')
        self.assertIn('host-extension', turn['text'])

    def test_sync_ack_hash_identifies_only_acknowledged_complete_source_prefix(self):
        self.write([self.user()])
        with self.source.open('a') as stream: stream.write('{"unfinished":')
        ack = archive.sync(self.sid, str(self.source))
        import hashlib
        prefix = self.source.read_bytes()[:ack['offset']]
        self.assertEqual(ack['source_digest'], hashlib.sha256(prefix).hexdigest())
        self.assertEqual(ack['inode'], self.source.stat().st_ino)
        self.assertEqual(ack['completeness'], 'durable_complete_source_prefix_only')
        self.assertIsNotNone(ack['deferred'])

    def test_ready_and_summary_need_success_not_attempt_or_failure(self):
        rows = [self.user(), self.call()]
        self.write(rows)
        self.assertFalse(tr.ready_since_boundary(rows, sid=self.sid))
        self.assertEqual(store.save_summary(self.sid, rows, tr.load_archive(self.sid)), [])
        rows.append(self.result(error=True)); self.write(rows)
        self.assertFalse(tr.ready_since_boundary(rows, sid=self.sid))
        self.assertEqual(store.save_summary(self.sid, rows, tr.load_archive(self.sid)), [])
        success = [self.user(), self.call(cid='good', uuid='a2'), self.result(cid='good', uuid='r2')]
        self.write(success)
        self.assertTrue(tr.ready_since_boundary(success, sid=self.sid))
        self.assertTrue(store.save_summary(self.sid, success, tr.load_archive(self.sid)))

    def test_direct_hook_success_can_prove_known_call_but_conflicting_results_cannot(self):
        rows = [self.user(), self.call()]; self.write(rows)
        self.hook(tool_use_id='call1', tool_input=rows[1]['message']['content'][0]['input'], tool_response='recorded')
        self.assertTrue(tr.ready_since_boundary(rows, sid=self.sid))
        self.hook(tool_use_id='call1', tool_input=rows[1]['message']['content'][0]['input'], tool_response='different completed result')
        self.assertFalse(tr.ready_since_boundary(rows, sid=self.sid))
        self.assertEqual(tr.load_archive(self.sid)[0]['projection_status'], 'conflict')

    def test_rules_and_todos_ignore_failed_unknown_updates(self):
        rows = [self.user(), self.call('rule-good', 'x__recall_rule', {'text': 'keep good'}, 'a-good'),
                self.result('rule-good', error=False, uuid='r-good'),
                self.call('rule-failed', 'x__recall_rule', {'text': 'do not save failed'}, 'a-bad'),
                self.result('rule-failed', error=True, uuid='r-bad'),
                self.call('todo-good', 'TodoWrite', {'todos': [{'content': 'known todo', 'status': 'pending'}]}, 'a-todo'),
                self.result('todo-good', error=False, uuid='r-todo'),
                self.call('todo-unknown', 'TodoWrite', {'todos': [{'content': 'unknown todo', 'status': 'completed'}]}, 'a-unknown')]
        self.write(rows)
        self.assertEqual(store.save_rules(self.sid, rows), 1)
        self.assertEqual(store.load_rules(self.sid)[0]['text'], 'keep good')
        self.assertEqual(store.latest_todos(rows, sid=self.sid), [{'content': 'known todo', 'status': 'pending'}])

    def test_successful_call_without_message_uuid_reconciles_same_archived_record(self):
        call = self.call(); call.pop('uuid')
        rows = [self.user(), call, self.result()]
        self.write(rows)
        self.assertTrue(tr.ready_since_boundary(rows, sid=self.sid))
        self.assertEqual(tr.tool_outcomes(rows, sid=self.sid)['call1']['status'], 'completed')

    def test_task_updates_require_a_success_result(self):
        rows = [self.user(), self.call('create', 'TaskCreate', {'subject': 'known task'}, 'a-create'),
                self.result('create', 'Task #7 created', uuid='r-create'),
                self.call('bad-update', 'TaskUpdate', {'taskId': '7', 'status': 'completed'}, 'a-update'),
                self.result('bad-update', 'update failed', error=True, uuid='r-update'),
                self.call('unknown-update', 'TaskUpdate', {'taskId': '7', 'status': 'deleted'}, 'a-unknown')]
        self.write(rows)
        self.assertEqual(store.latest_todos(rows, sid=self.sid), [{'content': 'known task', 'status': 'pending'}])

    def test_concurrent_identifierless_observations_are_distinct_durable_receipts(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            acks = list(pool.map(lambda _: self.hook('Stop', last_assistant_message='same text'), range(8)))
        self.assertTrue(all(a['durable'] for a in acks))
        rows = archive.records(self.sid)
        self.assertEqual(len(rows), 8); self.assertEqual(len({r['event_id'] for r in rows}), 8)
        self.assertEqual(tr.load_archive(self.sid), [])


if __name__ == '__main__': unittest.main()
