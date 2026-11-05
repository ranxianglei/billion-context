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
import { registerCompactionDisable, type CompactionDisableHost } from "./dsh-compaction-disable.js";

type PluginContext = CompactionDisableHost;

export const name = "bili-compaction-gate";
export const inject: string[] = [];

export function apply(ctx: PluginContext): void {
    registerCompactionDisable(ctx);
}
