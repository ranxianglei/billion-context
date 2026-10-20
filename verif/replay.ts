// Counterexample replay lock (#3848/#3853).
//
// What gets verified is ALWAYS the real code: the solver's witness only
// counts once the real compiled function reproduces it. A non-reproducing
// witness means the translator (the lens over the source) has distorted —
// the mismatch is reported as REPLAY MISMATCH so the skew is exposed on the
// spot instead of shipping a proof about a phantom.

export interface ReplayExpectation {
  args: unknown[];
  expect: { throws: string } | { returns: true };
}

export interface ReplayResult {
  args: unknown[];
  ok: boolean;
  detail: string;
}

export async function replay(
  modPath: string,
  fnName: string,
  expectations: ReplayExpectation[],
): Promise<ReplayResult[]> {
  const mod: Record<string, unknown> = await import(modPath);
  const fn = mod[fnName];
  if (typeof fn !== "function") {
    throw new Error(`${fnName} is not exported as a function from ${modPath}`);
  }
  const call = fn as (...a: unknown[]) => unknown;

  const results: ReplayResult[] = [];
  for (const exp of expectations) {
    let outcome: string;
    try {
      call(...exp.args);
      outcome = "returned";
    } catch (e) {
      outcome = e instanceof Error ? e.constructor.name : typeof e;
    }
    let ok: boolean;
    let expected: string;
    if ("throws" in exp.expect) {
      expected = exp.expect.throws;
      ok = outcome === exp.expect.throws;
    } else {
      expected = "return";
      ok = outcome === "returned";
    }
    results.push({
      args: exp.args,
      ok,
      detail: ok ? `${outcome} as expected` : `REPLAY MISMATCH: expected ${expected}, got ${outcome}`,
    });
  }
  return results;
}
