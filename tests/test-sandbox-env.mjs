// #5116: sandbox the XDG base dirs for every test-runner process.
//
// Any suite whose file forgets to pin XDG_* resolves paths through
// os.homedir() (src/paths.ts xdg()) and writes straight into the developer's
// REAL ~/.local/share/billion-context (index.db + session envelopes),
// ~/.local/state/billion-context (prefix-affinity.json, rollout-id.json,
// proxy-origin, bili.log) or reads the live ~/.config/billion-context —
// production data polluted with test fingerprints (found while investigating
// #5082). Loaded by tests/preload-storage-baseline.mjs, which npm test /
// scripts/run-ci-tests.mjs / scripts/measure-test-durations.mjs all pass via
// --import; bare targeted runs must use the same preload
// (reference/testing.md).
//
// Semantics: unset OR empty-string values are replaced by fresh per-process
// dirs under one mkdtemp root; an explicitly set non-empty value always wins,
// so every suite that pins its own mkdtemp homes keeps working untouched.
// Each node --test file is its own process, so files also stop sharing state
// dirs with each other. The temp root is deliberately NOT auto-removed: OS
// tmp reaping handles it, and leaving it makes failed runs inspectable. It is
// reported as BILI_TEST_XDG_ROOT so a post-mortem knows where artifacts went.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The four XDG base dirs bili resolves through src/paths.ts. */
export const SANDBOXED_XDG_KEYS = [
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
];

/**
 * Point every unset-or-empty XDG base dir in `env` at <root>/<name> under one
 * fresh mkdtemp root (default: os.tmpdir()). Explicit non-empty values win
 * and are left untouched. Returns { root, applied }; `root` is undefined when
 * nothing had to change, and is recorded on env.BILI_TEST_XDG_ROOT when set.
 */
export function sandboxXdgEnv(env, opts = {}) {
    const prefix = opts.prefix ?? "bili-test-xdg-";
    const baseDir = opts.baseDir ?? tmpdir();
    let root;
    const applied = {};
    for (const key of SANDBOXED_XDG_KEYS) {
        const cur = env[key];
        if (typeof cur === "string" && cur.length > 0) continue; // explicit setter wins
        if (root === undefined) root = mkdtempSync(path.join(baseDir, prefix));
        const dir = path.join(root, key.toLowerCase().replace(/^xdg_/, "").replace(/_home$/, ""));
        mkdirSync(dir, { recursive: true });
        env[key] = dir;
        applied[key] = dir;
    }
    if (root !== undefined) env.BILI_TEST_XDG_ROOT = root;
    return { root, applied };
}
