// #766 — Strict Responses backends (DeepSeek) reject a request whose
// function_call_output does not directly follow its call group: a message/reasoning
// item wedged between a call and its output yields "No tool output found for tool
// call <id>" even though both items exist. Enforced at the wire boundary: any such
// trapped item is hoisted just before the earliest call it sits between. No-op on
// healthy input, so well-formed sessions stay byte-stable for the prefix cache.

interface ToolPairItem {
    type?: string;
    call_id?: string;
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

function isCall(type: string | undefined): boolean {
    return type !== undefined && CALL_TYPES.has(type);
}

function isOutput(type: string | undefined): boolean {
    return type !== undefined && OUTPUT_TYPES.has(type);
}

function idOf(item: ToolPairItem): string {
    return typeof item.call_id === "string" ? item.call_id : "";
}

export function hoistTrappedToolItems<T extends ToolPairItem>(items: T[]): T[] {
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

    const groups: Array<{ start: number; end: number }> = [];
    for (const [id, start] of callPos) {
        const end = outPos.get(id);
        if (end === undefined || end <= start) continue;
        const previous = groups.at(-1);
        if (previous && start < previous.end) previous.end = Math.max(previous.end, end);
        else groups.push({ start, end });
    }
    if (groups.length === 0) return items;

    // Overlapping pairs form one group: hoisting into an earlier pair would create a new trap.
    const hoistBefore = new Array<number | null>(n).fill(null);
    let anyTrapped = false;
    let groupIndex = 0;
    for (let p = 0; p < n; p++) {
        const t = items[p].type;
        if (isCall(t) || isOutput(t)) continue;
        while (groupIndex < groups.length && groups[groupIndex].end <= p) groupIndex++;
        const group = groups[groupIndex];
        if (group && group.start < p) {
            hoistBefore[p] = group.start;
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
        if (batch) for (const item of batch) result.push(item);
        result.push(items[p]);
    }
    return result;
}
