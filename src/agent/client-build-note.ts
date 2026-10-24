// Client-build freshness note (#4545): a lane that runs our package INSIDE
// the user's client process can end up in front of a client build we have
// never tested. That is the dsh lane's real problem: @deepseek-ai/dsh ships
// NO stable release at all (every publish is -rc/-alpha) and its npm `latest`
// dist-tag drifts upward on its own, so an unattended reinstall silently puts
// us before untested code, and the first breakage tends to show up subtly and
// far from boot (overlay latch failure, preset drift). The other in-process
// lanes (pi / oh-my-pi / opencode) are ordinary stable-versioned clients that
// do not auto-drift like that, so per decision on #4545 only dsh is wired —
// but this module is deliberately lane-generic so a second check can be
// added later with one constant and one call site.
//
// The guard is SOFT and one-directional: when the resolved client version is
// STRICTLY NEWER than the newest build we test against for that lane, emit
// exactly ONE note through the lane's own visible/durable channel. It never
// gates, never blocks traffic, never fails a start — a wrong guess must not
// take down a working session. At-or-below-cap builds stay silent: known
// break modes on OLDER builds already have their own detectors (dsh: the
// compaction overlay-latch gap probe + its #3806 boot warning + #2474
// fallback). Unparseable versions fail open to "not newer" (silence).
//
// Per-lane ops knob (house env style, cf. retryIntervalMs):
// BILI_<LANE>_MAX_TESTED_VERSION — move the cap to a newly verified build, or
// set it to "" to switch the check off for that lane. Defaults track the CI
// e2e anchor installs (.github/workflows/ci-e2e-*.yml).

import { readFileSync } from "node:fs";
import path from "node:path";
import { isVersionNewer } from "../update.js";
import { logHostEvent } from "./host-log.js";

type ClientBuildCheck = {
    /** Short human label used in the note text ("dsh", "pi", ...). */
    label: string;
    /** The client's npm id, as shown in the note (@deepseek-ai/dsh, ...). */
    pkgId: string;
    /** Env knob controlling this lane's cap (BILI_<LANE>_MAX_TESTED_VERSION). */
    knobEnv: string;
    /** Newest client build this repo's CI exercises by default. */
    defaultMaxTested: string;
};

/** Cap tri-state: unset → the lane default; ""/whitespace-only → undefined
 *  (check OFF for the lane); anything else → the trimmed value. */
export function maxTestedVersion(check: ClientBuildCheck, env: Record<string, string | undefined> = process.env): string | undefined {
    const raw = env[check.knobEnv];
    if (raw === undefined) return check.defaultMaxTested;
    const v = raw.trim();
    return v.length === 0 ? undefined : v;
}

/** Walk UP from startDir (bounded hops) looking for
 *  <dir>/<pkgJsonRelPath> — the client package sits one or two levels above
 *  our injected bundle in desktop/profile layouts alike. Several candidate
 *  paths are tried at EVERY level before hopping up (nearest wins; e.g. pi
 *  ships under two npm spellings). Returns the first non-empty `version`
 *  field found; absent/unreadable/malformed everywhere → undefined, callers
 *  stay silent. */
export function walkUpNodeModuleVersion(startDir: string, pkgJsonRelPaths: string | string[], maxHops = 8): string | undefined {
    const candidates = (Array.isArray(pkgJsonRelPaths) ? pkgJsonRelPaths : [pkgJsonRelPaths])
        .map((rel) => rel.split("/").filter(Boolean))
        .filter((parts) => parts.length > 0);
    let dir = startDir;
    for (let hop = 0; hop < maxHops; hop += 1) {
        for (const parts of candidates) {
            try {
                const doc = JSON.parse(readFileSync(path.join(dir, ...parts), "utf8")) as { version?: unknown };
                if (typeof doc.version === "string" && doc.version.length > 0) return doc.version;
            } catch {
                // no client package.json here — next candidate / next level
            }
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return undefined;
}

/** Per-lane identities (#4545). Caps track the NEWEST client build this repo's CI e2e pins (.github/workflows/ci-e2e-*); bump them together when those anchors move. Only dsh is registered today (see module header): the other in-process clients are stable-versioned and need no cap. */
export const DSH_BUILD_CHECK: ClientBuildCheck = {
    label: "dsh",
    pkgId: "@deepseek-ai/dsh",
    knobEnv: "BILI_DSH_MAX_TESTED_VERSION",
    defaultMaxTested: "0.2.0-rc.2", // ci-e2e-dsh-native.yml anchor
};

/** Compose the one-shot bilingual note, or null when nothing needs saying:
 *  no version resolved (absence of evidence ≠ broken build), check switched
 *  off via the knob, at-or-below the cap, or either side unparseable
 *  (comparison fails open to silence). */
export function newerClientBuildMessage(
    check: ClientBuildCheck,
    found: string | undefined,
    env: Record<string, string | undefined> = process.env,
): string | null {
    const cap = maxTestedVersion(check, env);
    if (found === undefined || cap === undefined) return null;
    if (!isVersionNewer(found, cap)) return null;
    return `[${check.label}] You are running ${check.pkgId} v${found} — NEWER than the newest build billion-context has tested against (v${cap}). Everything keeps running as usual, but compression may misbehave on a build we have not tested; if you hit compression conflicts or lose history, roll the client back to v${cap} until support lands. （当前运行的 ${check.pkgId} v${found} 高于我们测试过的最高版本 v${cap}：功能照常运行，但压缩能力在该构建上未经我们验证、可能不稳定；如出现压缩冲突或历史丢失，请先将客户端回滚到 v${cap}。）`;
}

/** One-shot emission shared by native lanes (#4545; today only dsh calls it):
 *  resolve + compose + deliver through BOTH house channels when the note fires:
 *   · logHostEvent warn [native-client] — the durable bili.log record that
 *     survives GUI hosts swallowing stderr (#1158/#2831), readable via
 *     `/acp`-side diagnostics;
 *   · console.warn — boot-time banner per host-log.ts's explicit contract
 *     (fires at plugin load, before the TUI takes over; swallowed harmlessly
 *     by hosts that capture it).
 * Returns true exactly when a note went out. The caller owns its once-per-
 * process flag and fail-open try/catch; this helper throws nothing except
 * through the message composer (which cannot throw — every input is checked). */
export function emitNewerClientBuildNote(
    check: ClientBuildCheck,
    found: string | undefined,
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
    const msg = newerClientBuildMessage(check, found, env ?? process.env);
    if (msg === null) return false;
    logHostEvent("warn", "[native-client]", msg);
    console.warn(msg);
    return true;
}
