import { tierGatedStandardWindow } from "../config.js";
import { log as loggerLog } from "../logger.js";

// #300: bili→bili chain marker. When a bili instance forwards a request it has
// processed upstream, it stamps this header with its own instance id. A bili
// instance that RECEIVES a request already carrying it knows an upstream bili
// already ran the compression pipeline on this request — processing it again
// would double-compress and corrupt session state (issue #292). Clients never
// send this header, so its presence on an inbound request always means "came
// from a bili instance".
export const BILI_HOP_HEADER = "x-bili-hop";

// Per-model context windows handed over by a `bili <client>` launcher
// (BILI_LAUNCHER_MODEL_WINDOWS, JSON model-id → window), read from the
// client's OWN config (pi models.json / omp models.yml / …) at launch time.
// Ranked between the plugin report and the models.dev registry in the
// native-window chain — the client's own number is authoritative for its
// deployment (it is what the client itself truncates at), unlike the generic
// registry.
export function parseLauncherModelWindows(raw: string | undefined): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = Math.floor(v);
        }
        return out;
    } catch {
        return {};
    }
}

export const LAUNCHER_MODEL_WINDOWS: Readonly<Record<string, number>> = parseLauncherModelWindows(process.env.BILI_LAUNCHER_MODEL_WINDOWS);

// Same channel for configured max output (#971): BILI_LAUNCHER_MODEL_MAX_OUTPUTS
// (JSON model-id → maxOutput) read from the client's own config at launch
// time. Consumed by the #924 output-headroom fallback at the rank below the
// runtime-info protocol (#955) and above configured/registry.
export function parseLauncherModelMaxOutputs(raw: string | undefined): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = Math.floor(v);
        }
        return out;
    } catch {
        return {};
    }
}

export const LAUNCHER_MODEL_MAX_OUTPUTS: Readonly<Record<string, number>> = parseLauncherModelMaxOutputs(process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS);

export function launcherMaxOutput(model: string): number | undefined {
    return LAUNCHER_MODEL_MAX_OUTPUTS[model];
}

export function launcherContextWindow(model: string): number | undefined {
    return LAUNCHER_MODEL_WINDOWS[model];
}

export const windowSourceLogged = new Set<string>();

// Security cap on the beta-negotiated window: unbounded, a hostile
// `context-<N>m` header would drive the effective window (and thus every
// compression threshold) toward infinity, disabling all triggers until a real
// 400 stalls the session (#1064 #12). Kept well above any shipping context
// window so future betas still generalize while the header stays bounded
// (#1064 #12).
export const MAX_ANTHROPIC_BETA_WINDOW = 10_000_000;

/** Parse an `anthropic-beta` header for a larger-context beta (e.g.
 *  `context-1m-2025-08-07` → 1,000,000). The beta lets the CLIENT negotiate a
 *  window beyond the model's standard size, so it is the most direct per-request
 *  evidence of the window the upstream will actually serve — it outranks the
 *  model table / registry (which list the STANDARD window, e.g. 200K for claude)
 *  and must be re-read on every request (the header may appear/disappear between
 *  requests of the same session, #302). `context-Nm` generalizes to future
 *  larger-context betas (N × 1,000,000), clamped to {@link MAX_ANTHROPIC_BETA_WINDOW}.
 *  Returns the largest requested window, or undefined when no context beta is
 *  present. */
export function anthropicBetaContextWindow(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = headers["anthropic-beta"];
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw.join(",") : raw;
    let best: number | undefined;
    for (const part of list.split(",")) {
        const m = /^context-(\d+)m\b/.exec(part.trim().toLowerCase());
        if (!m) continue;
        const n = Number.parseInt(m[1], 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        const w = Math.min(n * 1_000_000, MAX_ANTHROPIC_BETA_WINDOW);
        if (best === undefined || w > best) best = w;
    }
    return best;
}

// #1321: an [Nm]-suffixed model name (e.g. "claude-opus-5-5[1m]") is the
// client's own declaration that THIS request runs on the expanded tier — the
// same evidence class as the context-Nm beta header, carried in the model id
// instead of a header. Resolved like the header: N × 1,000,000 clamped to
// MAX_ANTHROPIC_BETA_WINDOW (#1064 #12).
export function expandedContextSuffixWindow(model: string | undefined): number | undefined {
    if (!model) return undefined;
    const m = /\[(\d+)m\]$/i.exec(model.trim());
    if (!m) return undefined;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(n * 1_000_000, MAX_ANTHROPIC_BETA_WINDOW);
}

// #1321: models.dev advertises the MAX window a tier-gated model id can serve;
// without per-request tier evidence (context-Nm beta header / [Nm] suffix) the
// client's plan serves the STANDARD window, and budgeting against the
// advertised max pushes every percentage threshold beyond the client's own
// wall (#1310 item 2). Cap registry-derived windows at the built-in standard
// window for those families. Operator sources (per-model config, launcher
// windows, plugin report, runtime-info) are exempt — they are deployment-
// specific truth, never registry guesses. One info line per model so the cap
// is visible in the log instead of silently re-sizing thresholds.
const registryWindowCappedLogged = new Set<string>();
export function capRegistryWindowByStandard(
    model: string,
    registryWindow: number | undefined,
    hasTierEvidence: boolean,
): number | undefined {
    if (registryWindow === undefined || hasTierEvidence) return registryWindow;
    const std = tierGatedStandardWindow(model);
    if (std === undefined || registryWindow <= std) return registryWindow;
    if (!registryWindowCappedLogged.has(model)) {
        registryWindowCappedLogged.add(model);
        loggerLog("info", `[window] registry advertises ${registryWindow} for ${model} but the request carries no tier evidence (context-Nm beta header / [Nm] suffix) — capping at the built-in standard ${std} (#1321)`);
    }
    return std;
}
