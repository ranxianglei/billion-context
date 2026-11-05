import { createHash } from "node:crypto";
import { USER_IMAGE_PLACEHOLDER } from "./fold-reconcile.js";

/**
 * #2791: wire-neutral affinity projection.
 *
 * The anonymous prefix-affinity identity chain (#309) hashed the RAW wire
 * messages: `chainHashes`/`perItemHashes`/`#2265 sketches` all canonicalized
 * whatever JSON the client sent. That is stable while a session stays on one
 * protocol — and collapses the moment a stateless client switches protocol
 * mid-conversation (dsh switching its LLM provider from openai-completions
 * to anthropic-messages): the SAME transcript is re-rendered on the other
 * wire and nothing matches item-for-item:
 *
 *   openai                                    anthropic
 *   {role:"user", content:"s"}          ↔     {role:"user", content:[{type:"text",text:"s"}]}
 *   {role:"assistant", tool_calls:[     ↔     {role:"assistant", content:[
 *     {function:{name,arguments:JSON}}]}          {type:"thinking",thinking:...},
 *                                                 {type:"tool_use",name,input:{…}}]}
 *   {role:"tool", tool_call_id, content} ↔     {role:"user", content:[{type:"tool_result",…}]}
 *   (one message per result)                 (N results can share ONE user message)
 *
 * Result (#2791): the switched request resolves at depth 0, mints a fresh
 * anonymous `pfa-*` session, orphans the fold ledger of the real session and
 * re-pays the whole history (observed: 263% of window, ~182s re-fold, cache
 * reset to 0%) — silently, on every protocol switch, for every stateless
 * client (dsh sends NO identity headers on any lane; continuity is
 * content-affinity only).
 *
 * This module projects a protocol message list onto a WIRE-NEUTRAL turn
 * list so the same conversation hashes identically on every wire. The
 * projection is deliberately shaped by what real renderers disagree about
 * (verified against captured openai + anthropic renders of the same dsh
 * transcript):
 *
 *  - text content: string vs text-blocks → concatenated text (blocks join
 *    with "" — captures show pi-ai inlines with no separator).
 *  - tool calls: openai `arguments` (JSON string) ↔ anthropic `input`
 *    (object) → both canonicalized as parsed sorted-key JSON.
 *  - tool results: openai `role:"tool"` messages ↔ anthropic user
 *    `tool_result` blocks; a multi-block user message SPLITS into one turn
 *    per block (aligns with openai's one-message-per-result).
 *  - assistant thinking: kept for text-only turns, DROPPED on turns that
 *    carry tool calls (the openai render of a tool turn has content:null —
 *    the thinking exists only on the anthropic render, so keeping it would
 *    fork exactly the turns where the two wires must agree; the call
 *    name+args remain a strong position discriminator).
 *  - consecutive anthropic assistant messages (thinking message + tool_use
 *    message) MERGE into one turn (openai renders the same turn once).
 *  - client synthetic markers (dsh "[model changed: …]" user turns —
 *    machinery notices, not user words) are dropped, same discipline as the
 *    #1148 leading system run and the #2636 placeholder lines.
 *  - image-capability placeholder text blocks (#2636) are dropped from the
 *    turn text — the placeholder rides the tail on vision-capable renders
 *    only, so keeping it would fork identity on a capability switch (the
 *    #2601 line filter lifted into the neutral domain).
 *  - google `contents[].parts[]` and responses `input[]` item shapes map to
 *    the same turns; anything unrecognized falls back to canonical JSON of
 *    the raw item (same-wire replays stay byte-stable even when a shape is
 *    not neutralized — same input, same hash).
 *
 * Identity guarantees: the projection is a pure function of the message
 * list, so SAME-wire continuity never changes (same bytes in → same hash
 * out). Cross-wire, byte-equal logical content now hashes equal. Different
 * content still hashes differently — nothing here weakens the #1115/#629
 * anti-adoption discipline (ownership still rests on the user's own words
 * and, for adoption, the #2265 anchor gate).
 *
 * #2807 append-stability: merging a consecutive assistant run into ONE
 * turn makes the projection append-UNstable at the tail — a client that
 * appends another assistant message after an assistant tail rewrites the
 * stored tail turn's hash (solo turn → extended run) and the exact prefix
 * ladder in prefix-affinity.ts fails by one item. Each turn therefore also
 * carries `frags`: the per-SOURCE-MESSAGE fragment hashes it was built
 * from (one fragment per message that contributed to the turn). The
 * resolver's continuation rung uses them to recognize an in-place extension
 * (stored tail fragments ⊂ incoming tail fragments) without weakening the
 * byte-exact bar anywhere else. Capped at MAX_TURN_FRAGS per turn.
 */

/** Fragment cap per turn — runs longer than this keep their FIRST
 *  fragments (prefix discipline: the continuation rung only ever asks
 *  whether the stored fragment list is a prefix of the incoming one). */
