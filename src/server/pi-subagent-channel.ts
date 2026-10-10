// #2268: pi-subagents builtin roles ship strict frontmatter `tools:` allowlists
// that list none of the ACP context tool names. Since #2209's required-extension
// self-registration those children load bili and get named plugin sessions — but
// pi's child tool planning never adds extension-registered names to the effective
// allowlist, so the model cannot call compress/decompress/search_context/acp_status
// locally while the proxy (plugin mode) withholds wire injection. Pre-#2209,
// foreground children ran as anonymous proxy-mode sessions where wire-injected
// ACP tools worked; the upgrade silently downgraded interactive compression for
// those roles.
//
// Fix (owner-scoped to nicobailon/pi-subagents children only): a capability-aware
// channel fallback. Every in-process pi-subagents child request carries a stable
// identity marker in its system prompt — `<active_agent name="..."/>` followed by
// the role prompt (child-launch.ts in pi-subagents stamps it onto the child's
// system prompt; appended by default, replacing only in replace mode). When a
// plugin-stamped pi request carries that marker AND its tools array exposes none
// of the tool names bili would inject, the request is served through the
// proxy-style channel (wire-injected tools + nudge, server-side execution,
// acp_summary carrier): exactly what pre-#2209 foreground children got, now on
// top of named-session identity. The decision is stateless per request — a
// mid-session whitelist change self-heals on the next request, and if upstream
// ever drops the tag we degrade gracefully to today's behavior. A role exposing
// ANY bili-injectable name stays pure plugin mode (duplicate tool declarations
// are rejected by providers; partial grants remain unsupported by design).
//
// #2694 hardening: the marker search is scoped to the SYSTEM CARRIERS of the
// parsed body (top-level `system`, responses `instructions`, google
// `systemInstruction.parts`, and messages[]/input[] entries with role
// system|developer — the same carriers estimateWireOverhead counts, see
// src/server/budget.ts). History text (tool results, assistant/user messages)
// that merely QUOTES the marker no longer flips the channel: a main session
// reading repo docs about subagents stays plugin mode. The marker must also be
// COMPLETE — a quoted non-empty name right after the prefix; a bare prefix or an
// empty name is documentation residue, not an identity assertion. An unparseable
// or non-object body cannot be a genuine child request (they are plain JSON) —
// fail closed instead of byte-scanning. The tool walk additionally recurses into
// nested `tools` arrays so Responses-wire namespace wraps
// ({type:"namespace", tools:[...]}) exposing ACP grants are seen, not treated as
// absent.

/** Complete child-stamp contract: the producer emits
 *  `<active_agent name="<non-empty>"/>` (XML-attr-escaped name) in the tagged
 *  prompt. We require the prefix plus a quoted non-empty name but do NOT require
 *  the tag to terminate immediately after the closing quote, so extra attributes
 *  added by a future producer format still match. */
const PI_SUBAGENT_CHILD_MARKER_RE = /\x3cactive_agent name="([^"]+)"/;

/** Tool names bili may add to the request tools array when serving the
 *  proxy-style channel: the core ACP four plus the feature extras at their
 *  default names (absorb.toolName / ccr.toolName are config-renamable — a
 *  renamed extra colliding with a role-whitelisted name is an accepted residual
 *  edge, see PR #2268 discussion). */
const BILI_INJECTABLE_TOOL_NAMES = new Set([
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_rule",
    "acp_retrieve",
    "absorb",
    "image_full",
]);

// module-local type: only this file's exported detectors return it (internal-only export
// would trip the unused-export gate; fixed in-passing in the crush PR like 52d44540)
type PiSubagentChildSignal = { present: false } | { present: true; agent?: string };

function signalFromText(text: string): PiSubagentChildSignal {
    const m = PI_SUBAGENT_CHILD_MARKER_RE.exec(text);
    if (!m) return { present: false };
    return { present: true, agent: m[1] };
}

function blockText(v: unknown): string | undefined {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
        const t = (v as Record<string, unknown>).text;
        if (typeof t === "string") return t;
    }
    return undefined;
}

function pushBlockTexts(out: string[], blocks: unknown[]): void {
    for (const b of blocks) {
        const t = blockText(b);
        if (t !== undefined) out.push(t);
    }
}

