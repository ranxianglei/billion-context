"""End-to-end tests: hooks and MCP server run as subprocesses against synthetic transcripts."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'recall'
SID = 'sess-1'


def user(text):
    return {'type': 'user', 'isSidechain': False, 'timestamp': '2026-09-26T10:00:00Z',
            'message': {'role': 'user', 'content': text}}


def tool_call(name, inp, tokens, tid='t'):
    return {'type': 'assistant', 'isSidechain': False, 'message': {
        'role': 'assistant', 'content': [{'type': 'tool_use', 'id': tid, 'name': name, 'input': inp}],
        'usage': {'input_tokens': 2, 'cache_read_input_tokens': tokens - 2, 'cache_creation_input_tokens': 0}}}


def tool_result(text, tid='t'):
    return {'type': 'user', 'isSidechain': False,
            'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tid, 'content': text}]}}


def reply(text, tokens):
    return {'type': 'assistant', 'isSidechain': False, 'message': {
        'role': 'assistant', 'content': [{'type': 'text', 'text': text}],
        'usage': {'input_tokens': 2, 'cache_read_input_tokens': tokens - 2, 'cache_creation_input_tokens': 0}}}


BOUNDARY = {'type': 'system', 'subtype': 'compact_boundary', 'isSidechain': False}
SUMMARY = {'type': 'user', 'isCompactSummary': True, 'isSidechain': False,
           'message': {'role': 'user', 'content': 'This session is being continued...'}}
READY = 'mcp__plugin_billion-claude-recall_recall__compact_ready'


class RecallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.path = self.root / 't.jsonl'
        self.env = {**os.environ, 'RECALL_HOME': str(self.root / 'archive')}

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, entries):
        self.path.write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in entries), encoding='utf-8')

    def hook(self, *args, **extra):
        data = {'session_id': SID, 'transcript_path': str(self.path), **extra}
        return subprocess.run([sys.executable, '-X', 'utf8', str(PLUGIN / 'hook.py'), *args],
                              input=json.dumps(data).encode(), capture_output=True, env=self.env)

    def context(self, proc):
        out = proc.stdout.decode('utf-8').strip()
        return json.loads(out)['hookSpecificOutput']['additionalContext'] if out else None

    def conversation(self, n_turns, tokens, big_output=''):
        entries = []
        for i in range(1, n_turns + 1):
            entries += [user(f'任务 {i}'), tool_call('Read', {'file_path': f'src/f{i}.py'}, tokens),
                        tool_result(big_output if i == n_turns - 1 else f'内容 {i} 标识符 KEY{i}'), reply(f'完成 {i}', tokens)]
        return entries

    def events(self):
        p = self.root / 'archive' / SID / 'events.log'
        return [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines()] if p.exists() else []

    # --- event log ---
    def test_nudge_on_first_prompt_before_transcript_exists_is_silent(self):
        proc = self.hook('nudge', hook_event_name='UserPromptSubmit')
        self.assertEqual(proc.returncode, 0)
        self.assertIsNone(self.context(proc))
        self.assertEqual(self.events(), [])

    def test_event_log_records_block_allow_nudge_and_errors(self):
        self.write(self.conversation(3, 210_000))
        self.hook('nudge', hook_event_name='PostToolUse')
        self.hook('nudge', hook_event_name='PostToolUse')  # same step: no nudge, no log line
        self.hook('precompact', trigger='auto')
        self.write(self.conversation(3, 300_000))
        self.hook('precompact', trigger='auto')
        ev = self.events()
        self.assertEqual([(e['event'], e['ctx']) for e in ev],
                         [('nudge', 210_000), ('block', 210_000), ('allow', 300_000)])
        self.assertEqual(ev[0]['layer'], 'growth')
        self.assertEqual(ev[2]['reason'], 'hard')
        self.assertEqual(ev[2]['turns'], 3)

        self.path.unlink()
        failed = self.hook('precompact', trigger='auto')
        self.assertNotEqual(failed.returncode, 0)
        err = self.events()[-1]
        self.assertEqual((err['event'], err['hook']), ('error', 'precompact'))
        self.assertIn('FileNotFoundError', err['trace'])

    # --- compaction gate ---
    def test_auto_compaction_blocked_until_model_is_ready(self):
        self.write(self.conversation(3, 260_000))
        blocked = self.hook('precompact', trigger='auto')
        self.assertEqual(blocked.returncode, 2)
        self.assertIn('compact_ready', blocked.stderr.decode('utf-8'))
        self.assertFalse((self.root / 'archive' / SID / 'turns.jsonl').exists())

        self.write(self.conversation(3, 260_000) + [tool_call(READY, {'focus': 'x'}, 260_000)])
        allowed = self.hook('precompact', trigger='auto')
        self.assertEqual(allowed.returncode, 0)
        self.assertTrue((self.root / 'archive' / SID / 'turns.jsonl').exists())

    def test_ready_from_before_previous_compaction_does_not_count(self):
        self.write(self.conversation(2, 260_000)[:4] + [tool_call(READY, {'focus': 'x'}, 260_000), BOUNDARY, SUMMARY]
                   + self.conversation(2, 260_000))
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 2)

    def test_hard_ceiling_forces_compaction(self):
        self.write(self.conversation(3, 299_000))
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 2)
        self.write(self.conversation(3, 300_000))
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 0)

    def test_manual_compact_always_allowed(self):
        self.write(self.conversation(3, 120_000))
        self.assertEqual(self.hook('precompact', trigger='manual').returncode, 0)

    def test_sidechain_usage_ignored(self):
        side = reply('sub', 400_000)
        side['isSidechain'] = True
        self.write(self.conversation(2, 260_000) + [side])
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 2)

    # --- nudges ---
    def test_nudge_once_per_50k_step_and_reset_after_compaction(self):
        ev = {'hook_event_name': 'PostToolUse'}
        self.write(self.conversation(2, 100_000))
        self.assertIsNone(self.context(self.hook('nudge', **ev)))
        self.write(self.conversation(2, 155_000))
        first = self.context(self.hook('nudge', **ev))
        self.assertIn('155k', first)
        self.assertIsNone(self.context(self.hook('nudge', **ev)), 'same step must not repeat')
        self.write(self.conversation(2, 201_000))
        self.assertIn('201k', self.context(self.hook('nudge', **ev)))
        self.write(self.conversation(2, 60_000))
        self.assertIsNone(self.context(self.hook('nudge', **ev)))
        self.write(self.conversation(2, 160_000))
        self.assertIsNotNone(self.context(self.hook('nudge', **ev)), 'must nudge again after context dropped')

    def test_no_nudge_after_model_declared_ready(self):
        self.write(self.conversation(2, 260_000) + [tool_call(READY, {'focus': 'x'}, 260_000)])
        self.assertIsNone(self.context(self.hook('nudge', hook_event_name='PostToolUse')))

    # --- restore after compaction ---
    def test_restore_injects_last_five_turns_and_long_output_is_retrievable(self):
        middle = 'MIDDLE-SECRET-4242'
        big = 'A' * 12_000 + middle + 'B' * 12_000
        self.write(self.conversation(8, 260_000, big_output=big) + [BOUNDARY, SUMMARY])
        self.assertEqual(self.hook('precompact', trigger='manual').returncode, 0)

        blocks = [self.context(self.hook('restore', str(i))) for i in range(6)]
        for b in blocks:
            self.assertLessEqual(len(b), 9_500)
        self.assertIn(f'session_id="{SID}"', blocks[0])
        self.assertIn('#1 ', blocks[0])
        self.assertNotIn('#4 ', blocks[0], 'recent turns are not repeated in the index')
        for slot, n in zip(range(1, 6), range(4, 9)):
            self.assertIn(f'第 #{n} 轮原文', blocks[slot])
            self.assertIn(f'任务 {n}', blocks[slot])
        clipped = blocks[4]  # turn 7 holds the big output
        self.assertNotIn(middle, clipped)
        self.assertIn('recall_get(session_id="sess-1", turn=7', clipped)

        offset = int(clipped.split('offset=')[1].split(')')[0])
        got = self.mcp([('recall_get', {'session_id': SID, 'turn': 7, 'offset': offset, 'length': 20_000})])[0]
        self.assertIn(middle, got)

    # --- MCP server ---
    def mcp(self, calls, env=None, errors=None):
        reqs = [{'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}]
        reqs += [{'jsonrpc': '2.0', 'id': 10 + i, 'method': 'tools/call', 'params': {'name': n, 'arguments': a}}
                 for i, (n, a) in enumerate(calls)]
        proc = subprocess.run([sys.executable, '-X', 'utf8', str(PLUGIN / 'mcp_server.py')],
                              input=''.join(json.dumps(r) + '\n' for r in reqs).encode(), capture_output=True,
                              env={**self.env, **(env or {})})
        resps = {r['id']: r for r in map(json.loads, proc.stdout.decode('utf-8').splitlines())}
        self.assertEqual(resps[0]['result']['protocolVersion'], '2025-06-18')
        self.assertEqual({t['name'] for t in resps[1]['result']['tools']},
                         {'recall_search', 'recall_get', 'compact_ready', 'recall_status', 'recall_rule'})
        self.tools = {t['name']: t for t in resps[1]['result']['tools']}
        if errors is not None:
            errors[:] = [bool(resps[10 + i]['result'].get('isError')) for i in range(len(calls))]
        return [resps[10 + i]['result']['content'][0]['text'] for i in range(len(calls))]

    def test_search_finds_pre_compaction_tool_output_by_keyword_and_file(self):
        self.write(self.conversation(6, 260_000))
        self.hook('precompact', trigger='manual')
        by_key, by_file, miss = self.mcp([('recall_search', {'query': 'KEY3'}),
                                          ('recall_search', {'query': 'src/f2.py'}),
                                          ('recall_search', {'query': 'KEY3 不存在的词'})])
        self.assertIn('#3 ', by_key)
        self.assertIn('#2 ', by_file)
        self.assertIn('无匹配', miss)

    def test_tools_report_missing_archive(self):
        (text,) = self.mcp([('recall_search', {'query': 'x'})])
        self.assertIn('还没有任何存档', text)


if __name__ == '__main__':
    unittest.main()