export const MAX_TURN_FRAGS = 64;

/** Fragment hash of ONE source message's neutral contribution to its turn
 *  (kind included — an assistant fragment never equals a user fragment of
 *  the same text). Deterministic per message, independent of neighbors —
 *  that is the whole point (#2807). */
function fragmentHash(kind: string, text: string, calls: string[]): string {
    return createHash("sha256").update(`v2f\u0000${canon({ calls, kind, text })}`).digest("hex");
}

/** dsh-llm-pi-ai injects this notice into the transcript when the user
 *  switches model mid-session ("[model changed: assistant turns above this
 *  point were generated by glm-5.3; the session continues with glm-5.2]").
 *  It is client machinery, not conversation content — and it renders at
 *  DIFFERENT positions on different wires, so hashing it forks identity. */
const CLIENT_MARKER_RE = /^\[model changed: [^\]]*\]$/;

/** #1148: leading system/developer run (openai in-list system prompt)
 *  carries per-turn harness state (date, cwd, budget) — strip it so the
 *  chain does not fork on every request. Mid-conversation system items are
 *  conversation data and stay. */
function stripLeadingSystemRun(messages: unknown[]): unknown[] {
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (!m || typeof m !== "object") break;
        const role = (m as { role?: unknown }).role;
        if (role !== "system" && role !== "developer") break;
        i++;
    }
    return i === 0 ? messages : messages.slice(i);
}

export interface NeutralTurn {
    /** Turn class marker: "user" | "assistant" | "tool" | raw role. */
    kind: string;
    /** Joined text content (user words, assistant prose, tool result body). */
    text?: string;
    /** Assistant tool calls: `name\u0000canonicalJson(args)`, transcript order. */
    calls?: string[];
    /** #2807: per-source-message fragment hashes this turn was built from
     *  (one per contributing message, transcript order, capped). Lets the
     *  resolver recognize a tail turn that GREW by an appended same-role
     *  message without re-hashing the chain. */
    frags?: string[];
}

/** Deterministic JSON with recursively sorted keys (same discipline as
 *  stableStringify in prefix-affinity.ts — key order must never matter). */
function canon(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
        return out;
    }
    return value;
}

/** openai tool_calls[].function.arguments is a JSON STRING; anthropic
 *  tool_use.input is an object. Canonicalize to parsed sorted-key JSON so
 *  the same call hashes equal on both wires. Unparseable argument strings
 *  fall back to their raw form (deterministic per input). */
function canonicalCallArgs(args: unknown): string {
    if (typeof args === "string") {
        try {
            return canon(JSON.parse(args));
        } catch {
            return canon(args);
        }
    }
    return canon(args ?? {});
}

/** Text carried by an anthropic-style content block. */
function blockText(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (b.type === "text" || b.type === "input_text" || b.type === "output_text") {
        return typeof b.text === "string" ? b.text : "";
    }
    if (b.type === "thinking" || b.type === "redacted_thinking") {
        return typeof b.thinking === "string" ? b.thinking : "";
    }
    return null;
}

/** Tool-result body: anthropic tool_result.content may be a string or a
 *  block list; both reduce to one textual body per result. */
function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const b of content) {
            const t = blockText(b);
            parts.push(t !== null ? t : canon(b));
        }
        return parts.join("");
    }
    return content === undefined ? "" : canon(content);
}

/** Project a protocol message list onto wire-neutral turns. Pure: the same
 *  list always yields the same turn list (same-wire stability), and the
 *  same logical conversation yields the same list across wires. */
