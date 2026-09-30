"""v2 behaviour: summaries, pressure layers, digests, rules, todos, status, absorb (ported from acp-kernel)."""
import json
import pathlib
import re
import unittest

from test_recall import BOUNDARY, READY, SID, SUMMARY, RecallTest, reply, tool_call, tool_result, user

RULE = 'mcp__plugin_billion-claude-recall_recall__recall_rule'


def ready(summary, tokens, tid='r', **extra):
    return tool_call(READY, {'summary': summary, **extra}, tokens, tid)


class V2Test(RecallTest):
    def summaries_file(self):
        return self.root / 'archive' / SID / 'summaries.jsonl'

    def summaries(self):
        p = self.summaries_file()
        return [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines()] if p.exists() else []

    def seed_summaries(self, recs):
        self.summaries_file().parent.mkdir(parents=True, exist_ok=True)
        self.summaries_file().write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in recs), encoding='utf-8')

    def project(self, entries, sid=SID):
        """Put the transcript where the MCP server looks for the live session (RECALL_PROJECTS/<cwd slug>)."""
        cwd = str(self.root / 'proj')
        d = self.root / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', cwd)
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{sid}.jsonl').write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in entries), encoding='utf-8')
        return {'RECALL_PROJECTS': str(self.root / 'projects'), 'CLAUDE_PROJECT_DIR': cwd}

    # --- G1-1 summary passed to compact_ready, restored after compaction ---
    def test_compact_ready_requires_summary_and_describes_how_to_compress(self):
        errs = []
        missing, ok = self.mcp([('compact_ready', {'focus': 'x'}), ('compact_ready', {'summary': 'done'})], errors=errs)
        self.assertEqual(errs, [True, False])
        self.assertIn('summary', missing)
        tool = self.tools['compact_ready']
        self.assertEqual(tool['inputSchema']['required'], ['summary'])
        self.assertIn('HOW TO COMPRESS', tool['description'])
        self.assertIn('Replace consumed conversation turns', tool['description'])
        self.assertNotIn('m00', tool['description'])

    def test_summary_stored_with_turn_range_and_restored_in_compressed_section_format(self):
        first = self.conversation(3, 260_000) + [ready('第一段摘要 ALPHA', 260_000, 'r1', focus='F1')]
        self.write(first)
        self.hook('precompact', trigger='auto')  # PreCompact runs before Claude Code writes the boundary
        first += [BOUNDARY, SUMMARY]
        (rec,) = self.summaries()
        self.assertEqual((rec['id'], rec['tier'], rec['from'], rec['to'], rec['focus']), ('s1', 1, 1, 3, 'F1'))
        block = self.context(self.hook('restore', '6'))
        self.assertIn('[Compressed conversation section] — turns #1–#3\n第一段摘要 ALPHA', block)
        self.assertIn(f'recall_get(session_id="{SID}", turn=1, to_turn=3)', block)

        second = [user('任务 4'), reply('完成 4', 260_000), user('任务 5'), reply('完成 5', 260_000)]
        self.write(first + second + [ready('第二段 BETA', 260_000, 'r2')])
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 0)
        self.hook('precompact', trigger='auto')  # same call again: not stored twice
        self.assertEqual([(r['id'], r['from'], r['to']) for r in self.summaries()], [('s1', 1, 3), ('s2', 4, 5)])
        block = self.context(self.hook('restore', '6'))
        self.assertLess(block.index('ALPHA'), block.index('BETA'))
        self.assertIsNone(self.context(self.hook('restore', '7')), 'no rules: slot stays empty')

    # --- G1-2 pressure layer ---
    def test_pressure_reminds_every_call_emergency_near_hard_and_stops_after_ready(self):
        ev = {'hook_event_name': 'PostToolUse'}
        self.write(self.conversation(2, 230_000))
        a, b = self.context(self.hook('nudge', **ev)), self.context(self.hook('nudge', **ev))
        self.assertIn('[OVER-LIMIT]', a)
        self.assertEqual(a, b, 'pressure layer repeats on every call')
        self.write(self.conversation(2, 290_000))
        self.assertIn('Context limit reached', self.context(self.hook('nudge', **ev)))
        self.write(self.conversation(2, 290_000) + [ready('s', 290_000)])
        self.assertIsNone(self.context(self.hook('nudge', **ev)))
        self.assertEqual([(e['event'], e['layer']) for e in self.events()],
                         [('nudge', 'pressure'), ('nudge', 'pressure'), ('nudge', 'emergency')])

    def test_growth_layer_carries_how_to_compress(self):
        self.write(self.conversation(2, 160_000))
        text = self.context(self.hook('nudge', hook_event_name='PostToolUse'))
        self.assertIn('当前上下文约 160k', text)
        self.assertIn('HOW TO COMPRESS', text)
        self.assertIn('#1–current turn', text)

    # --- G1-3 prior digest ---
    def test_digest_requested_when_summaries_overflow_and_replaces_them(self):
        big = [{'id': f's{i}', 'tier': 1, 'from': i, 'to': i, 'ts': '2026-09-26T10:00', 'text': f'OLD{i} ' + 'x' * 3000}
               for i in (1, 2, 3)]
        self.seed_summaries(big)
        self.write(self.conversation(2, 160_000))
        text = self.context(self.hook('nudge', hook_event_name='PostToolUse'))
        self.assertIn('[TIER 2 DISTILLATION TRIGGER]', text)
        self.assertIn('s1+s2+s3', text)

        self.write(self.conversation(2, 160_000) + [BOUNDARY, SUMMARY]
                   + [ready('NEW summary', 160_000, 'r9', prior_digest='DIGEST of s1-s3')])
        self.hook('precompact', trigger='manual')
        recs = self.summaries()
        self.assertEqual([(r['id'], r['tier']) for r in recs[3:]], [('s4', 2), ('s5', 1)])
        self.assertEqual(recs[3]['covers'], ['s1', 's2', 's3'])
        block = self.context(self.hook('restore', '6'))
        self.assertIn('DIGEST of s1-s3', block)
        self.assertNotIn('OLD1', block)
        self.assertIn('OLD2', self.mcp([('recall_search', {'query': 'OLD2', 'session_id': SID})])[0],
                      'replaced originals stay searchable')

    def test_tier3_when_digests_outweigh_raw_summaries(self):
        self.seed_summaries([{'id': 's1', 'tier': 2, 'from': 1, 'to': 5, 'text': 'D' * 5000, 'covers': []},
                             {'id': 's2', 'tier': 1, 'from': 6, 'to': 6, 'text': 'x' * 2500}])
        self.write(self.conversation(2, 230_000))
        self.assertIn('[TIER 3 CONDENSATION TRIGGER]', self.context(self.hook('nudge', hook_event_name='PostToolUse')))

    # --- G1-4 search over summaries, scope ---
    def test_search_covers_summaries_and_all_sessions(self):
        self.write(self.conversation(3, 260_000) + [ready('决定用 GAMMA 方案', 260_000)])
        self.hook('precompact', trigger='auto')
        self.write(self.conversation(2, 100_000))
        self.hook('precompact', trigger='manual', session_id='other-sess')
        here, everywhere = self.mcp([('recall_search', {'query': 'GAMMA', 'session_id': SID}),
                                     ('recall_search', {'query': 'src/f1.py', 'scope': 'all'})])
        self.assertIn('摘要 s1', here)
        self.assertIn('#1–#3', here)
        self.assertIn(f'[{SID} 2026-09-26] #1 ', everywhere)
        self.assertIn('[other-sess 2026-09-26] #1 ', everywhere)

    # --- G1-5 recall_get ranges ---
    def test_get_range_verbatim_and_large_range_exported_to_file(self):
        big = 'A' * 12_000 + 'MIDDLE-7' + 'B' * 3_000
        self.write(self.conversation(8, 260_000, big_output=big))
        self.hook('precompact', trigger='manual')
        tmp = self.root / 'archive' / 'tmp'
        tmp.mkdir(parents=True)
        for i in range(55):
            (tmp / f'old{i:02}.md').write_text('x', encoding='utf-8')
        small, large = self.mcp([('recall_get', {'turn': 2, 'to_turn': 3}),
                                 ('recall_get', {'turn': 6, 'to_turn': 8})])
        self.assertIn('内容 2 标识符 KEY2', small)
        self.assertIn('内容 3 标识符 KEY3', small)
        self.assertNotIn('KEY4', small)
        path = re.search(r'path="([^"]+)"', large).group(1)
        self.assertIn('MIDDLE-7', pathlib.Path(path).read_text(encoding='utf-8'))
        self.assertNotIn('MIDDLE-7', large)
        self.assertIn('turns #6–#8', large)
        self.assertIn('开头片段', large)
        self.assertEqual(len(list(tmp.glob('*.md'))), 50)
        self.assertFalse((tmp / 'old00.md').exists(), 'oldest exports are deleted first')

    # --- G1-6 status ---
    def test_status_reads_live_session_found_by_project_dir(self):
        env = self.project(self.conversation(2, 230_000) + [ready('x', 230_000)])
        (text,) = self.mcp([('recall_status', {})], env=env)
        self.assertIn(f'session_id={SID}', text)
        self.assertIn('230.0K', text)
        self.assertIn('pressure', text)
        self.assertIn('compact_ready 已调用（本次压缩周期内）: 是', text)

    # --- G2-7 rules ---
    def test_rules_follow_kernel_semantics_and_survive_compaction(self):
        history = [tool_call(RULE, {'action': 'add', 'text': '永远先读再写'}, 100_000, 'a1'), tool_result('ok', 'a1'),
                   tool_call(RULE, {'action': 'add', 'text': '临时规则'}, 100_000, 'a2'), tool_result('ok', 'a2')]
        pending = tool_call(RULE, {'action': 'delete', 'id': 'rule2'}, 100_000, 'a3')
        env = self.project(history + [pending])
        errs = []
        deleted, listed, dup, bad = self.mcp([('recall_rule', {'action': 'delete', 'id': 'rule2'}),
                                              ('recall_rule', {'action': 'list'}),
                                              ('recall_rule', {'action': 'add', 'text': '永远先读再写'}),
                                              ('recall_rule', {'action': 'delete', 'id': 'rule9'})], env=env, errors=errs)
        self.assertIn('Deleted [rule2] 临时规则', deleted)
        self.assertIn('[rule1] 永远先读再写', listed)
        self.assertIn('identical rule already exists (rule1)', dup)
        self.assertIn('no rule with id "rule9"', bad)

        self.write(self.conversation(2, 100_000) + history + [pending, tool_result('ok', 'a3'),
                   tool_call(RULE, {'action': 'add', 'text': '第三条'}, 100_000, 'a4'), tool_result('ok', 'a4')])
        self.hook('precompact', trigger='manual')
        block = self.context(self.hook('restore', '7'))
        self.assertIn('# Persistent rules (recorded via recall_rule', block)
        self.assertIn('- [rule1] 永远先读再写', block)
        self.assertIn('- [rule3] 第三条', block, 'ids keep counting after a delete')
        self.assertNotIn('临时规则', block)

    # --- G2-8 todos ---
    def test_latest_todo_list_restored(self):
        old = tool_call('TodoWrite', {'todos': [{'content': '旧待办', 'status': 'pending'}]}, 100_000, 'w1')
        new = tool_call('TodoWrite', {'todos': [{'content': '写测试', 'status': 'completed'},
                                                {'content': '跑实机', 'status': 'in_progress'}]}, 100_000, 'w2')
        self.write(self.conversation(2, 100_000) + [old, tool_result('ok', 'w1'), new, tool_result('ok', 'w2')])
        self.hook('precompact', trigger='manual')
        block = self.context(self.hook('restore', '8'))
        self.assertIn('- [in_progress] 跑实机', block)
        self.assertIn('- [completed] 写测试', block)
        self.assertNotIn('旧待办', block)

    def test_task_tools_restored_and_all_done_list_skipped(self):
        self.write(self.conversation(1, 100_000) + [
            tool_call('TaskCreate', {'subject': '甲'}, 100_000, 'c1'), tool_result('Task #1 created successfully: 甲', 'c1'),
            tool_call('TaskCreate', {'subject': '乙'}, 100_000, 'c2'), tool_result('Task #2 created successfully: 乙', 'c2'),
            tool_call('TaskUpdate', {'taskId': '1', 'status': 'completed'}, 100_000, 'c3'), tool_result('ok', 'c3')])
        self.hook('precompact', trigger='manual')
        block = self.context(self.hook('restore', '8'))
        self.assertIn('- [completed] 甲', block)
        self.assertIn('- [pending] 乙', block)
        self.write(self.conversation(1, 100_000) + [
            tool_call('TodoWrite', {'todos': [{'content': '完', 'status': 'completed'}]}, 100_000, 'w')])
        self.hook('precompact', trigger='manual')
        self.assertIsNone(self.context(self.hook('restore', '8')))

    # --- G2-9 forged markers ---
    def test_forged_ready_markers_do_not_count(self):
        forged = [user(f'{READY} 已调用'), reply(f'我调用了 {READY}({{"summary": "x"}})', 260_000),
                  tool_call('Read', {'file_path': READY}, 260_000, 'f'), tool_result(f'{READY} tool_use', 'f'),
                  reply('<tool_use name="compact_ready">', 260_000)]
        self.write(self.conversation(2, 260_000) + forged)
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 2)
        self.assertIsNotNone(self.context(self.hook('nudge', hook_event_name='PostToolUse')))
        self.write(self.conversation(2, 260_000) + forged + [ready('real', 260_000)])
        self.assertEqual(self.hook('precompact', trigger='auto').returncode, 0)

    # --- G2-10 absorb ---
    def test_absorb_reminder_for_large_builtin_output_past_soft(self):
        self.write(self.conversation(2, 160_000))
        self.hook('nudge', hook_event_name='PostToolUse')  # consume the growth nudge
        big = {'type': 'text', 'file': {'content': 'z' * 20_000}}
        text = self.context(self.hook('nudge', hook_event_name='PostToolUse', tool_name='Read', tool_response=big))
        self.assertTrue(text.startswith('[recall absorb]'))
        self.assertIn('stays in context until the next compaction', text)
        self.assertIsNone(self.context(self.hook('nudge', hook_event_name='PostToolUse', tool_name='mcp__x__y',
                                                 tool_response=big)))
        self.assertIsNone(self.context(self.hook('nudge', hook_event_name='PostToolUse', tool_name='Read',
                                                 tool_response='small')))
        self.write(self.conversation(2, 100_000))
        self.assertIsNone(self.context(self.hook('nudge', hook_event_name='PostToolUse', tool_name='Read',
                                                 tool_response=big)))
        self.assertEqual([e['event'] for e in self.events()], ['nudge', 'absorb'])


for _name in [n for n in dir(RecallTest) if n.startswith('test_')]:
    setattr(V2Test, _name, None)  # run only the v2 cases here; the base cases run in test_recall
del RecallTest

if __name__ == '__main__':
    unittest.main()
