import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Whether the host exposes Pi's buildContextEntries() session API (same check
 *  as billion-context-pi). Non-Pi hosts (OMP) never register acp_delegate —
 *  mirroring the main extension's refusal, which also gated the delegate. */
export function isPiHost(sm: ExtensionContext["sessionManager"]): boolean {
  const source = sm as unknown as { buildContextEntries?: unknown };
  return typeof source.buildContextEntries === "function";
}

/** Whether the host declared itself a Pi-compatible fork via environment
 *  (PI_ACP_FORK_HOST=1) — same contract as billion-context-pi's docs/host-adapter.md. */
export function isDeclaredForkHost(): boolean {
  const v = process.env.PI_ACP_FORK_HOST;
  return v === "1" || v?.toLowerCase() === "true";
}
