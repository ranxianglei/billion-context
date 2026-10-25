// Shared LIVE_FILES table (#3182 fix): the process-spawning test files.
// run-ci-tests.mjs enforces the SPAWN_RE tripwire against this list, and
// tests/preload-zone-slot.mjs assigns each entry its own zone port band so
// concurrent files on one shard runner never fight over the default 18787
// base (#3182/#3184/#3188: port-zone-live pinned 18787 while other live
// files' daemons ladder-drifted onto it under --test-concurrency 4).
// KEEP IN SYNC: adding a process-spawning suite means adding it here (the
// tripwire fails CI until you do); slot = index here.
export const LIVE_FILES = [
    "tests/codex-mcp-shell.test.ts",
    "tests/codex-plugin-version-sync.test.ts",
    "tests/session-transient-memory.test.ts",
    "tests/auto-restart.test.ts",
    "tests/bounded-storage-scale.test.ts",
    "tests/build-info.test.ts",
    "tests/cache-theorem.test.ts",
    "tests/claude-native.test.ts",
    "tests/codex-concurrent-launch.test.ts",
    "tests/e2e-plugin-tool-routing.test.ts",
    "tests/graceful-close.test.ts",
    "tests/hermes-native.test.ts",
    "tests/hook-command.test.ts",
    "tests/hook-graceful-exit.test.ts",
    "tests/index-entry-guard.test.ts",
    "tests/issue1958-routed-warn.test.ts",
    "tests/issue2752-forward-partial-outcome.test.ts",
    "tests/issue3472-mcp-structured-text.test.ts",
    "tests/issue4341-early-twin-adoption.test.ts",
    "tests/issue760-percall-conversation.test.ts",
    "tests/issue927-opencode-install.test.ts",
    "tests/kimi-native.test.ts",
    "tests/launcher-plugin-mode.test.ts",
    "tests/launcher-sqlite-overlay.test.ts",
    "tests/launcher.test.ts",
    "tests/logger-epipe.test.ts",
    "tests/mcp-native-thread.test.ts",
    "tests/multi-instance-live.test.ts",
    "tests/omp-native.test.ts",
    "tests/opencode-native.test.ts",
    "tests/overlay-busy-lock.test.ts",
    "tests/pi-native.test.ts",
    "tests/plugin-fork.test.ts",
    "tests/port-zone-live.test.ts",
    "tests/port-zone.test.ts",
    "tests/release-ci-gate.test.ts",
    "tests/test-suite-lock.test.ts",
    "tests/text-safe.test.ts",
    "tests/watchdog-health-daemon.test.ts",
    "tests/watchdog-health.test.ts",
    "tests/win-cmd-argv.test.ts",
    "tests/zcode-mcp-degraded.test.ts",
    "tests/zcode-real-cli.test.ts",
    // appended, NOT alphabetical: slot = index drives each file's zone port
    // band (preload-zone-slot), so mid-list inserts renumber every later band
    "tests/storage-durability.test.ts",
    "tests/server-close-all-connections.test.ts",
    // both spawn the corrupt-index-child helper (unified-store cold-load
    // corruption probes, #4216/#4249 follow-ups); append-only per the note above
    "tests/storage-engine-proofs.test.ts",
    "tests/web-storage-banner.test.ts",
    // #4434 (split-brain surface): spawns bili CLI children against a throwaway
    // origin; own probe server is listen(0) so only the zone band matters
    "tests/issue-split-brain-surface.test.ts",
    // #3890: spawns the drain fixture; that fixture is listen(0) and reports
    // READY <port>, so no zone band is needed — the entry is for the tripwire
    "tests/issue3890-parent-gone-confirm-drain.test.ts",
    // #4695: spawns git + bash children against throwaway lane repos; binds no
    // ports, so the entry is for the SPAWN_RE tripwire only
    "tests/lane-leak-guard.test.ts",
];

/** Band width per live file: the zone ladder drifts +1 per EADDRINUSE retry;
 *  32 gives every file's in-file ladder more headroom than any suite uses
 *  (observed max drift is +2). Bases stay far below the Linux ephemeral
 *  range (32768), so bands never collide with freePort()/listen(0) picks. */
const ZONE_SLOT_BAND = 32;

/** First band starts one band ABOVE the default base so bare 18787 is never
 *  a CI target: any file that (wrongly) spawns without inheriting the
 *  injected env lands on the default base and collides with nobody's
 *  assertions — it fails loudly in its OWN suite instead of poisoning
 *  others. */
export function zonePortForSlot(slot) {
    return 18787 + (slot + 1) * ZONE_SLOT_BAND;
}
