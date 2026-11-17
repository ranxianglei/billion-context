import { limitsOutboundBytes, limitsReceiveBytes } from "./knobs.js";

export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_DECODED_REQUEST_BYTES = 2 * MAX_REQUEST_BYTES;
const MAX_LARGE_DECODED_REQUESTS = 2;
let largeDecodedRequests = 0;

// #5794: the slot budget above was keyed on limitsReceiveBytes() — whose #3128
// default is 5 GiB — so it could only count a body OVER 5 GiB and the 2-slot
// cap was effectively dead: #5794's 51.2 MiB / 6s-ingest request (29,619
// messages, 54.6% of all local CPU, 747 s event-loop FATAL → #4762 self-restart)
// never consumed a slot. Key the budget on a cost-meaningful threshold
// instead: a decoded body this size costs seconds of single-threaded
// ingest+parse per request, so at most TWO such bodies may be admitted at once
// and the third gets 503 retry-after. The Math.min with limitsReceiveBytes()
// keeps any operator-set SMALLER receive cap binding (strictly stricter, never
// looser than before).

export const LARGE_DECODED_ADMISSION_BYTES = 32 * 1024 * 1024;

export class DecodedRequestBusyError extends Error {
    constructor() {
        super("large decoded request budget is busy; retry after an active request finishes");
        this.name = "DecodedRequestBusyError";
    }
}

/** #5794：超过 min(limitsReceiveBytes(), 32MiB) 的解码请求占用超大正文名额；
 *  普通请求不占。阈值取 min 保持单调：运维把接收预算调小时仍按更小者生效，
 *  同时补上 32MiB 成本带（51.2MiB 的请求体一次摄入口约 6s）——旧阈值默认 5GiB，名额实际从未生效。 */
export class DecodedRequestAdmission {
    private admitted = false;
    observe(bytes: number): void {
        if (bytes <= Math.min(limitsReceiveBytes(), LARGE_DECODED_ADMISSION_BYTES) || this.admitted) return;
        if (largeDecodedRequests >= MAX_LARGE_DECODED_REQUESTS) throw new DecodedRequestBusyError();
        largeDecodedRequests++;
        this.admitted = true;
    }
    release(): void {
        if (!this.admitted) return;
        largeDecodedRequests--;
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
