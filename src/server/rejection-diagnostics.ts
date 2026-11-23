/**
 * #4452: bounded terminal-cause diagnostics for a relayed upstream REJECTION.
 *
 * A relay/gateway that fans a request out across candidate targets may answer a
 * total failure with ONE aggregate body carrying every per-target attempt, e.g.:
 *
 *   { "error": { "message": "All targets failed", "type": "upstream_error" },
 *     "attempts": [ { "target": "…", "details": { "error": { "message": "…" } } }, … ] }
 *
 * bili's own log line (`← upstream <status>: <snippet>`) keeps only the first
 * 600 bytes of that body, so the operator sees the OUTER narrative — "all
 * targets failed" — while the per-target cause sits further in. This module
 * reads exactly ONE such nested cause (the last usable attempt's) when a body
 * has that shape, reporting its attempt position rather than guessing causality.
 *
 * Hard bounds, deliberately:
 *  - ONE message, never a recursive walk: no `JSON.stringify` of the payload, no
 *    traversal of `cause`/`errors`/`attempts` chains, no echoing of the request
 *    body. Only one `attempts[].details.error.message`, with the aggregate
 *    accepted directly or beneath its standard `error` envelope.
 *  - Credential scrubbing goes through the shared log-mask sanitizer
 *    (`redactSecretsInText`), the SAME choke point the logger applies, so a
 *    provider that echoes the rejected key cannot smuggle it into the log. It is
 *    a high-signal credential scrubber, NOT a general privacy filter: it does not
 *    mask arbitrary URLs or paths, and the far stronger guarantee here is
 *    structural — only this one nested string is ever read, never a body dump.
 *  - Bounded to `MAX_DIAGNOSTIC_CHARS`; ALL control characters (C0+C1, incl.
 *    NEL U+0085) and whitespace collapsed so a newline (the `\r\n` shape or any
 *    C1 line-break) can never forge a second log field.
 *  - Absent, non-string, empty, or structurally-unrelated payloads return
 *    `undefined`: the caller then logs exactly what it logged before, so a
 *    rejection that carries no attempt detail is unchanged byte-for-byte.
 *
 * Recovery policy is NOT touched here — this module only reads a rejection
 * body; every retry/refold/arm decision stays in the relay.
 */

import { redactSecretsInText } from "../log-mask.js";

/** Upper bound on the retained cause text, independent of the outer snippet. */
const MAX_DIAGNOSTIC_CHARS = 300;

/** Do not even attempt to parse a body larger than this: an aggregate error
 *  reply is small (a few KB); a multi-megabyte body is a stream (or an HTML
 *  error page), not a JSON rejection envelope, and parsing it would cost the
 *  request more than the diagnostic is worth. */
const MAX_PARSED_BYTES = 64 * 1024;

interface DiagnosticResult {
    /** The last usable attempt's nested cause, sanitized + bounded. */
    message: string;
    /** 0-based index of the attempt the cause came from (for the log line). */
    attemptIndex: number;
    /** How many attempts the aggregate body carried. */
    attempts: number;
}

/** Collapse control chars (C0+C1 — incl. NEL U+0085) and all whitespace to
 *  single spaces, then clamp, so no control byte can survive as a forged field
 *  break in the log line. */
function bound(text: string): string {
    const collapsed = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    if (collapsed.length <= MAX_DIAGNOSTIC_CHARS) return collapsed;
    return `${collapsed.slice(0, MAX_DIAGNOSTIC_CHARS)} …`;
}

/** Read `value[name]` only when `value` is a non-array object, so a nested
 *  field is reached without a generic record guard that would prove nothing
 *  about the field actually consumed here. */
function child(value: unknown, name: string): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[name];
}

/**
 * Read the single last-reported nested cause out of a relay rejection body.
 *
 * `payload` is the raw upstream error-body text (the same string the relay
 * already buffers to detect an overflow). Returns `undefined` whenever there is
 * no usable `attempts[].details.error.message`, leaving the caller's existing
 * logging untouched.
 *
 * Selection rule: the LAST attempt that carries a non-empty
 * `details.error.message`, scanning from the end. If the terminal attempt is
 * silent, an earlier cause is reported with its actual position and is NOT
 * labeled terminal: its existence does not establish why the last stage failed.
 */
export function rejectionDiagnostics(payload: string | null | undefined): DiagnosticResult | undefined {
    if (typeof payload !== "string" || payload.length === 0) return undefined;
    if (Buffer.byteLength(payload, "utf8") > MAX_PARSED_BYTES) return undefined;
    const trimmed = payload.trim();
    // A rejection body must be a JSON object envelope — anything else (an HTML
    // error page, a bare text message, an SSE frame) carries no attempts[].
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return undefined;
    }
    const attempts = child(parsed, "attempts") ?? child(child(parsed, "error"), "attempts");
    if (!Array.isArray(attempts) || attempts.length === 0) return undefined;
    for (let i = attempts.length - 1; i >= 0; i--) {
        const raw = child(child(child(attempts[i], "details"), "error"), "message");
        if (typeof raw !== "string") continue;
        const sanitized = bound(redactSecretsInText(raw));
        if (sanitized.length === 0) continue;
        return { message: sanitized, attemptIndex: i, attempts: attempts.length };
    }
    return undefined;
}

/** Render the diagnostic as the compact suffix the relay appends to its
 *  `← upstream <status>` line. Returns "" when there is no usable cause, so the
 *  caller can concatenate unconditionally and stay byte-identical without one.
 *  Pure numbers and the sanitized cause only — never the payload. */
export function rejectionDiagnosticSuffix(payload: string | null | undefined): string {
    const diag = rejectionDiagnostics(payload);
    if (diag === undefined) return "";
    const position = diag.attempts > 1 ? ` attempt ${diag.attemptIndex + 1}/${diag.attempts}` : "";
    return `; ${diag.attemptIndex === diag.attempts - 1 ? "terminal" : "reported"} cause${position}: ${diag.message}`;
}
