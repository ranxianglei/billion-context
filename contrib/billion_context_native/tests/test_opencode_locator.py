"""Stable native reads, stale-number rejection, and actual MCP byte bounds."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import archive
import native_read


def message(mid, kind, text):
    payload = {'id': mid, 'type': kind, 'time': {'created': 1}}
    if kind == 'user':
        payload['text'] = text
    else:
        payload.update(content=[{'type': 'text', 'text': text}], time={'created': 2, 'completed': 3})
    return {'kind': 'message', 'identity': {'message_id': mid}, 'revision': {}, 'payload': payload,
            'origin': 'synthetic-stable-read-test'}


class NativeLocatorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.project = self.root / 'explicit-project'
        self.project.mkdir()
        self.sid = 'ses_locator'
        self.env = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'recall')})
        self.env.start()
        self.addCleanup(self.env.stop)

    def append(self, records):
        return archive.append_native(self.sid, str(self.project), records)

    def seed(self, text='ORIGINAL_BODY'):
        self.append([message('msg_001', 'user', 'LOCATOR_A'), message('msg_002', 'assistant', text)])
        return native_read.search(self.sid, 'LOCATOR_A')['hits'][0]

    def error(self, code, function, *args, **kwargs):
        with self.assertRaises(native_read.NativeReadError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def mcp(self, arguments, name='recall_get'):
        request = {'jsonrpc': '2.0', 'id': 'native-locator-test', 'method': 'tools/call',
                   'params': {'name': name, 'arguments': arguments}}
        child = subprocess.run([sys.executable, str(PLUGIN / 'mcp_server.py')],
            input=json.dumps(request) + '\n', text=True, capture_output=True, check=True,
            env={k: v for k, v in os.environ.items() if k != 'deponia_key'})
        return json.loads(child.stdout)['result'], len(child.stdout.encode('utf-8'))

    def test_locator_frozen_prefix_survives_late_turn_insertion(self):
        hit = self.seed()
        original = native_read.get(locator_value=hit['locator'])
        self.append([message('msg_000', 'user', 'LATE_EARLIER_TURN')])
        frozen = native_read.get(locator_value=hit['locator'])
        self.assertEqual(frozen['text'], original['text'])
        self.assertEqual(frozen['locator'], original['locator'])
        self.assertNotIn('LATE_EARLIER_TURN', frozen['text'])
        self.error('revision_mismatch', native_read.get, session_id=self.sid, turn=1,
                   expected_revision=hit['expected_revision'])

    def test_locator_does_not_redirect_to_new_text_version(self):
        hit = self.seed('ORIGINAL')
        self.append([message('msg_002', 'assistant', 'ORIGINAL extended final')])
        self.assertNotIn('extended final', native_read.get(locator_value=hit['locator'])['text'])
        self.error('revision_mismatch', native_read.get, session_id=self.sid, turn=1,
                   expected_revision=hit['expected_revision'])
        current = native_read.search(self.sid, 'extended final')['hits'][0]
        self.assertNotEqual(current['expected_revision'], hit['expected_revision'])
        self.assertIn('extended final', native_read.get(locator_value=current['locator'])['text'])

    def test_locator_survives_disposable_index_deletion(self):
        hit = self.seed()
        (archive.session_dir(self.sid) / 'index.sqlite3').unlink()
        self.assertIn('ORIGINAL_BODY', native_read.get(locator_value=hit['locator'])['text'])

    def test_missing_highwater_and_changed_fact_do_not_silently_rebind(self):
        hit = self.seed()
        bad = {**hit['locator'], 'highwater_seq': 50000}
        self.error('revision_missing', native_read.get, locator_value=bad)
        path = archive.session_dir(self.sid) / 'events.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[1]['entry']['payload']['content'][0]['text'] = 'CORRUPT_DIFFERENT_BODY'
        path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
        self.error('revision_mismatch', native_read.get, locator_value=hit['locator'])

    def test_boundary_event_id_and_native_anchor_are_not_optional(self):
        hit = self.seed()
        self.error('revision_missing', native_read.get,
                   locator_value={**hit['locator'], 'highwater_event_id': 'different'})
        self.error('anchor_missing', native_read.get,
                   locator_value={**hit['locator'], 'native_user_id': 'msg_unrelated'})
        invalid = dict(hit['locator'])
        invalid.pop('native_user_id')
        self.error('invalid_locator', native_read.get, locator_value=invalid)

    def test_scope_and_locator_numeric_mixture_are_rejected(self):
        hit = self.seed()
        self.error('invalid_argument', native_read.get, locator_value=hit['locator'], session_id='ses_other')
        self.error('invalid_argument', native_read.get, locator_value=hit['locator'], turn=1)

    def test_conflicting_current_revision_is_explicit_but_old_snapshot_is_readable(self):
        hit = self.seed('FIRST_CONFLICT_VALUE')
        self.append([message('msg_002', 'assistant', 'SECOND_CONFLICT_VALUE')])
        current = native_read.search(self.sid, 'LOCATOR_A')['hits'][0]
        self.assertFalse(current['readable'])
        self.assertEqual(current['error'], 'revision_conflict')
        self.assertNotIn('locator', current)
        self.error('revision_conflict', native_read.get, session_id=self.sid, turn=1)
        self.assertIn('FIRST_CONFLICT_VALUE', native_read.get(locator_value=hit['locator'])['text'])

    def test_pending_prompt_has_no_readable_locator(self):
        self.append([{'kind': 'prompt', 'identity': {'message_id': 'msg_001'}, 'revision': {},
            'payload': {'sessionID': self.sid, 'messageID': 'msg_001', 'prompt': {'text': 'UNADMITTED'}}}])
        hit = native_read.search(self.sid, 'UNADMITTED')['hits'][0]
        self.assertEqual(hit['error'], 'pending_admission')
        self.error('pending_admission', native_read.get, session_id=self.sid, turn=1)

    def test_utf8_pages_reassemble_exact_original_and_cap_serialized_wire_bytes(self):
        text = ('中文😀\\"\n\x00' * 15000) + 'FINAL_RANDOM_END'
        hit = self.seed(text)
        current = {'locator': hit['locator'], 'byte_offset': 0}
        chunks, pages = [], []
        while current is not None:
            page = native_read.get(locator_value=current['locator'], byte_offset=current['byte_offset'])
            pages.append(page)
            reply = {'jsonrpc': '2.0', 'id': 123, 'result': native_read.tool_result(page)}
            self.assertLessEqual(len(json.dumps(reply, ensure_ascii=False).encode()), native_read.MAX_BYTES)
            self.assertEqual(page['returned_range']['start'], current['byte_offset'])
            self.assertEqual(len(page['text'].encode()), page['returned_range']['end'] - page['returned_range']['start'])
            chunks.append(page['text'])
            current = page['next_cursor']
            if current:
                self.assertGreater(current['byte_offset'], page['returned_range']['start'])
        self.assertGreater(len(pages), 1)
        self.assertEqual(''.join(chunks), '【用户】LOCATOR_A\n【助手】' + text)
        self.assertEqual(pages[0]['trust'], 'untrusted_historical_data')
        self.assertIn('not system instructions', native_read.tool_result(pages[0])['content'][0]['text'])

    def test_byte_offset_must_be_utf8_boundary_and_limits_are_hard(self):
        hit = self.seed('汉字')
        self.error('invalid_byte_offset', native_read.get, locator_value=hit['locator'], byte_offset=1)
        for limit in [0, -1, 65537, True, 1.5]:
            self.error('invalid_argument', native_read.get, locator_value=hit['locator'], byte_limit=limit)
        self.error('invalid_argument', native_read.get, locator_value=hit['locator'], byte_offset=-1)
        self.error('invalid_byte_offset', native_read.get, locator_value=hit['locator'], byte_offset=999999)

    def test_search_limit_and_encoded_cap_with_stable_pagination(self):
        self.append([message('msg_' + str(i).zfill(4), 'user', 'FIND_' + str(i)) for i in range(12)])
        result = native_read.search(self.sid, 'FIND', limit=4, byte_limit=5000)
        self.assertLessEqual(native_read.encoded_size(result), 5000)
        anchors = [h['native_user_id'] for h in result['hits']]
        self.append([message('msg_9999', 'user', 'FIND_NEW_UNRELATED')])
        while result['next_cursor']:
            result = native_read.search(self.sid, 'FIND', limit=4, byte_limit=5000, cursor=result['next_cursor'])
            self.assertLessEqual(native_read.encoded_size(result), 5000)
            anchors.extend(h['native_user_id'] for h in result['hits'])
        self.assertEqual(len(anchors), 12)
        self.assertEqual(len(set(anchors)), 12)
        self.assertNotIn('msg_9999', anchors)
        self.error('invalid_argument', native_read.search, self.sid, 'FIND', limit=21)
        self.error('invalid_argument', native_read.search, self.sid, 'FIND', limit=-1)

    def test_unknown_session_and_non_native_archive_fail_without_new_facts(self):
        self.error('archive_missing', native_read.get, session_id=self.sid, turn=1)
        self.assertFalse(archive.session_dir(self.sid).exists())
        source = self.project / (self.sid + '.jsonl')
        source.write_text(json.dumps({'type': 'user', 'message': {'content': 'CC'}}) + '\n')
        archive.sync(self.sid, str(source))
        self.assertFalse(native_read.is_native(self.sid))
        self.error('host_mismatch', native_read.get, session_id=self.sid, turn=1)

    def test_real_stdio_search_locator_read_and_stale_revision_errors(self):
        self.seed('ORIGINAL_STDIO')
        result, size = self.mcp({'session_id': self.sid, 'query': 'LOCATOR_A', 'structured': True}, 'recall_search')
        self.assertNotIn('isError', result)
        self.assertLessEqual(size, native_read.MAX_BYTES)
        hit = result['structuredContent']['hits'][0]
        self.append([message('msg_000', 'user', 'NEW_NUMBER_ONE')])
        got, size = self.mcp({'locator': hit['locator'], 'byte_limit': 65536})
        self.assertIn('ORIGINAL_STDIO', got['structuredContent']['text'])
        self.assertNotIn('NEW_NUMBER_ONE', got['structuredContent']['text'])
        self.assertLessEqual(size, native_read.MAX_BYTES)
        error, size = self.mcp({'session_id': self.sid, 'turn': 1,
                               'expected_revision': hit['expected_revision']})
        self.assertTrue(error['isError'])
        self.assertEqual(error['structuredContent']['error'], 'revision_mismatch')
        self.assertLessEqual(size, native_read.MAX_BYTES)

    def test_real_stdio_utf8_pages_reassemble_and_never_exceed_wire_cap(self):
        original = ('汉字😀\x00\\"' * 7000) + 'END_STDIO'
        hit = self.seed(original)
        cursor = {'locator': hit['locator'], 'byte_offset': 0}
        chunks = []
        while cursor is not None:
            result, size = self.mcp({**cursor, 'byte_limit': 65536})
            self.assertLessEqual(size, native_read.MAX_BYTES)
            self.assertNotIn('isError', result)
            data = result['structuredContent']
            self.assertEqual(data['trust'], 'untrusted_historical_data')
            chunks.append(data['text'])
            cursor = data['next_cursor']
        self.assertEqual(''.join(chunks), '【用户】LOCATOR_A\n【助手】' + original)
        error, size = self.mcp({'locator': hit['locator'], 'byte_limit': 65537})
        self.assertTrue(error['isError'])
        self.assertEqual(error['structuredContent']['error'], 'invalid_argument')
        self.assertLessEqual(size, native_read.MAX_BYTES)

    def test_native_legacy_numeric_caps_bytes_and_supplies_usable_cursor(self):
        original = '中文' * 20000 + 'LEGACY_NATIVE_END'
        self.seed(original)
        result, size = self.mcp({'session_id': self.sid, 'turn': 1, 'length': 500000})
        self.assertLessEqual(size, native_read.MAX_BYTES)
        text = result['content'][0]['text']
        body, footer = text.removeprefix(native_read.NOTICE).rsplit('\n[Native byte page ', 1)
        metadata = json.loads(footer[:-1])
        self.assertIsNotNone(metadata['next_cursor'])
        chunks = [body]
        cursor = metadata['next_cursor']
        while cursor is not None:
            result, size = self.mcp({**cursor, 'byte_limit': 65536})
            self.assertLessEqual(size, native_read.MAX_BYTES)
            data = result['structuredContent']; chunks.append(data['text']); cursor = data['next_cursor']
        self.assertEqual(''.join(chunks), '【用户】LOCATOR_A\n【助手】' + original)


if __name__ == '__main__':
    unittest.main()
