// #3662: the always-on half of the #3354 compaction gate. bili-native used to
// own BOTH the load-time overlay and the service the four web-profile presets
// inject — so disabling or kill-switching it removed the service and left the
// presets pending forever, bricking session creation. The overlay now lives in
// this separate entry, which has no dependencies of its own and therefore
// activates whenever the bundle patch / launcher overlay is mounted, whatever
// bili-native's state. It registers the transform and provides the gate
// service atomically (the #3354 ordering guarantee survives the split);
// WHETHER the transform actually disables rows is decided per process by the
// verdict bili-native declares — see dsh-compaction-disable.ts.
import {
    hostPlaneOverrideLostWarning,
    hostPlaneRowsMissingAutoFalse,
    registerCompactionDisable,
    type CompactionDisableHost,
} from "./dsh-compaction-disable.js";
import { logHostEvent } from "./host-log.js";

/** What the #7113 scan needs from the host loader (never a hard dependency:
 *  a required `loader` here would restore the #3662 failure mode — this entry
 *  would pend and the presets would keep waiting on a service it never
 *  publishes). */
export type LoaderFace = { loader?: { entries?: () => Iterable<unknown> } };

type GateContext = CompactionDisableHost & {
    inject?: (deps: string[], callback: (inner: LoaderFace) => void) => unknown;
};

export const name = "bili-compaction-gate";
export const inject: string[] = [];

/** Boot-time alarm text for a profile whose host-plane override is gone
 *  (null = the declaration survived, or the row is stock-disabled). */
export function hostPlaneWarningFor(inner: LoaderFace): string | null {
    const entries = inner.loader?.entries?.();
    if (entries === undefined) return null;
    const lost = hostPlaneRowsMissingAutoFalse(entries);
    return lost.length === 0 ? null : hostPlaneOverrideLostWarning(lost);
}

export function apply(ctx: GateContext): void {
    registerCompactionDisable(ctx);
    ctx.inject?.(["loader"], (inner) => {
        const warning = hostPlaneWarningFor(inner);
        if (warning !== null) logHostEvent("warn", "bili-compaction-gate", warning);
    });
}
