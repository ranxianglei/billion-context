"""Renaming the plugin must preserve configured stores and immutable references."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import archive
import config
import hook
import native_read
import transcript


class RenameCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        clean = {key: value for key, value in os.environ.items()
                 if not key.startswith(('RECALL_', 'BILLION_CONTEXT_NATIVE_'))
                 and key != 'CLAUDE_PROJECT_DIR'}
        self.env = patch.dict(os.environ, clean, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_all_configuration_names_accept_legacy_and_canonical_with_precedence(self):
        for suffix in ('HOME', 'PROJECTS', 'SOFT', 'STEP', 'HARD', 'HARD_HAIKU', 'CC_VERSION'):
            with self.subTest(suffix=suffix):
                old, new = 'RECALL_' + suffix, 'BILLION_CONTEXT_NATIVE_' + suffix
                self.assertEqual(config.env(suffix, 'default'), 'default')
                with patch.dict(os.environ, {old: 'old'}):
                    self.assertEqual(config.env(suffix), 'old')
                    with patch.dict(os.environ, {new: 'new'}):
                        self.assertEqual(config.env(suffix), 'new')
                    with patch.dict(os.environ, {new: ''}):
                        self.assertEqual(config.env(suffix), '')
                with patch.dict(os.environ, {new: 'new'}):
                    self.assertEqual(config.env(suffix), 'new')

    def test_archive_default_is_unchanged_and_creates_nothing(self):
        with patch.object(pathlib.Path, 'home', return_value=self.root):
            expected = self.root / '.claude' / 'recall'
            self.assertEqual(archive.root(), expected)
            self.assertEqual(transcript.archive_root(), expected)
            self.assertEqual(list(self.root.iterdir()), [])
            with patch.dict(os.environ, {'RECALL_HOME': '/unused/old', 'BILLION_CONTEXT_NATIVE_HOME': ''}):
                self.assertEqual(archive.root(), expected)

    def test_runtime_thresholds_use_either_prefix_and_canonical_precedence(self):
        values = {'SOFT': 111, 'STEP': 222, 'HARD': 333, 'HARD_HAIKU': 444}
        script = 'import transcript as t, json; print(json.dumps([t.SOFT,t.STEP,t.HARD,t.HARD_HAIKU]))'
        cases = [({}, [150000, 50000, 300000, 180000])]
        for prefix in ('RECALL_', 'BILLION_CONTEXT_NATIVE_'):
            cases.append(({prefix + k: str(v) for k, v in values.items()}, list(values.values())))
        cases.append(({**{'RECALL_' + k: '9' for k in values},
                       **{'BILLION_CONTEXT_NATIVE_' + k: str(v) for k, v in values.items()}}, list(values.values())))
        for variables, expected in cases:
            with self.subTest(variables=variables):
                child = subprocess.run([sys.executable, '-c', script], cwd=PLUGIN,
                                       env={**os.environ, **variables}, capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(child.stdout), expected)

    def test_version_gate_uses_either_prefix_and_canonical_precedence(self):
        self.assertEqual(hook.cc_gate_capability(), 'unknown')
        for prefix in ('RECALL_', 'BILLION_CONTEXT_NATIVE_'):
            with patch.dict(os.environ, {prefix + 'CC_VERSION': '2.1.105'}):
                self.assertEqual(hook.cc_gate_capability(), 'supported')
        with patch.dict(os.environ, {'RECALL_CC_VERSION': '2.1.105', 'BILLION_CONTEXT_NATIVE_CC_VERSION': '2.1.104'}):
            self.assertEqual(hook.cc_gate_capability(), 'unsupported')
        with patch.dict(os.environ, {'RECALL_CC_VERSION': '2.1.105', 'BILLION_CONTEXT_NATIVE_CC_VERSION': ''}):
            self.assertEqual(hook.cc_gate_capability(), 'unknown')

    def test_project_scope_uses_either_prefix_without_claude_project_dir(self):
        cwd = os.getcwd()
        for prefix in ('RECALL_', 'BILLION_CONTEXT_NATIVE_'):
            with self.subTest(prefix=prefix), patch.dict(os.environ, {prefix + 'PROJECTS': str(self.root / 'projects')}):
                project = str(self.root / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', cwd))
                with patch.object(transcript, 'find_transcript', return_value=None), \
                     patch.object(transcript, 'all_sessions', return_value=['matching', 'other']), \
                     patch.object(archive, 'records', side_effect=lambda sid: [{'identity': {'project': project if sid == 'matching' else '/other'}}]):
                    self.assertEqual(transcript.implicit_session(), 'matching')
        with patch.dict(os.environ, {'RECALL_PROJECTS': '/old', 'BILLION_CONTEXT_NATIVE_PROJECTS': str(self.root)}):
            self.assertEqual(transcript.projects_root(), self.root)
        with patch.object(transcript, 'find_transcript', return_value=None), \
             patch.object(transcript, 'all_sessions', return_value=['matching', 'other']):
            with self.assertRaises(ValueError):
                transcript.implicit_session()

    def test_existing_archive_bytes_ids_and_locator_survive_prefix_switch(self):
        sid = 'rename-existing-session'
        home = self.root / '.claude' / 'recall'
        source = self.root / (sid + '.jsonl')
        rows = [
            {'type': 'user', 'uuid': 'original-user', 'sessionId': sid,
             'message': {'role': 'user', 'content': 'RENAME_COMPAT_QUERY'}},
            {'type': 'assistant', 'uuid': 'original-answer', 'sessionId': sid,
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ORIGINAL_RESPONSE'}], 'stop_reason': 'end_turn'}},
        ]
        source.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        with patch.dict(os.environ, {'RECALL_HOME': str(home)}):
            transcript.write_archive(sid, str(source))
            reference = native_read.search(sid, 'RENAME_COMPAT_QUERY', host='claude-code')['hits'][0]['locator']
            original = native_read.get(locator_value=reference)['text']
            records = archive.records(sid)
            immutable = {p.relative_to(home): p.read_bytes() for p in home.rglob('*.jsonl')}
            self.assertTrue(immutable)
        source.unlink()
        with patch.dict(os.environ, {'BILLION_CONTEXT_NATIVE_HOME': str(home), 'RECALL_HOME': str(self.root / 'ignored')}):
            self.assertEqual(archive.root(), home)
            self.assertEqual(transcript.archive_root(), home)
            self.assertEqual(archive.records(sid), records)
            reread = native_read.get(locator_value=reference)
            self.assertEqual(reread['text'], original)
            self.assertIn('ORIGINAL_RESPONSE', reread['text'])
            self.assertEqual({p.relative_to(home): p.read_bytes() for p in home.rglob('*.jsonl')}, immutable)
            self.assertFalse((self.root / 'ignored').exists())
            self.assertFalse((self.root / '.claude' / 'billion_context_native').exists())


if __name__ == '__main__':
    unittest.main()
