"""Independent adversarial tests. Synthetic only; no model/host DB/network use."""
import concurrent.futures
import copy
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import archive
import opencode_bridge as bridge
import transcript
import mcp_server

NODE = shutil.which('node')
ADAPTER = PLUGIN.parents[1] / 'opencode' / 'index.js'

NODE_REVIEW = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [adapterPath, root, python, bridgePath, whichCase] = process.argv.slice(2);
const adapter = (await import(pathToFileURL(adapterPath))).default;
const project=path.join(root,'synthetic-project');
const other=path.join(root,'other-project');fs.mkdirSync(other);
const sid='ses_synthetic_js_review';
let location=project, parentID=null, reads=0;
const hooks={}, toolHooks={};
const home=path.join(root,'js-archive');
const ctx={
 app:{version:'2.2.5'},location:{directory:project},
 options:{enabled:true,projects:[project],sessions:[sid],archiveHome:home,python,bridgePath},
 session:{hook:async(n,fn)=>{hooks[n]=fn;},
  get:async({sessionID})=>{reads++;return {id:sessionID,parentID,location:{directory:location}};},
  context:async()=>[{id:'msg_001',type:'user',text:'SYNTHETIC NATIVE USER',time:{created:1}}]},
 tool:{hook:async(n,fn)=>{toolHooks[n]=fn;}},
 // A live native subscription stays open until adapter disposal. Immediate
 // iteration completion is an event-stream failure, tested separately below.
 event:{async *subscribe({signal}){
  if (!signal.aborted) await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 }},
};
function rawRecords(){
 const p=path.join(home,sid,'events.jsonl');
 return fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
}
if(whichCase==='optin'){
 const noCtx={options:{},location:{directory:'/must-not-be-read'}};
 await adapter.setup(noCtx);assert(!fs.existsSync(home));
 const invalid={...ctx,options:{...ctx.options,sessions:[]}};
 await assert.rejects(adapter.setup(invalid));assert(!fs.existsSync(home));
 const unselected={...ctx,options:{...ctx.options,projects:[other]}};
 await adapter.setup(unselected);assert.equal(Object.keys(hooks).length,0);assert(!fs.existsSync(home));
 const clean=await adapter.setup(ctx);
 await hooks.context({sessionID:'ses_unselected'});assert.equal(reads,0);assert.equal(rawRecords().length,0);
 parentID='ses_parent';await hooks.context({sessionID:sid});assert.equal(rawRecords().length,0);
 await clean();
}else if(whichCase==='move'){
 const clean=await adapter.setup(ctx);
 await hooks.context({sessionID:sid});const count=rawRecords().length;assert(count>0);
 location=other;await hooks.context({sessionID:sid});assert.equal(rawRecords().length,count);assert(reads>=2);
 await clean();
}else if(whichCase==='failure'){
 const fake=path.join(root,'fake-bridge.py');
 fs.writeFileSync(fake,'import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({"ok":True,"durable":True,"session_id":"ses_wrong","host":"opencode","main_session":True}))\n');
 ctx.options.bridgePath=fake;
 const clean=await adapter.setup(ctx);
 // This is a fake caller, not a native OpenCode lifecycle. Recall's archive
 // failure must be isolated while the host hook continues without rollback.
 const hostState={alreadyDiscarded:true};
 await hooks.compaction({sessionID:sid,messages:[]});
 assert.equal(hostState.alreadyDiscarded,true);assert.equal(rawRecords().length,0);
 await clean();
 const audit=fs.readFileSync(path.join(home,'opencode-adapter-status.jsonl'),'utf8');
 assert(audit.includes('invalid_ack_identity'));assert(audit.includes('degraded'));
 assert(!audit.includes('"event":"durable_ack"'));
}else if(whichCase==='rawtool'){
 const clean=await adapter.setup(ctx);
 const input={payload:'I'.repeat(4500)+'INPUT_PROOF_SYNTHETIC'};
 const output='O'.repeat(12500)+'OUTPUT_PROOF_SYNTHETIC';
 const payload={sessionID:sid,messageID:'msg_002',id:'call_synthetic',tool:'SyntheticAudit',
  input,status:'completed',result:{output,content:[{type:'text',text:'HOST_BOUNDED'}]}};
 await toolHooks['execute.after'](payload);
 // Activation may independently append a selected-session snapshot. Assert the
 // raw hook fact itself, without assuming this is the only archive writer.
 const records=rawRecords().filter(r=>r.entry.kind==='tool.raw');
 assert.equal(records.length,1);assert.deepEqual(records[0].entry.payload,payload);
 await clean();
}else if(whichCase==='streamclosed'){
 ctx.event={async *subscribe(){}};
 const clean=await adapter.setup(ctx);
 await hooks.context({sessionID:sid});
 await clean();
 const audit=fs.readFileSync(path.join(home,'opencode-adapter-status.jsonl'),'utf8');
 assert(audit.includes('event_stream_closed'));assert(audit.includes('degraded'));
 assert(!rawRecords().some(r=>r.entry.kind==='barrier'));
}else if(whichCase==='lookupfailure'){
 ctx.session.get=async()=>{throw new Error('SYNTHETIC SESSION LOOKUP FAILURE');};
 const clean=await adapter.setup(ctx);
 const input={sessionID:sid,messageID:'msg_002',id:'call_synthetic',tool:'SyntheticAudit',input:{synthetic:true}};
 const before=JSON.stringify(input);
 await hooks.context({sessionID:sid});
 await hooks.compaction({sessionID:sid,messages:[]});
 await toolHooks['execute.before'](input);
 assert.equal(JSON.stringify(input),before);assert.equal(rawRecords().length,0);
 await clean();
 const audit=fs.readFileSync(path.join(home,'opencode-adapter-status.jsonl'),'utf8');
 assert(audit.includes('degraded'));assert(!audit.includes('"event":"durable_ack"'));
}else throw new Error('Unknown local review case');
console.log(JSON.stringify({case:whichCase,status:'PASS',synthetic_mock_hooks:true,model_requests:0}));
'''


class OpenCodeIndependentReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recall-native-review-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.project = self.root / 'synthetic-project'
        self.project.mkdir()
        self.sid = 'ses_synthetic_independent_review'
        self.env_patch = patch.dict(os.environ, {'RECALL_HOME': str(self.root / 'recall'),
                                                'RECALL_PROJECTS': str(self.root / 'empty-host-projects'),
                                                'CLAUDE_PROJECT_DIR': str(self.project)})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def observation(self, label='ORIGINAL', revision=1, message='msg_synthetic'):
        return {
            'kind': 'message',
            'identity': {'message_id': message},
            'revision': {'updated': revision},
            'payload': {'sessionID': self.sid, 'id': message, 'role': 'assistant',
                        'parts': [{'id': 'part_synthetic', 'type': 'text', 'text': label}]},
            'origin': 'independent-synthetic-test', 'observed_at': '2026-11-01T00:00:01Z',
        }

    def request(self, records=None, **overrides):
        return {'operation': 'append', 'session_id': self.sid, 'project': str(self.project),
                'records': [self.observation()] if records is None else records, **overrides}

    def run_bridge(self, request):
        # Pass a minimal synthetic environment; no inherited provider/host credentials.
        env = {'RECALL_HOME': str(self.root / 'recall'), 'PYTHONDONTWRITEBYTECODE': '1',
               'PATH': os.defpath, 'LANG': 'C.UTF-8'}
        proc = subprocess.run([sys.executable, str(PLUGIN / 'opencode_bridge.py')],
                              input=json.dumps(request), text=True, capture_output=True,
                              env=env, timeout=30)
        self.assertEqual(proc.stderr, '')
        return proc.returncode, json.loads(proc.stdout)

    def test_unknown_status_and_barrier_never_acknowledge_or_create_archive(self):
        directory = archive.session_dir(self.sid)
        for operation in ['status', 'barrier']:
            rc, result = self.run_bridge(self.request([], operation=operation))
            self.assertNotEqual(rc, 0)
            self.assertFalse(result['ok'])
            self.assertFalse(result['durable'])
            self.assertFalse(directory.exists())

    def test_duplicate_observation_is_idempotent_across_bridge_process_restart(self):
        first = self.observation()
        rc, result = self.run_bridge(self.request([first]))
        self.assertEqual(rc, 0)
        self.assertEqual(result['appended'], 1)
        repeated = copy.deepcopy(first)
        repeated['observed_at'] = '2026-11-01T00:00:09Z'
        repeated['origin'] = 'new-process-observation'
        rc, result = self.run_bridge(self.request([repeated]))
        self.assertEqual(rc, 0)
        self.assertEqual(result['appended'], 0)
        self.assertEqual(archive.entries(self.sid), [first])

    def test_same_revision_conflicts_and_late_older_observation_are_all_retained(self):
        newer = self.observation('NEWER', 7)
        conflict = self.observation('SAME_REVISION_DIFFERENT_FACT', 7)
        older = self.observation('LATE_OLDER', 3)
        for value in [newer, conflict, older, newer]:
            bridge.handle(self.request([value]))
        self.assertEqual(archive.entries(self.sid), [newer, conflict, older])
        self.assertEqual([r['seq'] for r in archive.records(self.sid)], [1, 2, 3])

    def test_project_parent_and_host_scope_cannot_be_overwritten(self):
        bridge.handle(self.request())
        before = (archive.session_dir(self.sid) / 'events.jsonl').read_bytes()
        other = self.root / 'other-project'
        other.mkdir()
        for overrides in [dict(project=str(other)), dict(parent_id='ses_other_parent')]:
            with self.assertRaises(ValueError):
                bridge.handle(self.request(**overrides))
            self.assertEqual((archive.session_dir(self.sid) / 'events.jsonl').read_bytes(), before)
        spoof = self.observation('SPOOF_ATTEMPT', 2)
        spoof['identity'].update(host='claude', project=str(other), session='ses_other',
                                 branch='child', parent_session='ses_fake')
        bridge.handle(self.request([spoof]))
        identity = archive.records(self.sid)[-1]['identity']
        self.assertEqual(identity['host'], 'opencode')
        self.assertEqual(identity['project'], str(self.project))
        self.assertEqual(identity['session'], self.sid)
        self.assertEqual(identity['branch'], 'main')
        self.assertIsNone(identity['parent_session'])

    def test_foreign_payload_session_rejected_atomically_before_first_append(self):
        good = self.observation('GOOD')
        bad = self.observation('FOREIGN', message='msg_foreign')
        bad['payload']['sessionID'] = 'ses_foreign'
        with self.assertRaises(ValueError):
            bridge.handle(self.request([good, bad]))
        self.assertFalse(archive.session_dir(self.sid).exists())
        wrapped = self.observation()
        wrapped['payload'] = {'data': {'sessionID': 'ses_foreign'}}
        with self.assertRaises(ValueError):
            bridge.handle(self.request([wrapped]))

    def test_json_and_path_validation_fail_without_echoing_synthetic_payload(self):
        sentinel = 'DO_NOT_ECHO_SYNTHETIC_CONTENT'
        bad = self.observation(sentinel)
        bad['payload']['not_json'] = float('nan')
        rc, result = self.run_bridge(self.request([bad]))
        self.assertNotEqual(rc, 0)
        self.assertFalse(result['durable'])
        self.assertNotIn(sentinel, json.dumps(result))
        for sid in ['../escape', '', '.', 'a/b']:
            rc, result = self.run_bridge(self.request([], session_id=sid))
            self.assertNotEqual(rc, 0)
            self.assertFalse(result['durable'])

    def test_concurrent_duplicate_append_then_deleted_index_rebuild_is_lossless(self):
        records = [self.observation('CONCURRENT_%02d' % i, i, 'msg_%02d' % i) for i in range(6)]
        requests = [self.request([record]) for record in records for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(self.run_bridge, requests))
        self.assertTrue(all(rc == 0 and result['durable'] for rc, result in results))
        self.assertEqual(len(archive.entries(self.sid)), 6)
        raw = archive.session_dir(self.sid) / 'events.jsonl'
        before = raw.read_bytes()
        index = archive.session_dir(self.sid) / 'index.sqlite3'
        index.unlink()
        rc, result = self.run_bridge(self.request(records))
        self.assertEqual(rc, 0)
        self.assertEqual(result['appended'], 0)
        self.assertEqual(raw.read_bytes(), before)
        self.assertEqual(len(archive.records(self.sid)), 6)

    def test_failed_fsync_never_returns_durable_ack_and_retry_recovers(self):
        value = self.observation('FSYNC_BOUNDARY')
        with patch.object(archive.os, 'fsync', side_effect=OSError('synthetic fsync failure')):
            with self.assertRaises(OSError):
                bridge.handle(self.request([value]))
        result = bridge.handle(self.request([value]))
        self.assertTrue(result['durable'])
        self.assertEqual(archive.entries(self.sid), [value])


    def native_message(self, mid, kind, text=None, content=None, completed=None):
        payload = {'id': mid, 'type': kind, 'time': {'created': 1 if kind == 'user' else 2}}
        if text is not None:
            payload['text'] = text
        if content is not None:
            payload['content'] = content
        if completed is not None:
            payload['time']['completed'] = completed
        return {'kind': 'message', 'identity': {'message_id': mid}, 'payload': payload,
                'revision': copy.deepcopy(payload['time']), 'origin': 'independent-native-view'}

    def test_empty_snapshot_does_not_make_unknown_barrier_successful(self):
        bridge.handle(self.request([], operation='snapshot'))
        rc, result = self.run_bridge(self.request([], operation='barrier'))
        self.assertNotEqual(rc, 0)
        self.assertFalse(result['durable'])

    def test_projection_preserves_conflicting_versions_and_late_delivery(self):
        user = self.native_message('msg_001', 'user', text='SYNTHETIC QUESTION')
        a = self.native_message('msg_002', 'assistant', content=[{'type': 'text', 'text': 'FINAL_A'}], completed=4)
        b = self.native_message('msg_002', 'assistant', content=[{'type': 'text', 'text': 'FINAL_B'}], completed=4)
        old = self.native_message('msg_002', 'assistant', content=[{'type': 'text', 'text': 'FIN'}])
        for value in [user, a, b, old, a]:
            bridge.handle(self.request([value]))
        turns = transcript.load_archive(self.sid)
        self.assertEqual(len(turns), 1)
        self.assertIn('FINAL_A', turns[0]['text'])
        self.assertIn('FINAL_B', turns[0]['text'])
        self.assertIn('msg_002', turns[0]['conflicts'])
        self.assertEqual(len(archive.entries(self.sid)), 4)

    def test_streaming_snapshots_and_raw_tool_long_values_survive_source_free_restart(self):
        long_input = {'payload': 'RAW_ARGUMENT_START' + 'I' * 4500 + 'INPUT_END_MARKER'}
        long_output = 'RAW_RESULT_START' + 'O' * 12500 + 'OUTPUT_END_MARKER'
        user = self.native_message('msg_001', 'user', text='LONG SYNTHETIC TOOL AUDIT')
        partial = self.native_message('msg_002', 'assistant', content=[{'type': 'text', 'text': 'Preparing'}])
        final = self.native_message('msg_002', 'assistant', content=[
            {'type': 'text', 'text': 'Preparing full synthetic tool audit'},
            {'type': 'tool', 'id': 'call_synthetic', 'name': 'SyntheticAudit',
             'state': {'status': 'completed', 'input': {'payload': 'HOST_BOUNDED_INPUT'},
                       'content': [{'type': 'text', 'text': 'HOST_BOUNDED_OUTPUT'}]}},
        ], completed=4)
        raw = {'kind': 'tool.raw', 'identity': {'message_id': 'msg_002', 'tool_call_id': 'call_synthetic'},
               'payload': {'sessionID': self.sid, 'messageID': 'msg_002', 'id': 'call_synthetic',
                           'tool': 'SyntheticAudit', 'input': long_input, 'status': 'completed',
                           'result': {'output': long_output,
                                      'content': [{'type': 'text', 'text': 'HOST_BOUNDED_OUTPUT'}]}}}
        for value in [user, partial, raw, final, partial]:
            bridge.handle(self.request([value]))
        directory = archive.session_dir(self.sid)
        # Disposable projections must never replace the raw archive as authority.
        (directory / 'turns.jsonl').write_text(json.dumps({'text': 'STALE_DERIVED_CACHE'}) + '\n')
        (directory / 'index.sqlite3').unlink()
        env = {'RECALL_HOME': str(self.root / 'recall'), 'PYTHONDONTWRITEBYTECODE': '1',
               'PATH': os.defpath, 'LANG': 'C.UTF-8'}
        code = ('import sys,json;sys.path.insert(0,sys.argv[1]);import transcript;'
                'print(json.dumps(transcript.load_archive(sys.argv[2]),ensure_ascii=False))')
        proc = subprocess.run([sys.executable, '-c', code, str(PLUGIN), self.sid],
                              text=True, capture_output=True, env=env, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        turns = json.loads(proc.stdout)
        self.assertEqual(len(turns), 1)
        text = turns[0]['text']
        self.assertIn(json.dumps(long_input, ensure_ascii=False), text)
        self.assertIn(long_output, text)
        self.assertIn('Preparing full synthetic tool audit', text)
        self.assertNotIn('STALE_DERIVED_CACHE', text)
        self.assertEqual(turns[0]['tools']['SyntheticAudit'], 1)
        self.assertEqual(len(archive.entries(self.sid)), 4)

    def test_child_native_facts_are_retained_but_not_mixed_into_main_turns(self):
        child = self.native_message('msg_001', 'user', text='CHILD_PRIVATE_SYNTHETIC_MARKER')
        bridge.handle(self.request([child], parent_id='ses_synthetic_parent'))
        self.assertEqual(archive.entries(self.sid), [child])
        self.assertEqual(transcript.load_archive(self.sid), [])

    def run_adapter_case(self, case):
        if NODE is None:
            self.skipTest('Node runtime not installed; Python core checks remain independent')
        script = self.root / 'adapter-review.mjs'
        script.write_text(NODE_REVIEW, encoding='utf-8')
        env = {'PATH': os.defpath, 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        proc = subprocess.run([NODE, str(script), str(ADAPTER), str(self.root),
                               sys.executable, str(PLUGIN / 'opencode_bridge.py'), case],
                              text=True, capture_output=True, env=env, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['model_requests'], 0)
        self.assertTrue(result['synthetic_mock_hooks'])

    def test_adapter_requires_explicit_optin_project_session_and_excludes_children(self):
        self.run_adapter_case('optin')

    def test_adapter_rechecks_native_session_project_after_move(self):
        self.run_adapter_case('move')

    def test_adapter_wrong_session_ack_degrades_without_blocking_compaction_hook(self):
        self.run_adapter_case('failure')

    def test_adapter_archives_raw_long_tool_result_before_bounded_content(self):
        self.run_adapter_case('rawtool')

    def test_adapter_unexpected_event_stream_close_degrades_without_blocking_host(self):
        self.run_adapter_case('streamclosed')

    def test_adapter_session_lookup_failure_never_blocks_host_model_tool_or_compaction(self):
        self.run_adapter_case('lookupfailure')

    def test_missing_native_recall_get_returns_error_instead_of_ready_or_empty_success(self):
        result = mcp_server.handle({'method': 'tools/call', 'params': {
            'name': 'recall_get', 'arguments': {'session_id': self.sid, 'turn': 1}}})
        self.assertTrue(result['isError'])
        self.assertFalse(archive.session_dir(self.sid).exists())


if __name__ == '__main__':
    unittest.main()
