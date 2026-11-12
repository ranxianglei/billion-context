/** [#5688] OpenRouter's Anthropic Messages surface rejects a history that
 *  contains two ADJACENT `{role:"system", content:[], output_config:{...}}`
 *  effort directives ("Two adjacent output_config directives are not
 *  allowed"). Clients that emit per-turn effort directives (pi's
 *  insertThinkingLevelMessages: one before every leveled assistant message +
 *  one trailing) are healthy on their own — every directive is separated by
 *  its assistant message. But bili's fold reconstruction can remove the
 *  message BETWEEN two directives (reasoning hygiene, CCR excerpting, range
 *  trimming, empty-message pruning), leaving them adjacent and the session
 *  deterministically 400s on every retry.
 *
 *  Repair at egress: collapse runs of adjacent effort directives down to the
 *  LAST one (later effort wins — the same semantics the trailing active
 *  directive relies on). Detection is deliberately narrow: a system message
 *  whose content is an EMPTY array (or absent / empty string) carrying an
 *  output_config object — exactly the directive shape, nothing else. Ordinary
 *  system messages (text content) are never touched. Returns the input array
 *  unchanged when nothing was adjacent.
 *
 *  Shared by every anthropic-wire egress surface that renders from a core
 *  view fold reconstruction can leave adjacent in: the steady prepare egress
 *  (prepare-anthropic), the nudge-decide side body (same file), and the loop
 *  round-2 rebuild (loop/adapter-anthropic buildRequest). */
export function dedupeAdjacentOutputConfig<T>(messages: T[]): T[] {
    const isDirective = (m: unknown): boolean => {
        const msg = m as { role?: unknown; content?: unknown; output_config?: unknown };
        if (msg?.role !== "system") return false;
        if (msg.output_config === null || typeof msg.output_config !== "object") return false;
        if (Array.isArray(msg.content) && msg.content.length > 0) return false;
        if (typeof msg.content === "string" && msg.content.length > 0) return false;
        return true;
    };
    const out: T[] = [];
    let removed = 0;
    for (const m of messages) {
        if (out.length > 0 && isDirective(m) && isDirective(out[out.length - 1])) {
            out[out.length - 1] = m; // later effort wins
            removed++;
            continue;
        }
        out.push(m);
    }
    return removed > 0 ? out : messages;
}
