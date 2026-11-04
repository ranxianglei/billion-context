// #766 — Strict Responses backends (DeepSeek) reject a request whose
// function_call_output does not directly follow its call group: a message/reasoning
// item wedged between a call and its output yields "No tool output found for tool
// call <id>" even though both items exist. Enforced at the wire boundary: any such
// trapped item is hoisted just before the earliest call it sits between. No-op on
// healthy input, so well-formed sessions stay byte-stable for the prefix cache.
// #5670 — Codex 0.166 additionally emits tool_search_call / tool_search_output pairs
// (OpenAI tool-search feature), which were absent from the type sets above, so neither
// guarantee applied to them. Second failure mode on the same boundary: when compression
// drops a call but keeps its output, no reordering can save the turn — strict backends
// 400 the whole request with "No tool call found for tool output <id>" and the session
// is stuck until restart. Fail closed here: orphaned outputs are dropped and logged.
// Both guarantees are no-ops (same array reference) on healthy input.

import { log } from "./logger.js";

interface ToolPairItem {
    type?: string;
    call_id?: string;
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call", "tool_search_call"]);
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

function isCall(type: string | undefined): boolean {
    return type !== undefined && CALL_TYPES.has(type);
}

function isOutput(type: string | undefined): boolean {
    return type !== undefined && OUTPUT_TYPES.has(type);
}

function idOf(item: ToolPairItem): string {
    return typeof item.call_id === "string" ? item.call_id : "";
}

// #5670 fail-closed half: an output whose call_id matches no call in the array can never
// be valid upstream (a compression pass that dropped the call leaves exactly this shape),
// so it is dropped instead of shipped. Outputs with an empty/missing call_id are kept —
// unjudgeable, and dropping them would lose data we cannot prove orphaned. Returns the
// same reference when nothing is dropped (byte-stable for the prefix cache).
export function dropOrphanToolOutputs<T extends ToolPairItem>(items: T[]): T[] {
    const callIds = new Set<string>();
    for (const it of items) {
        if (!isCall(it.type)) continue;
        const id = idOf(it);
        if (id) callIds.add(id);
    }
    const dropped: string[] = [];
    const kept = items.filter((it) => {
        if (!isOutput(it.type)) return true;
        const id = idOf(it);
        if (!id || callIds.has(id)) return true;
        dropped.push(id);
        return false;
    });
    if (dropped.length === 0) return items;
    log("warn", `[tool-pair-order] dropped ${dropped.length} orphan tool output(s) whose call is absent from the outbound array: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ""}`);
    return kept;
}

export function hoistTrappedToolItems<T extends ToolPairItem>(input: T[]): T[] {
    const items = dropOrphanToolOutputs(input);
    const n = items.length;
    if (n < 3) return items;

    const callPos = new Map<string, number>();
    const outPos = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const id = idOf(items[i]);
        if (!id) continue;
        const t = items[i].type;
        if (isCall(t) && !callPos.has(id)) callPos.set(id, i);
        else if (isOutput(t) && !outPos.has(id)) outPos.set(id, i);
    }
    if (callPos.size === 0) return items;

    // For each non-tool item p, find the earliest call c < p whose output o > p.
    // Such an item is "trapped" between that call and its output.
    const hoistBefore = new Array<number | null>(n).fill(null);
    let anyTrapped = false;
    for (let p = 0; p < n; p++) {
        const t = items[p].type;
        if (isCall(t) || isOutput(t)) continue;
        let target = -1;
        for (const [id, c] of callPos) {
            const o = outPos.get(id);
            if (o === undefined || !(c < p && o > p)) continue;
            if (target === -1 || c < target) target = c;
        }
        if (target >= 0) {
            hoistBefore[p] = target;
            anyTrapped = true;
        }
    }
    if (!anyTrapped) return items;

    const pendingByTarget = new Map<number, T[]>();
    for (let p = 0; p < n; p++) {
        const target = hoistBefore[p];
        if (target === null) continue;
        const batch = pendingByTarget.get(target);
        if (batch) batch.push(items[p]);
        else pendingByTarget.set(target, [items[p]]);
    }

    const result: T[] = [];
    for (let p = 0; p < n; p++) {
        if (hoistBefore[p] !== null) continue;
        const batch = pendingByTarget.get(p);
        if (batch) result.push(...batch);
        result.push(items[p]);
    }
    return result;
}
