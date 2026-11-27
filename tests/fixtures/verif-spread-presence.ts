/**
 * #7823 regression fixture — object spread over conditionally-built objects.
 * Translated by the verif smoke test (tests/verif-spread-presence.test.ts).
 */
export function spreadMerge(x: number, y: number): number {
  const a = x > 0 ? { v: 1 } : {};
  const b = y > 0 ? { v: 2 } : {};
  const o = { ...a, ...b };
  return x > 0 ? (o.v as number) : -1;
}
