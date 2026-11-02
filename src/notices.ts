// #5548 unified announcement surface (design v2, owner-approved): three sources
// (A built-in declarations / B local JSON / C remote GitHub raw) feed ONE
// renderer through shared pure filter/sort functions and one dismissal store.
// P1 lands lane A only — the built-in table converging the two hand-copied
// banners (#5079 pck-default-off, #5469 wm-fastpath-intro); lanes B/C register
// their loaded ids via registerDynamicNoticeIds() when they land (P2/P3).
// Pure module: no fs, no io — the dismissal store stays in pck-notice.ts.

export type NoticeKind = "new-feature" | "upgrade-advisory" | "warning" | "suggestion" | "incident" | "deprecation" | "other";
export type NoticeTone = "ok" | "warn" | "info";
export type NoticeDismiss = "persistent" | "instance" | "always";
/** Multilang copy: locale object (keys like "zh-CN"/"en") or a plain string. */
export type NoticeText = string | Record<string, string>;

export interface NoticeRecord {
    id: string;
    kind: NoticeKind;
    title: NoticeText;
    desc?: NoticeText;
    hint?: NoticeText;
    ctaLabel?: NoticeText;
    ctaUrl?: string;
    /** Explicit tone overrides the kind-derived one (toneOf). */
    tone?: NoticeTone;
    /** persistent (default) | instance (process-only) | always (never hidden, no close button). */
    dismiss?: NoticeDismiss;
    /** 0–100; absent/null falls back to the kind default in KIND_PRIORITY. */
    priority?: number | null;
    /** ISO8601 UTC; sort tiebreak after priority (newer first). */
    publishedAt?: string;
    // P2 targeting dimensions (declared now so wire types stay stable across
    // phases; their filters land with lane B in P2):
    versions?: string[];
    percent?: number | null;
    since?: string;
    until?: string;
}

/** Server-side state a built-in declaration's active predicate may read. */
export interface BuiltInContext {
    /** effectivePromptCacheRouting() result ("disabled"/"auto"/"enabled"). */
    promptCacheRouting: string;
    /** True when the user wrote an explicit pluginFullResendWatermark rollout override. */
    wmOverridePresent: boolean;
}

export interface BuiltinNotice extends NoticeRecord {
    active: (ctx: BuiltInContext) => boolean;
}

export const KIND_PRIORITY: Record<NoticeKind, number> = {
    incident: 90,
    "upgrade-advisory": 80,
    warning: 70,
    deprecation: 60,
    suggestion: 50,
    "new-feature": 40,
    other: 30,
};

export function priorityOf(rec: Pick<NoticeRecord, "kind" | "priority">): number {
    return typeof rec.priority === "number" ? rec.priority : KIND_PRIORITY[rec.kind];
}

/** Kind-derived tone: new-feature→ok, warning/incident/deprecation→warn, rest→info. */
export function toneOf(rec: Pick<NoticeRecord, "kind" | "tone">): NoticeTone {
    if (rec.tone) return rec.tone;
    if (rec.kind === "new-feature") return "ok";
    if (rec.kind === "warning" || rec.kind === "incident" || rec.kind === "deprecation") return "warn";
    return "info";
}

export function dismissModeOf(rec: Pick<NoticeRecord, "dismiss">): NoticeDismiss {
    return rec.dismiss ?? "persistent";
}

/** Visible under the record's dismiss mode (P2 upgrades store keys to id@hash16). */
export function noticeVisible(
    rec: Pick<NoticeRecord, "id" | "dismiss">,
    dismissedPersistent: ReadonlySet<string>,
    dismissedInstance: ReadonlySet<string> = new Set(),
): boolean {
    const mode = dismissModeOf(rec);
    if (mode === "always") return true;
    if (mode === "instance") return !dismissedInstance.has(rec.id);
    return !dismissedPersistent.has(rec.id);
}

/** Stable sort: priority desc, then publishedAt desc (missing timestamps last). */
export function sortNotices<T extends NoticeRecord>(list: readonly T[]): T[] {
    const ts = (r: NoticeRecord): number => {
        const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        return Number.isNaN(t) ? -Infinity : t;
    };
    return [...list].sort((a, b) => {
        const pa = priorityOf(a), pb = priorityOf(b);
        if (pa !== pb) return pb - pa;
        const ta = ts(a), tb = ts(b);
        if (ta !== tb) return tb - ta;
        return 0;
    });
}

export const PCK_NOTICE_ID = "pck-default-off";
export const WM_FASTPATH_INTRO_ID = "wm-fastpath-intro";

