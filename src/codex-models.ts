import type { IncomingHttpHeaders } from "node:http";
import codexSnapshot from "./codex-models-snapshot.json" with { type: "json" };

type CodexModelEntry = { context_window?: number; max_context_window?: number };
type CodexSnapshotShape = { fetchedAt?: unknown; source?: unknown; models?: Record<string, CodexModelEntry> };

/** Slim snapshot of openai/codex's model table (codex-rs/models-manager/
 *  models.json), committed at src/codex-models-snapshot.json (refresh with
 *  `npm run codex:snapshot`) and inlined into dist at build time — the same
 *  offline-floor pattern as registry-snapshot.json. Only the window fields
 *  are kept: auto_compact_token_limit is null for every current entry (the
 *  90% clamp lives in codex code), so context_window is codex's knowledge. */
const MODELS: Record<string, CodexModelEntry> = (() => {
    const snap = codexSnapshot as CodexSnapshotShape;
    if (!snap || typeof snap !== "object" || !snap.models || typeof snap.models !== "object") return {};
    return snap.models;
})();

export function codexModelWindow(model: string | undefined): number | undefined {
    if (!model) return undefined;
    const entry = MODELS[model];
    if (!entry) return undefined;
    const primary = entry.context_window;
    if (typeof primary === "number" && primary > 0) return primary;
    const max = entry.max_context_window;
    return typeof max === "number" && max > 0 ? max : undefined;
}

export function isCodexClient(headers: IncomingHttpHeaders): boolean {
    return headers["x-codex-turn-metadata"] !== undefined;
}
