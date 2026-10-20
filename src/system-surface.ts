import { createHash } from "node:crypto";
import type { Session } from "./session.js";

/** #3201: the OUTBOUND system surface of a session — the system prompt text
 *  plus the tool catalog exactly as last sent to the upstream. The web UI's
 *  trajectory view renders it so a user can see the full context head without
 *  capturing the raw wire. Captured per request on the four prepare-* lanes,
 *  at the same sites (and under the same title-gen guards) where
 *  metadata.systemPromptTokens is stamped, so the two always describe the
 *  same outbound payload.
 *
 *  Persisted as a separate sidecar file next to the session JSON (same
 *  pattern as the kernel CCR content store, #1097): it is payload bytes with
 *  its own lifecycle, NOT part of the session record — buildRecord omits it,
 *  which preserves whole-file encryption of the record and .json discovery.
 *
 *  Bounded by design: both fields are capped (see MAX_*_CHARS below); the
 *  hash covers the UNTRUNCATED bytes so a change only inside the truncated
 *  tail still invalidates the cache and triggers a rewrite. */
export interface SystemSurfaceRecord {
    v: 1;
    /** sha256 over fullText + "\u0000" + fullToolsJson (untruncated). */
    hash: string;
    systemText: string;
    systemTruncated: boolean;
    toolsJson: string;
    toolsTruncated: boolean;
    /** Best-effort extraction across all four wire shapes (display aid only —
     *  toolsJson stays the source of truth). */
    toolNames: string[];
    updatedAt: number;
}

/** Companion filename suffix — sibling of the session JSON, mirroring
 *  `.content-store.json` (#1097). Every directory walker / GC predicate that
 *  special-cases the content-store suffix must special-case this one too. */
export const SYSTEM_SURFACE_SUFFIX = ".system-surface.json";

const MAX_SYSTEM_CHARS = 400_000;
const MAX_TOOLS_CHARS = 400_000;

export function isValidSystemSurface(value: unknown): value is SystemSurfaceRecord {
    if (!value || typeof value !== "object") return false;
    const r = value as Record<string, unknown>;
    return r.v === 1
        && typeof r.hash === "string"
        && typeof r.systemText === "string"
        && typeof r.systemTruncated === "boolean"
        && typeof r.toolsJson === "string"
        && typeof r.toolsTruncated === "boolean"
        && Array.isArray(r.toolNames)
        && r.toolNames.every((n) => typeof n === "string")
        && typeof r.updatedAt === "number";
}

/** Best-effort tool-name extraction across the four wire shapes:
 *  OpenAI `{type:"function",function:{name}}`, Anthropic `{name}`,
 *  Responses `{type:"function",name}`, Google `{functionDeclarations:[{name}]}`. */
function extractToolNames(tools: unknown[]): string[] {
    const names: string[] = [];
    for (const t of tools) {
        if (!t || typeof t !== "object") continue;
        const o = t as Record<string, unknown>;
        const fn = o.function;
        if (typeof o.name === "string") {
            names.push(o.name);
            continue;
        }
        if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
            names.push((fn as Record<string, unknown>).name as string);
            continue;
        }
        const decls = o.functionDeclarations;
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (d && typeof d === "object" && typeof (d as Record<string, unknown>).name === "string") {
                    names.push((d as Record<string, unknown>).name as string);
                }
            }
        }
    }
    return names;
}

/** Capture the outbound system surface for this request. No-op when the
 *  surface is unchanged (hash compare) — steady-state turns cost one sha256
 *  over strings already in memory, no allocation beyond the digest, and never
 *  arm a sidecar rewrite. */
export function captureSystemSurface(session: Session, systemText: string | null | undefined, tools: unknown): void {
    const text = typeof systemText === "string" ? systemText : "";
    const list = Array.isArray(tools) ? tools : [];
    if (text.length === 0 && list.length === 0) return;
    const toolsJson = JSON.stringify(list);
    const hash = createHash("sha256").update(text, "utf8").update("\u0000", "utf8").update(toolsJson, "utf8").digest("hex");
    const prev = session.systemSurface;
    if (prev && prev.hash === hash) return;
    session.systemSurface = {
        v: 1,
        hash,
        systemText: text.length > MAX_SYSTEM_CHARS ? text.slice(0, MAX_SYSTEM_CHARS) : text,
        systemTruncated: text.length > MAX_SYSTEM_CHARS,
        toolsJson: toolsJson.length > MAX_TOOLS_CHARS ? toolsJson.slice(0, MAX_TOOLS_CHARS) : toolsJson,
        toolsTruncated: toolsJson.length > MAX_TOOLS_CHARS,
        toolNames: extractToolNames(list),
        updatedAt: Date.now(),
    };
    session.systemSurfaceDirty = true;
}
