import { bodyDumpEnabled } from "../knobs.js";

// #5385: observation-only instrument for prompt-cache-break triage. Anthropic
// caching is explicit and PREFIX-based, so when a rebuild changes a body byte
// ahead of the tail (e.g. a mid-history fold) the stable prefix shrinks and the
// next request re-caches from the first changed message to the tail — the exact
// symptom #5385 reports (cache_read pinned at the system+tools prefix while
// cache_creation grows with session length). Each turn we compare the rebuilt
// outbound message list against the PREVIOUS turn's by per-message fingerprint
// and report the longest common prefix + what sits at the boundary + where the
// cache_control breakpoints landed. Reads the rebuilt body, NEVER touches the
// wire bytes. Gated behind diagnostics.dumpBody / ACP_DUMP_BODY (off by default)
// so there is zero overhead unless you are already inspecting bodies; levels:
// debug every turn, info exactly on shrinkage (the cache-break event), landing
// in the same bili.log users send for triage.

function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/** Compact order-stable fingerprint of one outbound wire message: role, content
 *  shape, block-type run, thinking/cache-control presence, total text length and
 *  a content hash. Equal fingerprints ⇒ equal bytes for caching purposes. */
function fingerprint(m: unknown): string {
    const msg = m as { role?: unknown; content?: unknown };
    const role = typeof msg.role === "string" ? msg.role : "?";
    const c = msg.content;
    if (typeof c === "string") {
        return `${role}|str|len=${c.length}|h=${djb2(c)}`;
    }
    if (!Array.isArray(c)) {
        return `${role}|${c === undefined ? "nil" : typeof c}`;
    }
    let textLen = 0;
    let think = false;
    let cc = false;
    const types: string[] = [];
    for (const b of c as Array<Record<string, unknown>>) {
        const t = typeof b?.type === "string" ? b.type : "?";
        types.push(t);
        if (t === "thinking" || t === "redacted_thinking") think = true;
        if (b?.cache_control !== undefined) cc = true;
        if (typeof b?.text === "string") textLen += b.text.length;
        else if (typeof b?.thinking === "string") textLen += b.thinking.length;
        else if (b?.input !== undefined || b?.content !== undefined) textLen += JSON.stringify(b.input ?? b.content ?? "").length;
    }
    return `${role}|blk|types=[${types.join(",")}]|think=${think ? 1 : 0}|cc=${cc ? 1 : 0}|len=${textLen}|h=${djb2(JSON.stringify(c))}`;
}

export function observeOutboundPrefix(
    sessionId: string,
    messages: ReadonlyArray<unknown>,
    meta: Record<string, unknown>,
    log: (level: string, msg: string) => void,
): void {
    if (!bodyDumpEnabled()) return;
    try {
        const cur = messages.map(fingerprint);
        const key = "outboundPrefixFingerprint";
        const prev = Array.isArray(meta[key]) ? (meta[key] as string[]) : null;
        meta[key] = cur;
        if (!prev || prev.length === 0) return;
        const n = Math.min(prev.length, cur.length);
        let lcp = 0;
        while (lcp < n && prev[lcp] === cur[lcp]) lcp++;
        // A mid-history byte change vs last turn: the whole previous list no
        // longer matches from some index on (a healthy append keeps lcp == prev).
        const shrank = lcp < prev.length;
        const ccIdx: number[] = [];
        for (let i = 0; i < cur.length; i++) if (cur[i].includes("|cc=1")) ccIdx.push(i);
        const detail = shrank
            ? ` BREAK@${lcp} prev[${prev.length}]="${prev[lcp] ?? "<end>"}" -> cur[${cur.length}]="${cur[lcp] ?? "<end>"}"`
            : "";
        log(shrank ? "info" : "debug", `[${sessionId}] outbound-prefix: lcp=${lcp}/${cur.length} (prev ${prev.length}) cc@[${ccIdx.join(",")}]${detail} (#5385)`);
    } catch {
        // observation-only: never disturb the request path
    }
}
