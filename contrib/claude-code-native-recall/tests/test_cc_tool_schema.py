import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'plugin'/'recall'))
import mcp_server,native_read

class CCToolSchemaTest(unittest.TestCase):
    def test_cc_receives_recall_get_without_root_union(self):
        tool=next(t for t in mcp_server.handle({'method':'tools/list'})['tools'] if t['name']=='recall_get')
        self.assertEqual(tool['inputSchema']['type'],'object')
        self.assertFalse(set(tool['inputSchema']) & {'anyOf','oneOf','allOf'})
        self.assertIn('turn',tool['inputSchema']['properties'])
        self.assertIn('locator',tool['inputSchema']['properties'])

    def test_missing_selector_fails_before_archive_access(self):
        r=mcp_server.handle({'method':'tools/call','params':{'name':'recall_get','arguments':{}}})
        self.assertTrue(r['isError'])
        self.assertEqual(r['structuredContent']['error'],'invalid_argument')
