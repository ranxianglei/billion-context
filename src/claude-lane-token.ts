/** #5095 (D1-C): the SubagentStart lane token. bili's managed Claude Code
 *  settings install a SubagentStart hook (dist/claude-subagent-hook.js) that
 *  mints one random token per subagent DISPATCH and injects it into the
 *  dispatch's context via `additionalContext`. The token then rides the wire
 *  inside that dispatch's first user message — giving the proxy a
 *  bili-minted, per-dispatch-unique discriminator for subagent requests that
 *  share the parent's session id and carry no agent-id headers (#4352 /
 *  #5095): the order resolver keys such traffic on
 *  `<rawId>|sub:<fp16(tag)>:t:<token>` instead of the persona-text
 *  fingerprint alone, which merges parallel same-type dispatches (the D1
 *  injectivity gap).
 *
 *  Zero-dependency module on purpose: it is bundled standalone into the hook
 *  entry AND imported by the proxy side — one definition of the grammar. */
import { randomBytes } from "node:crypto";

export const LANE_TOKEN_MARKER = "bili-lane-token:";
const LANE_TOKEN_HEX_LEN = 12;

const LANE_TOKEN_RE = new RegExp(`(?<![0-9a-f])${LANE_TOKEN_MARKER}([0-9a-f]{${LANE_TOKEN_HEX_LEN}})(?![0-9a-f])`);

/** Runtime type guard + sanitizer: a lane token is exactly 12 lowercase hex
 *  chars. Anything else on the wire (forged, truncated, garbage) is rejected
 *  so the resolver never builds a lane key from unsanitized input. */
export function isClaudeLaneToken(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

export function mintClaudeLaneToken(): string {
    return randomBytes(6).toString("hex");
}

/** First lane token in a text blob, or undefined. Boundary guards keep a
 *  longer hex run (a quoted token of another dispatch, a hash in prose) from
 *  matching as a substring. */
export function claudeLaneTokenIn(text: string): string | undefined {
    const m = LANE_TOKEN_RE.exec(text);
    return m === null ? undefined : m[1];
}
