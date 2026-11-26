/** #7106: price the PROMPT mass of a wire body, not the whole body.
 *
 *  The client-local doom gate (#2924/#4068/#4111/#5405/#5996) estimates tokens
 *  from raw body BYTES: `ceil(bytes/4) * 1.14`, minus image bytes. That is a
 *  sound upper bound for a plain model request, but DSH requests carry
 *  transport-only top-level fields that never reach the model:
 *
 *    dsh_session_log        incremental session-log contribution (up to 8 MiB)
 *    dsh_plugin_packages    plugin inventory blob
 *
 *  Pricing them as prompt mass makes a healthy in-window request look like a
 *  2.4M-token body on a 1M-token window, so the local gate refuses it before
 *  the provider ever sees it (#7090 family, client-side face; #7106).
 *
 *  The client gate has no route config and no protocol header, but the body
 *  shape is unambiguous: google carries `contents`, responses `input`,
 *  anthropic `system`, openai `messages`. Once the lane is known, the prompt
 *  mass is exactly the text under that lane's prompt keys — counted with the
 *  same CJK-aware walker the server-side preflight uses, so both sides price
 *  the same bytes. Non-JSON / unrecognized bodies keep the byte estimate.
 */

import { estimateRawBodyTokens } from "../preflight.js";
import type { WireProtocol } from "../util.js";

/** Top-level keys that carry prompt mass, per wire protocol.
 *  (Same split as the server-side `PROMPT_BODY_KEYS` added by #7092; kept
 *  local so this client fix applies without depending on that PR landing.) */
const PROMPT_KEYS: Record<WireProtocol, readonly string[]> = {
    openai: ["messages", "tools"],
    anthropic: ["messages", "tools", "system"],
    google: ["contents", "systemInstruction", "tools"],
    responses: ["input", "instructions", "tools"],
};

interface WirePromptMass {
    /** Lane the body shape was recognized as; only used for reporting. */
    protocol: WireProtocol;
    /** CJK-aware token mass of the prompt fields (turns + system + tools).
     *  Inline images are deliberately excluded: the text walk skips image
     *  keys (media stays uncounted, #4111). */
    promptTokens: number;
}

/** Recognize the lane from the body shape. */
function sniffWireProtocolOfBody(body: Record<string, unknown>): WireProtocol | undefined {
    if (body.contents !== undefined) return "google";
    if (body.input !== undefined) return "responses";
    if (body.system !== undefined) return "anthropic";
    if (body.messages !== undefined) return "openai";
    return undefined;
}

/** Prompt mass of one raw request body, or undefined when it cannot be priced
 *  from shape (non-JSON, non-object, or no recognizable prompt key). */
export function promptMassOfWireBody(raw: string | undefined): WirePromptMass | undefined {
    if (raw === undefined) return undefined;
    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    const protocol = sniffWireProtocolOfBody(record);
    if (protocol === undefined) return undefined;
    const promptOnly: Record<string, unknown> = {};
    for (const key of PROMPT_KEYS[protocol]) {
        if (record[key] !== undefined) promptOnly[key] = record[key];
    }
    return {
        protocol,
        promptTokens: estimateRawBodyTokens(promptOnly),
    };
}
