import { limitsOutboundBytes, limitsReceiveBytes } from "./knobs.js";

export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_DECODED_REQUEST_BYTES = 2 * MAX_REQUEST_BYTES;
const MAX_LARGE_DECODED_REQUESTS = 2;
let largeDecodedRequests = 0;

export class DecodedRequestBusyError extends Error {
    constructor() {
        super("large decoded request budget is busy; retry after an active request finishes");
        this.name = "DecodedRequestBusyError";
    }
}

/** 只限制超过配置的接收预算（limitsReceiveBytes）的解压请求；普通请求不占超大正文名额。 */
export class DecodedRequestAdmission {
    private admitted = false;
    observe(bytes: number): void {
        if (bytes <= limitsReceiveBytes() || this.admitted) return;
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
