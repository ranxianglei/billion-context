import { limitsLargeDecodedAdmissionBytes, limitsMaxLargeDecodedRequests, limitsOutboundBytes, limitsReceiveBytes } from "./knobs.js";

export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_DECODED_REQUEST_BYTES = 2 * MAX_REQUEST_BYTES;
let largeDecodedRequests = 0;
// #7277: per-slot admission timestamps (admission instance → Date.now() at admit),
// so a refusal can report how long the OLDEST in-flight large request has been
// running — the one piece of state a bare counter cannot supply.
const admitTimes = new Map<DecodedRequestAdmission, number>();

// #5794: the slot budget above was keyed on limitsReceiveBytes() — whose #3128
// default is 5 GiB — so it could only count a body OVER 5 GiB and the 2-slot
// cap was effectively dead: #5794's 51.2 MiB / 6s-ingest request (29,619
// messages, 54.6% of all local CPU, 747 s event-loop FATAL → #4762 self-restart)
// never consumed a slot. Key the budget on a cost-meaningful threshold
// instead: a decoded body this size costs seconds of single-threaded
// ingest+parse per request, so at most TWO such bodies may be admitted at once
// and the third gets 503 retry-after. The Math.min with limitsReceiveBytes()
// keeps any operator-set SMALLER receive cap binding (strictly stricter, never
// looser than before). #7277: both the slot count and the band are now knobs
// (limitsMaxLargeDecodedRequests / limitsLargeDecodedAdmissionBytes, defaults
// unchanged at 2 and 32 MiB) and the refusal reports the live values.

export class DecodedRequestBusyError extends Error {
    // #7277: the diagnostic triple is optional so the error stays constructible
    // bare (the decode-layer tests throw a stand-in); the real refusal path
    // carries the live count/limit/oldest-running so the 503 log + body say WHY.
    constructor(admitted = 0, limit = 0, oldestRunningMs = 0) {
        const detail = admitted > 0 && limit > 0
            ? ` (${admitted}/${limit} large requests active, oldest admitted ${Math.round(oldestRunningMs)} ms ago)`
            : "";
        super(`large decoded request budget is busy${detail} — this is a local bili concurrency limit, not an upstream error; retry after an active request finishes`);
        this.name = "DecodedRequestBusyError";
    }
}

/** #5794：超过 min(limitsReceiveBytes(), 32MiB) 的解码请求占用超大正文名额；
 *  普通请求不占。阈值取 min 保持单调：运维把接收预算调小时仍按更小者生效，
 *  同时补上 32MiB 成本带（51.2MiB 的请求体一次摄入口约 6s）——旧阈值默认 5GiB，名额实际从未生效。
 *  #7277：名额数与成本带改为 knobs（默认不变），拒绝时报告在途数/上限/最早在途时长。 */
export class DecodedRequestAdmission {
    private admitted = false;
    observe(bytes: number): void {
        const limit = limitsMaxLargeDecodedRequests();
        if (bytes <= Math.min(limitsReceiveBytes(), limitsLargeDecodedAdmissionBytes()) || this.admitted) return;
        if (largeDecodedRequests >= limit) {
            let oldest = Infinity;
            for (const t of admitTimes.values()) if (t < oldest) oldest = t;
            throw new DecodedRequestBusyError(largeDecodedRequests, limit, Number.isFinite(oldest) ? Date.now() - oldest : 0);
        }
        largeDecodedRequests++;
        admitTimes.set(this, Date.now());
        this.admitted = true;
    }
    release(): void {
        if (!this.admitted) return;
        largeDecodedRequests--;
        admitTimes.delete(this);
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
