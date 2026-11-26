import { largeDecodedAdmissionBytes, limitsReceiveBytes, limitsOutboundBytes, maxLargeDecodedRequests } from "./knobs.js";

export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_DECODED_REQUEST_BYTES = 2 * MAX_REQUEST_BYTES;

// #7277: shipped defaults, kept as named exports for compatibility (tests pin
// against them); the LIVE values come from the knobs below —
// maxLargeDecodedRequests() / largeDecodedAdmissionBytes(). Re-exported from
// knobs.js so there is a single source of truth for the defaults.
export { DEFAULT_MAX_LARGE_DECODED_REQUESTS as MAX_LARGE_DECODED_REQUESTS, DEFAULT_LARGE_DECODED_ADMISSION_BYTES as LARGE_DECODED_ADMISSION_BYTES } from "./knobs.js";

// #5794: the slot budget above was keyed on limitsReceiveBytes() — whose #3128
// default is 5 GiB — so it could only count a body OVER 5 GiB and the slot
// cap was effectively dead: #5794's 51.2 MiB / 6s-ingest request (29,619
// messages, 54.6% of all local CPU, 747 s event-loop FATAL → #4762 self-restart)
// never consumed a slot. Key the budget on a cost-meaningful threshold
// instead: a decoded body this size costs seconds of single-threaded
// ingest+parse per request, so at most N such bodies may be admitted at once
// and the next gets 503 retry-after. The Math.min with limitsReceiveBytes()
// keeps any operator-set SMALLER receive cap binding (strictly stricter, never
// looser than before).
// #7277: the cap (was hardcoded 2) and the band (was hardcoded 32 MiB) are now
// operator knobs — maxLargeDecodedRequests() / largeDecodedAdmissionBytes() —
// because a long in-flight upstream stream (multi-minute 6M-token sessions)
// can hold every slot for minutes and the operator had no way to widen the
// budget short of patching; the refusal log below also reports held/cap and
// how long the OLDEST slot has been held (the "invisible 503" complaint).

export class DecodedRequestBusyError extends Error {
    constructor() {
        super("large decoded request budget is busy; retry after an active request finishes");
        this.name = "DecodedRequestBusyError";
    }
}

/** #7277: one admitted over-band body and when it took its slot — used by
 *  the 503 refusal log to report how long the oldest slot has been held. */
const heldSlots = new Map<DecodedRequestAdmission, number>();

export interface LargeDecodedBudgetStatus {
    /** Over-band bodies currently holding a slot. */
    held: number;
    /** maxLargeDecodedRequests() at call time. */
    cap: number;
    /** Band at call time: Math.min(limitsReceiveBytes(), largeDecodedAdmissionBytes()). */
    bandBytes: number;
    /** ms since the OLDEST held slot was admitted (undefined when none held). */
    oldestHeldMs: number | undefined;
}

export function largeDecodedBudgetStatus(): LargeDecodedBudgetStatus {
    let oldest: number | undefined;
    for (const since of heldSlots.values()) if (oldest === undefined || since < oldest) oldest = since;
    return {
        held: heldSlots.size,
        cap: maxLargeDecodedRequests(),
        bandBytes: Math.min(limitsReceiveBytes(), largeDecodedAdmissionBytes()),
        oldestHeldMs: oldest === undefined ? undefined : Date.now() - oldest,
    };
}

/** #5794：超过 min(limitsReceiveBytes(), 准入带) 的解码请求占用超大正文名额（#7277 起
 *  名额数与带宽均可配置）；普通请求不占。阈值取 min 保持单调：运维把接收预算调小时
 *  仍按更小者生效，同时补上 32MiB 成本带（51.2MiB 的请求体一次摄入口约 6s）——旧阈值
 *  默认 5GiB，名额实际从未生效。 */
export class DecodedRequestAdmission {
    private admitted = false;
    observe(bytes: number): void {
        if (bytes <= Math.min(limitsReceiveBytes(), largeDecodedAdmissionBytes()) || this.admitted) return;
        if (heldSlots.size >= maxLargeDecodedRequests()) throw new DecodedRequestBusyError();
        heldSlots.set(this, Date.now());
        this.admitted = true;
    }
    release(): void {
        if (!this.admitted) return;
        heldSlots.delete(this);
        this.admitted = false;
    }
}

export class OutboundBodyTooLargeError extends Error {
    constructor(public readonly bytes: number) {
        super(`rebuilt request exceeds ${limitsOutboundBytes()} bytes (${bytes} bytes); reduce historical images or content before retrying`);
        this.name = "OutboundBodyTooLargeError";
    }
}

export function checkOutboundBody(body: unknown): void {
    const bytes = typeof body === "string" ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.byteLength : 0;
    if (bytes > limitsOutboundBytes()) throw new OutboundBodyTooLargeError(bytes);
}
