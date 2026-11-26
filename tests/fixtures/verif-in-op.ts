/**
 * Test fixture for the verif translator's `in` operator support (#7627).
 *
 * `in` sits in a NON-discarded path (the function's main condition), so a
 * missing translator case would degrade the if-condition and the degradation
 * would propagate to `r.degradations` (the regression the test pins).
 *
 * - hasRange: concrete key `"range"` — the own-property approximation folds.
 * - hasKey: variable key — a symbolic key cannot be resolved against the
 *   obj's concrete fields, so the if-condition degrades (documented limit).
 */
export function hasRange(value: Record<string, unknown>): boolean {
  if ("range" in value) {
    return true;
  }
  return false;
}

export function hasKey(value: Record<string, unknown>, key: string): boolean {
  if (key in value) {
    return true;
  }
  return false;
}
