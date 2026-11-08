import { createHash } from "node:crypto";

export interface RetouchMessage {
    role: string;
    content: unknown;
}

interface CompactRetouch {
    index: number;
    contentHash: string;
    cacheControls: unknown[];
}

export type WireRetouch = CompactRetouch | { index: number; message: RetouchMessage };

function block(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function retouchContentHash(message: RetouchMessage): string {
    const content = Array.isArray(message.content) ? message.content.map((value: unknown) => {
        if (!block(value) || !Object.hasOwn(value, "cache_control")) return value;
        const { cache_control: _mark, ...rest } = value;
        return rest;
    }) : message.content;
    return createHash("sha256").update(`${message.role}\u0000${JSON.stringify(content)}`).digest("hex");
}

export function compactRetouch(index: number, message: RetouchMessage): CompactRetouch {
    return {
        index,
        contentHash: retouchContentHash(message),
        cacheControls: Array.isArray(message.content) ? message.content.map((value: unknown) =>
            block(value) && Object.hasOwn(value, "cache_control") ? value.cache_control : null) : [],
    };
}

export function isCompactRetouch(value: unknown): value is CompactRetouch {
    if (!block(value) || Object.hasOwn(value, "message")) return false;
    return Number.isSafeInteger(value.index) && Number(value.index) >= 0
        && typeof value.contentHash === "string" && /^[0-9a-f]{64}$/.test(value.contentHash)
        && Array.isArray(value.cacheControls)
        && value.cacheControls.every((mark: unknown) => mark === null || block(mark));
}

export function expandRetouch(message: RetouchMessage, patch: CompactRetouch): RetouchMessage | null {
    if (retouchContentHash(message) !== patch.contentHash) return null;
    if (!Array.isArray(message.content)) return patch.cacheControls.length === 0 ? message : null;
    if (patch.cacheControls.length !== message.content.length) return null;
    const content: unknown[] = [];
    for (let i = 0; i < message.content.length; i++) {
        const value: unknown = message.content[i];
        const mark: unknown = patch.cacheControls[i];
        if (!block(value)) {
            if (mark !== null) return null;
            content.push(value);
            continue;
        }
        const next = { ...value };
        if (mark === null) delete next.cache_control;
        else next.cache_control = mark;
        content.push(next);
    }
    return { ...message, content };
}
