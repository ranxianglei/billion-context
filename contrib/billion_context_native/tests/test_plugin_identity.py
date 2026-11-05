"""Installation identity and protocol-safe namespaces for the renamed plugin."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugin' / 'billion_context_native'
sys.path.insert(0, str(PLUGIN))
import mcp_server
import transcript


class PluginIdentityTests(unittest.TestCase):
    def test_all_host_installation_identities_are_canonical(self):
        manifest = json.loads((ROOT / 'plugin/.claude-plugin/plugin.json').read_text())
        market = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        self.assertEqual(manifest['name'], 'billion_context_native')
        self.assertEqual(market['name'], manifest['name'])
        self.assertEqual(market['plugins'][0]['name'], manifest['name'])
        self.assertEqual(market['plugins'][0]['version'], manifest['version'])
        self.assertEqual(market['plugins'][0]['source'], './plugin')
        for host in ['opencode', 'dsh']:
            self.assertEqual(json.loads((ROOT / host / 'package.json').read_text())['name'], manifest['name'])

    def test_cc_namespace_stays_within_tool_reference_limit(self):
        config = json.loads((ROOT / 'plugin/.mcp.json').read_text())
        self.assertEqual(list(config['mcpServers']), ['native'])
        tools = mcp_server.handle({'method': 'tools/list'})['tools']
        self.assertEqual({t['name'] for t in tools}, {'recall_search', 'recall_get', 'compact_ready', 'recall_status', 'recall_rule'})
        for tool in tools:
            qualified = 'mcp__plugin_billion_context_native_native__' + tool['name']
            self.assertLessEqual(len(qualified), 64, qualified)
        server = config['mcpServers']['native']
        self.assertEqual(server['command'], '${RECALL_PYTHON:-python3}')
        entry = server['args'][-1].replace('${CLAUDE_PLUGIN_ROOT}', str(ROOT / 'plugin'))
        self.assertTrue(pathlib.Path(entry).is_file())

    def test_renamed_mcp_entry_initializes_in_fresh_process(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {key: value for key, value in os.environ.items() if not key.startswith(('RECALL_', 'BILLION_CONTEXT_NATIVE_'))}
            env.update(BILLION_CONTEXT_NATIVE_HOME=temp, PYTHONDONTWRITEBYTECODE='1')
            result = subprocess.run([sys.executable, '-X', 'utf8', str(PLUGIN / 'mcp_server.py')],
                input=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n',
                text=True, capture_output=True, env=env, check=True, timeout=10)
            response = json.loads(result.stdout)
            self.assertEqual(response['result']['serverInfo']['name'], 'billion_context_native')

    def test_hooks_use_real_renamed_entry(self):
        config = json.loads((ROOT / 'plugin/hooks/hooks.json').read_text())
        for groups in config['hooks'].values():
            for group in groups:
                for hook in group['hooks']:
                    self.assertIn('${CLAUDE_PLUGIN_ROOT}/billion_context_native/hook.py', hook['command'])
                    self.assertNotIn('${CLAUDE_PLUGIN_ROOT}/recall/', hook['command'])

    def test_old_and_new_ready_names_are_replay_compatible(self):
        names = ['mcp__plugin_billion-claude-recall_recall__compact_ready',
                 'mcp__plugin_billion_context_native_native__compact_ready']
        for name in names:
            call = {'type': 'tool_use', 'id': 'call_ready', 'name': name, 'input': {'summary': 'synthetic'}}
            entries = [{'type': 'assistant', 'message': {'content': [call]}}]
            self.assertEqual(transcript.tool_uses(entries, transcript.READY_SUFFIX), [call])
