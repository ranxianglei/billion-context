"""Offline regressions for acknowledged rule identities and transcript replay."""
from concurrent.futures import ThreadPoolExecutor
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
import mcp_server
import archive
import hook
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

    def conflicting_history(self):
        calls = [('alpha', {'action': 'add', 'text': 'ALPHA'}), ('beta', {'action': 'add', 'text': 'BETA'})]
        return history(calls, [('alpha', 'Recorded [rule1] ALPHA'), ('beta', 'Recorded [rule1] BETA')])

    def append_call(self, entries, cid, args, result=None):
        new = history([(cid, args)], [(cid, result)] if result is not None else None)
        for i, entry in enumerate(new):
            entry['uuid'] = f'{cid}-{i}'
        return entries + new

    def test_recovery_status_keeps_metrics_and_clear_is_available_before_reset_persists(self):
        entries = self.conflicting_history()
        with patch.object(mcp_server, '_live', return_value=('rules-session', entries)):
            status = mcp_server.status({})
            self.assertIn('session_id=rules-session', status)
            self.assertIn('Context:', status)
            self.assertIn('rule_conflict', status)
            for args in ({'action': 'list'}, {'action': 'add', 'text': 'NEW'}, {'action': 'delete', 'id': 'rule1'}):
                self.assertTrue(mcp_server.rule(args).startswith('Error: rule_conflict'))
            ack = mcp_server.rule({'action': 'clear'})
        self.assertEqual(ack, 'Cleared all rules and unresolved rule conflicts. Previous rule IDs remain reserved.')
        self.assertIn('conflict', store.replay_rules(entries, completed_only=True))

    def test_recovery_save_replaces_stale_projection_and_restore_reports_conflict(self):
        sid = 'rules-session'
        directory = archive.session_dir(sid)
        directory.mkdir(parents=True)
        stale = {'rules': [{'id': 'rule99', 'text': 'STALE RULE'}], 'next': 100}
        (directory / 'rules.json').write_text(json.dumps(stale), encoding='utf-8')
        self.assertEqual(store.save_rules(sid, self.conflicting_history()), 0)
        state = json.loads((directory / 'rules.json').read_text(encoding='utf-8'))
        self.assertEqual(state['rules'], [])
        self.assertIn('conflict', state)
        self.assertIn('rule_conflict', store.rules_block(sid))
        self.assertNotIn('STALE RULE', store.rules_block(sid))

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
            with self.subTest(result=result):
                state = store.replay_rules(history([('one', {'action': 'add', 'text': 'ALPHA'})], [('one', result)]), completed_only=True)
                self.assertEqual(state['rules'], [])
                self.assertEqual(state['conflict'], 'Invalid recall_rule acknowledgment')
        calls = [('one', {'action': 'add', 'text': 'ALPHA'}), ('clear', {'action': 'clear'}),
                 ('two', {'action': 'add', 'text': 'BETA'})]
        results = [('one', 'Recorded [rule1] ALPHA'), ('clear', 'Cleared 1 rules.'), ('two', 'Recorded [rule1] BETA')]
        state = store.replay_rules(history(calls, results), completed_only=True)
        self.assertEqual(state['rules'], [])
        self.assertEqual(state['conflict'], 'Conflicting recall_rule acknowledgment for rule1')

    def test_recovery_successful_reset_then_add_list_delete_and_repeated_evidence(self):
        entries = self.conflicting_history()
        with patch.object(mcp_server, '_live', return_value=('rules-session', entries)):
            ack = mcp_server.rule({'action': 'clear'})
        reset = self.append_call(entries, 'reset', {'action': 'clear'}, ack)
        state = store.replay_rules(reset + reset, completed_only=True)
        self.assertNotIn('conflict', state)
        self.assertEqual(state['rules'], [])
        with patch.object(mcp_server, '_live', return_value=('rules-session', reset)):
            added = mcp_server.rule({'action': 'add', 'text': 'NEW RULE'})
        rid = acknowledged_id(added)
        self.assertNotEqual(rid, 'rule1')
        active = self.append_call(reset, 'new', {'action': 'add', 'text': 'NEW RULE'}, added)
        with patch.object(mcp_server, '_live', return_value=('rules-session', active)):
            self.assertIn(f'[{rid}] NEW RULE', mcp_server.rule({'action': 'list'}))
            deleted = mcp_server.rule({'action': 'delete', 'id': rid})
        self.assertEqual(deleted, f'Deleted [{rid}] NEW RULE')
        final = self.append_call(active, 'delete-new', {'action': 'delete', 'id': rid}, deleted)
        self.assertEqual(store.replay_rules(final, completed_only=True)['rules'], [])

    def test_recovery_requires_unambiguous_observed_positive_reset_completion(self):
        seed = self.conflicting_history()
        failed = self.append_call(seed, 'reset', {'action': 'clear'}, store.RULE_RESET_ACK)
        failed[-1]['message']['content'][0]['is_error'] = True
        rejected = self.append_call(seed, 'reset', {'action': 'clear'}, 'Error: reset rejected')
        missing = self.append_call(seed, 'reset', {'action': 'clear'})
        generic = self.append_call(seed, 'reset', {'action': 'clear'}, 'ok')
        unrelated = self.append_call(seed, 'not-reset', {'action': 'list'}, store.RULE_RESET_ACK)
        ambiguous = self.append_call(seed, 'reset', {'action': 'clear'}, store.RULE_RESET_ACK)
        conflict = self.append_call([], 'reset', {'action': 'clear'}, 'Error: reset rejected')
        conflict[0]['uuid'] = 'conflicting-reset-owner'
        conflict[1]['uuid'] = 'conflicting-reset-result'
        ambiguous += conflict
        envelope_error = self.append_call(seed, 'reset', {'action': 'clear'})
        envelope_error.append({'type': 'cc_hook_observation', 'hook_event_name': 'PostToolUse', 'data': {
            'tool_use_id': 'reset', 'tool_input': {'action': 'clear'},
            'tool_response': {'isError': True, 'content': [{'type': 'text', 'text': store.RULE_RESET_ACK}]}}})
        for name, rows in (('failed', failed), ('rejected', rejected), ('missing', missing), ('generic', generic),
                           ('unrelated', unrelated), ('ambiguous', ambiguous), ('envelope-error', envelope_error)):
            with self.subTest(name=name):
                state = store.replay_rules(rows, completed_only=True)
                self.assertIn('conflict', state)
                self.assertEqual(state['rules'], [])

    def test_recovery_reserves_old_ids_and_accepts_exact_legacy_clear_ack(self):
        seed = self.conflicting_history()
        reset = self.append_call(seed, 'reset', {'action': 'clear'}, 'Cleared 2 rules.')
        old_id = self.append_call(reset, 'reuse', {'action': 'add', 'text': 'NEW'}, 'Recorded [rule1] NEW')
        self.assertIn('conflict', store.replay_rules(old_id, completed_only=True))
        malformed = history([('malformed', {'action': 'add', 'text': 'RIGHT'})], [('malformed', 'Recorded [rule3] WRONG')])
        malformed = self.append_call(malformed, 'reset', {'action': 'clear'}, store.RULE_RESET_ACK)
        for i in range(4):
            malformed = self.append_call(malformed, f'legacy-{i}', {'action': 'add', 'text': f'LEGACY {i}'}, 'ok')
        state = store.replay_rules(malformed, completed_only=True)
        self.assertNotIn('conflict', state)
        self.assertEqual([r['id'] for r in state['rules']], ['rule2', 'rule4', 'rule5', 'rule6'])

    def test_recovery_archive_conflict_survives_source_compaction_and_late_restore(self):
        sid = 'rules-session'
        source = self.root / (sid + '.jsonl')
        first = {'type': 'user', 'uuid': 'original-user', 'message': {'role': 'user', 'content': 'ORIGINAL QUESTION'}}
        rows = [first] + self.conflicting_history()
        source.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        archive.sync(sid, str(source))
        with patch.object(mcp_server.tr, 'find_transcript', return_value=source):
            self.assertIn('rule_conflict', mcp_server.status({}))
        directory = archive.session_dir(sid)
        stale = {'rules': [{'id': 'rule99', 'text': 'STALE RULE'}], 'next': 100}
        (directory / 'rules.json').write_text(json.dumps(stale), encoding='utf-8')
        archive_before = (directory / 'events.jsonl').read_bytes()
        self.assertIn('rule_conflict', store.rules_block(sid))
        self.assertEqual((directory / 'events.jsonl').read_bytes(), archive_before)
        data = {'session_id': sid, 'transcript_path': str(source), 'source': 'resume', 'hook_event_name': 'SessionStart'}
        with patch.object(hook, 'emit_history') as emit:
            hook.restore(data, 7)
        self.assertIn('rule_conflict', emit.call_args.args[2])
        self.assertNotIn('STALE RULE', emit.call_args.args[2])
        self.assertTrue((directory / 'events.jsonl').read_bytes().startswith(archive_before))
        compacted = [{'type': 'system', 'subtype': 'compact_boundary', 'uuid': 'boundary'},
                     {'type': 'user', 'uuid': 'summary', 'isCompactSummary': True,
                      'message': {'role': 'user', 'content': 'COMPACTED SUMMARY'}}]
        source.write_text(''.join(json.dumps(row) + '\n' for row in compacted), encoding='utf-8')
        with patch.object(mcp_server.tr, 'find_transcript', return_value=source):
            self.assertIn('rule_conflict', mcp_server.status({}))
            ack = mcp_server.rule({'action': 'clear'})
        self.assertEqual(store.save_rules(sid, compacted), 0)
        self.assertIn('conflict', json.loads((directory / 'rules.json').read_text(encoding='utf-8')))
        reset = self.append_call(compacted, 'reset', {'action': 'clear'}, ack)
        source.write_text(''.join(json.dumps(row) + '\n' for row in reset), encoding='utf-8')
        with patch.object(mcp_server.tr, 'find_transcript', return_value=source):
            self.assertNotIn('rule_conflict', mcp_server.status({}))
            added = mcp_server.rule({'action': 'add', 'text': 'AFTER RESET'})
        active = self.append_call(reset, 'new', {'action': 'add', 'text': 'AFTER RESET'}, added)
        source.write_text(''.join(json.dumps(row) + '\n' for row in active), encoding='utf-8')
        hook.precompact({**data, 'trigger': 'manual', 'hook_event_name': 'PreCompact'})
        with patch.object(hook, 'emit_history') as emit:
            hook.restore(data, 7)
        self.assertIn(f'[{acknowledged_id(added)}] AFTER RESET', emit.call_args.args[2])
        self.assertNotIn('rule_conflict', emit.call_args.args[2])
        self.assertNotIn('ALPHA', emit.call_args.args[2])

    def test_recovery_keeps_saved_only_legacy_fallback_and_propagates_archive_failures(self):
        sid = 'rules-session'
        directory = archive.session_dir(sid)
        directory.mkdir(parents=True)
        saved = {'rules': [{'id': 'rule7', 'text': 'LEGACY SAVED RULE'}], 'next': 8}
        (directory / 'rules.json').write_text(json.dumps(saved), encoding='utf-8')
        self.assertIn('[rule7] LEGACY SAVED RULE', store.rules_block(sid))
        source = self.root / (sid + '.jsonl')
        auxiliary = history([('other-agent', {'action': 'add', 'text': 'OTHER AGENT'})], [('other-agent', 'ok')])
        auxiliary[0]['agentId'] = 'non-main-agent'
        source.write_text(''.join(json.dumps(row) + '\n' for row in auxiliary), encoding='utf-8')
        archive.sync(sid, str(source))
        self.assertIn('[rule7] LEGACY SAVED RULE', store.rules_block(sid))
        source.write_text('', encoding='utf-8')
        with patch.object(mcp_server.tr, 'find_transcript', return_value=source), \
                patch.object(archive, 'sync', side_effect=OSError('ARCHIVE IO FAILURE')):
            with self.assertRaisesRegex(OSError, 'ARCHIVE IO FAILURE'):
                mcp_server.rule({'action': 'clear'})

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
