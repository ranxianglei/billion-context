// Host-side Responses input transport. Wire items are opaque JSON objects:
// never project them through the Anthropic converter or rewrite encrypted data.
import { createHash } from "node:crypto";

export type ResponsesItem = Record<string, unknown>;
export interface ResponsesSnapshot {
    route: string;
    hashes: string[];
}
interface ResponsesTurn {
    body: string;
    snapshot: ResponsesSnapshot;
}

export function responsesItems(value: unknown): value is ResponsesItem[] {
    return Array.isArray(value) && value.every(item => item !== null && typeof item === "object"
        && !Array.isArray(item) && (typeof item.type === "string" || typeof item.role === "string"));
}

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The caller retains original HTTP bytes for direct fallback. These hashes
 * describe only ACKNOWLEDGED input items, not a speculative previous dispatch. */
export function planResponsesInput(
    conversationId: string,
    route: string,
    request: Record<string, unknown>,
    acknowledged?: ResponsesSnapshot,
): ResponsesTurn | null {
    if (typeof request.model !== "string" || !responsesItems(request.input) || request.input.length === 0) return null;
    // Existing upstream continuation already carries a suffix. Without its
    // response-owned base we must not reinterpret that suffix as a full seed.
    if (request.previous_response_id !== undefined && request.previous_response_id !== null) return null;
    const hashes = request.input.map(digest);
    const prefix = acknowledged?.route === route && acknowledged.hashes.length <= hashes.length
        && acknowledged.hashes.every((hash, index) => hash === hashes[index]);
    const sinceSeq = prefix && acknowledged ? acknowledged.hashes.length : 0;
    const { input, ...parameters } = request;
    return {
        body: JSON.stringify({
            conversationId, wireFormat: "responses", path: "/v1/responses",
            sinceSeq, resync: !prefix,
            request: parameters, messages: request.input.slice(sinceSeq),
        }),
        snapshot: { route, hashes },
    };
}

export function responsesAckMatches(snapshot: ResponsesSnapshot, header: string | null): boolean {
    return header !== null && /^(0|[1-9][0-9]*)$/.test(header)
        && Number.isSafeInteger(Number(header)) && Number(header) === snapshot.hashes.length;
}

interface RetainedInput {
    serialized: string[];
    bytes: number;
}
export class ResponsesInputError extends Error {
    constructor(readonly status: 400 | 409 | 413, message: string) { super(message); }
}

/** Bounded WARM cache only. Eviction/restart requires an honest full reseed;
 * this makes no stronger durability claim than the existing volatile lane ack. */
export class ResponsesInputHistory {
    private readonly retained = new Map<string, RetainedInput>();
    private bytes = 0;
    constructor(private readonly maxBytes = 256 * 1024 * 1024, private readonly maxEntries = 64) {}

    prepare(key: string, payload: Record<string, unknown>): { body: Buffer; appliedSeq: number; commit: () => void } {
        if (!Number.isSafeInteger(payload.sinceSeq) || Number(payload.sinceSeq) < 0
            || (payload.resync !== undefined && typeof payload.resync !== "boolean")
            || !responsesItems(payload.messages)) throw new ResponsesInputError(400, "invalid Responses item envelope");
        const request = payload.request;
        if (request === null || typeof request !== "object" || Array.isArray(request))
            throw new ResponsesInputError(400, "Responses request parameters must be an object");
        const parameters = request as Record<string, unknown>;
        if (typeof parameters.model !== "string" || "input" in parameters
            || (parameters.previous_response_id !== undefined && parameters.previous_response_id !== null))
            throw new ResponsesInputError(400, "ambiguous Responses request parameters");
        const resync = payload.resync === true;
        const old = resync ? undefined : this.retained.get(key);
        if (resync && payload.sinceSeq !== 0) throw new ResponsesInputError(400, "resync must start at zero");
        if (!resync && (!old || old.serialized.length !== payload.sinceSeq))
            throw new ResponsesInputError(409, "Responses prefix unavailable; resend the complete input");
        const serialized = [...(old?.serialized ?? []), ...payload.messages.map(item => JSON.stringify(item))];
        if (serialized.length === 0) throw new ResponsesInputError(400, "Responses input must not be empty");
        const bytes = serialized.reduce((total, item) => total + Buffer.byteLength(item), 0);
        if (bytes > this.maxBytes) throw new ResponsesInputError(413, "Responses retained input exceeds cache budget");
        const skeleton = JSON.stringify(parameters);
        const body = Buffer.from(`${skeleton.slice(0, -1)},"input":[${serialized.join(",")}]}`);
        return { body, appliedSeq: serialized.length, commit: () => {
            const previous = this.retained.get(key);
            if (previous) { this.bytes -= previous.bytes; this.retained.delete(key); }
            while (this.retained.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
                const oldest = this.retained.entries().next().value;
                if (!oldest) break;
                this.retained.delete(oldest[0]);
                this.bytes -= oldest[1].bytes;
            }
            this.retained.set(key, { serialized, bytes });
            this.bytes += bytes;
        } };
    }
    clear(): void { this.retained.clear(); this.bytes = 0; }
}