export function neutralTurns(messages: unknown[]): NeutralTurn[] {
    const list = stripLeadingSystemRun(messages);
    const turns: NeutralTurn[] = [];
    let asst: NeutralTurn | null = null;
    let asstFrags: string[] = [];
    const flushAssistant = (): void => {
        if (asst === null) return;
        if (asst.calls !== undefined && asst.calls.length === 0) {
            // no calls after all → plain assistant text turn
            asst = { kind: "assistant", text: asst.text ?? "", frags: asstFrags.slice(0, MAX_TURN_FRAGS) };
        } else if (asst.calls !== undefined) {
            // thinking text is renderer-divergent on tool turns — dropped
            delete asst.text;
            asst.frags = asstFrags.slice(0, MAX_TURN_FRAGS);
        }
        turns.push(asst);
        asst = null;
        asstFrags = [];
    };
    const pushTextTurn = (kind: string, text: string, frags?: string[]): void => {
        if (kind === "user" && CLIENT_MARKER_RE.test(text)) return; // client machinery
        turns.push({ kind, text, ...(frags ? { frags } : {}) });
    };

    for (const message of list) {
        if (!message || typeof message !== "object") {
            turns.push({ kind: "raw", text: canon(message), frags: [fragmentHash("raw", canon(message), [])] });
            continue;
        }
        const m = message as {
            role?: unknown;
            content?: unknown;
            tool_calls?: unknown;
            parts?: unknown;
            type?: unknown;
            name?: unknown;
            arguments?: unknown;
            input?: unknown;
            output?: unknown;
            response?: unknown;
            reasoning_content?: unknown;
        };

        // google-generative contents[] items: {role:"user"|"model", parts:[…]}
        if (Array.isArray(m.parts)) {
            const role = m.role === "model" ? "assistant" : typeof m.role === "string" ? m.role : "user";
            const texts: string[] = [];
            const calls: string[] = [];
            let toolBody: string | undefined;
            for (const part of m.parts) {
                if (!part || typeof part !== "object") continue;
                const p = part as { text?: unknown; functionCall?: unknown; functionResponse?: unknown };
                if (typeof p.text === "string" && p.text !== USER_IMAGE_PLACEHOLDER) texts.push(p.text);
                if (p.functionCall && typeof p.functionCall === "object") {
                    const fc = p.functionCall as { name?: unknown; args?: unknown };
                    calls.push(`${String(fc.name ?? "")}\u0000${canon(fc.args ?? {})}`);
                }
                if (p.functionResponse && typeof p.functionResponse === "object") {
                    const resp = (p.functionResponse as { response?: unknown }).response;
                    // gemini clients wrap the tool body under an arbitrary key
                    // ({output:…}/{result:…}/{content:…}); a single-string-valued
                    // object IS the body — unwrap so it equals the openai render.
                    if (typeof resp === "string") toolBody = resp;
                    else if (resp && typeof resp === "object" && !Array.isArray(resp)) {
                        const entries = Object.entries(resp as Record<string, unknown>);
                        toolBody = entries.length === 1 && typeof entries[0]![1] === "string" ? entries[0]![1]! : canon(resp);
                    } else toolBody = canon(resp ?? p.functionResponse);
                }
            }
            // model turns MERGE into the pending assistant run — gemini splits
            // commentary and the function call across contents[] items while
            // openai splits them across messages; both must reduce to the same
            // single run or cross-wire replays fork (#2791).
            if (role === "assistant") {
                asst = asst ?? { kind: "assistant", text: "", calls: [] };
                const joined = texts.join("");
                asst.text = (asst.text ?? "") + joined;
                asst.calls = [...(asst.calls ?? []), ...calls];
                asstFrags.push(fragmentHash("assistant", joined, calls));
                continue;
            }
            flushAssistant();
            if (toolBody !== undefined) turns.push({ kind: "tool", text: toolBody, frags: [fragmentHash("tool", toolBody, [])] });
            if (calls.length > 0 && toolBody === undefined) turns.push({ kind: "assistant", calls, frags: [fragmentHash("assistant", "", calls)] });
            else if (texts.length > 0) pushTextTurn(role, texts.join(""), [fragmentHash(role, texts.join(""), [])]);
            continue;
        }

        // responses-protocol input items: {type:"function_call", …} /
        // {type:"function_call_output", …} arrive as siblings of messages.
        if (typeof m.type === "string" && m.type === "function_call" && typeof m.name === "string") {
            const call = `${m.name}\u0000${canonicalCallArgs(m.arguments)}`;
            // codex splits assistant commentary and the tool call across items —
            // merge into the pending run so it reduces like the openai render.
            if (asst !== null) {
                asst.calls = [...(asst.calls ?? []), call];
                asstFrags.push(fragmentHash("assistant", "", [call]));
                continue;
            }
            flushAssistant();
            turns.push({ kind: "assistant", calls: [call], frags: [fragmentHash("assistant", "", [call])] });
            continue;
        }
        if (typeof m.type === "string" && (m.type === "function_call_output" || m.type === "local_shell_call_output")) {
            flushAssistant();
            const body = typeof m.output === "string" ? m.output : canon(m.output ?? "");
            turns.push({ kind: "tool", text: body, frags: [fragmentHash("tool", body, [])] });
            continue;
        }

        const role = typeof m.role === "string" ? m.role : "?";

        // openai tool result message: {role:"tool", tool_call_id, content}
        if (role === "tool") {
            flushAssistant();
            const body = typeof m.content === "string" ? m.content : Array.isArray(m.content)
                ? m.content.map((b) => { const t = blockText(b); return t !== null ? t : canon(b); }).join("")
                : m.content === undefined || m.content === null ? "" : canon(m.content);
            turns.push({ kind: "tool", text: body, frags: [fragmentHash("tool", body, [])] });
            continue;
        }

        // string content — openai and anthropic shorthand share this shape.
        // (An openai tool-call turn carries `content: null` WITH
        // `tool_calls` — it must fall through to the tool_calls branch
        // below, not be treated as a text-only turn, or its calls vanish
        // from the projection and the chain diverges from the anthropic
        // render of the same conversation.)
        if ((typeof m.content === "string" || m.content === undefined || m.content === null) && !Array.isArray(m.tool_calls)) {
            const text = m.content ?? "";
            if (role === "assistant") {
                asst = asst ?? { kind: "assistant", text: "", calls: [] };
                const own = text + (typeof m.reasoning_content === "string" ? m.reasoning_content : "");
                asst.text = (asst.text ?? "") + own;
                asstFrags.push(fragmentHash("assistant", own, []));
                continue;
            }
            flushAssistant();
            pushTextTurn(role, text, [fragmentHash(role, text, [])]);
            continue;
        }

        // block-list content (anthropic; openai array content)
        if (Array.isArray(m.content)) {
            const texts: string[] = [];
            const calls: string[] = [];
            const results: string[] = [];
            let foreign = false;
            for (const block of m.content) {
                if (!block || typeof block !== "object") { foreign = true; continue; }
                const b = block as { type?: unknown; name?: unknown; input?: unknown; content?: unknown; id?: unknown };
                if (b.type === "tool_use") {
                    calls.push(`${String(b.name ?? "")}\u0000${canonicalCallArgs(b.input)}`);
                } else if (b.type === "tool_result") {
                    results.push(toolResultText(b.content));
                } else {
                    const t = blockText(b);
                    if (t === USER_IMAGE_PLACEHOLDER) continue; // #2636 capability churn — machinery, not content
                    if (t !== null) texts.push(t);
                    else foreign = true; // image/document/etc — canonicalize whole block below
                }
            }
            if (role === "assistant") {
                asst = asst ?? { kind: "assistant", text: "", calls: [] };
                const ownText = texts.join("") + (foreign ? "\u0000foreign:" + canon(m.content) : "");
                asst.text = (asst.text ?? "") + ownText;
                asst.calls = [...(asst.calls ?? []), ...calls];
                asstFrags.push(fragmentHash("assistant", ownText, calls));
                continue;
            }
            flushAssistant();
            for (const r of results) turns.push({ kind: "tool", text: r, frags: [fragmentHash("tool", r, [])] }); // split multi-result messages
            if (results.length > 0 && texts.length > 0 && role === "user") pushTextTurn("user", texts.join(""), [fragmentHash("user", texts.join(""), [])]);
            else if (results.length === 0 && texts.length > 0) pushTextTurn(role, texts.join(""), [fragmentHash(role, texts.join(""), [])]);
            else if (results.length === 0 && texts.length === 0 && role === "user" && foreign) pushTextTurn("user", canon(m.content), [fragmentHash("user", canon(m.content), [])]);
            continue;
        }

        // openai assistant with tool_calls and non-array content
        if (Array.isArray(m.tool_calls)) {
            if (role === "assistant") {
                asst = asst ?? { kind: "assistant", text: "", calls: [] };
                const calls = m.tool_calls
                    .filter((tc): tc is { function?: { name?: unknown; arguments?: unknown } } => !!tc && typeof tc === "object")
                    .map((tc) => `${String(tc.function?.name ?? "")}\u0000${canonicalCallArgs(tc.function?.arguments)}`);
                asst.calls = [...(asst.calls ?? []), ...calls];
                asstFrags.push(fragmentHash("assistant", "", calls));
                continue;
            }
        }

        // unrecognized shape — canonical JSON keeps same-wire replays stable
        flushAssistant();
        turns.push({ kind: role, text: canon(m), frags: [fragmentHash(role, canon(m), [])] });
    }
    flushAssistant();
    return turns;
}

/** Canonical string of a neutral turn — the single hashing input for the
 *  identity chain, per-item hashes and #2265 sketches. */
export function neutralTurnCanonical(turn: NeutralTurn): string {
    // Shape fidelity, not a wrapper: the #2265 simhash gates in
    // prefix-affinity.ts (ALIGN_SIMILAR_HAMMING etc.) were calibrated on
    // the feature distribution of the RAW-wire canon `{"content":\u2026,
    // "role":\u2026}` (word-bigram shingles \u2014 other wrapper shapes re-weight
    // every sketch and push borderline decorative rewrites across the
    // thresholds). Text-only turns therefore canonicalize to EXACTLY that
    // v1 string (same body \u2192 same sketch \u2192 the existing tuning stays
    // valid); calls turns use the analogous `{calls, role}` shape. The
    // string is still wire-neutral \u2014 it is built from the extracted turn,
    // never from the raw message \u2014 so openai and anthropic renders of the
    // same conversation canonicalize identically (#2791).
    if (turn.calls !== undefined) return canon({ calls: turn.calls, role: turn.kind });
    return canon({ content: turn.text ?? "", role: turn.kind });

}
