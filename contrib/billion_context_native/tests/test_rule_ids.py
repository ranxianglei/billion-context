"""Offline regressions for acknowledged rule identities and transcript replay."""
from concurrent.futures import ThreadPoolExecutor
import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import mcp_server
import archive
import store

RULE = 'mcp__plugin_billion_context_native_native__recall_rule'


def history(calls, results=None):
    entries = [{'type': 'assistant', 'uuid': 'rules-assistant', 'message': {
        'role': 'assistant', 'content': [{'type': 'tool_use', 'id': cid, 'name': RULE, 'input': args}
                                         for cid, args in calls]}}]
    if results:
        entries.append({'type': 'user', 'uuid': 'rules-results', 'message': {
            'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': cid,
                                        'content': text, 'is_error': False} for cid, text in results]}})
    return entries


def acknowledged_id(text):
    return re.fullmatch(r'Recorded \[(rule\d+)\] .+', text).group(1)


class RuleIdentityTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='recall-rule-ids-')
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {'RECALL_HOME': temp.name})
        env.start()
        self.addCleanup(env.stop)
        self.root = pathlib.Path(temp.name)

    def parallel_add(self, texts, entries=None):
        args = [{'action': 'add', 'text': text} for text in texts]
        with patch.object(mcp_server, '_live', return_value=('rules-session', entries or [])):
            with ThreadPoolExecutor(max_workers=len(args)) as executor:
                results = list(executor.map(mcp_server.rule, args))
        return args, results

    def test_parallel_adds_replay_and_delete_by_the_acknowledged_id(self):
        args, results = self.parallel_add(['ALPHA', 'BETA'])
        ids = [acknowledged_id(result) for result in results]
        self.assertEqual(len(set(ids)), 2, 'each acknowledged addition must keep its own identity')
        entries = history(list(zip(('alpha', 'beta'), args)), list(zip(('beta', 'alpha'), reversed(results))))
        state = store.replay_rules(entries, completed_only=True)
        self.assertEqual(state['rules'], [{'id': ids[0], 'text': 'ALPHA'}, {'id': ids[1], 'text': 'BETA'}])
        with patch.object(mcp_server, '_live', return_value=('rules-session', entries)):
            deleted = mcp_server.rule({'action': 'delete', 'id': ids[1]})
        self.assertEqual(deleted, f'Deleted [{ids[1]}] BETA')
        entries += history([('delete-beta', {'action': 'delete', 'id': ids[1]})], [('delete-beta', deleted)])
        entries[-2]['uuid'] = 'delete-assistant'
        entries[-1]['uuid'] = 'delete-result'
        self.assertEqual(store.replay_rules(entries, completed_only=True)['rules'], [{'id': ids[0], 'text': 'ALPHA'}])

    def test_parallel_identical_adds_keep_both_acknowledged_ids(self):
        args, results = self.parallel_add(['SAME TEXT', 'SAME TEXT'])
        entries = history(list(zip(('one', 'two'), args)), list(zip(('one', 'two'), results)))
        state = store.replay_rules(entries, completed_only=True)
        self.assertEqual(state['rules'], [{'id': acknowledged_id(result), 'text': 'SAME TEXT'} for result in results])

    def test_parallel_adds_at_limit_do_not_lose_a_successful_acknowledgment(self):
        calls = [(f'old-{i}', {'action': 'add', 'text': f'OLD-{i}'}) for i in range(store.MAX_RULES - 1)]
        entries = history(calls, [(cid, 'ok') for cid, _ in calls])
        args, results = self.parallel_add(['ALPHA', 'BETA'], entries)
        new = history(list(zip(('alpha', 'beta'), args)), list(zip(('alpha', 'beta'), results)))
        new[0]['uuid'] = 'new-assistant'
        new[1]['uuid'] = 'new-results'
        state = store.replay_rules(entries + new, completed_only=True)
        self.assertEqual(len(state['rules']), store.MAX_RULES + 1)
        self.assertEqual([r['id'] for r in state['rules'][-2:]], [acknowledged_id(result) for result in results])
        self.assertTrue(store.apply_rule(state, {'action': 'add', 'text': 'EXTRA'}).startswith('Error: rule limit'))

    def test_rejected_application_results_are_not_replayed_as_mutations(self):
        calls = [('rejected', {'action': 'add', 'text': 'REJECTED'}),
                 ('one', {'action': 'add', 'text': 'KEPT'}),
                 ('rejected-delete', {'action': 'delete', 'id': 'rule1'})]
        entries = history(calls, [('rejected', 'Error: rule limit reached (50)'), ('one', 'ok'),
                                  ('rejected-delete', 'Error: no rule with id "rule1"')])
        self.assertEqual(store.replay_rules(entries, completed_only=True)['rules'], [{'id': 'rule1', 'text': 'KEPT'}])

    def test_legacy_results_keep_sequential_ids_after_delete_and_new_ids_do_not_expand_counter(self):
        rid = 'rule229035276993771795771121700399390913955'
        calls = [('one', {'action': 'add', 'text': 'ONE'}), ('two', {'action': 'add', 'text': 'TWO'}),
                 ('delete', {'action': 'delete', 'id': 'rule2'}), ('three', {'action': 'add', 'text': 'THREE'}),
                 ('uuid', {'action': 'add', 'text': 'NEW'}), ('fallback', {'action': 'add', 'text': 'LATER LEGACY'})]
        results = [(cid, f'Recorded [{rid}] NEW' if cid == 'uuid' else 'ok') for cid, _ in calls]
        state = store.replay_rules(history(calls, results), completed_only=True)
        self.assertEqual(state['rules'], [{'id': 'rule1', 'text': 'ONE'}, {'id': 'rule3', 'text': 'THREE'},
                                         {'id': rid, 'text': 'NEW'}, {'id': 'rule5', 'text': 'LATER LEGACY'}])
        self.assertEqual(state['next'], 6)

    def test_native_text_blocks_and_archived_hook_mcp_envelope_keep_the_returned_id(self):
        args = {'action': 'add', 'text': 'LINE ONE\nLINE TWO'}
        rid = 'rule229035276993771795771121700399390913955'
        result = f'Recorded [{rid}] LINE ONE\nLINE TWO'
        for value in (result, [{'type': 'text', 'text': result}]):
            with self.subTest(value=value):
                entries = history([('one', args)], [('one', value)])
                self.assertEqual(store.replay_rules(entries, completed_only=True)['rules'], [{'id': rid, 'text': args['text']}])
        entries = history([('hook-only', args)])
        source = self.root / 'rules-session.jsonl'
        archive.append_cc_hook('rules-session', str(source), 'PostToolUse', {
            'tool_use_id': 'hook-only', 'tool_input': args,
            'tool_response': {'content': [{'type': 'text', 'text': result}], 'isError': False}})
        with patch.object(mcp_server, '_live', return_value=('rules-session', entries)):
            self.assertIn(f'[{rid}] LINE ONE\nLINE TWO', mcp_server.rule({'action': 'list'}))

    def test_archived_mcp_application_error_is_not_replayed(self):
        args = {'action': 'add', 'text': 'REJECTED'}
        entries = history([('hook-error', args)])
        archive.append_cc_hook('rules-session', str(self.root / 'rules-session.jsonl'), 'PostToolUse', {
            'tool_use_id': 'hook-error', 'tool_input': args,
            'tool_response': {'isError': True, 'content': [{'type': 'text', 'text': 'failed'}]}})
        self.assertEqual(store.replay_rules(entries, completed_only=True, sid='rules-session')['rules'], [])

    def test_legacy_counter_skips_acknowledged_numeric_holes_after_delete_or_clear(self):
        for operation in ({'action': 'clear'}, {'action': 'delete', 'id': 'rule7'}):
            with self.subTest(operation=operation):
                calls = [('seven', {'action': 'add', 'text': 'SEVEN'}), ('remove', operation)]
                calls += [(f'legacy-{i}', {'action': 'add', 'text': f'LEGACY {i}'}) for i in range(8)]
                results = [(cid, 'Recorded [rule7] SEVEN' if cid == 'seven' else 'ok') for cid, _ in calls]
                state = store.replay_rules(history(calls, results), completed_only=True)
                self.assertEqual([r['id'] for r in state['rules']], [f'rule{i}' for i in (2, 3, 4, 5, 6, 8, 9, 10)])
                self.assertEqual(state['next'], 11)

    def test_malformed_and_reused_acknowledgments_fail_without_reassigning_ids(self):
        for result in ('Recorded [] ALPHA', 'Recorded [rule1] WRONG TEXT'):
            with self.subTest(result=result), self.assertRaisesRegex(ValueError, 'Invalid recall_rule acknowledgment'):
                store.replay_rules(history([('one', {'action': 'add', 'text': 'ALPHA'})], [('one', result)]), completed_only=True)
        calls = [('one', {'action': 'add', 'text': 'ALPHA'}), ('clear', {'action': 'clear'}),
                 ('two', {'action': 'add', 'text': 'BETA'})]
        results = [('one', 'Recorded [rule1] ALPHA'), ('clear', 'Cleared 1 rules.'), ('two', 'Recorded [rule1] BETA')]
        with self.assertRaisesRegex(ValueError, 'Conflicting recall_rule acknowledgment for rule1'):
            store.replay_rules(history(calls, results), completed_only=True)

    def test_failed_unknown_and_repeated_evidence_do_not_create_rules_twice(self):
        args = {'action': 'add', 'text': 'ALPHA'}
        unknown = history([('one', args)])
        self.assertEqual(store.replay_rules(unknown, completed_only=True)['rules'], [])
        entries = history([('one', args)], [('one', 'Recorded [rule7] ALPHA')])
        entries[-1]['message']['content'][0]['is_error'] = True
        self.assertEqual(store.replay_rules(entries, completed_only=True)['rules'], [])
        entries[-1]['message']['content'][0]['is_error'] = False
        self.assertEqual(store.replay_rules(entries + entries, completed_only=True)['rules'], [{'id': 'rule7', 'text': 'ALPHA'}])


if __name__ == '__main__':
    unittest.main()
