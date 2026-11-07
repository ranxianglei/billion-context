"""Synthetic DSH events exercise shared archive integrity and stable retrieval."""
import copy
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'))
import archive
import dsh_bridge
import native_read


class DshNativeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.project = str(self.root.resolve())
        self.sid = 'dsh-synthetic-one'
        env = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'recall')})
        env.start(); self.addCleanup(env.stop)
        self.raw = 'ORION_DSH\n' + ('星河 Ω café \"quoted\"\t\u0001\n' * 1800) + 'COMPLETE_PROOF_END'
        self.events = [
            {'type': 'turn/start', 'seq': 0, 'time': 100, 'data': {'turn': 1}},
            {'type': 'user/message', 'seq': 1, 'time': 101, 'surfaceOp': 'append', 'data': {'id': 'u1', 'role': 'user', 'source': {'kind': 'user'}, 'content': [{'type': 'text', 'text': 'Read synthetic fixture'}]}},
            {'type': 'tool/call', 'seq': 2, 'time': 102, 'data': {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'fixture', 'arguments': '{"long":"' + 'a' * 3000 + '"}'}},
            {'type': 'tool/result', 'seq': 3, 'time': 103, 'surfaceOp': 'append', 'data': {'turn': 1, 'step': 1, 'message': {'toolCallId': 'c1', 'content': [{'type': 'text', 'text': self.raw}], 'isError': False}}},
            {'type': 'turn/end', 'seq': 4, 'time': 104, 'data': {'turn': 1, 'reason': {'kind': 'completed'}}},
        ]

    def append(self, events=None, origin='host_live_event', **extra):
        return dsh_bridge.handle({'operation': 'append', 'session_id': self.sid, 'project': self.project,
            'records': [{'kind': 'event', 'payload': e, 'identity': {'native_seq': e['seq']},
                         'revision': {'seq': e['seq'], 'session_format': 4}, 'origin': origin} for e in (self.events if events is None else events)], **extra})

    def search(self):
        return dsh_bridge.handle({'operation': 'search', 'session_id': self.sid, 'arguments': {'query': 'ORION_DSH'}})['result']

    def get(self, loc, **args):
        return dsh_bridge.handle({'operation': 'get', 'session_id': self.sid, 'arguments': {'locator': loc, **args}})['result']

    def test_native_payload_and_long_tool_input_are_preserved(self):
        self.append()
        self.assertEqual([r['entry']['payload'] for r in archive.records(self.sid)], self.events)

    def test_full_utf8_pages_match_raw_tool_bytes(self):
        self.append(); hit = self.search()['hits'][0]; loc = hit['locator']
        out = b''; off = 0
        while True:
            page = self.get(loc, byte_offset=off, byte_limit=10000)
            raw = page['text'].encode(); self.assertEqual(page['returned_range']['start'], off)
            self.assertEqual(page['returned_range']['end'] - off, len(raw))
            self.assertLessEqual(native_read.encoded_size(page), native_read.MAX_BYTES - native_read.WIRE_RESERVE)
            out += raw; off = page['returned_range']['end']
            if page['next_cursor'] is None: break
        value = json.loads(out)
        self.assertEqual(value['events'][3]['event']['data']['message']['content'][0]['text'].encode(), self.raw.encode())

    def test_compaction_replacement_does_not_remove_original(self):
        self.append(); loc = self.search()['hits'][0]['locator']; before = self.get(loc)['text']
        self.append([{'type': 'user/message', 'seq': 5, 'time': 105, 'surfaceOp': {'op': 'replace', 'startSeq': 1, 'endSeq': 3}, 'data': {'content': [{'type': 'text', 'text': 'short summary'}]}}])
        self.assertEqual(self.get(loc)['text'], before)
        self.assertEqual(self.search()['hits'][0]['locator']['text_sha256'], loc['text_sha256'])

    def test_index_rebuild_keeps_host_and_old_locator(self):
        self.append(); loc = self.search()['hits'][0]['locator']
        (archive.session_dir(self.sid) / 'index.sqlite3').unlink()
        self.append(); self.assertEqual(self.get(loc)['locator']['host'], 'dsh')
        self.assertEqual(len(archive.records(self.sid)), 5)

    def test_snapshot_deduplicates_live_records_without_relabelling_origin(self):
        self.append(); self.append(origin='host_agent_snapshot')
        self.assertEqual(len(archive.records(self.sid)), 5)
        self.assertTrue(all(r['source']['origin'] == 'host_live_event' for r in archive.records(self.sid)))

    def test_resume_snapshot_origin_is_not_claimed_as_physical_log(self):
        self.append(origin='host_agent_snapshot')
        self.assertEqual(archive.records(self.sid)[0]['source']['origin'], 'host_agent_snapshot')

    def test_same_seq_conflict_blocks_new_locator_but_old_prefix_remains(self):
        self.append(); loc = self.search()['hits'][0]['locator']
        changed = copy.deepcopy(self.events[3]); changed['data']['message']['content'][0]['text'] = 'ORION_DSH changed'
        self.append([changed])
        self.assertFalse(self.search()['hits'][0]['readable'])
        self.assertIn('ORION_DSH', self.get(loc)['text'])

    def test_cross_session_locator_is_rejected(self):
        self.append(); loc = self.search()['hits'][0]['locator']; loc['session_id'] = 'different-session'
        with self.assertRaises(ValueError): self.get(loc)

    def test_cross_host_locator_is_rejected(self):
        self.append(); loc = self.search()['hits'][0]['locator']; loc['host'] = 'opencode'
        with self.assertRaises(ValueError): self.get(loc)

    def test_archive_cannot_be_rebound_to_different_host(self):
        self.append()
        with self.assertRaises(ValueError): archive.append_native(self.sid, self.project, [], host='opencode')

    def test_archive_cannot_be_rebound_to_different_project(self):
        self.append()
        with self.assertRaises(ValueError): archive.append_native(self.sid, '/', [], host='dsh')

    def test_invalid_native_seq_is_rejected(self):
        rows = copy.deepcopy(self.events); rows[0]['seq'] = True
        with self.assertRaises(ValueError): self.append(rows)

    def test_unknown_event_fields_are_preserved(self):
        rows = copy.deepcopy(self.events); rows.insert(4, {'type': 'future/ignorable', 'seq': 5, 'time': 103, 'data': {'deep': {'binary_ref': 'reference-only'}}, 'ignorable': True})
        self.append(rows)
        self.assertEqual(archive.records(self.sid)[4]['entry']['payload']['data'], rows[4]['data'])

    def test_missing_archive_is_not_success(self):
        with self.assertRaises(ValueError): self.search()
