// Codec for the zed cloud wire family: cloud.zed.dev wraps a standard provider
// request in an envelope ({thread_id, prompt_id, provider, model,
// provider_request}). unwrap turns one into the inner provider wire body so
// the standard pipeline (kernel, preflight, window resolution, session
// binding) runs unchanged; rewrap restores the envelope at the final forward
// boundary AFTER pipeline mutations have applied to the inner body.
//
// Strict fidelity (#1284 precedent): ANY shape this codec cannot convert is
// rejected (undefined) and the caller relays the original bytes verbatim —
// never a partial conversion.

export const ZED_PROVIDERS = ["anthropic", "open_ai", "google", "x_ai"] as const;

export type ZedProvider = (typeof ZED_PROVIDERS)[number];

export const ZED_PROVIDER_PROTOCOL: Record<ZedProvider, "anthropic" | "responses" | "openai" | "google"> = {
    anthropic: "anthropic",
    open_ai: "responses",
    google: "google",
    x_ai: "openai",
};

export interface ZedEnvelopeMeta {
    /** Every original top-level envelope key except `provider_request`, verbatim. */
    rest: Record<string, unknown>;
    provider: ZedProvider;
    threadId?: string;
    promptId?: string;
    model?: string;
}

interface UnwrappedZedEnvelope {
    innerBody: Record<string, unknown>;
    provider: ZedProvider;
    threadId?: string;
    promptId?: string;
    meta: ZedEnvelopeMeta;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function zedInnerShapeOk(provider: ZedProvider, inner: Record<string, unknown>): boolean {
    switch (provider) {
        case "anthropic":
        case "x_ai":
            return Array.isArray(inner.messages) && inner.messages.length > 0;
        case "open_ai":
            return Array.isArray(inner.input);
        case "google":
            return Array.isArray(inner.contents);
    }
}

export function unwrapZedEnvelope(parsed: Record<string, unknown>): UnwrappedZedEnvelope | undefined {
    const provider = parsed.provider;
    if (typeof provider !== "string" || !(ZED_PROVIDERS as readonly string[]).includes(provider)) return undefined;
    const inner = parsed.provider_request;
    if (!isObj(inner)) return undefined;
    if (!zedInnerShapeOk(provider as ZedProvider, inner)) return undefined;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (k !== "provider_request") rest[k] = v;
    }
    const threadId = typeof rest.thread_id === "string" && rest.thread_id.length > 0 ? (rest.thread_id as string) : undefined;
    const promptId = typeof rest.prompt_id === "string" && rest.prompt_id.length > 0 ? (rest.prompt_id as string) : undefined;
    const model = typeof rest.model === "string" ? (rest.model as string) : undefined;
    const meta: ZedEnvelopeMeta = { rest, provider: provider as ZedProvider, threadId, promptId, model };
    return { innerBody: inner, provider: provider as ZedProvider, threadId, promptId, meta };
}

export function rewrapZedEnvelope(innerBody: Record<string, unknown>, meta: ZedEnvelopeMeta): Record<string, unknown> {
    // Every envelope field passes through VERBATIM from meta.rest (thread_id /
    // prompt_id / provider / model are never pipeline-mutated); only `model` is
    // refreshed when the pipeline rewrote the inner body's model, and
    // `provider_request` carries the transformed inner body.
    const out: Record<string, unknown> = { ...meta.rest };
    const innerModel = typeof innerBody.model === "string" ? innerBody.model : undefined;
    if (innerModel !== undefined) out.model = innerModel;
    out.provider_request = innerBody;
    return out;
}
