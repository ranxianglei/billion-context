// #2241/#2250: continuity-aware persona anchor for id-sharing traffic
// (dsh persona lanes, codex root threads / older builds, claude-over-Responses).
//
// The original dsh persona fingerprint (db21309d, #1916/#1307/#1314) keyed
// dsh traffic by id + system-text hash with kernel subagentNamespace
// first-seen anchor semantics: the FIRST system seen under the id keeps the
// raw key, any different system forks onto `<id>|sub:<fp>`. That was built
// on the assumption "dsh composes its main system once per session, so main
// turns never fork mid-conversation" — validated for the volatile
// time-context (which dsh puts in a USER message) but broken by `/model`:
// dsh rebuilds the main system per model, so every model switch forked the
// MAIN lane off the raw key. The host only ever stamps the bare id, so
// compression tool calls kept hitting the frozen husk on the raw key while
// the live conversation rode a `|sub:` session with zero compression state
// (#2241: 266,966 pendingT1 tokens, 0 folds, 38 minutes).
//
// This module keeps the review isolation intact but changes the fork
// TRIGGER from "system text changed" to "system text changed AND the
// incoming history does not continue the raw key's chain":
//
//   - model switch (same conversation, new system) — the request replays
//     the full history plus new turns, so it BYTE-EXACTLY CONTINUES the
//     raw key's prefix-affinity chain (#1106/#1148 identity semantics:
//     content is identity, system drift is evolution). The anchor
//     MIGRATES to the new fingerprint and the conversation keeps its
//     compression blocks, refs, and ledger on the raw key.
//   - auto-review classifyRisk (fresh single-message blob under a fixed
//     REVIEW_POLICY system) — its message list does not continue any
//     tracked chain, so it still forks onto `<id>|sub:<fp>` exactly as
//     before, sharing ONE forked session across successive reviews.
//
// The fork id format `<rawId>|sub:<sha256(system)[0..16]>` is unchanged, so
// downstream consumers (the #2601 persona-lineage routing in plugin.ts —
// host-stamped management calls follow the live `|sub:` descendant — and
// the #2170 designNamespaced canary) keep working. Empty system text stays
// non-anchoring (kernel semantics): system-less auxiliary calls keep riding
// the main session verbatim.
//
// Anchors are process memory, like the kernel anchor map they replace — no
// persistence contract changes. After a proxy restart the first arrival
// claims the raw anchor; if a review claims it, the next main turn's
// continuity check runs against the raw key's PERSISTED chain (#1724
// permanent chains) and migrates the anchor back, so the restart race
// self-heals on the very next main turn.

import { createHash } from "node:crypto";
import { prefixAffinity } from "./prefix-affinity.js";

const anchors = new Map<string, { fp: string; system: string; model?: string }>();

function personaFingerprint(systemText: string): string {
    return createHash("sha256").update(systemText, "utf8").digest("hex").slice(0, 16);
}

/** #2601 B': fold to lowercase alphanumerics so a display-name render of
 *  {{model}} ("GLM 4.6") and the x-bili-plugin-model key ("glm-4.6") compare
 *  equal — the host declares both facts in its own vocabularies. */
