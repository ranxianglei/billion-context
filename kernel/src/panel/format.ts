/** Compact token formatting for user-facing panels: lowercase k/M with the
 *  same thresholds as the hosts' footers (<1000 → raw, <10000 → one decimal
 *  k, <1e6 → rounded k, <1e7 → one decimal M). */
export function formatCompactTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
