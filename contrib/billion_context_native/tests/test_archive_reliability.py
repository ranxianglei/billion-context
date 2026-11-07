"""Archive integrity regressions using synthetic data and real MCP subprocesses."""
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

from test_recall import BOUNDARY, PLUGIN, SUMMARY, reply, tool_call, tool_result, user

sys.path.insert(0, str(PLUGIN))
import transcript as tr


class ArchiveReliabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.project = self.root / 'synthetic-project'
        self.project.mkdir()
        self.sources = self.root / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(self.project))
        self.sources.mkdir(parents=True)
        self.sid = 'integrity-session'
        self.path = self.sources / f'{self.sid}.jsonl'
        self.env = {'RECALL_HOME': str(self.root / 'archive'),
                    'RECALL_PROJECTS': str(self.root / 'projects'),
                    'CLAUDE_PROJECT_DIR': str(self.project)}
        self.patcher = patch.dict(os.environ, self.env)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def write(self, entries, path=None):
        (path or self.path).write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in entries),
                                      encoding='utf-8')

    def sync(self, sid=None, path=None):
        return tr.write_archive(sid or self.sid, str(path or self.path))

    def turns(self, sid=None):
        return tr.load_archive(sid or self.sid)

    def texts(self, sid=None):
        return '\n'.join(t['text'] for t in self.turns(sid))

    def mcp(self, calls, raw_results=False):
        requests = [{'jsonrpc': '2.0', 'id': n, 'method': 'tools/call',
                     'params': {'name': name, 'arguments': args}}
                    for n, (name, args) in enumerate(calls)]
        proc = subprocess.run([sys.executable, str(PLUGIN / 'mcp_server.py')],
                              input=''.join(json.dumps(r) + '\n' for r in requests), text=True,
                              capture_output=True, env={**os.environ, **self.env}, check=True)
        responses = [json.loads(line)['result'] for line in proc.stdout.splitlines()]
        if raw_results:
            return responses
        for response in responses:
            self.assertFalse(response.get('isError'), response)
        return [r['content'][0]['text'] for r in responses]

    def child_sync(self, sid=None, path=None):
        return subprocess.Popen([sys.executable, '-c',
                                 'import sys; sys.path.insert(0, sys.argv[1]); import transcript as tr; '
                                 'tr.write_archive(sys.argv[2], sys.argv[3])',
                                 str(PLUGIN), sid or self.sid, str(path or self.path)],
                                env={**os.environ, **self.env}, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)

    def assert_children_ok(self, children):
        for child in children:
            out, err = child.communicate(timeout=30)
            self.assertEqual(child.returncode, 0, out + err)

    def test_large_tool_arguments_outputs_and_chinese_are_retrievable(self):
        argument = '甲' * 3100 + 'PARAMETER_END_9517'
        output = '乙' * 26000 + 'OUTPUT_END_7319'
        self.write([user('多块原始内容'), tool_call('Write', {'file_path': '测试.py', 'content': argument}, 100),
                    tool_result(output), reply('完成中文', 100)])
        self.sync()
        text = self.texts()
        self.assertIn(argument, text)
        self.assertIn(output, text)
        found, got = self.mcp([('recall_search', {'session_id': self.sid, 'query': 'PARAMETER_END_9517'}),
                               ('recall_get', {'session_id': self.sid, 'turn': 1, 'length': 60000})])
        self.assertIn('#1 ', found)
        self.assertIn(argument, got)
        self.assertIn(output, got)

    def test_same_content_distinct_events_and_repeated_sync(self):
        first, second = user('重复文本'), user('重复文本')
        first['uuid'], second['uuid'] = 'event-first', 'event-second'
        self.write([first, reply('same', 100), second, reply('same', 100)])
        self.sync()
        initial = copy.deepcopy(self.turns())
        self.sync()
        self.assertEqual(self.turns(), initial)
        self.assertEqual(len(initial), 2)
        self.assertEqual([t['n'] for t in initial], [1, 2])

    def test_identical_idless_rows_at_different_offsets_survive(self):
        self.write([user('完全重复'), reply('一样', 100), user('完全重复'), reply('一样', 100)])
        self.sync()
        self.sync()
        self.assertEqual(len(self.turns()), 2)

    def test_truncate_rewrite_and_rotation_keep_archived_history(self):
        old = [user('FIRST_PRESERVED'), reply('old answer', 100)]
        self.write(old)
        self.sync()
        self.write([BOUNDARY, SUMMARY, user('SECOND_AFTER_COMPACTION'), reply('new answer', 100)])
        self.sync()
        self.assertIn('FIRST_PRESERVED', self.texts())
        self.assertIn('SECOND_AFTER_COMPACTION', self.texts())
        self.path.rename(self.path.with_suffix('.rotated'))
        self.write([user('THIRD_AFTER_ROTATION'), reply('last answer', 100)])
        self.sync()
        search, original = self.mcp([('recall_search', {'session_id': self.sid, 'query': 'FIRST_PRESERVED'}),
                                    ('recall_get', {'session_id': self.sid, 'turn': 1})])
        self.assertIn('#1 ', search)
        self.assertIn('FIRST_PRESERVED', original)
        self.assertIn('SECOND_AFTER_COMPACTION', self.texts())
        self.assertIn('THIRD_AFTER_ROTATION', self.texts())

    def test_same_size_in_place_rewrite_is_detected(self):
        self.write([user('ORIGINAL_A')])
        self.sync()
        stat = self.path.stat()
        self.write([user('REPLACED_B')])
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.sync()
        self.assertIn('ORIGINAL_A', self.texts())
        self.assertIn('REPLACED_B', self.texts())

    def test_complete_json_without_newline_is_deferred(self):
        self.write([user('committed first')])
        with self.path.open('ab') as stream:
            stream.write(json.dumps(user('uncommitted tail')).encode())
        self.sync()
        self.assertNotIn('uncommitted tail', self.texts())
        with self.path.open('ab') as stream:
            stream.write(b'\n')
        self.sync()
        self.assertIn('uncommitted tail', self.texts())

    def test_split_utf8_and_json_tail_resumes_without_duplicates(self):
        first = json.dumps(user('安全首条'), ensure_ascii=False).encode() + b'\n'
        last = json.dumps(user('中文末条'), ensure_ascii=False).encode() + b'\n'
        cut = last.index('文'.encode()) + 1
        self.path.write_bytes(first + last[:cut])
        self.sync()
        self.assertIn('安全首条', self.texts())
        self.assertNotIn('中文末条', self.texts())
        with self.path.open('ab') as stream:
            stream.write(last[cut:])
        self.sync()
        self.assertEqual(len(self.turns()), 2)
        self.assertIn('中文末条', self.texts())

    def test_parallel_writers_same_session_are_idempotent(self):
        self.write([item for n in range(30) for item in [user(f'parallel {n}'), reply(str(n), 100)]])
        self.assert_children_ok([self.child_sync() for _ in range(5)])
        self.assertEqual(len(self.turns()), 30)
        self.assertEqual([t['n'] for t in self.turns()], list(range(1, 31)))

    def test_parallel_sessions_remain_separate(self):
        other = self.sources / 'other-session.jsonl'
        self.write([user('ONLY_FIRST_SESSION')])
        self.write([user('ONLY_OTHER_SESSION')], other)
        self.assert_children_ok([self.child_sync(), self.child_sync('other-session', other)])
        self.assertIn('ONLY_FIRST_SESSION', self.texts())
        self.assertNotIn('ONLY_OTHER_SESSION', self.texts())
        self.assertIn('ONLY_OTHER_SESSION', self.texts('other-session'))
        self.assertNotIn('ONLY_FIRST_SESSION', self.texts('other-session'))

    def test_restart_reads_preserved_data_after_source_removed(self):
        self.write([user('RESTART_RECALL_851')])
        self.sync()
        self.path.unlink()
        got, = self.mcp([('recall_get', {'session_id': self.sid, 'turn': 1})])
        self.assertIn('RESTART_RECALL_851', got)

    def test_source_uuid_rewrite_preserves_both_versions(self):
        event = user('UUID_FIRST_CONTENT')
        event['uuid'] = 'same-native-uuid'
        self.write([event])
        self.sync()
        changed = copy.deepcopy(event)
        changed['message']['content'] = 'UUID_EDITED_CONTENT'
        self.write([changed])
        self.sync()
        self.assertIn('UUID_FIRST_CONTENT', self.texts())
        self.assertIn('UUID_EDITED_CONTENT', self.texts())

    def raw_module(self):
        import archive
        return archive

    def archive_dir(self):
        return pathlib.Path(self.env['RECALL_HOME']) / self.sid

    def test_raw_preserves_nontext_blocks_embedded_bytes_and_reference_status(self):
        content = [{'type': 'text', 'text': '文本一'},
                   {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                                'data': 'c3ludGhldGljLWltYWdl'}},
                   {'type': 'document', 'source': {'type': 'url', 'url': 'https://example.invalid/reference.pdf'}},
                   {'type': 'text', 'text': '文本二'}]
        event = user(content)
        event['uuid'] = 'content-block-identity'
        event['parentUuid'] = 'branch-parent'
        self.write([event])
        self.sync()
        records = self.raw_module().records(self.sid)
        raw = [record for record in records if record.get('kind') == 'event']
        self.assertEqual(len(raw), 1)
        self.assertEqual(raw[0]['entry'], event)
        self.assertEqual(raw[0]['identity']['host'], 'claude-code')
        self.assertEqual(raw[0]['identity']['session'], self.sid)
        self.assertTrue(raw[0]['identity']['project'])
        self.assertIn('branch', raw[0]['identity'])
        self.assertTrue(raw[0]['event_id'])
        self.assertIn('source', raw[0])
        self.assertEqual([item['status'] for item in raw[0]['attachments']],
                         ['embedded_in_record', 'reference_only_not_fetched'])

    def test_attachment_only_message_remains_retrievable_without_fetching(self):
        event = user([{'type': 'image', 'source': {'type': 'url', 'url': 'https://example.invalid/only-image.png'}},
                      {'type': 'document', 'source': {'type': 'unknown'}}])
        self.write([event])
        self.sync()
        records = [r for r in self.raw_module().records(self.sid) if r.get('kind') == 'event']
        self.assertEqual(records[0]['entry'], event)
        self.assertEqual([item['status'] for item in records[0]['attachments']],
                         ['reference_only_not_fetched', 'content_unavailable'])
        got, = self.mcp([('recall_get', {'session_id': self.sid, 'turn': 1})])
        self.assertIn('only-image.png', got)

    def test_append_before_index_failure_recovers_without_duplicate(self):
        archive = self.raw_module()
        self.write([user('before fault')])
        self.sync()
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(user('after fault')) + '\n')
        with patch.object(archive, '_commit_index', side_effect=OSError('injected commit failure')):
            with self.assertRaises(OSError):
                self.sync()
        self.sync()
        text = self.texts()
        self.assertIn('before fault', text)
        self.assertIn('after fault', text)
        events = [r for r in archive.records(self.sid) if r.get('kind') == 'event']
        self.assertEqual(len(events), 2)
        self.assertEqual(len({r['event_id'] for r in events}), 2)

    def test_partial_and_corrupt_raw_tails_are_quarantined_and_repaired(self):
        archive = self.raw_module()
        self.write([user('original archive payload')])
        self.sync()
        raw = self.archive_dir() / 'events.jsonl'
        good = raw.read_bytes()
        for bad in (b'{"partial":', b'not-json\n'):
            with self.subTest(bad=bad):
                with raw.open('ab') as stream:
                    stream.write(bad)
                self.sync()
                self.assertEqual(raw.read_bytes(), good)
                self.assertEqual(len([r for r in archive.records(self.sid) if r.get('kind') == 'event']), 1)
                self.assertTrue(any(bad in p.read_bytes() for p in self.archive_dir().rglob('*')
                                    if p.is_file() and p.name != 'events.jsonl'),
                                'damaged bytes must be preserved for diagnosis')

    def test_raw_archive_and_legacy_backup_rebuild_existing_recall_tools(self):
        archive = self.raw_module()
        directory = self.archive_dir()
        directory.mkdir(parents=True)
        legacy = {'n': 1, 'ts': '2020-01-01', 'epoch': 0, 'text': 'LEGACY_MISSING_ORIGINAL',
                  'user': 'legacy user', 'files': [], 'tools': {}}
        original_bytes = (json.dumps(legacy) + '\n').encode()
        (directory / 'turns.jsonl').write_bytes(original_bytes)
        self.write([user('RAW_NEW_PAYLOAD')])
        self.sync()
        self.assertIn('LEGACY_MISSING_ORIGINAL', self.texts())
        self.assertIn('RAW_NEW_PAYLOAD', self.texts())
        self.assertTrue(any(p.read_bytes() == original_bytes for p in directory.rglob('*')
                            if p.is_file() and p.name != 'turns.jsonl'), 'legacy backup must be byte exact')
        self.assertTrue(archive.legacy_turns(self.sid), 'legacy material must remain explicitly identifiable')
        (directory / 'turns.jsonl').unlink(missing_ok=True)
        for p in directory.glob('index.sqlite3*'):
            p.unlink()
        self.path.unlink()
        found, got = self.mcp([('recall_search', {'session_id': self.sid, 'query': 'LEGACY_MISSING_ORIGINAL'}),
                               ('recall_get', {'session_id': self.sid, 'turn': 2})])
        self.assertIn('#1 ', found)
        self.assertIn('RAW_NEW_PAYLOAD', got)

    def test_source_symlink_is_rejected(self):
        outside = self.root / 'outside.jsonl'
        self.write([user('untrusted symlink')], outside)
        self.path.symlink_to(outside)
        with self.assertRaises((ValueError, OSError)):
            self.sync()

    def test_incremental_append_preserves_raw_file_prefix_and_event_ids(self):
        archive = self.raw_module()
        self.write([user('incremental first')])
        self.sync()
        raw = self.archive_dir() / 'events.jsonl'
        first_bytes = raw.read_bytes()
        first_stat = raw.stat()
        first_ids = [r['event_id'] for r in archive.records(self.sid)]
        addition = (json.dumps(user('incremental second')) + '\n').encode()
        with self.path.open('ab') as stream:
            stream.write(addition)
        result = archive.sync(self.sid, str(self.path))
        self.assertGreater(result['appended'], 0)
        self.assertEqual(raw.stat().st_ino, first_stat.st_ino)
        self.assertTrue(raw.read_bytes().startswith(first_bytes))
        self.assertEqual([r['event_id'] for r in archive.records(self.sid)][:len(first_ids)], first_ids)
        self.assertLessEqual(result['bytes_read'], len(addition) + 16384)
        stable_stat = raw.stat()
        repeated = archive.sync(self.sid, str(self.path))
        self.assertEqual(repeated['appended'], 0)
        self.assertEqual(raw.stat().st_size, stable_stat.st_size)
        self.assertEqual(raw.stat().st_mtime_ns, stable_stat.st_mtime_ns)

    def test_native_ids_allow_rotation_overlap_without_duplicate_events(self):
        old, retained, fresh = user('old unique'), user('retained unique'), user('fresh unique')
        old['uuid'], retained['uuid'], fresh['uuid'] = 'u-old', 'u-retained', 'u-fresh'
        self.write([old, retained])
        self.sync()
        self.path.rename(self.path.with_suffix('.rotated'))
        self.write([retained, fresh])
        self.sync()
        raw = [r for r in self.raw_module().records(self.sid) if r.get('kind') == 'event']
        self.assertEqual(len(raw), 3)
        self.assertEqual(len(self.turns()), 3)

    def test_rebuild_deleted_index_does_not_migrate_its_own_derived_view(self):
        self.write([user('rebuild without duplicate')])
        self.sync()
        before = copy.deepcopy(self.turns())
        for p in self.archive_dir().glob('index.sqlite3*'):
            p.unlink()
        self.sync()
        self.assertEqual(self.turns(), before)
        self.assertEqual(self.raw_module().legacy_turns(self.sid), [])

    def test_interleaved_sidechain_does_not_reassign_main_turn_output(self):
        branch_user = user('SIDECHAIN_SECRET')
        branch_user.update(isSidechain=True, agentId='worker-a', uuid='worker-prompt')
        main = user('MAIN_PROMPT')
        main['uuid'] = 'main-prompt'
        self.write([main, branch_user, reply('MAIN_RESULT_AFTER_SIDECHAIN', 100)])
        self.sync()
        turns = self.turns()
        self.assertEqual(len(turns), 1)
        self.assertIn('MAIN_PROMPT', turns[0]['text'])
        self.assertIn('MAIN_RESULT_AFTER_SIDECHAIN', turns[0]['text'])
        self.assertNotIn('SIDECHAIN_SECRET', turns[0]['text'])
        records = self.raw_module().records(self.sid)
        branches = {r['identity']['branch'] for r in records if r.get('kind') == 'event'}
        self.assertIn('worker-a', branches)

    def test_ambiguous_same_project_requires_explicit_session(self):
        second = self.sources / 'second-session.jsonl'
        self.write([user('FIRST_BINDING')])
        self.write([user('SECOND_BINDING')], second)
        self.sync()
        self.sync('second-session', second)
        results = self.mcp([('recall_get', {'turn': 1}), ('recall_status', {}),
                            ('recall_rule', {'action': 'add', 'text': 'do not guess session'})], raw_results=True)
        self.assertTrue(all(r.get('isError') for r in results), results)
        first, other = self.mcp([('recall_get', {'session_id': self.sid, 'turn': 1}),
                                 ('recall_get', {'session_id': 'second-session', 'turn': 1})])
        self.assertIn('FIRST_BINDING', first)
        self.assertNotIn('SECOND_BINDING', first)
        self.assertIn('SECOND_BINDING', other)

    def test_implicit_archive_scope_is_current_project_even_when_other_is_newer(self):
        self.write([user('CURRENT_PROJECT_DATA')])
        self.sync()
        other_project = self.root / 'other-project'
        other_project.mkdir()
        other_sources = self.root / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(other_project))
        other_sources.mkdir()
        other = other_sources / 'foreign-session.jsonl'
        self.write([user('FOREIGN_PROJECT_SECRET')], other)
        with patch.dict(os.environ, {'CLAUDE_PROJECT_DIR': str(other_project)}):
            self.sync('foreign-session', other)
        found, got = self.mcp([('recall_search', {'query': 'FOREIGN_PROJECT_SECRET'}),
                               ('recall_get', {'turn': 1})])
        self.assertIn('无匹配', found)
        self.assertIn('CURRENT_PROJECT_DATA', got)
        self.assertNotIn('FOREIGN_PROJECT_SECRET', got)

    def test_explicit_live_session_cannot_bind_foreign_project(self):
        foreign = self.root / 'projects' / 'foreign-project'
        foreign.mkdir()
        self.write([user('not current live context')], foreign / 'foreign-id.jsonl')
        self.assertIsNone(tr.find_transcript('foreign-id'))
        result, = self.mcp([('recall_status', {'session_id': 'foreign-id'})], raw_results=True)
        self.assertTrue(result.get('isError'), result)

    def test_session_traversal_is_rejected(self):
        self.write([user('must not escape')])
        for sid in ('../escape', str(self.root / 'absolute-escape'), 'nested/session', '..', '.', ''):
            with self.subTest(sid=sid), self.assertRaises((ValueError, OSError)):
                tr.write_archive(sid, str(self.path))


if __name__ == '__main__':
    unittest.main()
