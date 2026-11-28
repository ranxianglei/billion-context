import { startServer } from '../../src/server.ts';
import { loadOptions } from '../../src/config.ts';
import { defaultConfig } from 'acp-kernel';
import { SessionStore, _setStoreForTest } from '../../src/persist.ts';
import { listSessions } from '../../src/session.ts';

_setStoreForTest(new SessionStore({ enabled: false }));
const kernelConfig = defaultConfig(400000);
kernelConfig.preserveRecentMessages = 2;
kernelConfig.preserveRecentTokens = 0;
const server = await startServer({ ...loadOptions({}), port: 0, host: '127.0.0.1', upstream: process.argv[2], modelContextLimit: 400000, kernelConfig, autoUpdate: false, autoRestartOnUpdate: false, advisoryCheck: false, releaseNotesCheck: false, log: false, debug: false });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
process.send({ origin: `http://127.0.0.1:${server.address().port}` });
process.on('message', () => process.send({ sessions: listSessions().map(s => ({ id: s.id, refs: s.state.messageRefs.byRaw, blocks: s.state.blocks })) }));
process.on('disconnect', () => { server.closeAllConnections(); server.close(); process.exit(0); });