function foldModel(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** #2601 B': header-corroborated model-drift absorption. The fork
 *  conjunction is "fp changed AND the chain is discontinuous"; a model
 *  switch whose chain ALSO broke (e.g. dsh local compaction rewrote the
 *  recorded bytes in the same window) still forks even with #2719's
 *  churn-tolerant continuity. Absorb the fp half when TWO independent
 *  host declarations corroborate the drift:
 *    1. the plugin model header actually changed (old anchor model ≠ this
 *       request's model — the host re-declared its model target), and
 *    2. the system line-diff is confined to lines that name the old model
 *       (before) / the new model (after) — the {{model}} template recompute.
 *  No host-specific phrasing is hardcoded: only the header-declared names
 *  are matched, folded. Anything else (AGENTS.md edit lines, timestamp
 *  plugin lines, review-policy rewrites) keeps the conjunction intact. */
function modelDriftAbsorbed(
    anchored: { system: string; model?: string },
    newSystem: string,
    newModel: string | undefined,
): boolean {
    const oldModel = anchored.model;
    if (oldModel === undefined || newModel === undefined) return false;
    if (oldModel === newModel || foldModel(oldModel) === foldModel(newModel)) return false;
    const a = anchored.system.split("\n");
    const b = newSystem.split("\n");
    if (a.length !== b.length) return false;
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        changed++;
        if (!foldModel(a[i]!).includes(foldModel(oldModel))) return false;
        if (!foldModel(b[i]!).includes(foldModel(newModel))) return false;
    }
    return changed > 0;
}

type PersonaAnchorAction = "claim" | "match" | "migrate" | "migrate-model" | "fork" | "passthrough";

interface PersonaKeyResolution {
    key: string;
    action: PersonaAnchorAction;
}

/**
 * Resolve the session key for a dsh persona-fingerprinted request.
 * `messages` is the protocol's conversation message list (the same list
 * prefix-affinity hashes — top-level system fields are not part of it).
 */
export function resolvePersonaKey(
    rawId: string,
    systemText: string,
    messages: unknown[],
    model?: string,
): PersonaKeyResolution {
    if (!systemText) return { key: rawId, action: "passthrough" };
    const fp = personaFingerprint(systemText);
    const anchored = anchors.get(rawId);
    if (anchored === undefined) {
        anchors.set(rawId, { fp, system: systemText, model });
        return { key: rawId, action: "claim" };
    }
    if (anchored.fp === fp) {
        // fp identical but the host re-declared a different model: keep the
        // record fresh ONLY when the declared name actually renders in the
        // system text (fold containment) — the recorded model must stay a
        // name the model identity line really contains, or the old-side
        // containment in modelDriftAbsorbed would stop matching. An alias
        // switch that does not re-render {{model}} keeps the old name.
        if (model !== undefined && model !== anchored.model && foldModel(anchored.system).includes(foldModel(model))) {
            anchors.set(rawId, { ...anchored, model });
        }
        return { key: rawId, action: "match" };
    }
    if (prefixAffinity.chainContinues(messages, rawId)) {
        anchors.set(rawId, { fp, system: systemText, model });
        return { key: rawId, action: "migrate" };
    }
    if (modelDriftAbsorbed(anchored, systemText, model)) {
        anchors.set(rawId, { fp, system: systemText, model });
        return { key: rawId, action: "migrate-model" };
    }
    return { key: `${rawId}|sub:${fp}`, action: "fork" };
}

/**
 * server.ts wrapper: resolves the key and surfaces anchor migrations in the
 * log (forks stay silent — they are the designed review path). Protocol
 * neutral since #2250: `systemText` is the lane's persona carrier — the dsh
 * main system text, or the Responses top-level `instructions` — and
 * `messages` is the same list prefix-affinity hashes (system carriers are
 * never part of it, so a pure persona drift cannot break the chain).
 * Whitespace-only carriers pass through un-anchored (kernel subagentNamespace
 * semantics, kept for the codex swap).
 */
export function personaNamespace(
    rawId: string,
    systemText: string,
    messages: unknown,
    log: (level: "info" | "warn" | "error", message: string) => void,
    model?: string,
): string {
    const list = Array.isArray(messages) ? messages : [];
    const text = typeof systemText === "string" && systemText.trim().length > 0 ? systemText : "";
    const res = resolvePersonaKey(rawId, text, list, model);
    if (res.action === "migrate") {
        log("info", `[persona] persona text changed mid-conversation but the history continues ${rawId}'s chain — anchor migrated, compression state stays on the raw key (#2241/#2250)`);
    } else if (res.action === "migrate-model") {
        log("info", `[persona] persona text changed with a discontinued chain, but the drift is a header-corroborated model switch (${model}) — anchor migrated, compression state stays on the raw key (#2601)`);
    }
    return res.key;
}

/** Current anchor fingerprint for a raw id (test/diagnostic surface). */
export function personaAnchorOf(rawId: string): string | undefined {
    return anchors.get(rawId)?.fp;
}

export function resetPersonaAnchorsForTest(): void {
    anchors.clear();
}
