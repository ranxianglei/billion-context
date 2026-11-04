// Unified built-in notice registry (#5548 P1): one table, one client render
// loop, zero per-notice wiring in admin/client/page. Adding a 4th notice =
// one entry here + its i18n keys + its id in the pck-notice allowlist — no
// other file touches per-notice code again. Display semantics (tone color,
// action words) come from the web layer; activity predicates live HERE so the
// server-side judgment never scatters back into route handlers.
import { effectivePromptCacheRouting, loadConfigFile } from "./config.js";
import { featureOverrideAbsent } from "./rollout.js";
import { PCK_NOTICE_ID, dismissedUpgradeNotices, pckNoticeActive, WM_FASTPATH_INTRO_ID } from "./pck-notice.js";

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
];

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
