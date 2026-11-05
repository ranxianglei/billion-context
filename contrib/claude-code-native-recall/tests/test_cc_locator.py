"""Explicit CC stable reads over real append-only facts, with legacy opt-out."""
import copy
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'recall'
sys.path.insert(0, str(PLUGIN))
import archive
import native_read
import transcript


class CCLocatorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.project = self.root / 'synthetic-project'
        self.project.mkdir()
        self.sid = 'cc-synthetic-locator'
        self.sources = self.root / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(self.project))
        self.sources.mkdir(parents=True)
        self.source = self.sources / (self.sid + '.jsonl')
        self.env = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'recall'),
            'RECALL_PROJECTS': str(self.root / 'projects'), 'CLAUDE_PROJECT_DIR': str(self.project)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def user(self, text='CC_LOCATOR_QUERY', uuid='cc-native-user'):
        row = {'type': 'user', 'sessionId': self.sid, 'timestamp': '2026-11-02T00:00:00Z',
               'message': {'role': 'user', 'content': text}}
        if uuid is not None:
            row['uuid'] = uuid
        return row

    def assistant(self, text='CC_ORIGINAL_ANSWER', uuid='cc-native-assistant'):
        row = {'type': 'assistant', 'sessionId': self.sid, 'timestamp': '2026-11-02T00:00:01Z',
               'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn'}}
        if uuid is not None:
            row['uuid'] = uuid
        return row

    def sync(self, rows, append=False):
        with self.source.open('a' if append else 'w') as output:
            output.write(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
        transcript.write_archive(self.sid, str(self.source))

    def search(self, query='CC_LOCATOR_QUERY', **options):
        return native_read.search(self.sid, query, host='claude-code', **options)

    def mcp(self, name, args):
        req = {'jsonrpc': '2.0', 'id': 'cc-synthetic', 'method': 'tools/call',
               'params': {'name': name, 'arguments': args}}
        child = subprocess.run([sys.executable, str(PLUGIN / 'mcp_server.py')],
            input=json.dumps(req) + '\n', text=True, capture_output=True, check=True,
            env={key: value for key, value in os.environ.items() if key != 'deponia_key'})
        return json.loads(child.stdout)['result'], len(child.stdout.encode('utf-8'))

    def assert_error(self, code, function, **args):
        with self.assertRaises(native_read.NativeReadError) as caught:
            function(**args)
        self.assertEqual(caught.exception.code, code)

    def test_uuid_locator_uses_original_prefix_after_source_rewrite_and_index_loss(self):
        self.sync([self.user(), self.assistant()])
        hit = self.search()['hits'][0]
        reference = hit['locator']
        self.assertEqual(reference['host'], 'claude-code')
        self.assertEqual(reference['anchor_kind'], 'cc_user_uuid')
        self.assertEqual(reference['anchor_id'], 'cc-native-user')
        self.assertNotIn('path', json.dumps(reference))
        self.assertNotIn(str(self.project), json.dumps(reference))
        original = native_read.get(locator_value=reference)['text']
        self.sync([self.user('REPLACEMENT_USER', 'different-user'), self.assistant('REPLACEMENT_ANSWER', 'different-assistant')])
        (archive.session_dir(self.sid) / 'index.sqlite3').unlink()
        self.source.unlink()
        reread = native_read.get(locator_value=reference)
        self.assertEqual(reread['text'], original)
        self.assertNotIn('REPLACEMENT', reread['text'])
        self.assertEqual(reread['host_completion'], 'not_asserted')

    def test_no_uuid_uses_real_archived_turn_id_without_inventing_native_identity(self):
        self.sync([self.user(uuid=None), self.assistant(uuid=None)])
        hit = self.search()['hits'][0]
        reference = hit['locator']
        starts = [r for r in archive.records(self.sid) if r['entry'].get('type') == 'user']
        self.assertEqual(reference['anchor_kind'], 'archive_turn_id')
        self.assertEqual(reference['anchor_id'], starts[0]['source']['turn_id'])
        self.assertNotIn('native_user_id', reference)
        self.assertIn('CC_ORIGINAL_ANSWER', native_read.get(locator_value=reference)['text'])

    def test_current_numeric_revision_rejects_new_content_but_old_locator_is_fixed(self):
        self.sync([self.user(), self.assistant()])
        hit = self.search()['hits'][0]
        self.sync([self.assistant('LATE_FOLLOWUP', 'another-assistant')], append=True)
        self.assert_error('revision_mismatch', native_read.get, session_id=self.sid, turn=1,
                          expected_revision=hit['expected_revision'], host='claude-code')
        self.assertNotIn('LATE_FOLLOWUP', native_read.get(locator_value=hit['locator'])['text'])

    def test_incomplete_jsonl_tail_is_not_part_of_fixed_original(self):
        self.sync([self.user()])
        before = self.search()['hits'][0]
        suffix = json.dumps(self.assistant('ONLY_AFTER_NEWLINE'), ensure_ascii=False)
        with self.source.open('a') as stream:
            stream.write(suffix)
        transcript.write_archive(self.sid, str(self.source))
        self.assertEqual(self.search()['hits'][0]['expected_revision'], before['expected_revision'])
        with self.source.open('a') as stream:
            stream.write('\n')
        transcript.write_archive(self.sid, str(self.source))
        self.assertNotIn('ONLY_AFTER_NEWLINE', native_read.get(locator_value=before['locator'])['text'])
        self.assertNotEqual(self.search()['hits'][0]['expected_revision'], before['expected_revision'])

    def test_legacy_only_turn_has_no_fabricated_stable_anchor(self):
        directory = archive.session_dir(self.sid)
        directory.mkdir(parents=True)
        (directory / 'turns.jsonl').write_text(json.dumps({'n': 1, 'text': 'LEGACY_ONLY', 'user': 'LEGACY_ONLY', 'ts': ''}) + '\n')
        self.sync([])
        hit = self.search('LEGACY_ONLY')['hits'][0]
        self.assertFalse(hit['readable'])
        self.assertEqual(hit['error'], 'anchor_missing')
        self.assertNotIn('locator', hit)
        self.assert_error('anchor_missing', native_read.get, session_id=self.sid, turn=1, host='claude-code')

    def test_cc_locator_cannot_claim_opencode_host_or_child_branch(self):
        self.sync([self.user(), self.assistant()])
        reference = self.search()['hits'][0]['locator']
        self.assert_error('host_mismatch', native_read.get, locator_value=reference, host='opencode')
        self.assert_error('invalid_locator', native_read.get, locator_value={**reference, 'branch': 'child'})
        forged = {'version': 1, 'host': 'opencode', 'session_id': self.sid,
            'native_user_id': reference['anchor_id'], 'highwater_seq': reference['highwater_seq'],
            'highwater_event_id': reference['highwater_event_id'], 'text_sha256': reference['text_sha256']}
        self.assert_error('host_mismatch', native_read.get, locator_value=forged)

    def test_cc_sidechain_never_enters_structured_main_read(self):
        child = self.assistant('CHILD_PRIVATE_MARKER', 'child-assistant')
        child.update(isSidechain=True, agentId='child')
        self.sync([self.user(), self.assistant(), child])
        hit = self.search()['hits'][0]
        self.assertNotIn('CHILD_PRIVATE_MARKER', native_read.get(locator_value=hit['locator'])['text'])
        self.assertEqual(self.search('CHILD_PRIVATE_MARKER')['hits'], [])

    def test_stdio_cc_structured_pages_are_low_trust_bounded_and_reassemble(self):
        original = ('中文😀\x00\\"' * 8000) + 'CC_END_MARKER'
        self.sync([self.user(), self.assistant(original)])
        searched, size = self.mcp('recall_search', {'session_id': self.sid, 'query': 'CC_LOCATOR_QUERY', 'structured': True})
        self.assertLessEqual(size, native_read.MAX_BYTES)
        hit = searched['structuredContent']['hits'][0]
        cursor = {'locator': hit['locator'], 'byte_offset': 0}
        chunks = []
        while cursor is not None:
            result, size = self.mcp('recall_get', {**cursor, 'byte_limit': 65536})
            self.assertNotIn('isError', result)
            self.assertLessEqual(size, native_read.MAX_BYTES)
            page = result['structuredContent']
            self.assertEqual(page['host'], 'claude-code')
            self.assertEqual(page['trust'], 'untrusted_historical_data')
            self.assertEqual(page['projection_status'], 'completed')
            self.assertEqual(page['completeness'], 'observed_terminal_marker')
            self.assertEqual(page['host_completion'], 'not_asserted')
            self.assertEqual(page['returned_range']['start'], cursor['byte_offset'])
            self.assertEqual(len(page['text'].encode()), page['returned_range']['end'] - page['returned_range']['start'])
            chunks.append(page['text'])
            cursor = page['next_cursor']
        self.assertEqual(''.join(chunks), '【用户】CC_LOCATOR_QUERY\n'
            '【助手观察状态 completed；observed_stop_reason:end_turn】\n【助手】' + original)

    def test_legacy_text_is_unchanged_while_explicit_bytes_and_revision_are_enabled(self):
        original = '汉' * 27000 + 'LEGACY_CC_END'
        self.sync([self.user(), self.assistant(original)])
        legacy, size = self.mcp('recall_get', {'session_id': self.sid, 'turn': 1, 'length': 60000})
        self.assertIn(original, legacy['content'][0]['text'])
        self.assertNotIn('structuredContent', legacy)
        self.assertNotIn(native_read.NOTICE, legacy['content'][0]['text'])
        self.assertGreater(size, native_read.MAX_BYTES)  # explicitly preserved old CC protocol
        structured, size = self.mcp('recall_get', {'session_id': self.sid, 'turn': 1,
            'structured': True, 'byte_limit': 65536})
        self.assertLessEqual(size, native_read.MAX_BYTES)
        self.assertIsNotNone(structured['structuredContent']['next_cursor'])
        wrong, _ = self.mcp('recall_get', {'session_id': self.sid, 'turn': 1, 'expected_revision': 'wrong'})
        self.assertEqual(wrong['structuredContent']['error'], 'revision_mismatch')

    def test_structured_stdio_requires_explicit_session_instead_of_default_discovery(self):
        self.sync([self.user(), self.assistant()])
        search, _ = self.mcp('recall_search', {'query': 'CC_LOCATOR_QUERY', 'structured': True})
        self.assertEqual(search['structuredContent']['error'], 'explicit_session_required')
        get, _ = self.mcp('recall_get', {'turn': 1, 'byte_limit': 8000})
        self.assertEqual(get['structuredContent']['error'], 'explicit_session_required')

    def test_compact_ready_reply_does_not_claim_durable_write_or_host_compaction(self):
        result, _ = self.mcp('compact_ready', {'summary': 'synthetic readiness request'})
        self.assertNotIn('isError', result)
        text = result['content'][0]['text']
        self.assertIn('已收到就绪请求', text)
        self.assertIn('不是耐久归档确认', text)
        self.assertIn('宿主成功工具结果', text)
        self.assertIn('不保证触发', text)
        self.assertNotIn('已记录', text)
        self.assertFalse((archive.session_dir(self.sid) / 'events.jsonl').exists())

    def test_mcp_reports_package_version_without_changing_locator_version(self):
        import mcp_server
        result = mcp_server.handle({'method': 'initialize', 'params': {}})
        self.assertEqual(result['serverInfo']['version'], '0.3.2')
        self.sync([self.user(), self.assistant()])
        self.assertEqual(self.search()['hits'][0]['locator']['version'], 1)


if __name__ == '__main__':
    unittest.main()
