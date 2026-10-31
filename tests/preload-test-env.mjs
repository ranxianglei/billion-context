// #5107: hermetic data roots for the whole suite.
//
// Without this layer every test process inherits the developer's real XDG
// homes, and anything resolving the src/paths.ts defaults (BILI_SESSIONS_DIR /
// XDG_DATA_HOME unset) persists straight into the PRODUCTION tree —
// ~/.local/share/billion-context/sessions plus its index.db. #5082/#5091
// forensics found hundreds of test sessions in a live index.db; this host's
// own tree showed the same (e2e codex "请只回复" probes among real agent
// sessions). Per-test isolation (_setStoreForTest, mkdtemp dirs, explicit env)
// stays authoritative — it runs after this preload; this only replaces the
// ambient default, so a forgotten test degrades to a throwaway root instead of
// the production tree. node --test gives every FILE its own process, so each
// gets its own mkdtemp root: parallel shards never collide, and the OS tmp
// cleanup discards them. Unconditional assignment (deliberately NOT ??=): a
// distro-set ambient XDG_DATA_HOME is still somebody's real data area, and the
// suite must not depend on the host layout either way. HOME is untouched —
// bili's path resolution only consults homedir() as the XDG fallback, and
// spawned tools (npm/git) need the real HOME.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "bili-test-"));
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
// DELETE rather than pin BILI_CONFIG_FILE (#4599): configFile() (src/paths.ts)
// consults that env BEFORE the XDG default, so ANY pinned value shadows every
// fixture that re-points XDG_CONFIG_HOME at its own dir and writes the default
// config path (claude-native attach-gate tests, #3436 compat tests). Deleting
// both un-shadows those fixtures and drops a developer's ambient pin, leaving
// the XDG_CONFIG_HOME root below as the sole config authority.
delete process.env.BILI_CONFIG_FILE;
process.env.XDG_DATA_HOME = path.join(root, "data");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
// Materialize every advertised dir (#5121 CI red): an explicit BILI_SESSIONS_DIR
// pointing at a MISSING dir is not the pristine default layout — #2180/#1937
// deliberately keep that loud (walkSessionFiles top-level ENOENT propagates,
// /__bili/overview 500s instead of resolving to an empty index), so the harness
// must point at dirs that exist. An existing EMPTY dir is the normal
// "no sessions yet" state the read paths already handle.
for (const name of ["sessions", "data", "state", "cache", "config"]) mkdirSync(path.join(root, name), { recursive: true });
