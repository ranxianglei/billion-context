/**
 * Counterexample replay — the anti-drift lock of the verification pipeline.
 *
 * A solver witness is only a FINDING if the real compiled kernel code
 * reproduces it. If the translated model and the real code disagree, the
 * replay fails and the translator is wrong — that failure is the signal,
 * never "verification passed anyway".
 */

/** Parse z3's s-expression numeric output: "5", "(- 5808901)", "96.0",
 *  "10000000.0", "(/ 1 3)". Reals that are not integral return NaN — the
 *  caller must constrain the witness variable to integers. */
export function parseIntWitness(raw: string): number {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  // Real numerals print with a decimal tail ("96.0", "-3.0")
  const real = /^(-?\d+)\.0+$/.exec(t);
  if (real) return Number(real[1]);
  const m = /^\(\s*(-|\+)\s+(\d+)\)$/.exec(t);
  if (m) return m[1] === "-" ? -Number(m[2]) : Number(m[2]);
  return Number.NaN;
}

export async function replayThrows(
  fn: (x: number) => unknown,
  arg: number,
): Promise<boolean> {
  try {
    fn(arg);
    return false;
  } catch {
    return true;
  }
}
