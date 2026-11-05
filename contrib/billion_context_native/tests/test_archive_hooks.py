"""Synthetic real hook processes prove incremental capture before native compaction."""
import json
import unittest

import test_recall as fixture
from test_recall import SID, reply, user


class ArchiveHooksTest(unittest.TestCase):
    setUp = fixture.RecallTest.setUp
    tearDown = fixture.RecallTest.tearDown
    write = fixture.RecallTest.write
    hook = fixture.RecallTest.hook
    context = fixture.RecallTest.context
    mcp = fixture.RecallTest.mcp
    def test_nudge_archives_and_blocked_compaction_retains_raw(self):
        self.write([user('HOOK_ARCHIVE_FIRST'), reply('first response', 210000)])
        self.assertEqual(self.hook('nudge', hook_event_name='PostToolUse').returncode, 0)
        raw = self.root / 'archive' / SID / 'events.jsonl'
        original = raw.read_bytes()
        self.assertEqual(len(original.splitlines()), 2)
        self.write([user('HOOK_ARCHIVE_SECOND'), reply('second response', 210000)])
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 2)
        self.assertTrue(raw.read_bytes().startswith(original))
        got = self.mcp([('recall_get', {'session_id': SID, 'turn': 1})])[0]
        self.assertIn('HOOK_ARCHIVE_FIRST', got)

    def test_complete_partial_json_not_used_for_hook_context(self):
        self.write([user('committed')])
        with self.path.open('ab') as stream:
            stream.write(json.dumps(reply('not yet committed', 300000)).encode())
        proc = self.hook('nudge', hook_event_name='PostToolUse')
        self.assertEqual(proc.returncode, 0)
        self.assertIsNone(self.context(proc))
        raw = self.root / 'archive' / SID / 'events.jsonl'
        self.assertEqual(len(raw.read_bytes().splitlines()), 1)
