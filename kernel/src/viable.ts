/** Minimum size for a compressible range to be worth recommending. Ranges
 *  below this are fragmented leftovers (a 16-token ack, a one-line tool
 *  result): the model cannot write a meaningful >=50-char summary for them,
 *  and a batched compress call that includes one gets atomically rejected
 *  (the kernel validates the whole batch). Observed in the wild: a 14-range
 *  recommendation list containing a 16-token range → every batch attempt
 *  failed with "Summary too short". Apply on every surface that recommends
 *  ranges: the injected nudge, acp_status, and the /acp panel. */
export const VIABLE_RANGE_MIN_TOKENS = 200;

export function viableRanges<T extends { tokens: number }>(ranges: T[]): T[] {
  return ranges.filter((r) => r.tokens >= VIABLE_RANGE_MIN_TOKENS);
}
