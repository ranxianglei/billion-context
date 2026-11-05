// CI-only preload (#3182 fix): assign the running test file its own zone
// port band. run-ci-tests.mjs loads this via --import before every per-file
// child process; node --test runs each file in its own process, so scanning
// process.argv identifies THIS file unambiguously. Setting BILI_ZONE_PORT in
// the test process propagates to spawned daemons (children inherit the env)
// and to every assertion via resolveZonePortBase(process.env) — see
// port-zone-live.test.ts / claude-native.test.ts.
//
// Outside CI (plain `npm test`) this file is never loaded and nothing
// changes: the default 18787 base keeps working exactly as before.
import { LIVE_FILES, zonePortForSlot } from "../scripts/live-files.mjs";

const argvFile = process.argv
    .map((a) => a.replace(/\\/g, "/"))
    .find((a) => /(^|\/)tests\/[^/]+\.test\.ts$/.test(a));
if (argvFile) {
    const rel = argvFile.slice(argvFile.indexOf("tests/"));
    const slot = LIVE_FILES.indexOf(rel);
    if (slot >= 0) process.env.BILI_ZONE_PORT = String(zonePortForSlot(slot));
}