/** System-carrier texts of a parsed request body, covering all four wire shapes:
 *  anthropic/openai-hoisted top-level `system` (string or text-block array),
 *  responses `instructions`, google `systemInstruction.parts`, and system/developer
 *  entries kept inside `messages[]`/`input[]` by raw clients (identical carrier
 *  list to estimateWireOverhead, src/server/budget.ts). */
function systemCarrierTexts(parsed: Record<string, unknown>): string[] {
    const out: string[] = [];
    const sys = parsed.system;
    if (typeof sys === "string") out.push(sys);
    else if (Array.isArray(sys)) pushBlockTexts(out, sys);
    const inst = parsed.instructions;
    if (typeof inst === "string") out.push(inst);
    const si = parsed.systemInstruction;
    if (typeof si === "object" && si !== null) {
        const parts = (si as Record<string, unknown>).parts;
        if (Array.isArray(parts)) pushBlockTexts(out, parts);
    }
    for (const key of ["messages", "input"]) {
        const arr = parsed[key];
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
            if (typeof entry !== "object" || entry === null) continue;
            const rec = entry as Record<string, unknown>;
            if (rec.role !== "system" && rec.role !== "developer") continue;
            const c = rec.content;
            if (typeof c === "string") out.push(c);
            else if (Array.isArray(c)) pushBlockTexts(out, c);
        }
    }
    return out;
}

function detectInParsed(parsed: Record<string, unknown>): PiSubagentChildSignal {
    for (const text of systemCarrierTexts(parsed)) {
        const sig = signalFromText(text);
        if (sig.present) return sig;
    }
    return { present: false };
}

/** Detect the pi-subagents child marker in a request body. #2694: the marker
 *  only counts when it sits in a SYSTEM CARRIER (see systemCarrierTexts) and is
 *  complete (quoted non-empty name). An unparseable or non-object body cannot be
 *  a genuine child request — fail closed rather than byte-scan history text. */
export function detectPiSubagentChildSignal(bodyBuffer: Buffer): PiSubagentChildSignal {
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
        return { present: false };
    }
    if (typeof parsed !== "object" || parsed === null) return { present: false };
    return detectInParsed(parsed as Record<string, unknown>);
}

function isInjectableName(v: unknown): boolean {
    return typeof v === "string" && BILI_INJECTABLE_TOOL_NAMES.has(v);
}

const TOOL_WALK_MAX_DEPTH = 8;

function exposesInjectableInList(entries: unknown, depth: number): boolean {
    if (!Array.isArray(entries) || depth > TOOL_WALK_MAX_DEPTH) return false;
    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const rec = entry as Record<string, unknown>;
        if (isInjectableName(rec.name)) return true;
        const fn = rec.function;
        if (typeof fn === "object" && fn !== null && isInjectableName((fn as Record<string, unknown>).name)) return true;
        const decls = rec.functionDeclarations;
        if (Array.isArray(decls) && exposesInjectableInList(decls, depth + 1)) return true;
        // #2694: Responses-wire namespaces wrap their members in a nested
        // `tools` array ({type:"namespace", name, tools:[...]}); recurse so a
        // namespaced ACP grant is seen, not treated as absent. Any wrapper shape
        // carrying a nested tools list is covered by the same step.
        if (Array.isArray(rec.tools) && exposesInjectableInList(rec.tools, depth + 1)) return true;
    }
    return false;
}

/** Does the client-declared tools array expose any bili-injectable tool name?
 *  One generic walk covers all four wire shapes: top-level `name` (anthropic /
 *  responses), `function.name` (openai), `functionDeclarations[].name` (google),
 *  plus nested `tools` arrays (responses namespace wraps, #2694). Malformed
 *  entries are skipped, never thrown on — bodies are client-supplied. */
export function exposesBiliInjectableTool(tools: unknown): boolean {
    return exposesInjectableInList(tools, 0);
}

/** Full gate: pi-subagents child marker present in a system carrier AND the
 *  role allowlist exposes no bili-injectable tool name. Caller additionally
 *  requires pluginAgent==="pi". Reuses the caller's parsed body when available
 *  (no double parse on the hot path). */
export function piSubagentChannelFallback(bodyBuffer: Buffer, parsed: unknown): PiSubagentChildSignal {
    let signal: PiSubagentChildSignal;
    let tools: unknown;
    if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        signal = detectInParsed(rec);
        tools = rec.tools;
    } else {
        signal = detectPiSubagentChildSignal(bodyBuffer);
    }
    if (!signal.present) return signal;
    if (exposesBiliInjectableTool(tools)) return { present: false };
    return signal;
}
