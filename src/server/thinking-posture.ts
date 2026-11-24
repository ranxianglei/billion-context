// [#5998] Thinking-signature posture — learn-on-failure at the relay egress
// chokepoint. Two upstream personalities share one inbound wire and are
// byte-indistinguishable on it:
//   - signature-verifying peers (Anthropic proper) reject ANY thinking block
//     that carries no non-empty signature — pinned wording "thinking.signature:
//     Field required" (#2501); hosts whose transcripts store reasoning without
//     signatures (e.g. DSH: {type,text} only) therefore 400 on every rebuilt
//     turn until those blocks are gone;
//   - never-signing relays (DeepSeek's /anthropic endpoint, #5495) require the
//     unsigned thinking they produced to come back VERBATIM ("must be passed
//     back") — stripping there manufactures the 400 instead of fixing it.
// No content-based rule can tell the two apart (the histories are identical),
// so the upstream itself is asked: the first "Field required" 400 is answered
// with a single strip-and-resend probe. Accepted ⇒ causation confirmed — the
// session remembers the strict posture and later sends drop signature-less
// thinking proactively. Still failing ⇒ NOT this field — the second response
// is discarded, the original 400 is forwarded verbatim, nothing is learned.
// Session-scoped only (session.metadata, persisted with the session record);
// no config surface.
import type { Session } from "../session.js";

const POSTURE_KEY = "thinkingSignatureStrict";

export function thinkingPostureIsStrict(session: Pick<Session, "metadata">): boolean {
    return session.metadata[POSTURE_KEY] === true;
}

export function rememberStrictThinkingPosture(session: Pick<Session, "metadata">): void {
    session.metadata[POSTURE_KEY] = true;
}

/**
 * The signature-verifying upstream's rejection of a signature-less thinking
 * block ("thinking.signature: Field required", #2501). Deliberately narrow:
 * the #5495 mandatory-thinking wording ("must be passed back") and the #1960
 * tamper wording ("cannot be modified") are different pathologies with
 * different fixes — probing either would re-manufacture the 400 or rewrite a
 * signed channel (KDD#10), so both are excluded here.
 */
export function detectThinkingSignatureRejection(status: number, bodyText: string): boolean {
    if (status !== 400) return false;
    if (!/signature/i.test(bodyText)) return false;
    if (!/thinking/i.test(bodyText)) return false;
    if (!/(required|missing)/i.test(bodyText)) return false;
    if (/must be passed back/i.test(bodyText)) return false;
    if (/cannot be modified/i.test(bodyText)) return false;
    return true;
}

interface UnsignedThinkingStrip {
    body: string;
    removed: number;
}

function isUnsignedThinkingBlock(block: unknown): boolean {
    if (typeof block !== "object" || block === null) return false;
    const b = block as Record<string, unknown>;
    if (b.type !== "thinking") return false;
    const sig = b.signature;
    return !(typeof sig === "string" && sig.length > 0);
}

function assistantContent(msg: unknown): unknown[] | null {
    if (typeof msg !== "object" || msg === null) return null;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") return null;
    return Array.isArray(m.content) ? m.content : null;
}

/**
 * Drop signature-less thinking blocks from an outbound Anthropic wire body.
 * Signed blocks, redacted_thinking, text and tool blocks pass through
 * untouched; a message left with NO content at all (a turn that was pure
 * unsigned thinking) is dropped wholesale and any role-run the drop creates
 * is re-merged, so the result stays legal Anthropic shape. Returns the input
 * string untouched when nothing changed or the body is not JSON we understand
 * (never guess).
 */
export function stripUnsignedThinkingFromWire(body: string): UnsignedThinkingStrip {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, removed: 0 };
    }
    if (typeof parsed !== "object" || parsed === null) return { body, removed: 0 };
    const wire = parsed as Record<string, unknown>;
    const messages = wire.messages;
    if (!Array.isArray(messages)) return { body, removed: 0 };

    let removed = 0;
    const survivors: unknown[] = [];
    for (const msg of messages) {
        const content = assistantContent(msg);
        if (content === null || content.length === 0) {
            survivors.push(msg);
            continue;
        }
        if (content.every(isUnsignedThinkingBlock)) {
            // Pure-unsigned-thinking turn: dropping the blocks would leave
            // content: [], which is its own 400 — drop the message instead.
            removed += content.length;
            continue;
        }
        if (content.some(isUnsignedThinkingBlock)) {
            const kept = content.filter((b: unknown) => !isUnsignedThinkingBlock(b));
            (msg as Record<string, unknown>).content = kept;
            removed += content.length - kept.length;
        }
        survivors.push(msg);
    }
    if (removed === 0) return { body, removed: 0 };
    wire.messages = reconcileRoleRuns(survivors);
    return { body: JSON.stringify(wire), removed };
}

function reconcileRoleRuns(messages: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const msg of messages) {
        const prev = out[out.length - 1];
        if (prev !== undefined && typeof prev === "object" && prev !== null &&
            typeof msg === "object" && msg !== null &&
            (prev as Record<string, unknown>).role === (msg as Record<string, unknown>).role) {
            const p = prev as Record<string, unknown>;
            p.content = [...asContentBlocks(p.content), ...asContentBlocks((msg as Record<string, unknown>).content)];
            continue;
        }
        out.push(msg);
    }
    return out;
}

function asContentBlocks(content: unknown): unknown[] {
    if (Array.isArray(content)) return content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return [];
}