/** Lane A: built-in declarations (bound to code behavior, review-gated here). */
export const BUILTIN_NOTICES: readonly BuiltinNotice[] = [
    {
        // #5079: prompt_cache.routing default flip (auto → disabled) upgrade notice.
        // Explicit tone "warn": the derived tone for upgrade-advisory is info, but
        // this banner has rendered as .banner.warn since #5079 (byte-stable).
        id: PCK_NOTICE_ID,
        kind: "upgrade-advisory",
        tone: "warn",
        title: { "zh-CN": "prompt_cache_key 自注入已默认关闭（升级提示）", en: "prompt_cache_key self-stamping is now off by default (upgrade notice)" },
        desc: {
            "zh-CN": "本版本起 bili 不再自行向请求添加 OpenAI 的 prompt_cache_key 字段（此前默认开启）。如果你的上游是按该字段路由前缀缓存的中转站或号池（如 workbuddy panel/hub 等），请打开开关恢复注入，否则流量可能被随机路由、频繁未命中缓存。",
            en: "Since this version bili no longer adds OpenAI's prompt_cache_key field to requests on its own (previously on by default). If your upstream routes prefix cache by this key (relays such as workbuddy panel/hub, account pools), turn the switch back on — otherwise traffic may route randomly and miss the prefix cache.",
        },
        hint: {
            "zh-CN": "开关在「配置」页快速配置里（promptCache.routing：disabled/auto/enabled），也可直接改 billion-context.json；直连官方 API 的用户可忽略此提示。",
            en: "Switch: Configuration page → quick config (promptCache.routing: disabled/auto/enabled), or edit billion-context.json directly; direct official-API users can ignore this notice.",
        },
        active: (ctx) => ctx.promptCacheRouting === "disabled",
    },
    {
        // #5403/#5469: watermark fastpath experimental-grey intro — every install
        // sees it on first upgrade until closed or an explicit rollout override.
        id: WM_FASTPATH_INTRO_ID,
        kind: "new-feature",
        tone: "ok",
        title: { "zh-CN": "新功能提示：大上下文增量解析（增量压缩过渡功能 · 实验性）", en: "New: incremental parsing for large contexts (incremental-compression bridge feature, experimental)" },
        desc: {
            "zh-CN": "长会话每轮都要把整个历史重新发给代理解析一遍，现在改为增量解析：只解析本轮新增的那部分，优化长会话的解析性能（发给模型的内容不变；有任何疑点，当轮自动回退老路径并重新对齐）。当前版本对约 5% 的安装灰度开启，属实验性功能。",
            en: "Long conversations used to re-send their entire history for parsing on every turn. Now only the new part of each turn is parsed — faster parsing on long sessions (the request sent to the model is unchanged; any doubt falls back to the old path for that turn and re-aligns). This release rolls it out to roughly 5% of installs; it is marked experimental.",
        },
        hint: {
            "zh-CN": "开关在「配置」页快速配置（大上下文增量解析），也可在 billion-context.json 写 rollout.features.pluginFullResendWatermark: true/false，或设环境变量 BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK=1/0。",
            en: "Switch: Configuration page → quick config (incremental parsing for large contexts), or write rollout.features.pluginFullResendWatermark: true/false in billion-context.json, or set BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK=1/0.",
        },
        active: (ctx) => !ctx.wmOverridePresent,
    },
];

const dynamicIds = new Set<string>();

/** Lanes B/C register their loaded ids so dismissal stays validated (#5548 §4.5). */
export function registerDynamicNoticeIds(ids: Iterable<string>): void {
    for (const id of ids) dynamicIds.add(id);
}

/** Every notice id a dismissal POST may name: built-ins + registered lanes B/C. */
export function knownNoticeIds(): ReadonlySet<string> {
    const all = new Set(BUILTIN_NOTICES.map((b) => b.id));
    for (const id of dynamicIds) all.add(id);
    return all;
}

export interface VisibleNoticesOptions {
    dismissed: ReadonlySet<string>;
    instanceDismissed?: ReadonlySet<string>;
}

/** Lane-A visible set: active predicates AND dismiss mode, priority-sorted.
 *  Wire shape strips the active function — plain records only. */
export function visibleBuiltInNotices(ctx: BuiltInContext, opts: VisibleNoticesOptions): NoticeRecord[] {
    const live = BUILTIN_NOTICES.filter((b) => b.active(ctx) && noticeVisible(b, opts.dismissed, opts.instanceDismissed));
    return sortNotices(live).map(({ active: _active, ...wire }) => wire);
}
