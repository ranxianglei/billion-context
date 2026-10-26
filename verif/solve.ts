// Out-of-process SMT solving. The in-process z3-solver npm package is WASM
// (2GB heap cap) and OOMs on two-turn cache-stability formulas; native z3
// spins on the seq/LRA mix. cvc5 solves the same formulas instantly, so the
// runner prefers it when available. Override with VERIF_SOLVER_CMD (a command
// prefix that receives the smt2 file path as its last argument and must print
// `sat`/`unsat` plus `(get-value ...)` s-expr replies on stdout).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface SolveResult {
  status: "sat" | "unsat" | "unknown";
  /** Parsed `(get-value ...)` replies, in declaration order: raw strings. */
  values: string[];
  raw: string;
}

/** Parse the printed form of a get-value reply: `((name value) (name value))`
 * — one outer list of pairs; handles nested parens in name and value. */
const parseValues = (raw: string): string[] => {
  const out: string[] = [];
  const start = raw.indexOf("((");
  if (start < 0) return out;
  const s = raw.slice(start + 1); // s starts at the first PAIR's `(`
  let i = 0;
  const n = s.length;
  const readSexp = (): string => {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (s[i] === "\"") { // quoted SMT string: until the real closing quote ("" is an escaped quote)
      const b = i; i++;
      while (i < n) { if (s[i] === "\"") { if (s[i + 1] === "\"") { i += 2; continue; } i++; break; } i++; }
      return s.slice(b, i);
    }
    if (s[i] !== "(") { const j = i; while (i < n && !/[\s)]/.test(s[i]!)) i++; return s.slice(j, i); }
    let depth = 0; const b = i;
    while (i < n) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") { depth--; if (depth === 0) { i++; return s.slice(b, i); } }
      i++;
    }
    return s.slice(b);
  };
  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (s[i] !== "(") break; // end of the pair list
    i++; // past the pair's opening paren
    const name = readSexp(); void name;
    const value = readSexp();
    out.push(value);
    while (i < n && /\s/.test(s[i]!)) i++;
    if (s[i] === ")") i++; // pair close — keep going; next pair or list end follows
  }
  return out;
};

interface Attempt {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  parse: (raw: string) => SolveResult;
}

const buildAttempts = (file: string): Attempt[] => {
  const attempts: Attempt[] = [];
  if (process.env.VERIF_SOLVER_CMD) {
    const parts = process.env.VERIF_SOLVER_CMD.split(/\s+/);
    attempts.push({
      cmd: parts[0]!,
      args: [...parts.slice(1), file],
      env: process.env,
      parse: (raw) => ({ status: /(^|\n)sat/.test(raw) && !/unsat/.test(raw) ? "sat" : /unsat/.test(raw) ? "unsat" : "unknown", values: parseValues(raw), raw }),
    });
  }
  const py = process.env.VERIF_PYTHON ?? "python3";
  const cvc5Py = `${process.env.CVC5_HOME ?? process.env.HOME + "/tmp/cvc5"}`;
  const script = [
    "import sys",
    "import cvc5",
    "tm = cvc5.TermManager(); s = cvc5.Solver(tm)",
    "s.setOption('produce-models','true')",
    "sm = cvc5.SymbolManager(tm)",
    "p = cvc5.InputParser(s, sm)",
    `p.setFileInput(cvc5.InputLanguage.SMT_LIB_2_6, ${JSON.stringify(file)})`,
    "while True:",
    "    cmd = p.nextCommand()",
    "    if cmd.isNull(): break",
    "    out = cmd.invoke(s, sm)",
    "    if out: print(out.strip())",
  ].join("\n");
  attempts.push({
    cmd: py,
    args: ["-c", script],
    env: { ...process.env, PYTHONPATH: `${cvc5Py}:${process.env.PYTHONPATH ?? ""}` },
    parse: (raw) => ({ status: /(^|\n)sat\b/.test(raw) && !/unsat/.test(raw) ? "sat" : /unsat/.test(raw) ? "unsat" : "unknown", values: parseValues(raw), raw }),
  });
  const z3Bin = process.env.Z3_BIN ?? "z3";
  attempts.push({
    cmd: z3Bin,
    args: [file],
    env: process.env,
    parse: (raw) => ({ status: /(^|\n)sat\b/.test(raw) ? "sat" : /unsat/.test(raw) ? "unsat" : "unknown", values: parseValues(raw), raw }),
  });
  return attempts;
};

const runAttempt = (a: Attempt) =>
  spawnSync(a.cmd, a.args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: a.env });

// Index of the solver that last gave a decisive verdict this process, or
// undefined if none yet. Detect-once (#4140 instance 3): guard-probe and body
// solves share one stable verdict instead of each re-walking the whole ladder.
let decisiveIndex: number | undefined;

export const solveSmt2 = (input: string | { smt2: string }, getValue: string[]): SolveResult => {
  const smt2 = typeof input === "string" ? input : input.smt2;
  const dir = mkdtempSync(join(tmpdir(), "verif-solve-"));
  const file = join(dir, "query.smt2");
  try {
    const header = smt2.startsWith("(set-logic") ? "" : "(set-logic ALL)\n";
    const tail = getValue.length
      ? `(check-sat)\n(get-value (${getValue.join(" ")}))\n`
      : "(check-sat)\n";
    writeFileSync(file, header + smt2.replace(/\(check-sat\)[\s\S]*$/, "") + tail);

    const attempts = buildAttempts(file);

    // Detect-once fast path: try the already-decisive solver first, rebuilt
    // against the CURRENT file (index holds no stale temp path); a spawn error
    // means it died → invalidate and fall through to the full walk below.
    if (decisiveIndex !== undefined) {
      const a = attempts[decisiveIndex];
      if (a) {
        const r = runAttempt(a);
        if (r.error) decisiveIndex = undefined;
        else {
          const p = a.parse(r.stdout ?? "");
          if (p.status !== "unknown") return p;
        }
      }
    }

    let lastErr = "";
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const r = runAttempt(a);
      if (r.error) { lastErr += `${a.cmd}: ${r.error.message}\n`; continue; }
      // A verdict printed to stdout wins over the exit code: native z3
      // prints `unsat` and THEN exits 1 because the trailing (get-value)
      // fails with "model is not available" — discarding stdout there would
      // turn every unsat into "no solver available".
      const parsed = a.parse(r.stdout ?? "");
      if (parsed.status !== "unknown") { decisiveIndex = i; return parsed; }
      lastErr += r.status !== 0
        ? `${a.cmd}: exit ${r.status}: ${r.stderr.slice(0, 500)}\n`
        : `${a.cmd}: unknown\n`;
    }
    throw new Error(`no solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON):\n${lastErr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Parse a model value like `4001`, `4001.0`, `(- 3)` into a JS number. */
export const parseNum = (v: string): number => {
  const t = v.trim();
  if (t.startsWith("(-")) {
    const inner = t.replace(/^\(-\s*/, "").replace(/\)$/, "").trim();
    return -parseNum(inner);
  }
  const n = Number(t.replace(/\.0+$/, ""));
  if (!Number.isFinite(n)) throw new Error(`unparseable model value: ${v}`);
  return n;
};
