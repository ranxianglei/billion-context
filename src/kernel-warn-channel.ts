// #7791: where the kernel's own mid-turn diagnostics go.
//
// The kernel is I/O-free by contract, so its diagnostics reached the outside
// world through `console.warn` (kernel/src/recommend.ts, kernel/src/compress.ts).
// That is fine for a CLI proxy — stderr is a log stream — but the inline lanes
// embed the SAME core inside the host agent process, where stderr IS the
// interactive TUI: a console write lands on the physical screen appended to the
// input-box line until the next redraw (#2827/#2831/#5940 are the same defect
// class from other sources, see agent/host-log.ts). The logger's stderr mute
// (inline-engine's muteStderrLeg) cannot help — it governs bili's OWN tee
// logger, not a raw console call from a bundled module.
//
// So every lane builds its core through here and picks a sink at construction
// time (the choice is baked into the pipeline nodes, like #4313's timestamps):
//   - inline lanes (in-process engine inside pi/omp/dsh/opencode): durable
//     bili.log only, zero terminal traffic;
//   - server lanes (standalone `bili start`, launcher attach): the proxy's own
//     tee logger, which already knows whether stderr is a log stream or a
//     terminal (logger's stderr leg + mute rules);
//   - anything unrecognized: the historical console.warn (byte-identical to
//     pre-#7791 behavior), so a new lane can never lose the diagnostic.
import type { Ports } from "acp-kernel";
import { logHostEvent } from "./agent/host-log.js";
import { log as loggerLog } from "./logger.js";

type KernelDiagLane = "inline" | "server";

/** Sink for one kernel core. The kernel already prefixes its own lines with
 *  `[acp-kernel]`, so the inline leg passes an EMPTY origin — host-log.ts drops
 *  the separator and the line matches what the server leg records. */
export function kernelWarnSink(lane: KernelDiagLane | undefined): Pick<Ports, "warn"> {
    if (lane === "inline") {
        return {
            warn: (message: string) => logHostEvent("warn", "", message),
        };
    }
    if (lane === "server") {
        return { warn: (message: string) => loggerLog("warn", message) };
    }
    return {};
}
