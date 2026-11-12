// Unified built-in notice registry (#5548 P1): one table, one client render
// loop, zero per-notice wiring in admin/client/page. Adding a 4th notice =
// one entry here + its i18n keys + its id in the pck-notice allowlist — no
// other file touches per-notice code again. Display semantics (tone color,
// action words) come from the web layer; activity predicates live HERE so the
// server-side judgment never scatters back into route handlers.
import fs from "node:fs";
import path from "node:path";
import { effectivePromptCacheRouting, loadConfigFile } from "./config.js";
import { resolveDshHome } from "./client-config.js";
import { dshProfileDirs } from "./dsh-channel.js";
import { featureOverrideAbsent } from "./rollout.js";
import { IOT_INCOMPAT_NOTICE_ID, PCK_NOTICE_ID, dismissedUpgradeNotices, pckNoticeActive, WM_FASTPATH_INTRO_ID } from "./pck-notice.js";

interface NoticeEntry {
    readonly id: string;
    readonly tone: "ok" | "warn";
    readonly keys: { on: string; desc: string; hint: string; dismiss: string };
    readonly active: () => boolean;
}

export const NOTICES: readonly NoticeEntry[] = [
    // #5079: prompt_cache.routing default flip (auto → disabled). Visible while
    // the effective routing is still "disabled" and not dismissed — users who
    // re-enabled auto made their call and are not nagged.
    {
        id: PCK_NOTICE_ID,
        tone: "warn",
        keys: { on: "pckoff.on", desc: "pckoff.desc", hint: "pckoff.hint", dismiss: "pckoff.dismiss_btn" },
        active: () => pckNoticeActive(effectivePromptCacheRouting(loadConfigFile().promptCache)),
    },
    // #5403: watermark fastpath experimental-grey intro — visible to every
    // install until closed or an explicit rollout override exists (users who
    // wrote their own percent/enabled made the call themselves).
    {
        id: WM_FASTPATH_INTRO_ID,
        tone: "ok",
        keys: { on: "wmfast.on", desc: "wmfast.desc", hint: "wmfast.hint", dismiss: "wmfast.dismiss_btn" },
        active: () =>
            !dismissedUpgradeNotices(process.env).has(WM_FASTPATH_INTRO_ID) &&
            featureOverrideAbsent("pluginFullResendWatermark", loadConfigFile().rollout),
    },
    // Owner report 2026-11-09: dsh's iot-thinking plugin rewrites/hides the
    // thinking channel through a SECOND, self-issued model call after every
    // reply. Both calls share one session lane, so the step keeps waiting
    // after its first byte — the measured gap tracked that rewrite call's own
    // latency (p50 ~7s per step) and the extra requests vanished when the
    // plugin was disabled (44% of one session's requests were that shape).
    // Installed AND not switched off in its own config ⇒ warn (owner ruling
    // 2026-11-09: disabling the plugin removes the extra wait, so the notice
    // must go away with it and only reappear when it is turned back on).
    {
        id: IOT_INCOMPAT_NOTICE_ID,
        tone: "warn",
        keys: { on: "iotcompat.on", desc: "iotcompat.desc", hint: "iotcompat.hint", dismiss: "iotcompat.dismiss_btn" },
        active: () =>
            !dismissedUpgradeNotices(process.env).has(IOT_INCOMPAT_NOTICE_ID) &&
            dshIotThinkingActive(process.env),
    },
];

/** Uncached: does ANY dsh profile carry the iot-thinking plugin? Never throws
 *  (no profiles / unreadable home ⇒ false — an advisory must not fail a page). */
export function probeDshIotThinking(env: NodeJS.ProcessEnv = process.env): boolean {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return false;
    }
    for (const dir of dirs) {
        try {
            if (fs.existsSync(path.join(dir, "node_modules", "dsh-plugin-iot-thinking", "package.json"))) return true;
        } catch {
            // unreadable profile: keep scanning the rest
        }
    }
    return false;
}

/** Installed AND effective-enabled. The plugin's own default is enabled
 *  (its config-store seeds enabled: true), so a missing/unreadable config
 *  keeps the warning; only an explicit enabled: false silences it. */
export function dshIotThinkingActive(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!probeDshIotThinking(env)) return false;
    try {
        const raw = fs.readFileSync(path.join(resolveDshHome(env), "plugin-data", "iot-thinking", "config.json"), "utf8");
        const doc: unknown = JSON.parse(raw);
        if (doc !== null && typeof doc === "object" && (doc as { enabled?: unknown }).enabled === false) return false;
    } catch {
        // absent/broken config ⇒ plugin runs on its default (enabled)
    }
    return true;
}

/** Currently-visible notices, in registry order. Never throws. */
export function visibleNotices(): Array<{ id: string; tone: "ok" | "warn"; keys: NoticeEntry["keys"] }> {
    const out: Array<{ id: string; tone: "ok" | "warn"; keys: NoticeEntry["keys"] }> = [];
    for (const n of NOTICES) {
        let ok = false;
        try {
            ok = n.active();
        } catch {
            ok = false;
        }
        if (ok) out.push({ id: n.id, tone: n.tone, keys: n.keys });
    }
    return out;
}
