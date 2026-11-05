"""Independent integrity review regressions on synthetic archive records."""
import json
import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import archive
import transcript as tr
import mcp_server as mcp


class ArchiveReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.path = self.root / 'review-session.jsonl'
        self.patch = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'archive')})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def write(self, entries):
        self.path.write_text(''.join(json.dumps(e) + '\n' for e in entries), encoding='utf-8')

    def sync(self):
        return tr.write_archive('review-session', str(self.path))

    def test_interleaved_branches_keep_independent_turn_context(self):
        self.write([
            {'type': 'user', 'uuid': 'main-user', 'message': {'content': 'MAIN QUESTION'}},
            {'type': 'user', 'uuid': 'child-user', 'agentId': 'child', 'isSidechain': True,
             'message': {'content': 'CHILD QUESTION'}},
            {'type': 'assistant', 'uuid': 'main-answer',
             'message': {'content': [{'type': 'text', 'text': 'MAIN ANSWER'}]}},
            {'type': 'assistant', 'uuid': 'child-answer', 'agentId': 'child', 'isSidechain': True,
             'message': {'content': [{'type': 'text', 'text': 'CHILD ANSWER'}]}},
        ])
        self.sync()
        turns = tr.load_archive('review-session')
        main = next(t for t in turns if t['branch'] == 'main')
        self.assertIn('MAIN ANSWER', main['text'])
        self.assertNotIn('CHILD ANSWER', main['text'])
        records = archive.records('review-session')
        main_answer = next(r for r in records if r['entry'].get('uuid') == 'main-answer')
        child_answer = next(r for r in records if r['entry'].get('uuid') == 'child-answer')
        self.assertNotEqual(main_answer['source']['turn_id'], child_answer['source']['turn_id'])

    def test_identical_idless_new_inode_occurrences_remain_retrievable(self):
        self.write([{'type': 'user', 'message': {'content': 'REAL REPEATED OCCURRENCE'}}])
        self.sync()
        self.path.rename(self.path.with_suffix('.rotated'))
        self.write([{'type': 'user', 'message': {'content': 'REAL REPEATED OCCURRENCE'}}])
        self.sync()
        self.assertEqual(len(archive.entries('review-session')), 2)
        self.assertEqual(len(tr.load_archive('review-session')), 2,
                         'conservatively retained different source occurrences must both be readable')

    def test_interrupted_legacy_migration_resumes_all_original_rows(self):
        self.write([{'type': 'user', 'message': {'content': 'NEW AFTER MIGRATION'}}])
        directory = archive.session_dir('review-session')
        directory.mkdir(parents=True)
        old = [{'n': i, 'text': f'LEGACY ROW {i}', 'user': f'legacy {i}',
                'ts': '', 'epoch': 0, 'files': [], 'tools': {}} for i in range(1, 4)]
        original = ''.join(json.dumps(t) + '\n' for t in old).encode()
        (directory / 'turns.jsonl').write_bytes(original)
        append = archive._append_record
        written = []
        def fail_second(out, record):
            if len(written) == 1:
                raise OSError('injected interrupted legacy migration')
            append(out, record)
            written.append(record)
        with patch.object(archive, '_append_record', side_effect=fail_second):
            with self.assertRaises(OSError):
                self.sync()
        self.sync()
        self.assertEqual(len(archive.legacy_turns('review-session')), 3)
        self.assertEqual((directory / 'turns.legacy-v0.jsonl').read_bytes(), original)
        text = '\n'.join(t['text'] for t in tr.load_archive('review-session'))
        for number in range(1, 4):
            self.assertIn(f'LEGACY ROW {number}', text)

    def test_future_archive_version_rejected_without_modifying_bytes(self):
        self.write([{'type': 'user', 'message': {'content': 'GOOD ARCHIVE'}}])
        self.sync()
        raw = archive.session_dir('review-session') / 'events.jsonl'
        future = dict(archive.records('review-session')[0], version=999, seq=2,
                      event_id='future-record')
        with raw.open('ab') as out:
            out.write((json.dumps(future) + '\n').encode())
        before = raw.read_bytes()
        with self.assertRaises(archive.UnsupportedArchiveVersion):
            self.sync()
        self.assertEqual(raw.read_bytes(), before)

    def test_schema_invalid_tail_is_quarantined_before_projection(self):
        self.write([{'type': 'user', 'message': {'content': 'GOOD ARCHIVE'}}])
        self.sync()
        raw = archive.session_dir('review-session') / 'events.jsonl'
        good = raw.read_bytes()
        invalid = {'version': 1, 'seq': 2, 'event_id': 'broken-envelope'}
        with raw.open('ab') as out:
            out.write((json.dumps(invalid) + '\n').encode())
        self.sync()
        self.assertEqual(raw.read_bytes(), good)
        self.assertIn('GOOD ARCHIVE', tr.load_archive('review-session')[0]['text'])

    def test_mcp_explicit_source_does_not_resolve_away_symlink_ancestor(self):
        project = str(self.root / 'working-project')
        real_root = self.root / 'real-projects'
        directory = real_root / re.sub(r'[^A-Za-z0-9]', '-', project)
        directory.mkdir(parents=True)
        source = directory / 'review-session.jsonl'
        source.write_text(json.dumps({'type': 'user', 'message': {'content': 'SYMLINK SOURCE'}}) + '\n')
        alias = self.root / 'linked-projects'
        alias.symlink_to(real_root, target_is_directory=True)
        with patch.dict(os.environ, {'RECALL_PROJECTS': str(alias), 'CLAUDE_PROJECT_DIR': project}):
            with self.assertRaises(ValueError):
                mcp._session({'session_id': 'review-session'})

    def test_export_rejects_existing_file_symlink(self):
        target = self.root / 'unrelated-user-file'
        target.write_text('KEEP THIS CONTENT')
        export_dir = pathlib.Path(os.environ['RECALL_HOME']) / 'tmp'
        export_dir.mkdir(parents=True)
        link = export_dir / 'review-session-turns-1-2-fixed-time.md'
        link.symlink_to(target)
        with patch.object(mcp.time, 'strftime', return_value='fixed-time'):
            with self.assertRaises(ValueError):
                mcp._export('review-session', 1, 2, 'MUST NOT WRITE')
        self.assertEqual(target.read_text(), 'KEEP THIS CONTENT')
