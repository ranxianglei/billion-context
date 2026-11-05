// Driver for tests/verif-responses-ingress.test.ts — composes the REAL
// exported ingress fns in the REAL pipeline order (src/server/prepare-responses.ts:
// normalize → sanitize → drop). Glue only; all logic runs in the real fns.

import {
    normalizeResponsesMessageItems,
    sanitizeResponsesInputIds,
    dropWhitespaceResponsesMessages,
} from "../../src/loop/adapter-responses.ts";

export function pipeline(input: unknown): void {
    normalizeResponsesMessageItems(input);
    sanitizeResponsesInputIds(input);
    dropWhitespaceResponsesMessages(input);
}

// Non-vacuity probe: per-stage effects must be reachable — normalize
// stamp count, i0 typed, i1 id deleted, drop count.
export function stageEffects(input: unknown): number[] {
    const typed = normalizeResponsesMessageItems(input);
    const t1has = (input as Record<string, unknown>[])[1]!.type === "message" ? 1 : 0;
    sanitizeResponsesInputIds(input);
    const id1gone = (input as Record<string, unknown>[])[1]!.id === undefined ? 1 : 0;
    const dropped = dropWhitespaceResponsesMessages(input);
    return [typed, t1has, id1gone, dropped];
}

// Q1: run the pipeline twice; state after run 2 must equal state after run 1.
export function idempotenceViolation(input: unknown): boolean {
    pipeline(input);
    const first = [...(input as unknown[])] as Record<string, unknown>[];
    pipeline(input);
    const second = input as Record<string, unknown>[];
    if (first.length !== second.length) return true;
    for (let i = 0; i < first.length; i++) {
        const a = first[i];
        const b = second[i];
        if (a.id !== b.id || a.role !== b.role || a.type !== b.type || a.content !== b.content) return true;
    }
    return false;
}

// Q2: a type-less message item and its explicit-type twin must produce the
// same pipeline output (ingress canonicalization must be total — this pins
// the normalize→sanitize ORDER: swapped, the type-less twin would miss the
// bili-id delete in sanitize).
export function canonicalizationViolation(x: unknown, y: unknown): boolean {
    pipeline(x);
    pipeline(y);
    const a = x as Record<string, unknown>[];
    const b = y as Record<string, unknown>[];
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
        const ra = a[i];
        const rb = b[i];
        if (ra.id !== rb.id || ra.role !== rb.role || ra.type !== rb.type || ra.content !== rb.content) return true;
    }
    return false;
}

// Q3: non-message, non-droppable, non-bili-id items must leave the pipeline
// field-identical (upstream-owned items reach the provider byte-identical).
export function localityViolation(input: unknown): boolean {
    const n = (input as unknown[]).length;
    const ids: unknown[] = [];
    const types: unknown[] = [];
    const roles: unknown[] = [];
    const contents: unknown[] = [];
    for (let i = 0; i < n; i++) {
        const r = (input as Record<string, unknown>[])[i];
        ids.push(r.id);
        types.push(r.type);
        roles.push(r.role);
        contents.push(r.content);
    }
    pipeline(input);
    const out = input as Record<string, unknown>[];
    if (out.length !== n) return true;
    for (let i = 0; i < n; i++) {
        const r = out[i];
        if (r.id !== ids[i] || r.type !== types[i] || r.role !== roles[i] || r.content !== contents[i]) return true;
    }
    return false;
}

// DEBUG (temporary): per-field twin divergence after the full pipeline.
