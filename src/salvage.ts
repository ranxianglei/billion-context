// #4889: public repair entry for layers that sit BETWEEN the model and bili's
// tool execution — provider plugins / gateways that assemble tool_call
// arguments and hand them to a host doing ONE strict JSON.parse per call.
// They hold the complete argument bytes before any parse; running them through
// salvageCompressArgs there recovers bad-shape-A compress args (#2580) on the
// lanes where bili's own wire rewrite never sees them (third-party providers,
// non-Anthropic protocols). Same implementation as the plugin relay's rewrite
// (plugin-compress-salvage.ts) — no second regex copy.
// #1039 boundary inherited from the ladder: strict-JSON input returns null
// (leave it byte-identical), unrecoverable input returns null too (the host
// rejects it as today); non-null is always strict JSON ready to parse.
// `ranges` = how many compress ranges the rescue recovered, so gateways can
// log how much was salvaged per repair (#4891 gateway feedback).

import { salvageCompressArgs } from "./plugin-compress-salvage.js";

export interface RepairCompressArgsResult {
    json: string;   // strict JSON, ready for the host's single JSON.parse
    ranges: number; // compress ranges recovered by the rescue
}

export function repairCompressArgs(raw: string, callId?: string): RepairCompressArgsResult | null {
    const s = salvageCompressArgs(raw, callId ?? "external-salvage");
    return s.action === "canonicalized" || s.action === "wrapped" ? { json: s.out, ranges: s.ranges } : null;
}
