// #2879: provenance capture for ANONYMOUS (prefix-affinity-resolved) sessions.
// A pfa-* ledger's producer was otherwise unknowable after the fact: the file
// name hashes the id, every such ledger shared ONE display label, and the mint
// log carried no client fingerprint (#2847 misread four parallel pfa-* ledgers
// as twin files of one session). Capture is FIRST-WRITER-WINS per session id
// (the mint request IS the producer; fork semantics bind one pfa-* id to one
// lineage). Attribution-grade by design: header NAMES only (values NEVER —
// they may carry credentials), UA truncated, first-message preview collapsed,
// URL-masked and capped.

import { maskUrlsInText } from "./log-mask.js";

export interface AnonymousProvenance {
    ua?: string;
    /** Header NAMES only, sorted (values never recorded). */
    headers: string[];
    /** x-bili-plugin marker value: the host extension announced its lane (e.g.
     *  "pi") yet produced NO usable conversation identity — the stamp-failure
     *  signature (toolsReady / sessionId gap), the key H1 discriminator. */
    pluginAgent?: string;
    /** First user-role message preview (fallback: first message) — system
     *  prompts are persona-shared and carry no signal; the first user turn
     *  separates a main-history replay from a fresh sub-agent task. */
    firstMsg?: string;
    remote?: string;
    at: number;
}

const MAX_PREVIEW_CHARS = 160;
const MAX_UA_CHARS = 120;
const MAX_HEADER_NAMES = 48;

function firstHeaderValue(h: Record<string, unknown>, name: string): string | undefined {
    const v = h[name.toLowerCase()];
    if (typeof v === "string") return v.length > 0 ? v : undefined;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
    return undefined;
}

function partText(v: unknown): string | undefined {
    if (typeof v === "string") return v.length > 0 ? v : undefined;
    if (Array.isArray(v)) {
        for (const part of v) {
            if (typeof part === "string") {
                if (part.length > 0) return part;
                continue;
            }
            if (part !== null && typeof part === "object") {
                const p = part as Record<string, unknown>;
                if (typeof p.text === "string" && p.text.length > 0) return p.text;
                if (typeof p.content === "string" && p.content.length > 0) return p.content;
            }
        }
        return undefined;
    }
    return undefined;
}

function previewOf(messages: unknown[]): string | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const objects = messages.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object");
    const target = objects.find((m) => m.role === "user") ?? objects[0] ?? messages[0];
    let raw: string | undefined;
    if (typeof target === "string") {
        raw = target;
    } else if (target !== null && typeof target === "object") {
        const o = target as Record<string, unknown>;
        // responses: input items {role, content:string|Part[]} · openai /
        // anthropic: messages {role, content} · google: contents {parts:[{text}]}
        raw = partText(o.content) ?? partText(o.parts) ?? partText(o.input) ?? JSON.stringify(target);
    }
    if (raw === undefined) return undefined;
    const flat = maskUrlsInText(raw.replace(/\s+/g, " ")).trim();
    return flat.length > 0 ? flat.slice(0, MAX_PREVIEW_CHARS) : undefined;
}

export function buildAnonymousProvenance(
    headers: Record<string, unknown>,
    messages: unknown[],
    remote?: string,
): AnonymousProvenance {
    const h = headers ?? {};
    const names = Object.keys(h)
        .filter((n) => n.length > 0)
        .sort()
        .slice(0, MAX_HEADER_NAMES);
    const ua = firstHeaderValue(h, "user-agent");
    const pluginAgent = firstHeaderValue(h, "x-bili-plugin");
    const firstMsg = previewOf(messages);
    return {
        ...(ua !== undefined ? { ua: ua.slice(0, MAX_UA_CHARS) } : {}),
        headers: names,
        ...(pluginAgent !== undefined ? { pluginAgent: pluginAgent.slice(0, 64) } : {}),
        ...(firstMsg !== undefined ? { firstMsg } : {}),
        ...(remote !== undefined ? { remote } : {}),
        at: Date.now(),
    };
}
