import type { GoogleContent } from "acp-kernel/wire";

// #5253: Gemini thinking models validate the thoughtSignature of every
// replayed functionCall/thought part and 400 the whole request when one is
// missing. bili forwards client parts verbatim, so an unsigned part on the
// outbound was unsigned on the inbound — but until now that failure mode was
// silent: the lane just died with an upstream 400 every turn. This audit makes
// it visible and attributes the origin (client resend vs bili rebuild).

export interface GoogleSigAudit {
    signedCalls: number;
    unsignedCalls: number;
    signedThoughts: number;
    unsignedThoughts: number;
    sites: string[];
}

const MAX_SITES = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

/** Count signed/unsigned functionCall and thought parts over a Google
 *  `contents` array. Never throws on malformed shapes — a broken body must
 *  not break the request path that is about to forward it. */
export function auditGoogleSignatures(contents: readonly GoogleContent[]): GoogleSigAudit {
    const out: GoogleSigAudit = { signedCalls: 0, unsignedCalls: 0, signedThoughts: 0, unsignedThoughts: 0, sites: [] };
    for (let i = 0; i < contents.length; i++) {
        const c = contents[i];
        if (!c || typeof c !== "object" || !Array.isArray(c.parts)) continue;
        for (let j = 0; j < c.parts.length; j++) {
            const p = c.parts[j];
            if (!isRecord(p)) continue;
            const signed = typeof p.thoughtSignature === "string";
            const fc = p.functionCall;
            if (isRecord(fc) && typeof fc.name === "string") {
                if (signed) out.signedCalls++;
                else {
                    out.unsignedCalls++;
                    if (out.sites.length < MAX_SITES) out.sites.push(`contents[${i}].parts[${j}] ${fc.name}`);
                }
            } else if (p.thought === true) {
                if (signed) out.signedThoughts++;
                else out.unsignedThoughts++;
            }
        }
    }
    return out;
}

export interface GoogleSigWarnInput {
    /** Sticky per-session latch: this model has been observed signing its
     *  calls/thoughts at least once (its own responses or the client's
     *  replay). Non-signing models never need signatures — no warn. */
    modelSigns: boolean;
    unsignedIn: number;
    unsignedOut: number;
    /** Prior affected turns already warned in this session. */
    warnedTurns: number;
}

export interface GoogleSigWarnDecision {
    warn: boolean;
    /** true when the unsigned bytes came in unsigned (client-side loss);
     *  false means the client sent them signed and the rebuild dropped them
     *  (a bili-side defect that must be reported as such). */
    clientOrigin: boolean;
}

const REWARN_EVERY = 10;

export function googleSigWarnDecision(x: GoogleSigWarnInput): GoogleSigWarnDecision {
    const clientOrigin = x.unsignedIn > 0;
    const warn = x.modelSigns && x.unsignedOut > 0 && (x.warnedTurns === 0 || x.warnedTurns % REWARN_EVERY === 0);
    return { warn, clientOrigin };
}
