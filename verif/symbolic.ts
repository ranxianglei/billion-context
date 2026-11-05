/**
 * verif symbolic executor — v2.
 *
 * Translates REAL TypeScript function bodies (from the guarded kernel files)
 * into z3 constraints. The code under verification is the actual source;
 * this file is only the lens. The replay lock (verif/replay.ts + smoke
 * tests) catches any lens distortion.
 *
 * Value model (modeling decisions, all documented in verif/README.md):
 *  - numbers   → z3 Real (exact rationals ≈ JS doubles; boundary divergence
 *                is caught by replay)
 *  - booleans  → z3 Bool
 *  - strings   → z3 Seq (string theory)
 *  - arrays    → bounded slot vectors: { elems: SymVal[N], len: Real }
 *                with N = maxArrayLength (unrolled combinators, push via
 *                ITE store). Sound for found counterexamples; absence
 *                claims hold within the bound only.
 *  - objects   → structural field maps { fields: Map<string, SymVal> }
 *  - unknown/degraded constructs → { kind: "any" } (never silently
 *                trustworthy: harnesses receive the degradation list)
 *
 * Execution model: single-assignment environment; if/else via ITE value
 * merge (no path enumeration); loops unrolled up to K iterations with
 * termination assumptions collected for the solver.
 *
 * Function calls: local functions in the same file are INLINED (depth
 * capped) so harnesses exercise the real helper chain. Calls that cannot
 * be translated degrade to `any`.
 */
import ts from "typescript";
import { readFileSync, accessSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arith, Bool, Seq, Context, Term } from "./terms.js";

class TranslationUnsupported extends Error {
  constructor(readonly what: string, readonly file: string, readonly line: number) {
    super(`translation unsupported at ${file}:${line}: ${what}`);
  }
}

export type Z3 = Context;
export type Num = Arith;
type Str = Seq;

export type SymVal =
  | { kind: "num"; t: Num; undefUnder?: Bool<"main"> }
  | { kind: "bool"; t: Bool<"main">; undefUnder?: Bool<"main"> }
  | { kind: "str"; t: Str; undefUnder?: Bool<"main"> }
  // nullUnder: set on obj/arr values that came out of a STRICT branch merge
  // with null/undefined on the other arm — the value is the obj/arr only
  // when nullUnder is FALSE (JS truthiness/field-access must respect it).
  | { kind: "arr"; elems: SymVal[]; len: Num; nullUnder?: Bool<"main">; aliasEntries?: { entry: { fields: Map<string, SymVal> }; match: Bool<"main"> }[] }
  | { kind: "obj"; fields: Map<string, SymVal>; symFields?: Map<Term, { g: Bool<"main">; v: SymVal }>; nullUnder?: Bool<"main"> }
  | { kind: "fn"; node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration; env: Frame }
  | { kind: "null" }
  | { kind: "undef" }
  | { kind: "any" };

export interface ExecOut {
  ret: SymVal | null;
  thrown: { kind: "bool"; t: Bool<"main"> } | null;
  /** Solver must receive these for absence claims: unrolled loops that had
   *  not terminated within K iterations produce a completion assumption. */
  assumptions: Bool<"main">[];
  /** Every construct degraded to `any` — harness reports these; a property
   *  whose counterexample depends on an `any` hole is NOT a finding. */
  degradations: string[];
  /** The term context — carries `decls` (symbolic constants created while
   *  translating) so harnesses can emit `(declare-fun ...)` lines. */
  ctx: import("./terms.js").Context;
}

interface InterpreterOptions {
  maxArrayLength?: number; // default 8
  maxLoopIterations?: number; // default 8
  maxInlineDepth?: number; // default 12
  /** Implementations for INJECTED PORTS (public parameter seams like
   *  CompressionCore's `countTokens`). When a call resolves to a parameter
   *  with a port implementation, the hook runs instead of degrading. Ports
   *  are part of the module's public contract — hosts inject their own
   *  token counters — so this is composition, not bug-specific modeling. */
  portImpls?: Record<string, (arg: SymVal, ...rest: SymVal[]) => SymVal>;
}

/* ------------------------------------------------------------------ helpers */

const num = (ctx: Z3, v: number): Num => ctx.Real.val(v);
let numHoleCounter = 0;

const bool = (ctx: Z3, v: boolean): Bool<"main"> => ctx.Bool.val(v);

/** Constant side-channels: z3 expr objects created from JS constants are
 *  tagged so arithmetic/comparisons fold at construction time instead of
 *  bloating the symbolic DAG with trivially-decidable subterms. */
const strConst = {
  get: (t: Str | undefined): string | undefined => (t && typeof t.c === "string" ? t.c : undefined),
};
const numConst = {
  get: (t: Num | undefined): number | undefined => (t && typeof t.c === "number" ? t.c : undefined),
};
const boolConst = {
  get: (t: Bool<"main"> | undefined): boolean | undefined => (t && typeof t.c === "boolean" ? t.c : undefined),
};
const strc = (ctx: Z3, sv: string): Str => ctx.String.val(sv);
/** Foldable numeric equality: constant arguments decide immediately. */
const strEqF = (ctx: Z3, a: Term, b: Term): Bool<"main"> => {
  const ac = strConst.get(a), bc = strConst.get(b);
  if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
  return ctx.app2("=", a as never, b as never, "Bool") as Bool<"main">;
};
const numGt = (ctx: Z3, a: Num, b: Num): Bool<"main"> | null => {
  const ac = numC(a), bc = numC(b);
  if (ac !== undefined && bc !== undefined) return bool(ctx, ac > bc);
  // const leaves carry no comparison methods — promote via app2
  return ctx.app2(">", a as never, b as never, "Bool") as Bool<"main">;
};
const pathIsUnconditional = (g: Bool<"main"> | undefined): boolean =>
  g === undefined || constBool(g) === true;
const numAdd = (ctx: Z3, a: Num, b: Num): Num => {
  const ac = numC(a), bc = numC(b);
  if (ac !== undefined && bc !== undefined) return num(ctx, ac + bc);
  // const leaves carry no arithmetic methods — promote via app2
  return ctx.app2("+", a as never, b as never, "Real") as Num;
};
const numEq = (ctx: Z3, a: Num, b: Num): Bool<"main"> => {
  const ac = numC(a), bc = numC(b);
  if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
  return a.eq(b);
};

/** Numeric constant lookup with structural fallback: constants created by
 *  harness code via raw ctx.Real.val(n) are recognized by their printed
 *  form so constant folding still applies to them. */
const numC = (t: Num): number | undefined => {
  const hit = numConst.get(t);
  if (hit !== undefined) return hit;
  const noKids = (t as unknown as { kids?: unknown[] }).kids;
  if (noKids !== undefined && noKids.length > 0) return undefined; // composite — never a literal
  const str = t.toString();
  if (/^-?\d+\.0+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) {
    const f = parseFloat(str);
    if (Number.isFinite(f)) return f;
  }
  return undefined;
};

function isNum(v: SymVal | undefined): v is { kind: "num"; t: Num } {
  return v !== undefined && v.kind === "num";
}
function isBool(v: SymVal | undefined): v is { kind: "bool"; t: Bool<"main"> } {
  return v !== undefined && v.kind === "bool";
}
function isStr(v: SymVal | undefined): v is { kind: "str"; t: Str } {
  return v !== undefined && v.kind === "str";
}
function isArr(v: SymVal | undefined): v is Extract<SymVal, { kind: "arr" }> {
  return v !== undefined && v.kind === "arr";
}
function isNumConstV(v: SymVal): boolean { return v.kind === "num" && typeof v.t.c === "number"; }
// Upper bound on a numeric Term from its constant leaves (ite merges of
// concrete lengths, +/- of constants). undefined = unbounded / undecidable.
function maxConcreteLeaf(t: { c?: number | string | boolean; op?: string; kids?: readonly unknown[] }, seen = new Set<unknown>()): number | undefined {
  if (seen.has(t)) return undefined;
  seen.add(t);
  if (typeof t.c === "number") return t.c;
  const kids = (t.kids ?? []) as { c?: number | string | boolean; op?: string; kids?: readonly unknown[] }[];
  if (kids.length === 0) return undefined; // free variable
  const op = t.op ?? "";
  if (op === "ite") {
    const a = maxConcreteLeaf(kids[1]!, seen), b = maxConcreteLeaf(kids[2]!, seen);
    return a === undefined || b === undefined ? undefined : Math.max(a, b);
  }
  if (kids.every((x) => typeof x.c === "number")) {
    if (op === "+") return kids.reduce((acc, x) => acc + (x.c as number), 0);
    if (op === "-") return (kids[0]!.c as number) - (kids[1]!.c as number);
  }
  return undefined;
}
function isObj(v: SymVal | undefined): v is Extract<SymVal, { kind: "obj" }> {
  return v !== undefined && v.kind === "obj";
}

/** Truthiness of a symbolic value as a boolean expr (JS coercion rules for
 *  the subset: numbers nonzero, strings nonempty, null/undef false). */
/** Literal check WITHOUT printing: reads the folded const tag only.
 *  Printing big DAG bools per-statement was exponential (the H2 OOM). */
function constBool(t: Bool<"main"> | null | undefined): boolean | null {
  if (t === null || t === undefined) return null;
  if (t.c === true) return true;
  if (t.c === false) return false;
  const op = (t as unknown as { op?: string }).op;
  if (op === "const" || op === "lit") {
    // non-folded literal — fall back to a SHORT print (no kids)
    const str = (t as unknown as { print(): string }).print ? (t as unknown as { print(): string }).print() : String(t);
    if (str === "true") return true;
    if (str === "false") return false;
  }
  return null;
}


function truthy(ctx: Z3, v: SymVal): Bool<"main"> | null {
  // undefUnder: a scalar that is `return undefined` on some path is falsy
  // on that path — the guard condition must survive truthiness reads.
  const uuNum = (v.kind === "num" || v.kind === "str" || v.kind === "bool") ? (v as { undefUnder?: Bool<"main"> }).undefUnder : undefined;
  if (uuNum) {
    const core = truthyCore(ctx, v);
    if (core === null) return null;
    const tc = boolConst.get(uuNum);
    const uuOk = tc === undefined ? uuNum.not() : bool(ctx, !tc);
    // inline and-fold (module scope has no andFold)
    const okC = boolConst.get(uuOk), coreC = boolConst.get(core);
    if (okC === true) return core;
    if (okC === false || coreC === false) return bool(ctx, false);
    if (coreC === true) return uuOk;
    return uuOk.and(core);
  }
  return truthyCore(ctx, v);
}

function truthyCore(ctx: Z3, v: SymVal): Bool<"main"> | null {
  switch (v.kind) {
    case "bool": return v.t;
    case "num": {
      const c = numC(v.t);
      if (c !== undefined) return bool(ctx, c !== 0);
      return v.t.neq(num(ctx, 0));
    }
    case "str": {
      const sv = strConst.get(v.t);
      if (sv !== undefined) return bool(ctx, sv.length > 0);
      return (ctx.ToReal(v.t.length() as never) as Num).neq(num(ctx, 0));
    }
    case "null":
    case "undef": return bool(ctx, false);
    case "arr": {
      const tag = (v as { nullUnder?: Bool<"main"> }).nullUnder;
      if (!tag) return bool(ctx, true); // arrays are truthy
      const tc = boolConst.get(tag);
      return tc === undefined ? tag.not() : bool(ctx, !tc);
    }
    case "obj": {
      const tag = (v as { nullUnder?: Bool<"main"> }).nullUnder;
      if (!tag) return bool(ctx, true);
      const tc = boolConst.get(tag);
      return tc === undefined ? tag.not() : bool(ctx, !tc);
    }
    default: return null;
  }
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  if (n === 1) return [[0]];
  const out: number[][] = [];
  const rest = permutations(n - 1);
  for (const p of rest) {
    for (let i = 0; i <= p.length; i++) {
      out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ program */

interface ModuleInfo {
  numbers: Map<string, number>;
  strings: Map<string, string>;
  functions: Map<string, ts.FunctionDeclaration>;
  constArrowFns: Map<string, ts.Expression>;
  constBindings: Map<string, ts.Expression>;
  /** exported names (functions, const arrows, consts) for import resolution */
  exports: Set<string>;
  /** export-from re-exports: export {x} from "./y.js" */
  reexports: Map<string, string>;
}

/** Resolve relative imports of a file recursively and collect exported
 *  callables/consts into a global registry (kernel files import helpers
 *  across files: truncate-tools → truncate/prune/ccr, hide-consumed → refs). */
function loadImportGraph(entry: string): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>();
  const queue: string[] = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { sf: entrySf, info } = loadModule(file);
    modules.set(file, info);
    for (const stmt of entrySf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // node/external: not symbolized
      const resolved = resolveTsPath(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return modules;
}

function resolveTsPath(fromFile: string, spec: string): string | null {
  const path = join(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  try {
    accessSync(path);
    return path;
  } catch {
    return null;
  }
}

/** Repo root (verif/ is one level down) — relative driver paths join here. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolve a module path for loading (#4195). Already-absolute inputs are
 *  used as-is, never re-rooted: a URL `.pathname` shape (`/D:/a/b.ts` —
 *  what `new URL(...).pathname` yields on windows) makes node resolve the
 *  leading `/` against the cwd drive root, producing the doubled drive
 *  letter (`D:\D:\a\b.ts`) ENOENT seen on windows CI; those are de-mangled
 *  back to their drive-absolute form instead. */
export function resolveModulePath(file: string): string {
  const mangled = /^\/([A-Za-z]:)([\\/].*)$/.exec(file);
  if (mangled) return `${mangled[1]}${mangled[2]}`;
  if (/^[A-Za-z]:[\\/]/.test(file) || isAbsolute(file)) return file;
  return join(REPO_ROOT, file);
}

function loadModule(file: string): { sf: ts.SourceFile; info: ModuleInfo } {
  const source = readFileSync(resolveModulePath(file), "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const info: ModuleInfo = {
    numbers: new Map(),
    strings: new Map(),
    functions: new Map(),
    constArrowFns: new Map(),
    constBindings: new Map(),
    exports: new Set(),
    reexports: new Map(),
  };
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      info.functions.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const i = node.initializer;
      if (ts.isNumericLiteral(i)) info.numbers.set(node.name.text, Number(i.text));
      else if (ts.isStringLiteral(i)) info.strings.set(node.name.text, i.text);
      else if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) info.constArrowFns.set(node.name.text, i);
      else info.constBindings.set(node.name.text, i);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  const walkExports = (node: ts.Node): void => {
    const hasExportMod = (n: ts.Node): boolean =>
      !!((n as ts.FunctionDeclaration).modifiers ?? []).some(
        (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (ts.isFunctionDeclaration(node) && node.name && hasExportMod(node)) {
      info.exports.add(node.name.text);
    }
    if (ts.isVariableStatement(node) && hasExportMod(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) info.exports.add(d.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) info.exports.add(el.name.text);
    }
    ts.forEachChild(node, walkExports);
  };
  walkExports(sf);
  return { sf, info };
}

/* ---------------------------------------------------------------- interpreter */

interface Frame {
  vars: Map<string, SymVal>;
}

interface RunState {
  ret: SymVal | null;
  /** conditional returns: function returns `val` when `cond` — following
   *  statements still execute (they produce the not-cond path's value) */
  pendingRets: { cond: Bool<"main">; val: SymVal }[];
  /** shared across branch copies — dedup identical diagnostics */
  seenDeg: Set<string>;
  seenAsum: Set<number>;
  /** hard unconditional return (dead code after `return`) */
  hardRet: boolean;
  thrown: Bool<"main"> | null;
  assumptions: Bool<"main">[];
  degradations: string[];
  breakCond: Bool<"main"> | null;
  continueCond: Bool<"main"> | null;
  /** real source-level container writes (old→next) — replayed at call
   *  boundaries so callee mutations are caller-visible (JS references) */
  mutations?: { old: SymVal; next: SymVal }[];
  /** conjunction of branch arms / loop iterations the current state copy
   *  executed under (undefined = unconditional path). Writes on a guarded
   *  path must NOT push raw mutation pairs — the pair's `next` is the
   *  single-arm object and replaying it unguarded clobbers alias holders
   *  (e.g. a caller's snapshot) with the arm's value. Guarded writes
   *  propagate via mergeBranch → the callee frame's final param binding
   *  → param-final replay instead. */
  pathCond?: Bool<"main">;
}

interface TranslateInput {
  file: string;
  function: string;
  params: Record<string, SymVal>;
  ctx: Z3;
  options?: InterpreterOptions;
}

export function translateFunction(input: TranslateInput): { exec: () => ExecOut } {
  const { file: entryFile, function: fnName, params, ctx } = input;
  const file = resolveModulePath(entryFile);

  /** z3 Seq.length() is Int-sorted; our numeric arithmetic is Real. */
  const lenR = (seq: Seq<"main">): Num => ctx.ToReal(seq.length() as never) as Num;
  const N = input.options?.maxArrayLength ?? 8;
  const K = input.options?.maxLoopIterations ?? 8;
  /** Constant-folding Boolean combinators: z3's .or/.and do NOT simplify
   * `(or false false)` to `false`, and control-flow checks compare the
   * printed form against "true"/"false" — so every control Bool must be
   * built through these to keep literal chains folded. */
  const orFold = (a: Bool<"main"> | null | undefined, b: Bool<"main"> | null | undefined): Bool<"main"> | undefined => {
    if (a === null || a === undefined) return b ?? undefined;
    if (b === null || b === undefined) return a;
    const ab = boolConst.get(a), bb = boolConst.get(b);
    if (ab === true || bb === true) return bool(ctx, true);
    if (ab === false) return b;
    if (bb === false) return a;
    return a.or(b);
  };
  const andFold = (a: Bool<"main"> | undefined, b: Bool<"main"> | undefined): Bool<"main"> | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    const ab = boolConst.get(a), bb = boolConst.get(b);
    if (ab === false || bb === false) return bool(ctx, false);
    if (ab === true) return b;
    if (bb === true) return a;
    return a.and(b);
  };
  const notFold = (a: Bool<"main">): Bool<"main"> => {
    const ab = boolConst.get(a);
    if (ab === true) return bool(ctx, false);
    if (ab === false) return bool(ctx, true);
    return a.not();
  };
  const MAXINLINE = input.options?.maxInlineDepth ?? 12;
  const modules = loadImportGraph(file);
  const info = modules.get(file)!;
  const sf = loadModule(file).sf;
  // identifier → definition in an imported module ("./x.js" exports)
  const importedSymbols = new Map<string, { file: string; info: ModuleInfo }>();
  // identifier → definition in an imported module ("./x.js" exports).
  // Per-module: nested imports (A imports B imports C — the entry's map
  // alone cannot resolve C's names inside B's inlined const initializers).
  const moduleImports = new Map<ModuleInfo, Map<string, { file: string; info: ModuleInfo }>>();
  const importsOf = (mi: ModuleInfo): Map<string, { file: string; info: ModuleInfo }> => {
    const hit = moduleImports.get(mi);
    if (hit) return hit;
    const map = new Map<string, { file: string; info: ModuleInfo }>();
    moduleImports.set(mi, map);
    for (const [mf, minfo] of modules) {
      if (minfo !== mi) continue;
      const msf = loadModule(mf).sf;
      for (const stmt of msf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const resolved = resolveTsPath(mf, spec);
        if (!resolved) continue;
        const target = modules.get(resolved);
        if (!target) continue;
        const named = stmt.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) map.set(el.name.text, { file: resolved, info: target });
        }
      }
    }
    return map;
  };
  {
    const entrySf = loadModule(file).sf;
    for (const stmt of entrySf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const resolved = resolveTsPath(file, spec);
      if (!resolved) continue;
      const target = modules.get(resolved);
      if (!target) continue;
      const named = stmt.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) importedSymbols.set(el.name.text, { file: resolved, info: target });
      }
    }
  }

  /** Module whose file's functions we are currently executing (for cross-file inlining).
 *  Top of stack = defining module; entry module is the base. */
  const moduleStack: ModuleInfo[] = [info];
  const curInfo = (): ModuleInfo => moduleStack[moduleStack.length - 1] ?? info;
  const portMemo = new Map<string, SymVal>();

  let numStrCounter = 0;
  /** String(number): an uninterpreted decimal string; only its length matters
   * for stability properties (1..19 digits) and the replay lock validates the
   * witness against the real code. */
  // String(number): memoized per INPUT TERM (same number → same string —
  // stability properties across turns need the function property, a fresh
  // hole per call would fake instability).
  const numStrMemo = new Map<number, { kind: "str"; t: Str }>();
  const digitsOnly = (hole: Str): void => {
    // String(number) holes must be digit strings (JS prints decimal digits;
    // sign/point excluded for the integer-dominant counts we model). Without
    // this, an uninterpreted __numstr could model as containing ANY substring
    // and fake a contains() violation on every line embedding a count.
    const zero = ctx.String.val("0"), nine = ctx.String.val("9");
    const digits = ctx.app1("re.+", ctx.app2("re.range", zero, nine, "Bool"), "Bool");
    ctx.pendingAsums.push(ctx.app2("str.in_re", hole, digits, "Bool"));
  };
  const numToStringStrFor = (x: Num): { kind: "str"; t: Str } => {
    const key = x.hash();
    const hit = numStrMemo.get(key);
    if (hit) return hit;
    const hole = ctx.String.const("__numstr_" + numStrCounter++);
    digitsOnly(hole);
    const v: { kind: "str"; t: Str } = { kind: "str", t: hole };
    numStrMemo.set(key, v);
    return v;
  };
  const numToStringStr = (st: RunState): { kind: "str"; t: Str } => {
    const hole = ctx.String.const("__numstr_" + numStrCounter++);
    digitsOnly(hole);
    pushAsum(st, (ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 19))));
    return { kind: "str", t: hole };
  };

  const decl = info.functions.get(fnName);
  if (!decl?.body) throw new Error(`function ${fnName} not found in ${file}`);

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const bad = (node: ts.Node, what: string): never => {
    throw new TranslationUnsupported(what, file, lineOf(node));
  };

  /* ---------------- value constructors ---------------- */

  const arrOf = (elems: SymVal[], len?: Num): Extract<SymVal, { kind: "arr" }> =>
    ({ kind: "arr", elems, len: len ?? num(ctx, elems.length) });

  /** Convert a REAL JSON value (from concrete JSON.parse) into a SymVal. */
  // JSON.parse over a symbolic concat template '{"id":"' X '","role":"' Y
  // ',"contentType":"' Z '","text":"' W '"}': walk the concat DAG into a
  // linear piece list, match the literal skeleton, return the parsed obj with
  // the holes as free fields. Domain: holes contain no '"' / '\\' (asserted),
  // so field extraction is exact for the plain-text message domain.
  const collectConcats = (t: Str, out: Str[]): void => {
    const tt = t as unknown as { op: string; kids?: Str[] };
    const kids = tt.kids;
    if (!kids || kids.length === 0) { out.push(t); return; }
    const op = tt.op;
    if (op === "str.++" || op === "concat") { for (let i = 0; i < kids.length; i++) collectConcats(kids[i]!, out); return; }
    if (op === "app2" && kids.length === 3 && (kids[0] as unknown as { op: string }).op === "str.++") { collectConcats(kids[1]!, out); collectConcats(kids[2]!, out); return; }
    out.push(t);
  };
  const jsonParseTemplate = (a0: { kind: "str"; t: Str }): SymVal | null => {
    const pieces: Str[] = [];
    collectConcats(a0.t, pieces);
    const isLit = (t: Str, v: string): boolean => t.c === v;
    if (pieces.length !== 9) return null;
    const SKELETON = ['{"id":"', '","role":"', '","contentType":"', '","text":"', '"}'];
    for (let i = 0; i < 5; i++) {
      const lit = pieces[i * 2]!;
      const want = SKELETON[i]!;
      if (!isLit(lit, want)) return null;
      // value pieces may be free holes OR concrete literals (role/contentType
      // are constants in the input model; ids/texts vary)
    }
    const mk = (hole: Str): { kind: "str"; t: Str } => {
      if (hole.c !== undefined) return { kind: "str", t: hole }; // concrete value: no constraint needed
      // domain: plain-text fields (no quote/backslash) keep extraction exact
      const q = ctx.String.val('"');
      const bs = ctx.String.val("\\");
      ctx.pendingAsums.push(hole.contains(q).not());
      ctx.pendingAsums.push(hole.contains(bs).not());
      return { kind: "str", t: hole };
    };
    const fields = new Map<string, SymVal>();
    fields.set("id", mk(pieces[1]!));
    fields.set("role", mk(pieces[3]!));
    fields.set("contentType", mk(pieces[5]!));
    fields.set("text", mk(pieces[7]!));
    return { kind: "obj", fields };
  };
  const jsonToSymVal = (v: unknown, depth: number): SymVal => {
    if (v === null) return { kind: "null" };
    if (typeof v === "string") return { kind: "str", t: strc(ctx, v) };
    if (typeof v === "number") return { kind: "num", t: num(ctx, v) };
    if (typeof v === "boolean") return { kind: "bool", t: bool(ctx, v) };
    if (Array.isArray(v)) {
      if (v.length > (input.options?.maxArrayLength ?? 8)) return { kind: "any" };
      return arrOf(v.map((x) => jsonToSymVal(x, depth + 1)));
    }
    if (typeof v === "object") {
      const fields = new Map<string, SymVal>();
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        fields.set(k, jsonToSymVal(val, depth + 1));
      }
      return { kind: "obj", fields };
    }
    return { kind: "undef" };
  };

  // STRICT merge for VARIABLE bindings across branch joins: unlike mergeVal
  // (whose undef/null-loses erasure is only sound for never-read tail slots),
  // this preserves the maybe-null/maybe-undefined distinction via nullUnder —
  // `if (lastTextCore)` must stay a SYMBOLIC condition, not fold true.
  const mergeValStrict = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a; // identity survives merges — see mergeVal note
    const objSide = a.kind === "obj" || a.kind === "arr" ? a : b.kind === "obj" || b.kind === "arr" ? b : null;
    const nullish = b.kind === "null" || b.kind === "undef" ? b : a.kind === "null" || a.kind === "undef" ? a : null;
    if (objSide && nullish) {
      const aIsObj = a === objSide;
      // value is the obj when nullUnder is false:
      //   mergeValStrict(cond, obj, null) → nullUnder = ¬cond
      //   mergeValStrict(cond, null, obj) → nullUnder = cond
      const side = aIsObj ? notFold(cond) : cond;
      const prev = (objSide as { nullUnder?: Bool<"main"> }).nullUnder;
      const tag = prev ? orFold(prev, side) : side;
      return objSide.kind === "obj"
        ? { kind: "obj", fields: objSide.fields, nullUnder: tag }
        : { kind: "arr", elems: objSide.elems, len: objSide.len, nullUnder: tag };
    }
    // SCALAR-vs-undef/null: TAG instead of drop. `rec[k]` fan reads are
    // ite(match, v, {undef}) — the undefined-ness IS the key-match guard
    // (mergeVal's undef-loses rule deleted it: `rec["missing"] !== undefined`
    // folded to true and multi-layer fans collapsed to the neutral "").
    if (nullish) {
      const scalarSide = a.kind === "num" || a.kind === "str" || a.kind === "bool" ? a
        : b.kind === "num" || b.kind === "str" || b.kind === "bool" ? b : null;
      if (scalarSide) {
        const scalarIsA = a === scalarSide;
        const side = scalarIsA ? notFold(cond) : cond; // undefined exactly when side
        const isNullTag = nullish.kind === "null";
        const prev = isNullTag ? (scalarSide as { nullUnder?: Bool<"main"> }).nullUnder : (scalarSide as { undefUnder?: Bool<"main"> }).undefUnder;
        const tag = prev ? orFold(prev, side) : side;
        const base: Record<string, unknown> = { kind: scalarSide.kind, t: scalarSide.t };
        base[isNullTag ? "nullUnder" : "undefUnder"] = tag;
        return base as unknown as SymVal;
      }
    }
    return mergeVal(cond, a, b);
  };

  const mergeVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    // Identity merge: the same SymVal on both arms is the same value under
    // both paths — returning it PRESERVES object identity across
    // loop-iteration/branch merges. Without this, every merge rebuilt every
    // untouched array slot/obj field into a clone, so a for-of elem bound
    // from the loop-entry array (or any local alias) lost identity with the
    // frame's current containers — mutation alias-replay (delete/member
    // writes) then found nothing to replace (responses-ingress E2).
    if (a === b) return a;
    // undef/null loses to any concrete value: out-of-bounds fallbacks in
    // element-access chains (guarded by length checks in real code) must not
    // poison the merged object. Real out-of-range access throws and is caught
    // by the replay lock.
    // EXCEPTION — scalar returns: a literal {kind:"undef"} arm from a
    // `return undefined` guard is a REAL JS return value, not an unwritten
    // slot. Merging it away would delete the guard entirely (the witness
    // gate bug: ite(cond, undef, n) collapsed to bare n, so every session
    // shape "passed" the gate). Track it as undefUnder on the scalar.
    if (a.kind === "undef" && (b.kind === "num" || b.kind === "str" || b.kind === "bool")) {
      // a (undef) is the THEN arm — live under cond.
      const bu = (b as { undefUnder?: Bool<"main"> }).undefUnder;
      const uu = bu ? orFold(cond, bu) : cond;
      return { ...(b as object), undefUnder: uu } as SymVal;
    }
    if (b.kind === "undef" && (a.kind === "num" || a.kind === "str" || a.kind === "bool")) {
      // b (undef) is the ELSE arm — live under ¬cond.
      const au = (a as { undefUnder?: Bool<"main"> }).undefUnder;
      const uu = au ? orFold(notFold(cond), au) : notFold(cond);
      return { ...(a as object), undefUnder: uu } as SymVal;
    }
    if (a.kind === "undef" && b.kind !== "undef") return mergeVal(cond.not(), b, { kind: "undef" }) === null ? { kind: "any" } : b;
    if (b.kind === "undef" && a.kind !== "undef") return a;
    if (a.kind === "null" && b.kind !== "null") return b;
    if (b.kind === "null" && a.kind !== "null") return a;
    if (a.kind !== b.kind) {
      return { kind: "any" };
    }
    switch (a.kind) {
      case "num": {
        const bb = b as Extract<SymVal, { kind: "num" }>;
        const ac = numC(a.t), bc = numC(bb.t);
        const au = (a as { undefUnder?: Bool<"main"> }).undefUnder, bu = (bb as { undefUnder?: Bool<"main"> }).undefUnder;
        // the maybe-undefined tag must SURVIVE value-vs-value merges: the
        // miss arm of a fan chain carries undefUnder, and merging it with
        // the next slot's real value dropped the tag — `map.get(k) ===
        // undefined` then folded to const-false and the PHANTOM hit value
        // leaked through every subsequent comparison.
        // Tagged maybe-undefined scalars merging value-vs-value: the tag
        // must NOT be re-attached as a plain or-chain here. Empirically this
        // polluted downstream guards with write-path conditions (the #3805
        // render guard folded to write-guard soup). The fan/get sites attach
        // exact nullness themselves (acc-chain); tagged-eq consults it.
        if (au === undefined && bu === undefined) {
          if (ac !== undefined && ac === bc) return a; // same constant: no ITE
          return { kind: "num", t: ctx.If(cond, a.t, bb.t) };
        }
        return { kind: "num", t: ctx.If(cond, a.t, bb.t) };
      }
      case "bool": {
        const bb = b as Extract<SymVal, { kind: "bool" }>;
        const auB = (a as { undefUnder?: Bool<"main"> }).undefUnder, buB = (bb as { undefUnder?: Bool<"main"> }).undefUnder;
        if (auB === undefined && buB === undefined) {
          const ac = boolConst.get(a.t), bc = boolConst.get(bb.t);
          if (ac !== undefined && ac === bc) return a;
          return { kind: "bool", t: ctx.If(cond, a.t, bb.t) };
        }
        return { kind: "bool", t: ctx.If(cond, a.t, bb.t) };
      }
      case "str": {
        const bb = b as Extract<SymVal, { kind: "str" }>;
        const auS = (a as { undefUnder?: Bool<"main"> }).undefUnder, buS = (bb as { undefUnder?: Bool<"main"> }).undefUnder;
        if (auS === undefined && buS === undefined) {
          const ac = strConst.get(a.t), bc = strConst.get(bb.t);
          if (ac !== undefined && ac === bc) return a;
          return { kind: "str", t: ctx.If(cond, a.t, bb.t) };
        }
        return { kind: "str", t: ctx.If(cond, a.t, bb.t) };
      }
      case "null": case "undef": return a;
      case "fn": return a; // closures are immutable; identical node survives
      case "arr": {
        const bb = b as Extract<SymVal, { kind: "arr" }>;
        const n = Math.max(a.elems.length, bb.elems.length);
        const elems: SymVal[] = [];
        for (let i = 0; i < n; i++) {
          const va = a.elems[i], vb = bb.elems[i];
          if (va === undefined && vb === undefined) { elems.push({ kind: "undef" }); continue; }
          // ONE-ARM slots must carry the branch guard inside the value
          // (guardedNeutral): the old undef-loses collapse made the arm's
          // value reachable unconditionally — a ghost arm the solver could
          // pick even when that branch never executed (false SAT, e.g. the
          // view-latch pass-through property). Reads are len-guarded AND
          // the value now carries ¬cond → its neutral.
          if (vb === undefined) { elems.push(guardedNeutral(cond, va)); continue; }
          if (va === undefined) { elems.push(guardedNeutral(cond.not()!, vb)); continue; }
          elems.push(mergeVal(cond, va, vb));
        }
        const la = numC(a.len), lb = numC(bb.len);
        if (la !== undefined && la === lb) return { kind: "arr", elems, len: a.len }; // same length: keep const
        return { kind: "arr", elems, len: ctx.If(cond, a.len, bb.len) };
      }
      case "obj": {
        const bb = b as Extract<SymVal, { kind: "obj" }>;
        const fields = new Map<string, SymVal>();
        for (const key of new Set([...a.fields.keys(), ...bb.fields.keys()])) {
          const va = a.fields.get(key);
          const vb = bb.fields.get(key);
          if (va && vb) fields.set(key, mergeVal(cond, va, vb));
          else if (va) fields.set(key, guardedNeutral(cond, va));
          else if (vb) fields.set(key, guardedNeutral(cond.not(), vb));
        }
        // merge symbolic-key bindings: present on one arm only means the
        // other arm never wrote it → undefined there (guard survives)
        // symFields entries carry their WRITE guard: a binding present on
        // one arm only keeps the path condition in .g (accumulated with
        // andFold) — the read fan tests (key = idx AND g) so a dead-path
        // write never shadows an older binding for the same string key.
        let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
        const sa = a.symFields, sb = bb.symFields;
        if (sa || sb) {
          symFields = new Map<Term, { g: Bool<"main">; v: SymVal }>();
          const seen = new Set<Term>();
          const bothArm = (ga: Bool<"main">, va: SymVal, gb: Bool<"main">, vb: SymVal): { g: Bool<"main">; v: SymVal } => {
            // An entry present on BOTH arms keeps the disjunction of the
            // arm-guarded write guards, and the merge-level condition goes
            // into the VALUE only. Entries often exist on both sides with
            // the SAME write guard (created in an earlier iteration): the
            // old form (g=true, v=ite(gT,va,ite(gE,vb,neutral))) erased that
            // guard and degraded the else-arm to a neutral value, losing
            // the pre-write binding (3-message refs.ts repro).
            const gT = andFold(cond, ga) ?? bool(ctx, false), gE = andFold(cond.not(), gb) ?? bool(ctx, false);
            const gLive = orFold(gT, gE) ?? bool(ctx, false);
            if (constBool(gLive) === false) return { g: bool(ctx, false), v: va };
            let v: SymVal;
            if (constBool(cond) === true) v = va;
            else if (constBool(cond) === false) v = vb;
            else v = iteVal(cond, va, vb);
            // No double-count: the fan tests `key ∧ g` (g already includes
            // cond via gT/gE) and then reads v = ite(cond, va, vb) — the
            // truthiness channel and the value channel agree.
            return { g: gLive, v };
          };
          if (sa) for (const [kt, ea] of sa) {
            seen.add(kt);
            const eb = sb?.get(kt);
            symFields.set(kt, eb ? bothArm(ea.g, ea.v, eb.g, eb.v) : { g: andFold(cond, ea.g)!, v: ea.v });
          }
          if (sb) for (const [kt, eb] of sb) {
            if (seen.has(kt)) continue;
            symFields.set(kt, { g: andFold(cond.not(), eb.g)!, v: eb.v });
          }
        }
        // nullUnder merges across arms: the merged value is null-ish exactly
        // when the LIVE arm is null-ish. An UNTAGGED arm is definitely NOT
        // null (a plain object/entry present in that arm) — treating it as
        // maybe-null (`?? tTrue`) made every merge with a plain obj acquire
        // nullUnder=true, so `rec === null` guards (dropWhitespace reverse
        // splice loop) folded to always-continue and dropped every item.
        // Only tagged arms contribute to the disjunction.
        const au = (a as { nullUnder?: Bool<"main"> }).nullUnder;
        const bu = (bb as { nullUnder?: Bool<"main"> }).nullUnder;
        let nullUnder: Bool<"main"> | undefined;
        if (au || bu) {
          const auT = au ? andFold(cond, au) : undefined;
          const buT = bu ? andFold(cond.not(), bu) : undefined;
          nullUnder = orFold(auT ?? null, buT ?? null) ?? undefined;
        }
        return { kind: "obj", fields, ...(symFields ? { symFields } : {}), ...(nullUnder ? { nullUnder } : {}) };
      }
      default: {
        return { kind: "any" };
      }
    }
  };

  // A value written under a path condition into a container slot must leave
  // the IN-DOMAIN neutral in the untaken arm: downstream truthiness/membership
  // reads (len>0 etc.) treat neutral as "absent". Without this the undef-loses
  // merge rule silently drops the write's path guard (same failure class as
  // the Set-add phantom-slot bug).
  const guardedNeutral = (cond: Bool<"main">, v: SymVal): SymVal => {
    switch (v.kind) {
      case "str": return { kind: "str", t: ctx.If(cond, v.t, ctx.String.val("")) };
      case "num": return { kind: "num", t: ctx.If(cond, v.t, ctx.Real.val(0)) };
      case "bool": return { kind: "bool", t: ctx.If(cond, v.t, ctx.Bool.val(false)) };
      case "obj": case "arr": return iteStrict(cond, v, { kind: "null" });
      default: return v;
    }
  };

  const neutralFor = (v: SymVal): SymVal => {
    switch (v.kind) {
      case "str": return { kind: "str", t: ctx.String.val("") };
      case "num": return { kind: "num", t: ctx.Real.val(0) };
      case "bool": return { kind: "bool", t: ctx.Bool.val(false) };
      default: return { kind: "null" };
    }
  };

  const iteStrict = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a;
    const cb = constBool(cond);
    if (cb === true) return a;
    if (cb === false) return b;
    return mergeValStrict(cond, a, b);
  };

  const iteVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a;
    const cb = constBool(cond);
    if (cb === true) return a;
    if (cb === false) return b;
    // Equal constants fold to the constant: ite(cond, 1, 1) is 1 in every
    // model. Without this, branch merges lose const tags (two structurally
    // equal Terms are distinct objects) and everything downstream degrades
    // to symbolic — including array lengths that guard loop unrolling.
    if (a.kind === b.kind && a.kind === "num" && b.kind === "num") {
      const ca = numC(a.t), cbd = numC(b.t);
      if (ca !== undefined && ca === cbd) return a;
    }
    if (a.kind === b.kind && a.kind === "str" && b.kind === "str") {
      const ca = strConst.get(a.t), cb2 = strConst.get(b.t);
      if (ca !== undefined && ca === cb2) return a;
    }
    if (a.kind === b.kind && a.kind === "bool" && b.kind === "bool") {
      const ca = boolConst.get(a.t), cb2 = boolConst.get(b.t);
      if (ca !== undefined && ca === cb2) return a;
    }
    if (a.kind === "undef" && b.kind === "undef") return a;
    return mergeVal(cond, a, b);
  };

  /** JS ?: on symbolic values. */
  const jsOr = (a: SymVal, b: () => SymVal): SymVal => {
    const t = truthy(ctx, a);
    if (t === null) return { kind: "any" };
    // JS || short-circuits: provably-true left → a (right never evaluated).
    const tf = constBool(t);
    if (tf === true) return a.kind === "bool" ? { kind: "bool", t } : a;
    if (tf === false) return b();
    const av = a;
    const bv = b();
    // (a || b): if a truthy → a else b
    return iteVal(t, av.kind === "bool" ? { kind: "bool", t: t } : av, bv);
  };
  const jsAnd = (a: SymVal, b: () => SymVal): SymVal => {
    const t = truthy(ctx, a);
    if (t === null) return { kind: "any" };
    // JS && short-circuits: a provably-false left operand must NOT evaluate
    // the right (the whole reason dead guards like Array.isArray(x) && x.some(...)
    // stay translatable without touching the right side's degradations).
    const tf = t === null ? null : constBool(t);
    if (tf === false) return a.kind === "bool" ? a : iteVal(t as never, a, a);
    if (tf === true) return b();
    if (t !== null) {
      const bb = b();
      // Prefer exact truthiness when both sides coerce: `(a && b)` in a
      // boolean context is `truthy(a) ∧ truthy(b)`. Operand-identity
      // (`a && b` evaluating to `a` when falsy) is only observable via
      // value-equality/aliasing patterns absent from the guarded subset.
      const tbv = truthy(ctx, bb);
      if (tbv !== null) return { kind: "bool", t: andFold(t, tbv) ?? bool(ctx, false) };
      return iteVal(t, bb, a.kind === "bool" ? { kind: "bool", t: t } : a);
    }
    return iteVal(t, b(), a.kind === "bool" ? { kind: "bool", t: t } : a);
  };

  const evalBinary = (expr: ts.BinaryExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    // ASSIGNMENT is a statement-level effect, not an arithmetic op: route
    // to writeLValue (container aliasing, mutation recording) and yield
    // the assigned value.
    if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const v = evalExpr(expr.right, frame, st, depth);
      writeLValue(expr.left, v, frame, st, depth);
      return v;
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      || expr.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
      const cur = evalExpr(expr.left, frame, st, depth);
      const rhs = evalExpr(expr.right, frame, st, depth);
      const op = expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
      const v = applyBinop(op, cur, rhs, expr, st);
      writeLValue(expr.left, v, frame, st, depth);
      return v;
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return jsAnd(evalExpr(expr.left, frame, st, depth), () => evalExpr(expr.right, frame, st, depth));
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return jsOr(evalExpr(expr.left, frame, st, depth), () => evalExpr(expr.right, frame, st, depth));
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return jsNullish(evalExpr(expr.left, frame, st, depth), () => evalExpr(expr.right, frame, st, depth));
    }
    const l = evalExpr(expr.left, frame, st, depth);
    const r = evalExpr(expr.right, frame, st, depth);
    return applyBinop(expr.operatorToken.kind, l, r, expr, st);
  };

  const jsNullish = (a: SymVal, b: () => SymVal): SymVal =>
    iteVal(a.kind === "null" || a.kind === "undef" ? bool(ctx, true) : bool(ctx, false), b(), a);

  /* ---------------- statements ---------------- */

  const runState0 = (): RunState => ({
    ret: null, pendingRets: [], hardRet: false, thrown: null,
    assumptions: [], degradations: [], seenDeg: new Set(), seenAsum: new Set(),
    breakCond: null, continueCond: null,
    // Always allocated so `{ ...st }` state copies SHARE the array — a
    // mutation recorded on a branch/iteration copy must reach the function
    // state (and the call-boundary replay).
    mutations: [],
  });

  interface Scope {
    frame: Frame;
    depth: number;
  }

  /** Sequential statement execution with conditional stop semantics:
   * after a possibly-taken break/continue, the REMAINING statements run on a
   * copy under ¬stop — recursively, so nested stops (break-if followed by
   * continue-if in the same block) guard correctly. */
  const execSeq = (stmts: readonly ts.Statement[], frame: Frame, st: RunState, depth: number): void => {
    for (let i = 0; i < stmts.length; i++) {
      if (process.env.VERIF_SEQ_DEBUG) console.log(`[seq] line=${sf.getLineAndCharacterOfPosition(stmts[i]!.getStart(sf)).line + 1} kind=${ts.SyntaxKind[stmts[i]!.kind]} pr=${st.pendingRets.length} hard=${st.hardRet}`);
      execStmt(stmts[i]!, frame, st, depth);
      const bc = st.breakCond;
      const cc = st.continueCond;
      const bcT = bc !== null && constBool(bc) !== false;
      const ccT = cc !== null && constBool(cc) !== false;
      if (bcT || ccT) {
        const stopCond = (bc && cc ? orFold(bc as Bool<"main">, cc as Bool<"main">) : ((bc ?? cc) as Bool<"main">)) as Bool<"main">;
        if (process.env.VERIF_SEQ_DEBUG) console.log(`[seq-stop] after line=${sf.getLineAndCharacterOfPosition(stmts[i]!.getStart(sf)).line + 1} stopConst=${constBool(stopCond)} rest=${stmts.length - i - 1} hard=${st.hardRet} thrownTrue=${constBool(st.thrown) === true} bcTerm=${(stopCond as unknown as { c?: unknown }).c ?? (stopCond as unknown as { op?: unknown }).op} ccT=${ccT}`);
        if (i + 1 < stmts.length && constBool(stopCond) !== true) {
          const f2: Frame = { vars: new Map(frame.vars) };
          const s2: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations, pathCond: andFold(st.pathCond, notFold(stopCond)) };
          execSeq(stmts.slice(i + 1), f2, s2, depth);
          mergeBranch(frame, st, notFold(stopCond), f2, s2, null, null);
        }
        break;
      }
      if (st.hardRet) break;
      if (constBool(st.thrown) === true) break;
    }
  };

  let stmtCount = 0;
  const stmtLines = new Map<number, number>();
  const execStmt = (stmt: ts.Statement, frame: Frame, st: RunState, depth: number): void => {
    if (st.hardRet) return;
    if (constBool(st.thrown) === true) return;
    if (constBool(st.breakCond) === true) return;
    if (constBool(st.continueCond) === true) return;
    if (ts.isBlock(stmt)) { execSeq(stmt.statements, frame, st, depth); return; }
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) return; // type-level only — erased
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init0 = d.initializer ? evalExpr(d.initializer, frame, st, depth) : { kind: "undef" as const };
        if (init0 === undefined) console.log("[INIT-UNDEFINED] line", lineOf(d), ts.isIdentifier(d.name) ? d.name.text : "pattern");
        const init: SymVal = init0 === undefined ? { kind: "any" } : init0;
        if (ts.isIdentifier(d.name)) {
          frame.vars.set(d.name.text, init);
        } else if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            frame.vars.set(el.name.text, member(init, propName, el, st));
          }
        } else if (ts.isArrayBindingPattern(d.name)) {
          const arrV = init.kind === "arr" ? init : { kind: "any" as const };
          if (arrV.kind === "arr") d.name.elements.forEach((el, j) => {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) return;
            frame.vars.set(el.name.text, elementAccess(arrV, { kind: "num", t: num(ctx, j) }, el, st));
          });
        } else {
          bad(stmt, "non-identifier declaration");
        }
      }
      return;
    }
    if (ts.isExpressionStatement(stmt)) {
      evalExpr(stmt.expression, frame, st, depth);
      return;
    }
    if (ts.isReturnStatement(stmt)) {
      if (st.ret === null) {
        st.ret = stmt.expression ? evalExpr(stmt.expression, frame, st, depth) : { kind: "undef" };

        st.hardRet = true;
      } else {
        // a pending conditional return already captured the tail; a second
        // return can only be reached on the not-cond path
        st.pendingRets.push({ cond: bool(ctx, false), val: stmt.expression ? evalExpr(stmt.expression, frame, st, depth) : { kind: "undef" } });
        st.hardRet = true;
      }
      return;
    }
    if (ts.isThrowStatement(stmt)) {
      // The thrown value itself never matters — only the fact.
      st.thrown = bool(ctx, true);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      const c = evalExpr(stmt.expression, frame, st, depth);
      const tb = truthy(ctx, c);
      if (tb === null) {
        degrade(st, stmt, "if condition degraded"); return;
      }
      // Dead-branch pruning: a constant condition executes only the live
      // arm, in-frame. Eager both-arm execution would force provably-dead
      // code (e.g. a regex in a never-taken branch) to be translatable.
      const cb = constBool(tb);
      if (cb === true) { if (process.env.VERIF_SEQ_DEBUG) console.log(`[if-live] line=${sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1}`); execStmt(stmt.thenStatement, frame, st, depth); return; }
      if (cb === false) { if (stmt.elseStatement) execStmt(stmt.elseStatement, frame, st, depth); return; }
      const thenFrame: Frame = { vars: new Map(frame.vars) };
      const thenState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations, pathCond: andFold(st.pathCond, tb) };
      execStmt(stmt.thenStatement, thenFrame, thenState, depth);
      let elseFrame: Frame | null = null;
      let elseState: RunState | null = null;
      if (stmt.elseStatement) {
        elseFrame = { vars: new Map(frame.vars) };
        elseState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations, pathCond: andFold(st.pathCond, notFold(tb)) };
        execStmt(stmt.elseStatement, elseFrame, elseState, depth);
      }
      mergeBranch(frame, st, tb, thenFrame, thenState, elseFrame, elseState);
      return;
    }
    if (ts.isForOfStatement(stmt)) {
      // Unroll over bounded array slots.
      let iter = evalExpr(stmt.expression, frame, st, depth);
      if (iter.kind === "obj" && iter.fields.has("__set_values")) {
        // for (const k of someSet) — iterate the Set-model's value list
        const vals = iter.fields.get("__set_values")!;
        iter = vals.kind === "arr" ? vals : ({ kind: "arr", elems: [], len: num(ctx, 0) } as SymVal);
      }
      if (!isArr(iter)) { degrade(st, stmt, "for-of over non-array"); return; }
      bindForVar(stmt.initializer, { kind: "undef" }, frame);
      // Dead-slot pruning: when the array length is a KNOWN constant, skip
      // slots beyond it entirely — executing dead iterations would pollute
      // live state with out-of-bounds degradations and any-values.
      const lenC = numC(iter.len);
      const slotCeil = lenC !== undefined ? Math.min(iter.elems.length, Math.ceil(lenC)) : iter.elems.length;
      for (let k = 0; k < slotCeil; k++) {
        // Iteration k runs only if the array is long enough AND the loop
        // has not already exited via break — `breakCond` accumulates
        // "exited by an earlier iteration", so the guard CONJOINS ITS
        // NEGATION. Conjoining the bare flag let iteration k+1 overwrite
        // loop-carried writes from a broken iteration k (snapshot-render
        // chain bySig candidates: the `first idx < cursor` pick loop
        // returned the SECOND candidate after breaking on the first).
        const guard = andFold(numGt(ctx, iter.len, num(ctx, k)) ?? bool(ctx, true), st.breakCond ? notFold(st.breakCond) : bool(ctx, true)) ?? bool(ctx, true);
        const prBefore = st.pendingRets.length;
        const elemFrame: Frame = { vars: new Map(frame.vars) };
        const elemState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        bindForVar(stmt.initializer, iter.elems[k], elemFrame);
        execStmt(stmt.statement, elemFrame, elemState, depth);
        mergeBranch(frame, st, guard, elemFrame, elemState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) {
          // break/continue terminate only THIS loop — see the tb-site note.
          if (process.env.VERIF_SEQ_DEBUG) console.log(`[forof-hard-exit] line=${sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1} hardRet=${st.hardRet} thrown=${String(st.thrown)} bc=${String(st.breakCond)}`);
          st.breakCond = null;
          st.continueCond = null;
          break;
        }
        // A conditional return/throw fired under this iteration's guard: a
        // real execution would have left the whole function — treat it as a
        // loop exit (post-loop statements run under ¬exit via rest-on-copy).
        // The exit condition is the RETURN'S OWN condition (guard ∧ inner),
        // NOT the bare guard: conflating them made guard-folded-true loops
        // (len const > 0) drop every post-loop statement unconditionally —
        // the fall-through path (return not taken) became unreachable and
        // the function's final return vanished (snapshot-render buildView
        // lost its success arm entirely, zero degradations).
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          let exitCond: Bool<"main"> | null = null;
          for (let pi = prBefore; pi < st.pendingRets.length; pi++) exitCond = orFold(exitCond, st.pendingRets[pi]!.cond) ?? null;
          if (st.thrown !== null && constBool(st.thrown) === undefined) exitCond = orFold(exitCond, guard) ?? null;
          st.breakCond = orFold(st.breakCond, exitCond) ?? null;
          break;
        }
      }
      // Elements beyond the declared length never execute. The loop is the
      // target of any break/continue inside it — consume them here so the
      // enclosing block's rest-on-copy does not guard post-loop statements
      // with a stale inner-break condition.
      st.breakCond = null;
      st.continueCond = null;
      return;
    }
    if (ts.isForStatement(stmt)) {
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          for (const d of stmt.initializer.declarations) {
            if (ts.isIdentifier(d.name)) {
              frame.vars.set(d.name.text, d.initializer ? evalExpr(d.initializer, frame, st, depth) : { kind: "undef" });
            }
          }
        } else {
          evalExpr(stmt.initializer, frame, st, depth);
        }
      }
      for (let k = 0; k < K; k++) {
        const c = stmt.condition ? evalExpr(stmt.condition, frame, st, depth) : { kind: "bool" as const, t: bool(ctx, true) };
        const tb = truthy(ctx, c);
        if (tb === null) { degrade(st, stmt, "for condition degraded"); return; }
        // Constant-false condition: the loop provably finished — do NOT
        // execute the body (dead iterations pollute live state).
        if (constBool(tb) === false) {
          pushAsum(st, bool(ctx, true));
          // the loop is the target of any break/continue inside it —
          // consumed here, never propagated to the enclosing block
          st.breakCond = null;
          st.continueCond = null;
          return;
        }
        // Ghost-iteration pruning: k concrete + bounded length term ⇒
        // iterations past the max reachable length never execute.
        if (stmt.condition && ts.isBinaryExpression(stmt.condition)) {
          const cond = stmt.condition;
          const rhsTerm = evalExpr(cond.right, frame, st, depth);
          if (rhsTerm.kind === "num") {
            const maxL = maxConcreteLeaf(rhsTerm.t);
            const lhsV = ts.isIdentifier(cond.left) ? frame.vars.get(cond.left.text) : undefined;
            const kC = lhsV && lhsV.kind === "num" ? numC(lhsV.t) : undefined;
            if (maxL !== undefined && kC !== undefined) {
              const ops = cond.operatorToken.kind;
              const dead = (ops === ts.SyntaxKind.LessThanToken && kC >= maxL) || (ops === ts.SyntaxKind.LessThanEqualsToken && kC > maxL);
              if (dead) { pushAsum(st, bool(ctx, true)); st.breakCond = null; st.continueCond = null; return; }
            }
          }
        }
        const prBefore = st.pendingRets.length;
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        // continue: still run the increment — handled by running increment
        // on iterFrame after body (continue skips rest of body only).
        if (stmt.incrementor) evalExpr(stmt.incrementor, iterFrame, iterState, depth);
        // post-break iterations never run: gate the merge by ¬break-so-far
        mergeBranch(frame, st, andFold(tb, st.breakCond ? notFold(st.breakCond) : bool(ctx, true)) as Bool<"main">, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) {
          // break/continue terminate only THIS loop — the loop construct
          // consumes them, and post-loop statements run unconditionally.
          // Leaving the flag set made execSeq treat the rest of the block
          // as unreachable (stopCond === "true") and drop the function's
          // final return entirely (ret null with zero degradations).
          st.breakCond = null;
          st.continueCond = null;
          return;
        }
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          // exit condition = the return's own condition (tb ∧ inner), not bare tb — see the for-of note.
          let exitCond: Bool<"main"> | null = null;
          for (let pi = prBefore; pi < st.pendingRets.length; pi++) exitCond = orFold(exitCond, st.pendingRets[pi]!.cond) ?? null;
          if (st.thrown !== null && constBool(st.thrown) === undefined) exitCond = orFold(exitCond, tb as Bool<"main">) ?? null;
          st.breakCond = orFold(st.breakCond, exitCond) ?? null;
          return;
        }
      }
      // Loop may need more than K iterations: assume it finished. The
      // exit assert (¬tb) is sound ONLY for a symbolic tb — a CONST-TRUE tb
      // (allocateFreeRef's `candidate <= MAX_INDEX` scan can never exit
      // within K) would push a const-FALSE assert and poison every query
      // to UNSAT. Bounded under-approximation instead: the model pretends
      // termination after K iterations (SAT witnesses stay real; UNSAT
      // claims only cover the first K iterations).
      const c = stmt.condition ? evalExpr(stmt.condition, frame, st, depth) : null;
      const tb = c ? truthy(ctx, c) : bool(ctx, true);
      if (tb && constBool(tb as Bool<"main">) === undefined) pushAsum(st, notFold(tb as Bool<"main">));
      st.breakCond = null;
      st.continueCond = null;
      return;
    }
    if (ts.isWhileStatement(stmt)) {
      for (let k = 0; k < K; k++) {
        const c = evalExpr(stmt.expression, frame, st, depth);
        const tb = truthy(ctx, c);
        if (tb === null) { degrade(st, stmt, "while condition degraded"); return; }
        const prBefore = st.pendingRets.length;
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        mergeBranch(frame, st, andFold(tb, st.breakCond ? notFold(st.breakCond) : bool(ctx, true)) as Bool<"main">, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) {
          // break/continue terminate only THIS loop — the loop construct
          // consumes them, and post-loop statements run unconditionally.
          // Leaving the flag set made execSeq treat the rest of the block
          // as unreachable (stopCond === "true") and drop the function's
          // final return entirely (ret null with zero degradations).
          st.breakCond = null;
          st.continueCond = null;
          return;
        }
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          // exit condition = the return's own condition (tb ∧ inner), not bare tb — see the for-of note.
          let exitCond: Bool<"main"> | null = null;
          for (let pi = prBefore; pi < st.pendingRets.length; pi++) exitCond = orFold(exitCond, st.pendingRets[pi]!.cond) ?? null;
          if (st.thrown !== null && constBool(st.thrown) === undefined) exitCond = orFold(exitCond, tb as Bool<"main">) ?? null;
          st.breakCond = orFold(st.breakCond, exitCond) ?? null;
          return;
        }
      }
      const c = evalExpr(stmt.expression, frame, st, depth);
      const tb = truthy(ctx, c);
      // K-cap exit: assert ¬tb only when the solver can still choose exit
      // (symbolic tb). CONST-TRUE tb means the loop cannot exit within the
      // bound — asserting it did would push a contradiction (see for-note).
      if (tb && constBool(tb as Bool<"main">) === undefined) pushAsum(st, notFold(tb as Bool<"main">));
      st.breakCond = null;
      st.continueCond = null;
      return;
    }
    if (ts.isBreakStatement(stmt)) { st.breakCond = bool(ctx, true); return; }
    if (ts.isContinueStatement(stmt)) { st.continueCond = bool(ctx, true); return; }
    if (ts.isSwitchStatement(stmt)) {
      // Desugar to if-chain over case expressions (guarded code has small
      // switches), with JS entry semantics: a clause's body runs when the
      // discriminant matches (or `default` is reached with no prior match)
      // AND no earlier entered clause broke out. Dead clauses (entry folds
      // false) are never executed — eager execution of provably-dead bodies
      // wasted terms and forced untranslatable code into the model.
      const disc = evalExpr(stmt.expression, frame, st, depth);
      // Clauses must start from the SAME pre-switch state. Copying from the
      // accumulated (already-merged) frame let each later arm see earlier
      // arms' pushes — arm N's msgs.push landed at a DIFFERENT slot than
      // arm N-1's, and the iteration merge then fused two arms' objects
      // into one field-union ghost (anthropic parse: thinking msg merged
      // with tool_use msg, text degraded to any).
      const flat = (xs: readonly ts.Statement[]): ts.Statement[] => xs.flatMap(x => ts.isBlock(x) ? flat(x.statements) : [x]);
      // Empty labels (`case "a": case "b": {…}`) are grouping, not fallthrough.
      const hasFallthrough = stmt.caseBlock.clauses.some((c, ci) =>
        ci < stmt.caseBlock.clauses.length - 1 && c.statements.length > 0 && !flat(c.statements).some(x => ts.isBreakStatement(x) || ts.isReturnStatement(x) || ts.isThrowStatement(x)));
      if (hasFallthrough) degrade(st, stmt, "switch fallthrough (no break) not modeled");
      const base: Frame = { vars: new Map(frame.vars) };
      let matched = bool(ctx, false); // some earlier case compared equal
      let stopped: Bool<"main"> | null = null; // an entered clause broke out
      for (const clause of stmt.caseBlock.clauses) {
        let enter: Bool<"main">;
        if (ts.isCaseClause(clause)) {
          const cv = evalExpr(clause.expression, frame, st, depth);
          const eq = valEq(disc, cv);
          if (eq === null) {
            degrade(st, clause.expression, "case comparison degraded");
            matched = bool(ctx, true); // unconstrained — conservative over-approx
            enter = bool(ctx, true);
          } else {
            matched = orFold(matched, eq) ?? bool(ctx, false);
            enter = eq ?? bool(ctx, true);
          }
        } else {
          enter = notFold(matched);
        }
        if (stopped) enter = andFold(enter, notFold(stopped)) ?? enter;
        const cf: Frame = { vars: new Map(base.vars) };
        const cs: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        const enterC = constBool(enter);
        if (enterC === false) continue; // dead clause: never executed
        for (const inner of clause.statements) execStmt(inner, cf, cs, depth);
        // JS semantics: `break` inside a switch exits the SWITCH, not the
        // enclosing loop. The clause's breakCond is consumed here — only
        // return/throw/continue propagate outward.
        const broke = cs.breakCond;
        cs.breakCond = null;
        if (enterC === true) {
          // Live clause: apply in-frame (no ITE wrapper needed).
          for (const [k2, v] of cf.vars) frame.vars.set(k2, v);
          const __cs_ret = cs.ret ?? st.ret; st.ret = __cs_ret as SymVal | null; st.hardRet = st.hardRet || cs.hardRet; 
          st.thrown = cs.thrown ?? st.thrown;
          st.breakCond = st.breakCond ? (orFold(st.breakCond, cs.breakCond ?? bool(ctx, false)) ?? null) : cs.breakCond;
          st.continueCond = st.continueCond ? (orFold(st.continueCond, cs.continueCond ?? bool(ctx, false)) ?? null) : cs.continueCond;
          st.pendingRets.push(...cs.pendingRets);
          if (constBool(broke) === true) stopped = bool(ctx, true);
          if (st.hardRet || constBool(st.thrown) === true) return;
          continue;
        }
        if (broke) stopped = orFold(stopped ?? bool(ctx, false), andFold(enter, broke) ?? bool(ctx, false)) ?? bool(ctx, false);
        mergeBranch(frame, st, enter, cf, cs, null, null);
        if (st.hardRet || constBool(st.thrown) === true) return;
      }
      return;
    }
    if (ts.isTryStatement(stmt)) {
      const tf: Frame = { vars: new Map(frame.vars) };
      const ts_: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
      execStmt(stmt.tryBlock, tf, ts_, depth);
      if (ts_.thrown && stmt.catchClause) {
        ts_.thrown = null; // caught
        if (stmt.catchClause.variableDeclaration?.name && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
          tf.vars.set(stmt.catchClause.variableDeclaration.name.text, { kind: "any" });
        }
        execStmt(stmt.catchClause.block, tf, ts_, depth);
      }
      if (stmt.finallyBlock) execStmt(stmt.finallyBlock, tf, ts_, depth);
      // merge try-path back unconditionally
      for (const [k2, v] of tf.vars) frame.vars.set(k2, v);
      const __try_ret = ts_.ret ?? st.ret; st.ret = __try_ret as SymVal | null; st.hardRet = st.hardRet || ts_.hardRet; st.thrown = ts_.thrown ?? st.thrown; 
      st.breakCond = st.breakCond ? (orFold(st.breakCond, ts_.breakCond ?? bool(ctx, false)) ?? null) : ts_.breakCond;
      st.continueCond = st.continueCond ? (orFold(st.continueCond, ts_.continueCond ?? bool(ctx, false)) ?? null) : ts_.continueCond;
      st.pendingRets.push(...ts_.pendingRets);
      // shared accumulators — no merge needed
      return;
    }
    if (ts.isEmptyStatement(stmt)) return;
    bad(stmt, `statement ${ts.SyntaxKind[stmt.kind]}`);
  };


  const bindForVar = (init: ts.ForInitializer, value: SymVal, frame: Frame): void => {
    if (ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) {
        if (ts.isIdentifier(d.name)) frame.vars.set(d.name.text, value);
        else if (ts.isObjectBindingPattern(d.name)) {
          // property destructuring with rename: `const { blockId, seqs: blockSeqs } of seeds`
          // (#4052 follow-up: anchor synthesis iterates blockSeeds this way)
          for (const el of d.name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            frame.vars.set(el.name.text, member(value, propName, el, st));
          }
        }
        else if (ts.isArrayBindingPattern(d.name)) {
          // positional destructuring: `[a, b] = pairArray`
          for (let j = 0; j < d.name.elements.length; j++) {
            const el = d.name.elements[j];
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const v: SymVal = isArr(value) ? (value.elems[j] ?? { kind: "undef" }) : { kind: "undef" };
            frame.vars.set(el.name.text, v);
          }
        }
      }
    }
  };

  const pushAsum = (st: RunState, t: Bool<"main">): void => {
    if (st.seenAsum === undefined) st.seenAsum = new Set();
    const k = t.hash();
    if (st.seenAsum.has(k)) return;
    st.seenAsum.add(k);
    st.assumptions.push(t);
  };

  const degrade = (st: RunState, node: ts.Node, what: string): void => {
    const key = `${what} @${lineOf(node)}`;
    if (st.seenDeg === undefined) st.seenDeg = new Set();
    if (st.seenDeg.has(key)) return;
    st.seenDeg.add(key);
    st.degradations.push(key);
  };
const mergeBranch = (
    frame: Frame,
    st: RunState,
    cond: Bool<"main">,
    thenFrame: Frame, thenState: RunState,
    elseFrame: Frame | null, elseState: RunState | null,
  ): void => {

    // Merge variables — a proper three-way merge:
    //   both branches wrote  → ite(cond, thenVal, elseVal)   (pre-branch value is dead)
    //   only then wrote     → ite(cond, thenVal, cur)
    //   only else wrote     → ite(¬cond, elseVal, cur)
    //   neither wrote       → keep cur
    // Sequential two-pass merging (then into frame, then else into the
    // already-merged frame) builds nested ite(¬c, e, ite(c, t, cur)) terms
    // that no constant folding can ever reduce — and worse, when BOTH
    // branches assigned, the stale pre-branch value survives inside the
    // nested term shape. Reference identity distinguishes written names:
    // untouched bindings carry the SAME object reference into branch copies.
    const names = new Set<string>([...thenFrame.vars.keys(), ...(elseFrame ? [...elseFrame.vars.keys()] : [])]);
    for (const name of names) {
      const cur = frame.vars.get(name);
      const tv = thenFrame.vars.get(name);
      const ev = elseFrame ? elseFrame.vars.get(name) : undefined;
      const wroteT = tv !== undefined && tv !== cur;
      const wroteE = ev !== undefined && ev !== cur;
      if (wroteT && wroteE) frame.vars.set(name, iteStrict(cond, tv, ev));
      else if (wroteT) frame.vars.set(name, cur !== undefined ? iteStrict(cond, tv, cur) : tv);
      else if (wroteE) frame.vars.set(name, cur !== undefined ? iteStrict(cond.not(), ev, cur) : ev);
    }
    // ret merge: branch returns become PENDING conditional returns — the
    // statements after the if still execute (they produce the other path's
    // value); the final return value folds all pending conditions at the end.
    if (thenState.hardRet || thenState.ret !== null) {
      const tv = thenState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond, val: tv });
    }
    // Conditional returns from INSIDE the branch (e.g. `if (x) return` in a
    // loop body) live only in pendingRets — hardRet/ret stay null, so lifting
    // them under the same if would DROP them: the while-loop early-return
    // detection compares pendingRets counts and never fires; the loop then
    // unrolls to exhaustion and the post-loop `throw` poisons the caller.
    for (const pr of thenState.pendingRets) st.pendingRets.push({ cond: andFold(cond, pr.cond) ?? bool(ctx, false), val: pr.val });
    if (elseState && (elseState.hardRet || elseState.ret !== null)) {
      const ev = elseState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond: notFold(cond), val: ev });
    }
    for (const pr of elseState?.pendingRets ?? []) st.pendingRets.push({ cond: andFold(notFold(cond), pr.cond) ?? bool(ctx, false), val: pr.val });
    // Flags merge — normalize provably-false flags back to null: a
    // const-false TERM is not nullish, and every consumer does
    // `st.flag ?? default`; a lingering false term flips loop guards
    // (for-of iteration k>=1 dying to `andFold(guard, false)`).
    const tThrown = thenState.thrown;
    const eThrown = elseState?.thrown ?? null;
    const tB = tThrown ?? bool(ctx, false);
    const eB = eThrown ?? bool(ctx, false);
    const mergedThrow = st.thrown ?? bool(ctx, false);
    const nt = orFold(orFold(mergedThrow, andFold(cond, tB) ?? bool(ctx, false)) ?? bool(ctx, false), andFold(notFold(cond), eB) ?? bool(ctx, false)) ?? bool(ctx, false);
    st.thrown = constBool(nt) === false ? null : nt;
    const tBrk = thenState.breakCond ?? null;
    const eBrk = elseState?.breakCond ?? null;
    const mergedBrk = st.breakCond ?? bool(ctx, false);
    const nb = orFold(orFold(mergedBrk, tBrk ? (andFold(cond, tBrk) ?? bool(ctx, false)) : bool(ctx, false)) ?? bool(ctx, false), eBrk ? (andFold(notFold(cond), eBrk) ?? bool(ctx, false)) : bool(ctx, false)) ?? bool(ctx, false);
    st.breakCond = constBool(nb) === false ? null : nb;
    const tCnt = thenState.continueCond ?? null;
    const eCnt = elseState?.continueCond ?? null;
    const mergedCnt = st.continueCond ?? bool(ctx, false);
    const nc = orFold(orFold(mergedCnt, tCnt ? (andFold(cond, tCnt) ?? bool(ctx, false)) : bool(ctx, false)) ?? bool(ctx, false), eCnt ? (andFold(notFold(cond), eCnt) ?? bool(ctx, false)) : bool(ctx, false)) ?? bool(ctx, false);
    st.continueCond = constBool(nc) === false ? null : nc;
    const pushAll = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll(st.assumptions, thenState.assumptions); if (elseState) pushAll(st.assumptions, elseState.assumptions);
    // degradations shared (single array across copies)
  };

  const valEq = (a: SymVal, b: SymVal): Bool<"main"> | null => {
    // undefined / null never equal anything: a switch over an out-of-range
    // slot read (phantom tail of a symbolic-length array) must simply not
    // match its cases — NOT degrade the whole statement.
    const ka: string = (a as { kind: string }).kind, kb: string = (b as { kind: string }).kind;
    if (ka === "undef" || ka === "null" || kb === "undef" || kb === "null") {
      return bool(ctx, ka === kb);
    }
    if (isNum(a) && isNum(b)) {
      const ac = numC(a.t), bc = numC(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      return a.t.eq(b.t);
    }
    if (isStr(a) && isStr(b)) {
      const ac = strConst.get(a.t), bc = strConst.get(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      if (typeof (a.t as { eq?: unknown }).eq !== "function" || typeof (b.t as { eq?: unknown }).eq !== "function") {
        return null;
      }
      return a.t.eq(b.t);
    }
    if (isBool(a) && isBool(b)) {
      const ac = boolConst.get(a.t), bc = boolConst.get(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      return a.t.eq(b.t);
    }
    if (a.kind === "null" && b.kind === "null") return bool(ctx, true);
    if (a.kind === "undef" && b.kind === "undef") return bool(ctx, true);
    return null;
  };

  /* ---------------- expressions ---------------- */

  const evalExpr = (expr: ts.Expression, frame: Frame, st: RunState, depth: number): SymVal => {
    if (ts.isNewExpression(expr)) {
      return evalNew(expr, frame, st, depth);
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return { kind: "fn", node: expr, env: frame };
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Math"
    ) {
      const meth = expr.expression.name.text;
      const argVals = expr.arguments.map((a) => evalExpr(a, frame, st, depth));
      return mathCall(meth, argVals, expr, st);
    }
    if (ts.isNumericLiteral(expr)) {
      // Numeric literals become Real; note 0.95 etc are exact rationals here.
      return { kind: "num", t: num(ctx, Number(expr.text.replace(/_/g, ""))) };
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { kind: "str", t: strc(ctx, expr.text) };
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "bool", t: bool(ctx, true) };
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "bool", t: bool(ctx, false) };
    if (expr.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };
    if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "undef" };
    if (ts.isIdentifier(expr)) {
      const v = frame.vars.get(expr.text);
      if (v) return v;
      const mi = curInfo();
      const c = mi.numbers.get(expr.text) ?? info.numbers.get(expr.text);
      if (c !== undefined) return { kind: "num", t: num(ctx, c) };
      const s = mi.strings.get(expr.text) ?? info.strings.get(expr.text);
      if (s !== undefined) return { kind: "str", t: strc(ctx, s) };
      const arrow = mi.constArrowFns.get(expr.text) ?? info.constArrowFns.get(expr.text);
      if (arrow) return evalExpr(arrow, frame, st, depth);
      // module-level function declaration used as a VALUE (filter(fnRef)):
      // hand out a closure; curInfo() during its body resolves its module.
      const mdFn = mi.functions.get(expr.text) ?? info.functions.get(expr.text);
      if (mdFn && mdFn.body) return { kind: "fn", node: mdFn, env: { vars: new Map() } };
      const binding = mi.constBindings.get(expr.text) ?? info.constBindings.get(expr.text);
      if (binding) return evalExpr(binding, frame, st, depth);
      const imported = (curInfo() === info ? importedSymbols.get(expr.text) : undefined)
        ?? importsOf(curInfo()).get(expr.text)
        ?? importedSymbols.get(expr.text);
      if (imported) {
        const ic = imported.info.numbers.get(expr.text);
        if (ic !== undefined) return { kind: "num", t: num(ctx, ic) };
        const is = imported.info.strings.get(expr.text);
        if (is !== undefined) return { kind: "str", t: ctx.String.val(is) };
        const ia = imported.info.constArrowFns.get(expr.text);
        if (ia) { moduleStack.push(imported.info); try { return evalExpr(ia, frame, st, depth); } finally { moduleStack.pop(); } }
        const ib = imported.info.constBindings.get(expr.text);
        // Initializers are evaluated in the DEFINING module's scope — an
        // imported const like ACP_NAME_ALT = `(?:${buildAcplikeName()})`
        // references its own module's helper, invisible from the importer.
        if (ib) { moduleStack.push(imported.info); try { return evalExpr(ib, frame, st, depth); } finally { moduleStack.pop(); } }
      }
      if (expr.text === "undefined") return { kind: "undef" };
      bad(expr, `unbound identifier ${expr.text}`);
    }
    if (ts.isParenthesizedExpression(expr)) return evalExpr(expr.expression, frame, st, depth);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return evalExpr(expr.expression, frame, st, depth);
    }
    if (ts.isTypeOfExpression(expr)) {
      const v = evalExpr(expr.expression, frame, st, depth);
      const uu = (v.kind === "num" || v.kind === "str" || v.kind === "bool") ? (v as { undefUnder?: Bool<"main"> }).undefUnder : undefined;
      const base = v.kind === "str" ? "string" : v.kind === "num" ? "number" : v.kind === "bool" ? "boolean"
        : v.kind === "obj" || v.kind === "null" || v.kind === "arr" ? "object"
        : v.kind === "fn" ? "function" : "undefined";
      if (uu) return { kind: "str", t: ctx.If(uu, ctx.String.val("undefined"), ctx.String.val(base)) } as SymVal;
      return { kind: "str", t: ctx.String.val(base) };
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      if (expr.operator === ts.SyntaxKind.ExclamationToken) {
        const v = evalExpr(expr.operand, frame, st, depth);
        const t = truthy(ctx, v);
        // const leaves (op:"true"/"false") carry no .not() — notFold folds them.
        return t ? { kind: "bool", t: notFold(t) } : { kind: "any" };
      }
      if (expr.operator === ts.SyntaxKind.MinusToken) {
        const v = evalExpr(expr.operand, frame, st, depth);
        return isNum(v) ? { kind: "num", t: v.t.neg() } : { kind: "any" };
      }
      if (expr.operator === ts.SyntaxKind.PlusToken) return evalExpr(expr.operand, frame, st, depth);
      bad(expr, `prefix ${ts.SyntaxKind[expr.operator]}`);
    }
    if (ts.isBinaryExpression(expr)) return evalBinary(expr, frame, st, depth);
    if (ts.isConditionalExpression(expr)) {
      const c = truthy(ctx, evalExpr(expr.condition, frame, st, depth));
      if (!c) { degrade(st, expr, "ternary condition degraded"); return { kind: "any" }; }
      const cb = constBool(c);
      if (cb === true) return evalExpr(expr.whenTrue, frame, st, depth);
      if (cb === false) return evalExpr(expr.whenFalse, frame, st, depth);
      const a = evalExpr(expr.whenTrue, frame, st, depth);
      const b = evalExpr(expr.whenFalse, frame, st, depth);
      return iteVal(c, a, b);
    }
    if (ts.isTemplateExpression(expr)) {
      const parts: SymVal[] = [{ kind: "str", t: ctx.String.val(expr.head.text) }];
      for (const span of expr.templateSpans) {
        let v = evalExpr(span.expression, frame, st, depth);
        if (isNum(v)) {
          // number→string interpolation: uninterpreted 1-8 digit string.
          // Content-irrelevant for structural properties; replay lock still
          // validates any witness end-to-end.
          const hole = ctx.String.const("__numstr_" + numHoleCounter++);
          digitsOnly(hole);
          pushAsum(st, (ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 8))));
          v = { kind: "str", t: hole };
        }
        parts.push(v);
        // the STATIC text following each hole is part of the string —
        // dropping it silently rewrites every template literal (bug found by
        // the module-init probe: `a${b}c${d}e` evaluated to "abd").
        if (span.literal.text) parts.push({ kind: "str", t: ctx.String.val(span.literal.text) });
      }
      return concatAll(parts);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const elems: SymVal[] = [];
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          const v = evalExpr(el.expression, frame, st, depth);
          if (isArr(v)) elems.push(...v.elems);
          else if (isObj(v) && v.fields.has("__set_values")) {
            // Set spread: JS iterates insertion order — our __set_values
            // array records exactly that.
            const sv = v.fields.get("__set_values")!;
            if (isArr(sv)) elems.push(...sv.elems);
            else degrade(st, el, "spread of set with non-array values");
          }
          else degrade(st, el, "spread of non-array in literal");
        } else {
          elems.push(evalExpr(el, frame, st, depth));
        }
      }
      const count = expr.elements.filter((e) => !ts.isSpreadElement(e)).length
        + expr.elements.filter((e) => ts.isSpreadElement(e)).length; // spread len merged below if needed
      void count;
      // declared length: count of elements (spread assumed full — guarded code
      // builds arrays with concrete sources; replay lock validates)
      let declaredLen: Num = num(ctx, 0);
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          const v = evalExpr(el.expression, frame, st, depth);
          if (isArr(v)) declaredLen = numAdd(ctx, declaredLen, v.len);
          else if (isObj(v)) {
            // Set spread carries its length in __set_values
            const sv = v.fields.get("__set_values");
            if (sv && isArr(sv)) declaredLen = numAdd(ctx, declaredLen, sv.len);
          }
        } else declaredLen = declaredLen.add(num(ctx, 1));
      }
      return arrOf(elems, declaredLen);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
      const fields = new Map<string, SymVal>();
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const v = evalExpr(prop.expression, frame, st, depth);
          if (isObj(v)) {
            for (const [k2, v2] of v.fields) fields.set(k2, v2);
            if (v.symFields) symFields = new Map(v.symFields);
          }
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          const pv = evalExpr(prop.initializer, frame, st, depth);
          fields.set(prop.name.text, pv);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const sv0 = evalExpr(prop.name, frame, st, depth);
          const sv = sv0 === undefined || sv0.kind === undefined ? (() => { console.log(`[AT-UNDEF] shorthand ${prop.name.text}:`, JSON.stringify(frame.vars.get(prop.name.text), (k, v) => (k === "kids" ? "…" : v))?.slice(0, 220)); return { kind: "any" as const }; })() : sv0;
          fields.set(prop.name.text, sv);
        } else {
          degrade(st, prop, "object literal member");
        }
      }
      return { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
    }
      if (ts.isPropertyAccessExpression(expr)) {
      const obj = evalExpr(expr.expression, frame, st, depth);
      return member(obj, expr.name.text, expr, st);
    }
    if (ts.isElementAccessExpression(expr)) {
      const obj = evalExpr(expr.expression, frame, st, depth);
      const idx = evalExpr(expr.argumentExpression, frame, st, depth);
      return elementAccess(obj, idx, expr, st);
    }
    if (ts.isCallExpression(expr)) return evalCall(expr, frame, st, depth);
    if (ts.isNonNullExpression(expr)) {
      // `x!` non-null assertion — type-level only, value is x
      return evalExpr(expr.expression, frame, st, depth);
    }
    if (ts.isRegularExpressionLiteral(expr)) {
      // /pat/flags — regex-literal carrier; String.replace/test model it.
      return { kind: "obj", fields: new Map([["__regex", { kind: "str", t: ctx.String.val(expr.text) }]]) } as SymVal;
    }
    if (expr.kind === ts.SyntaxKind.PostfixUnaryExpression || expr.kind === ts.SyntaxKind.PrefixUnaryExpression) {
      const u = expr as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
      const one = num(ctx, 1);
      const v = evalExpr(u.operand, frame, st, depth);
      if (isNum(v) && ts.isIdentifier(u.operand)) {
        const cv0 = isNum(v) ? numC(v.t) : undefined;
        const nv = cv0 !== undefined
          ? { kind: "num" as const, t: num(ctx, u.operator === ts.SyntaxKind.PlusPlusToken ? cv0 + 1 : cv0 - 1) }
          : { kind: "num" as const, t: u.operator === ts.SyntaxKind.PlusPlusToken ? v.t.add(one) : v.t.sub(one) };
        frame.vars.set(u.operand.text, nv);
        return u.kind === ts.SyntaxKind.PrefixUnaryExpression ? nv : v;
      }
      bad(expr, "update expression on non-number");
    }
    if (ts.isDeleteExpression(expr)) {
      // `delete obj[k]` / `delete obj.k`: the slot reads as undefined
      // afterwards. Modeled as an undef store (missing field ≡ undef).
      const t = expr.expression;
      if (ts.isElementAccessExpression(t)) {
        const base = evalExpr(t.expression, frame, st, depth);
        const idx = evalExpr(t.argumentExpression, frame, st, depth);
        if (isObj(base) && isStr(idx)) {
          const fields = new Map(base.fields);
          for (const key of [...fields.keys()]) {
            fields.set(key, iteVal(idx.t.eq(ctx.String.val(key)), { kind: "undef" }, fields.get(key)!));
          }
          // symbolic-key delete: drop symFields entries whose key matches the
          // index term (structural identity) — the merge machinery then folds
          // the removal into the enclosing path guard.
          let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
          if (base.symFields) {
            symFields = new Map(base.symFields);
            for (const kt of [...symFields.keys()]) {
              if (kt === idx.t || (kt.hash !== undefined && idx.t.hash !== undefined && kt.hash() === idx.t.hash())) {
                symFields.delete(kt);
              }
            }
          }
          const newObj: SymVal = { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
          writeLValue(t.expression, newObj, frame, st, depth);
          return { kind: "bool", t: bool(ctx, true) };
        }
      } else if (ts.isPropertyAccessExpression(t)) {
        const base = evalExpr(t.expression, frame, st, depth);
        if (isObj(base)) {
          const fields = new Map(base.fields);
          fields.set(t.name.text, { kind: "undef" });
          // JS reference semantics — mirror the member-write path
          // (`rec.id = v`): delete MUTATES the object in place; every
          // container still holding `base` must see the field vanish.
          // Rebinding only the local alias left the mutation invisible to
          // the caller's array slots once loop-iteration merges rebuilt
          // them (identity-based pair replay missed the fresh slot objs).
          const newObj: SymVal = { kind: "obj", fields, ...(base.symFields ? { symFields: new Map(base.symFields) } : {}) };
          if (pathIsUnconditional(st.pathCond)) st.mutations!.push({ old: base, next: newObj });
          replaceAliasInFrame(frame, base, newObj);
          writeLValue(t.expression, newObj, frame, st, depth);
          return { kind: "bool", t: bool(ctx, true) };
        }
      }
      return { kind: "bool", t: bool(ctx, true) };
    }
    return bad(expr, `expression ${ts.SyntaxKind[expr.kind]}`);
  };

  // (TS2366: `bad` throws; this satisfies the checker without changing behavior.)

  const rootName = (e: ts.PropertyAccessExpression): string | undefined =>
    ts.isIdentifier(e.expression) ? e.expression.text : ts.isPropertyAccessExpression(e.expression) ? rootName(e.expression) : undefined;

  const compoundOpKind = (k: ts.SyntaxKind): ts.BinaryOperatorToken["kind"] | undefined => {
    switch (k) {
      case ts.SyntaxKind.PlusEqualsToken: return ts.SyntaxKind.PlusToken;
      case ts.SyntaxKind.MinusEqualsToken: return ts.SyntaxKind.MinusToken;
      case ts.SyntaxKind.AsteriskEqualsToken: return ts.SyntaxKind.AsteriskToken;
      default: return undefined;
    }
  };

  const concatAll = (parts: SymVal[]): SymVal => {
    const strs: Str[] = [];
    let allConst = true;
    let acc = "";
    for (const p of parts) {
      if (!isStr(p)) {
        return { kind: "any" };
      }
      const sv = strConst.get(p.t);
      if (sv === undefined) allConst = false;
      else acc += sv;
      strs.push(p.t);
    }
    if (strs.length === 0) return { kind: "str", t: strc(ctx, "") };
    if (allConst) return { kind: "str", t: strc(ctx, acc) };
    return { kind: "str", t: strs.reduce((a, b) => a.concat(b)) };
  };

  const member = (obj: SymVal, name: string, at: ts.Node, st: RunState): SymVal => {
    if (isArr(obj)) {
      if (name === "length") return { kind: "num", t: obj.len };
      return { kind: "any" }; // methods are handled at call sites
    }
    if (isStr(obj)) {
      if (name === "length") {
        const sv = strConst.get(obj.t);
        if (sv !== undefined) return { kind: "num", t: num(ctx, sv.length) };
        return { kind: "num", t: lenR(obj.t) };
      }
      return { kind: "any" };
    }
    if (isObj(obj)) {
      // A merged-away object (nullUnder) must not hand out its surviving
      // side's fields unconditionally — gate every read by ¬nullUnder.
      const nu = (obj as { nullUnder?: Bool<"main"> }).nullUnder;
      if (nu) {
        const raw = member({ ...obj, nullUnder: undefined } as SymVal, name, at, st);
        if (raw.kind === "any") return raw;
        return iteVal(nu.not()!, raw, { kind: "undef" });
      }
      // Map/Set .size (property, not method)
      if (name === "size" && (obj.fields.has("__map_entries") || obj.fields.has("__set_values"))) {
        const e = obj.fields.get("__map_entries") ?? obj.fields.get("__set_values");
        if (e && isArr(e)) return { kind: "num", t: e.len };
      }
      const v = obj.fields.get(name);
      // missing field reads as `undefined` in JS (NOT unknown/any) —
      // `!!message.toolName` on a field-less message must fold to false,
      // not poison the condition
      return v ?? { kind: "undef" };
    }
    if (obj.kind === "null" || obj.kind === "undef") return { kind: "undef" };
    return bad(at, `member on ${obj.kind}`);
  };


  const elementAccess = (obj: SymVal, idx: SymVal, at: ts.Node, st: RunState): SymVal => {
    if (isArr(obj) && isNum(idx)) {
      const ic = numC(idx.t);
      if (ic !== undefined && Number.isInteger(ic)) {
        const rv = ic >= 0 && ic < obj.elems.length ? obj.elems[ic]! : { kind: "undef" as const };
        return rv;
      }
      // Chain of If(idx == k, elems[k]) for k < N.
      let acc: SymVal = { kind: "undef" };
      for (let k = obj.elems.length - 1; k >= 0; k--) {
        acc = iteVal(numEq(ctx, idx.t, num(ctx, k)), obj.elems[k], acc);
      }
      return acc;
    }
    if (isObj(obj) && isStr(idx)) {
      // Dynamic key: pick by string equality over known keys — concrete
      // fields first, then symbolic-key bindings (symFields). Layers merge
      // via iteStrict (tagged-strict): a non-matching fan leaves the value
      // undefined UNDER ¬match — tagged reads (`=== undefined`, truthiness,
      // typeof) consult the tag, concrete reads use the value.
      let acc: SymVal = { kind: "undef" };
      const fanLayer = (c: Bool<"main">, v: SymVal, accv: SymVal): SymVal => iteStrict(c, v, accv);
      for (const [key, v] of obj.fields) {
        acc = fanLayer(strEqF(ctx, idx.t, ctx.String.val(key)), v, acc);
      }
      if (obj.symFields) {
        for (const [kt, e] of obj.symFields) {
          acc = fanLayer(andFold(idx.t.eq(kt), e.g)!, e.v, acc);
        }
      }
      return acc;
    }
    return { kind: "any" };
  };

  const ASSIGN_OPS: ts.SyntaxKind[] = [
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ];

  /** Recursive lvalue store with value semantics: rebuilding a[i].f = v
   *  through the chain (slot-write the array, then rebind upward). Real JS
   *  uses references — `host = msgs[k]; host.f = v` is visible via msgs[k]
   *  — so chained stores must rewrite every container on the path. */
  // A field/key write on an object builds a NEW obj (Map copy). JS
  // reference semantics: every container still holding the OLD object must
  // observe the write, so replace it in all frame vars (arrays holding it
  // as an element, objects holding it as a field value).
  const replaceAliasInFrame = (frame: Frame, base: SymVal, newObj: SymVal): void => {
    for (const [vn, vv] of frame.vars) {
      if (isArr(vv)) {
        let hit = false;
        const elems = vv.elems.map((e) => { if (e === base) { hit = true; return newObj; } return e; });
        if (hit) {
          frame.vars.set(vn, { kind: "arr", elems, len: vv.len } as SymVal);
        }
      } else if (isObj(vv) && vv !== base) {
        let hit = false;
        const nf: Map<string, SymVal> = new Map(vv.fields);
        for (const [fk, fv] of nf) if (fv === base) { nf.set(fk, newObj); hit = true; }
        if (hit) frame.vars.set(vn, { kind: "obj", fields: nf, ...(vv.symFields ? { symFields: new Map(vv.symFields) } : {}) } as SymVal);
      }
    }
  };
  const writeLValue = (target: ts.Expression, value: SymVal, frame: Frame, st: RunState, depth: number): boolean => {
    if (ts.isNonNullExpression(target)) return writeLValue(target.expression, value, frame, st, depth);
    // (x as T).field = v / ((x)).field = v — unwrap casts and parens
    if (ts.isParenthesizedExpression(target) || ts.isAsExpression(target)) return writeLValue(target.expression, value, frame, st, depth);
    if (ts.isIdentifier(target)) {
      const prior = frame.vars.get(target.text);
      // Record source-level container rebinds: a callee mutating a
      // container param must be observable at the call boundary (JS
      // reference semantics). Loop/merge machinery rebinds vars through
      // mergeBranch instead, so only REAL writes land here.
      if (prior && prior !== value && (prior.kind === "arr" || prior.kind === "obj") && (value.kind === "arr" || value.kind === "obj")) {
        if (pathIsUnconditional(st.pathCond)) st.mutations!.push({ old: prior, next: value });
      }
      frame.vars.set(target.text, value);
      return true;
    }
    if (ts.isPropertyAccessExpression(target)) {
      // A[i].f = v with symbolic i: the read A[i] produces a fan over all
      // slots; mutating the fan and writing it back into every slot fuses
      // the slot identities into one field-union ghost AND (for plain
      // A[i] = v chains) grows len unboundedly under loop unrolling.
      // Correct semantics: distribute the field write per slot, guarded by
      // i == k, leaving len untouched (a field write never grows an array).
      let eaInner: ts.Expression = target.expression;
      while (ts.isAsExpression(eaInner) || ts.isParenthesizedExpression(eaInner) || ts.isNonNullExpression(eaInner)) eaInner = eaInner.expression;
      if (ts.isElementAccessExpression(eaInner) && !(eaInner.questionDotToken)) {
        const rootArr = evalExpr(eaInner.expression, frame, st, depth);
        const idxV = evalExpr(eaInner.argumentExpression, frame, st, depth);
        if (isArr(rootArr) && isNum(idxV) && !isNumConstV(idxV)) {
          const fname = target.name.text;
          const elems = rootArr.elems.map((e, k) => {
            const withField: SymVal = isObj(e)
              ? { kind: "obj", fields: new Map([...e.fields, [fname, value]]), ...(e.symFields ? { symFields: new Map(e.symFields) } : {}) } as SymVal
              : e;
            return iteVal(numEq(ctx, idxV.t, num(ctx, k)), withField, e);
          });
          const newRoot: SymVal = { kind: "arr", elems, len: rootArr.len } as SymVal;
          return writeLValue(eaInner.expression, newRoot, frame, st, depth);
        }
      }
      const base = evalExpr(target.expression, frame, st, depth);
      if (isObj(base)) {
        const fields = new Map(base.fields);
        fields.set(target.name.text, value);
        const newObj = { kind: "obj", fields, ...(base.symFields ? { symFields: new Map(base.symFields) } : {}) } as SymVal;
        // JS reference semantics: the same object is reachable from its
        // containers (`const host = msgs[k]` / find()) — a field write must
        // be visible through every array (and one level of object field)
        // that still holds this exact value. Value-copy alone rebinds only
        // the local alias and the container keeps the stale object.
        // JS reference semantics — see the PropertyAccess note above: the
        // write must be visible through every container still holding base.
        st.mutations!.push({ old: base, next: newObj });
        replaceAliasInFrame(frame, base, newObj);
        return writeLValue(target.expression, newObj, frame, st, depth);
      }
      return false;
    }
    if (ts.isElementAccessExpression(target)) {
      const base = evalExpr(target.expression, frame, st, depth);
      const idx = evalExpr(target.argumentExpression, frame, st, depth);
      if (isArr(base) && isNum(idx)) {
        const elems = base.elems.map((e, k) => iteVal(numEq(ctx, idx.t, num(ctx, k)), value, e));
        if (base.elems.length < N) {
          elems.push(iteVal(numEq(ctx, idx.t, num(ctx, base.elems.length)), value, { kind: "undef" }));
        }
        // a[i] = v with i ≥ len grows the array to i+1
        const grown = iteVal(idx.t.gt(base.len), { kind: "num", t: idx.t.add(num(ctx, 1)) }, { kind: "num", t: base.len });
        return writeLValue(target.expression, { kind: "arr", elems, len: (grown as { t: Num }).t } as never, frame, st, depth);
      }
      if (isObj(base) && isStr(idx)) {
        // Record write: obj[key] = v. Const keys (the common case — ids,
        // refs) write the field directly. Symbolic keys fan out over the
        // fields that already exist AND record a symFields binding so the
        // write is observable when the key matches nothing present (the
        // solver decides equality).
        const fields = new Map(base.fields);
        let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
        const idxC = idx.t.c;
        if (typeof idxC === "string" && idx.t.sort === "String" && (idx.t.kids?.length ?? 0) === 0) {
          fields.set(idxC, value);
        } else {
          for (const key of [...fields.keys()]) {
            fields.set(key, iteVal(strEqF(ctx, idx.t, ctx.String.val(key)), value, fields.get(key)!));
          }
          symFields = new Map(base.symFields ?? []);
          // same key-TERM: the new write replaces it (last write wins for
          // identical terms); equal-but-distinct terms resolve via the read
          // fan's guard, which falls through dead writes.
          symFields.delete(idx.t);
          symFields.set(idx.t, { g: bool(ctx, true), v: value });
        }
        const newObj: SymVal = { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
        if (pathIsUnconditional(st.pathCond)) st.mutations!.push({ old: base, next: newObj });
        // JS reference semantics: rec[k] = v must be visible through every
        // container still holding base (same rule as the member-write path).
        replaceAliasInFrame(frame, base, newObj);
        return writeLValue(target.expression, newObj, frame, st, depth);
      }
      return false;
    }
    return false;
  };

  const applyBinop = (op: ts.SyntaxKind, l: SymVal, r: SymVal, at: ts.Node, st: RunState): SymVal => {
    // JS equality with undefined/null: a phantom-slot read (out-of-range
    // index of a symbolic-length array) compares FALSE against any concrete
    // value — it must not degrade the surrounding condition.
    {
      const lu = (l as { kind?: string }).kind, ru = (r as { kind?: string }).kind;
      // TAGGED maybe-undefined/null values fall through to the tagged
      // handler below — this kind-only fold would otherwise force
      // `taggedX === undefined` to const-false and delete the guard.
      const lTag = (l as { undefUnder?: unknown; nullUnder?: unknown }).undefUnder ?? (l as { nullUnder?: unknown }).nullUnder;
      const rTag = (r as { undefUnder?: unknown; nullUnder?: unknown }).undefUnder ?? (r as { nullUnder?: unknown }).nullUnder;
      if (!lTag && !rTag && (lu === "undef" || lu === "null" || ru === "undef" || ru === "null")) {
        const isEq = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken;
        const isNe = op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (isEq || isNe) {
          const same = lu === ru;
          return { kind: "bool", t: bool(ctx, isEq ? same : !same) };
        }
      }
    }
    if (isNum(l) && isNum(r)) {
      const a = l.t, b = r.t;
      const ac = numC(a), bc = numC(b);
      if (ac !== undefined && bc !== undefined) {
        const fold = (): SymVal | null => {
          switch (op) {
            case ts.SyntaxKind.PlusToken: return { kind: "num", t: num(ctx, ac + bc) };
            case ts.SyntaxKind.MinusToken: return { kind: "num", t: num(ctx, ac - bc) };
            case ts.SyntaxKind.AsteriskToken: return { kind: "num", t: num(ctx, ac * bc) };
            case ts.SyntaxKind.SlashToken:
              if (bc !== 0 && Number.isInteger(ac) && Number.isInteger(bc) && ac % bc === 0) return { kind: "num", t: num(ctx, ac / bc) };
              return null;
            case ts.SyntaxKind.PercentToken:
              if (Number.isInteger(ac) && Number.isInteger(bc) && bc !== 0) return { kind: "num", t: num(ctx, ac % bc) };
              return null;
            case ts.SyntaxKind.LessThanToken: return { kind: "bool", t: bool(ctx, ac < bc) };
            case ts.SyntaxKind.LessThanEqualsToken: return { kind: "bool", t: bool(ctx, ac <= bc) };
            case ts.SyntaxKind.GreaterThanToken: return { kind: "bool", t: bool(ctx, ac > bc) };
            case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "bool", t: bool(ctx, ac >= bc) };
            case ts.SyntaxKind.EqualsEqualsToken:
            case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: "bool", t: bool(ctx, ac === bc) };
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: "bool", t: bool(ctx, ac !== bc) };
            default: return null;
          }
        };
        const f = fold();
        if (f) return f;
      }
      switch (op) {
        case ts.SyntaxKind.PlusToken: return { kind: "num", t: a.add(b) };
        case ts.SyntaxKind.MinusToken: return { kind: "num", t: a.sub(b) };
        case ts.SyntaxKind.AsteriskToken: return { kind: "num", t: a.mul(b) };
        case ts.SyntaxKind.SlashToken: return { kind: "num", t: a.div(b) };
        case ts.SyntaxKind.PercentToken: return { kind: "num", t: a.mod(b) };
        case ts.SyntaxKind.LessThanToken: return { kind: "bool", t: a.lt(b) };
        case ts.SyntaxKind.LessThanEqualsToken: return { kind: "bool", t: a.le(b) };
        case ts.SyntaxKind.GreaterThanToken: return { kind: "bool", t: a.gt(b) };
        case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "bool", t: a.ge(b) };
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: "bool", t: a.eq(b) };
        case ts.SyntaxKind.ExclamationEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: "bool", t: a.neq(b) };
      }
    }
    if (isStr(l) && isStr(r)) {
      const lc = strConst.get(l.t), rc = strConst.get(r.t);
      if (op === ts.SyntaxKind.PlusToken) {
        if (lc !== undefined && rc !== undefined) return { kind: "str", t: strc(ctx, lc + rc) };
        return { kind: "str", t: l.t.concat(r.t) };
      }
      if (lc !== undefined && rc !== undefined) {
        if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) return { kind: "bool", t: bool(ctx, lc === rc) };
        if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: bool(ctx, lc !== rc) };
      }
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) { if (!l.t || !r.t) return bad(at, `eq on ${l.kind}/${r.kind} without terms`); return { kind: "bool", t: l.t.eq(r.t) }; }
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: l.t.neq(r.t) };
    }
    if (isBool(l) && isBool(r)) {
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) { if (!l.t || !r.t || typeof (l.t as { eq?: unknown }).eq !== "function" || typeof (r.t as { eq?: unknown }).eq !== "function") { return bad(at, `eq on ${l.kind}/${r.kind} without terms`); } return { kind: "bool", t: l.t.eq(r.t) }; }
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: l.t.neq(r.t) };
    }
    // Mixed num/str `+` is JS string concatenation — route through the
    // memoized number→string rendering (same number always same string).
    if (op === ts.SyntaxKind.PlusToken && isNum(l) && isStr(r)) {
      const ls = numToStringStrFor(l.t);
      return { kind: "str", t: ls.t.concat(r.t) };
    }
    if (op === ts.SyntaxKind.PlusToken && isStr(l) && isNum(r)) {
      const rs = numToStringStrFor(r.t);
      return { kind: "str", t: l.t.concat(rs.t) };
    }
    // Mixed equality against null/undefined — TAGGED scalars must consult
    // their undefUnder/nullUnder tag first: the plain kind comparison below
    // folds `taggedX === undefined` to const-false BEFORE the tagged handler
    // runs, silently deleting the maybe-undefined guard (phantom Map.get hits).
    {
      const tl = (l as { undefUnder?: unknown; nullUnder?: unknown }).undefUnder ?? (l as { nullUnder?: unknown }).nullUnder;
      const tr = (r as { undefUnder?: unknown; nullUnder?: unknown }).undefUnder ?? (r as { nullUnder?: unknown }).nullUnder;
      const eitherTagged = (l.kind === "null" || l.kind === "undef" || r.kind === "null" || r.kind === "undef") && (tl || tr);
      if (!eitherTagged && ((l.kind === "null" || l.kind === "undef") || (r.kind === "null" || r.kind === "undef"))) {
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
          return { kind: "bool", t: bool(ctx, l.kind === r.kind) };
        }
        if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
          return { kind: "bool", t: bool(ctx, l.kind !== r.kind) };
        }
      }
    }
    // Tagged maybe-undefined/null scalars vs the literal: `x !== undefined`
    // must consult the undefUnder/nullUnder tag (Map.get fan results).
    // OBJ/ARR with a nullUnder tag (post-splice/post-merge slots, strict
    // branch merges) need the same consult: `rec === null` on a maybe-null
    // object folds to If(nullUnder, true, false), not a constant — folding
    // it to const-false deleted the null guard and degraded the whole `if`.
    {
      const scalar = isNum(l) || isStr(l) || isBool(l) ? l : isNum(r) || isStr(r) || isBool(r) ? r : null;
      const objSide = l.kind === "obj" || l.kind === "arr" ? l : r.kind === "obj" || r.kind === "arr" ? r : null;
      const taggedSide = scalar ?? objSide;
      const other = taggedSide === l ? r : l;
      if (taggedSide && (other.kind === "undef" || other.kind === "null")) {
        const uu = (taggedSide as { undefUnder?: Bool<"main">; nullUnder?: Bool<"main"> }).undefUnder
          ?? (taggedSide as { nullUnder?: Bool<"main"> }).nullUnder;
        if (uu) {
          const kindMatch = other.kind === "undef" ? (taggedSide as { undefUnder?: unknown }).undefUnder !== undefined : (taggedSide as { nullUnder?: unknown }).nullUnder !== undefined;
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
            return { kind: "bool", t: kindMatch ? uu : bool(ctx, false) };
          }
          return { kind: "bool", t: kindMatch ? notFold(uu) : bool(ctx, true) };
        }
      }
    }
    return { kind: "any" };
  };

  /* ---------------- calls ---------------- */

  let reTestN = 0;
  const evalCall = (call: ts.CallExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    // Spread arguments: flatten arrays of args (rare in guarded code).
    const argVals: SymVal[] = [];
    for (const a of call.arguments) {
      if (ts.isSpreadElement(a)) {
        const v = evalExpr(a.expression, frame, st, depth);
        if (isArr(v)) argVals.push(...v.elems);
        else degrade(st, a, "spread argument");
      } else {
        const av = evalExpr(a, frame, st, depth);
        if (av === undefined && process.env.VERIF_ARG_DEBUG) console.log(`[arg-undef] expr=${a.getText().slice(0, 60)}`);
        argVals.push(av);
      }
    }
    const calleeExpr = call.expression;

    // Namespace-qualified builtins ------------------------------------
    if (ts.isPropertyAccessExpression(calleeExpr) && ts.isIdentifier(calleeExpr.expression)) {
      const ns = calleeExpr.expression.text;
      const meth = calleeExpr.name.text;
      if (ns === "Number") {
        if (meth === "isInteger" && isNum(argVals[0])) {
          return { kind: "bool", t: ctx.IsInt(argVals[0].t) };
        }
        if (meth === "isFinite" && isNum(argVals[0])) return { kind: "bool", t: bool(ctx, true) };
        if (meth === "isFinite" && !isNum(argVals[0])) return { kind: "bool", t: bool(ctx, false) };
        if (meth === "isInteger" && !isNum(argVals[0])) return { kind: "bool", t: bool(ctx, false) };
        if ((meth === "parseInt" || meth === "parseFloat") && isStr(argVals[0])) {
          return { kind: "num", t: argVals[0].t.toInt() };
        }
      }
      if (ns === "Math") return mathCall(meth, argVals, call, st);
      if (ns === "Array" && meth === "isArray") {
        if (argVals[0].kind === "arr") return { kind: "bool", t: bool(ctx, true) };
        // undefined/null/bool/fn are provably not arrays (JS typeof)
        if (argVals[0].kind !== "any") return { kind: "bool", t: bool(ctx, false) };
        degrade(st, call, "Array.isArray on degraded value");
        return { kind: "any" };
      }
      if (ns === "String" && meth === "fromCharCode") return { kind: "str", t: ctx.String.val("") }; // degraded, content-neutral
      if (ns === "JSON") {
        // JSON.parse of a KNOWN string is pure and deterministic — run the
        // real implementation and convert. Degraded args still degrade.
        if (meth === "parse") {
          const a0 = argVals[0];
          if (isStr(a0)) {
            const lit = strConst.get(a0.t);
            if (lit !== undefined) {
              try { return jsonToSymVal(JSON.parse(lit), depth); } catch { return { kind: "null" }; }
            }
            // symbolic template: content built as literal-skeleton ++ free
            // holes (the transcript-row input model). The skeleton must be
            // the exact parseRow template; holes are constrained to contain
            // no quote/backslash so the extracted fields are faithful.
            const tmpl = jsonParseTemplate(a0);
            if (tmpl) return tmpl;
          }
        }
        degrade(st, call, `JSON.${meth}`); return { kind: "any" };
      }
      if (ns === "Object") {
        const a0 = argVals[0];
        if ((meth === "keys" || meth === "entries" || meth === "values") && isObj(a0)) {
          // concrete fields first, then symbolic-key bindings (a key may be
          // bound on either side of a branch merge — read via the fan)
          const ckeys: Str[] = [];
          for (const k of a0.fields.keys()) if (!k.startsWith("__")) ckeys.push(ctx.String.val(k));
          const sf = a0.symFields;
          if (sf && sf.size > 0) for (const kt of sf.keys()) ckeys.push(kt);
          if (meth === "keys") return arrOf(ckeys.map((t) => ({ kind: "str", t }) as SymVal));
          if (meth === "values") return arrOf(ckeys.map((t) => elementAccess(a0, { kind: "str", t }, call, st) as SymVal));
          // entries: [key, value] pairs (positional destructure reads them)
          return arrOf(ckeys.map((t) => arrOf([{ kind: "str", t } as SymVal, elementAccess(a0, { kind: "str", t }, call, st) as SymVal])));
        }
        degrade(st, call, `Object.${meth}`); return { kind: "any" };
      }
      if (ns === "Boolean") { degrade(st, call, `${ns}.${meth}`); return { kind: "any" }; }
    }

    // Method calls on values -------------------------------------------
    if (ts.isPropertyAccessExpression(calleeExpr)) {
      // optional call `x.m?.(…)` (dot on the CALL) or `x?.m(…)` (dot on the
      // property access — TS puts questionDotToken on the member chain node):
      // absent receiver/method reads as undefined (no throw)
      const optChain = call.questionDotToken !== undefined || (calleeExpr as unknown as { questionDotToken?: unknown }).questionDotToken !== undefined;
      if (optChain && !(input.options?.portImpls && ("__method_" + calleeExpr.name.text) in input.options.portImpls)) {
        const r0 = evalExpr(calleeExpr.expression, frame, st, depth);
        // the receiver itself absent (undef/null) or merged-away (nullUnder):
        // the whole optional chain short-circuits to undefined
        if (r0.kind === "undef" || r0.kind === "null") return { kind: "undef" };
        if (isObj(r0)) {
          if ((r0 as { nullUnder?: unknown }).nullUnder) return { kind: "undef" };
          const mv = r0.fields.get(calleeExpr.name.text);
          if (mv === undefined || mv.kind === "undef" || mv.kind === "null") return { kind: "undef" };
        }
      }
      const recv = evalExpr(calleeExpr.expression, frame, st, depth);
      const m = calleeExpr.name.text;
      return callMethod(recv, m, argVals, call, st, frame, depth);
    }

    // Plain identifier calls -------------------------------------------
    const name = ts.isIdentifier(calleeExpr) ? calleeExpr.text : undefined;
    if (!name) { degrade(st, call, "indirect call"); return { kind: "any" }; }

    // Builtins with exact translation
    if (name === "Number.isInteger" || name === "Number.isFinite") {
      const a0 = argVals[0];
      if (isNum(a0)) {
        if (name === "Number.isInteger") return { kind: "bool", t: ctx.IsInt(a0.t) };
        return { kind: "bool", t: bool(ctx, true) }; // finite within Real model
      }
      return { kind: "bool", t: bool(ctx, false) }; // undefined/null/non-number
    }
    if (name === "Number" || name === "String") {
      const a0 = argVals[0];
      if (name === "String") {
        if (isStr(a0)) return a0;
        if (isNum(a0)) return numToStringStrFor(a0.t);
        return { kind: "any" };
      }
      if (isNum(a0)) return a0;
      // Number(constString) folds faithfully — refNum() and friends parse
      // digit strings; without this fold Number.isFinite(any) collapses to
      // constant false and gated paths silently disappear from the model.
      if (isStr(a0)) {
        const cs = (a0.t as unknown as { c?: string }).c;
        if (typeof cs === "string" && cs.trim() !== "" && !Number.isNaN(Number(cs))) {
          return { kind: "num", t: num(ctx, Number(cs)) };
        }
      }
      return { kind: "any" };
    }
    if (name === "isNaN") {
      const a0 = argVals[0];
      return isNum(a0) ? { kind: "bool", t: bool(ctx, false) } : { kind: "any" };
    }

    // Local closure value call (const arrow / function expression stored in a var)
    const fnVal = frame.vars.get(name);
    if (fnVal && fnVal.kind === "fn") {
      return invokeCallback(fnVal.node, argVals, st, depth, fnVal.env, frame);
    }

    // Port override (public injection seam); memoized on the argument's
    // structural form — port implementations are pure functions.
    // Frame-bound names (parameters, port-assigned locals) take ports FIRST;
    // imported names take ports only when the test declares them (e.g. hashId
    // uses node:crypto — outside the guarded subset). Ports NEVER shadow
    // module-local real functions (the no-cheating core: real code always
    // runs). Multi-arg ports receive all arguments (single-arg only is
    // memoized; arg0-keyed memo is sound only for unary ports).
    const moduleLocalFn = curInfo().functions.get(name) ?? info.functions.get(name);
    const moduleLocalArrow = curInfo().constArrowFns.get(name) ?? info.constArrowFns.get(name);
    if (input.options?.portImpls && name in input.options.portImpls && !moduleLocalFn && !moduleLocalArrow) {
      const arg0 = argVals[0] ?? { kind: "undef" };
      const key = arg0.kind === "str" ? `s:${String((arg0.t as unknown as { c?: string }).c ?? `h${arg0.t.hash()}`)}` : arg0.kind === "num" ? `n:${String((arg0.t as unknown as { c?: number }).c ?? numC(arg0.t))}` : null;
      if (key !== null && argVals.length === 1) {
        const hit = portMemo.get(`${name}\u0000${key}`);
        if (hit) return hit;
        const r = input.options.portImpls[name]!(arg0);
        portMemo.set(`${name}\u0000${key}`, r);
        return r;
      }
      return input.options.portImpls[name]!(arg0, ...argVals.slice(1));
    }

    // Local function → INLINE (the no-cheating core: real helper bodies run)
    const entryFn = info.functions.get(name);
    const entryArrow = info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const defEntry = importsOf(curInfo()).get(name) ?? importedSymbols.get(name);
    const localFn = moduleLocalFn ?? defEntry?.info.functions.get(name) ?? entryFn;
    const defArrow = importedSymbols.get(name)?.info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const localArrow = moduleLocalArrow ?? defArrow ?? entryArrow;
    const fnNode = localFn ?? (localArrow as ts.ArrowFunction | undefined);
    if (fnNode) {
      if (depth >= MAXINLINE) { degrade(st, call, `inline depth cap at ${name}`); return { kind: "any" }; }
      return inlineCall(fnNode, argVals, call, st, depth, defEntry?.info, frame);
    }

    degrade(st, call, `call to ${name}`);
    return { kind: "any" };
  };

  const inlineCall = (
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    args: SymVal[],
    at: ts.Node,
    st: RunState,
    depth: number,
    defInfo?: ModuleInfo,
    callerFrame?: Frame,
  ): SymVal => {
      const nm = fn.name?.text || "(anon)";
    if (defInfo) moduleStack.push(defInfo);
    // The caller's frame (call-site scope); module-level fns fall back to
    // the translation entry frame. Callee mutations must replay HERE —
    // capturing the top-level `frame` instead lost them at nesting depth 2.
    const home: Frame = callerFrame ?? frame;
    try {
    const inner: Frame = { vars: new Map(home.vars) }; // lexical closure
    // bind parameters (earlier params visible to later default exprs)
    fn.parameters.forEach((prm, pi) => {
      const pv: SymVal | undefined = args[pi] ?? (prm.initializer ? evalExpr(prm.initializer, inner, innerState, depth + 1) : undefined);
      const pd: SymVal = pv === undefined ? { kind: "undef" } : pv;
      if (ts.isIdentifier(prm.name)) inner.vars.set(prm.name.text, pd);
      else if (ts.isArrayBindingPattern(prm.name)) prm.name.elements.forEach((el, j) => {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) return;
        inner.vars.set(el.name.text, elementAccess(pd, { kind: "num", t: num(ctx, j) }, el, st));
      });
    });
    const innerState: RunState = runState0();
    const body = ts.isFunctionDeclaration(fn) ? fn.body : fn.body;
    if (!body) return { kind: "any" };
    if (ts.isBlock(body)) {
      execStmt(body, inner, innerState, depth + 1);
    } else {
      // arrow with expression body
      innerState.ret = evalExpr(body, inner, innerState, depth + 1);
    }
    const pushAll2 = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll2(st.assumptions, innerState.assumptions);
    // JS reference semantics across calls: mutations the callee performed
    // on containers (innerState.mutations — each a REAL source-level
    // write) must be visible to the caller: replace old→next in the
    // caller's containers AND top-level bindings.

    // Param-final replay: mutation pairs carry the RAW structural write
    // (e.g. splice's rebuilt array) WITHOUT the enclosing branch guard —
    // path guards only land on the callee frame's FINAL param binding via
    // mergeBranch. Replay that final value (guards intact) FIRST so the
    // caller's containers are updated with the guarded value under the
    // original arg identity; the pair pass below then only covers
    // non-param mutations (nested objects), and its raw replacements can
    // no longer shadow this one.
    for (let pi = 0; pi < fn.parameters.length; pi++) {
      const prm = fn.parameters[pi]!;
      if (!ts.isIdentifier(prm.name)) continue;
      const arg = args[pi];
      const fin = inner.vars.get(prm.name.text);
      if (!arg || !fin || arg === fin) continue;
      if (arg.kind !== "obj" && arg.kind !== "arr") continue;
      if (fin.kind !== "obj" && fin.kind !== "arr") continue;
      // top-level home bindings holding the ORIGINAL arg identity
      for (const [vn, vv] of home.vars) if (vv === arg) home.vars.set(vn, fin);
      replaceAliasInFrame(home, arg, fin);
      // chain-compose: an outer caller may still hold a pair whose .old is
      // the original arg — its .next must now be the guarded final value
      for (const mut of st.mutations ?? []) {
        if (mut.old === arg) mut.next = fin;
      }
      st.mutations!.push({ old: arg, next: fin });
    }
    // Raw pair replay (unguarded structural writes — see pathCond note):
    // covers NON-param container mutations (nested objects the caller
    // holds by alias but never passed as an argument).
    for (const mut of innerState.mutations ?? []) {
      for (const [vn, vv] of home.vars) if (vv === mut.old) home.vars.set(vn, mut.next);
      replaceAliasInFrame(home, mut.old, mut.next);
      // compose with earlier pairs pointing at this old (chained writes)
      for (const mut0 of st.mutations ?? []) {
        if (mut0.next === mut.old) mut0.next = mut.next;
      }
      st.mutations!.push(mut);
    }
    // degradations shared
    if (innerState.thrown) st.thrown = orFold(st.thrown ?? bool(ctx, false), innerState.thrown) ?? null;
    // fold conditional returns (pendingRets) LIFO over the unconditional ret
    let out = innerState.ret;
    for (let i = innerState.pendingRets.length - 1; i >= 0; i--) {
      const pr = innerState.pendingRets[i]!;
      out = out === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, out);
    }
    return out ?? { kind: "undef" };
    } finally {
      if (defInfo) moduleStack.pop();
    }
  };


  const callMethod = (
    recv: SymVal, m: string, args: SymVal[],
    at: ts.CallExpression, st: RunState, frame: Frame, depth: number,
  ): SymVal => {
      // Map-entry array aliasing: `const l = m.get(k); l.push(...)` must be
      // visible through the map (JS shares the array object). mapSetOp "get"
      // records the entries the fan could match with their key-match guards;
      // a push writes the rebuilt array back into each entry under the same
      // guard (entry objects are shared by reference, so this is visible
      // through every alias of the map).
      const writeArrayAlias = (recvAlias: SymVal, next: SymVal, retv: SymVal): SymVal => {
        const aelist = isArr(recvAlias) ? recvAlias.aliasEntries : undefined;
        if (!aelist || aelist.length === 0) return retv;
        for (const ae of aelist) {
          const cur = ae.entry.fields.get("value");
          ae.entry.fields.set("value", iteVal(ae.match, next, cur ?? { kind: "undef" }));
        }
        return retv;
      };
      // named function references as callbacks (filter(isSuspectedEvent)):
    // resolve Identifier -> fn SymVal (frame binding or module fn decl)
    const cbNode = (cb: ts.Expression | undefined): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | null => {
      if (!cb) return null;
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) return cb;
      if (ts.isIdentifier(cb)) {
        const fv = frame.vars.get(cb.text);
        if (fv && fv.kind === "fn") return fv.node;
        const mi2 = curInfo();
        const md = mi2.functions.get(cb.text) ?? info.functions.get(cb.text);
        if (md && md.body) return md;
      }
      return null;
    };
    const callCb = (cb: ts.Expression | undefined, args: SymVal[]): SymVal | null => {
      const node = cbNode(cb);
      if (!node) return null;
      return invokeCallback(node, args, st, depth);
    };
    // ---- namespace objects ----
    if (isObj(recv) && m === "call" ) { degrade(st, at, "fn.call"); return { kind: "any" }; }

    // Anchored dynamic regex over-approximation: a pattern "^A…" with a
    // known literal head A only matches strings starting with A. On the
    // ¬startsWith side .test is exactly false and .replace is the identity;
    // on the reachable side the result is an unconstrained uninterpreted
    // value (recorded as a degradation only when the guard can hold —
    // replay validates any witness from that side on the real regex).
    /** Compile a CONCRETE JS regex source to an SMT Re term. Faithful for
     * the subset our guarded files use: literals, \\xNN/\\u{..} escapes, .,
     * \\s/\\S/\\d/\\w/\\D/\\W, [...] classes (negated via re.diff re.allchar),
     * groups (?:…)/(…), top-level and nested alternation, * + ? (lazy
     * quantifiers treated as greedy — strip-to-"" decisions are unaffected
     * in our shapes; documented approximation). Returns null when the
     * pattern leaves the subset (caller falls back to the anchor approx). */
    const wsCharClass = (): Term => {
      // JS \s core (space \t \n \r \f \v — the \u00a0-class extras are a
      // documented approximation; our ws-only texts come from the domain).
      const chars = [" ", "\t", "\n", "\r", "\f", "\v"];
      return chars.map((ch) => ctx.app1("str.to_re", ctx.String.val(ch), "RegLan") as Term)
        .reduce((a, b) => ctx.app2("re.union", a, b, "RegLan") as Term);
    };
    const regexToRe = (pat: string): Term | null => {
      const reAllChar = ctx.intern("re.allchar", "Bool", []);
      let i = 0;
      const peek = (): string => pat[i] ?? "";
      const eat = (): string => pat[i++] ?? "";
      const unionOf = (ts: Term[]): Term => ts.reduce((a, b) => ctx.app2("re.union", a, b, "RegLan") as Term);
      const concatOf = (ts: Term[]): Term => ts.length === 0
        ? ctx.app1("str.to_re", ctx.String.val(""), "RegLan") as Term
        : ts.reduce((a, b) => ctx.app2("re.++", a, b, "RegLan") as Term);
      const classRe = (body: string, negate: boolean): Term | null => {
        const parts: Term[] = [];
        let j = 0;
        while (j < body.length) {
          let ch = body[j]!;
          let lit: string | null = null;
          if (ch === "\\") {
            const e = body[j + 1] ?? "";
            if (e === "s") { if (negate) return null; parts.push(wsCharClass()); j += 2; continue; }
            if (e === "S") { if (!negate) return null; parts.push(wsCharClass()); j += 2; continue; }
            if (e === "d") { parts.push(ctx.app2("re.range", ctx.String.val("0"), ctx.String.val("9"), "RegLan") as Term); j += 2; continue; }
            if (e === "w") { parts.push(unionOf([ctx.app2("re.range", ctx.String.val("a"), ctx.String.val("z"), "RegLan") as Term, ctx.app2("re.range", ctx.String.val("A"), ctx.String.val("Z"), "RegLan") as Term, ctx.app2("re.range", ctx.String.val("0"), ctx.String.val("9"), "RegLan") as Term, ctx.app1("str.to_re", ctx.String.val("_"), "RegLan") as Term])); j += 2; continue; }
            if (e === "x") { const h = body.slice(j + 2, j + 4); if (/^[0-9a-fA-F]{2}$/.test(h)) { lit = String.fromCharCode(parseInt(h, 16)); j += 4; } else return null; continue; }
            if (e === "u") return null; // \uXXXX inside class: rare in our files
            lit = e; j += 2;
          } else { lit = ch; j += 1; }
          if (lit === null) continue;
          // range a-z?
          if (body[j] === "-" && j + 1 < body.length && body[j + 1] !== "]") {
            let hi = body[j + 1]!;
            let step = 2;
            if (hi === "\\") { const e = body[j + 2] ?? ""; if (e === "x") { const h = body.slice(j + 3, j + 5); if (/^[0-9a-fA-F]{2}$/.test(h)) { hi = String.fromCharCode(parseInt(h, 16)); step = 4; } else return null; } else { hi = e; step = 3; } }
            if (lit > hi) return null;
            parts.push(ctx.app2("re.range", ctx.String.val(lit), ctx.String.val(hi), "RegLan") as Term);
            j += step;
          } else {
            parts.push(ctx.app1("str.to_re", ctx.String.val(lit), "RegLan") as Term);
          }
        }
        if (parts.length === 0) return null;
        const u = unionOf(parts);
        return negate ? ctx.app2("re.diff", reAllChar, u, "RegLan") as Term : u;
      };
      const parseAlt = (): Term | null => {
        const seqs: Term[] = [];
        let cur = parseSeq();
        if (cur === null) return null;
        seqs.push(cur);
        while (peek() === "|") { eat(); cur = parseSeq(); if (cur === null) return null; seqs.push(cur); }
        return seqs.length === 1 ? seqs[0]! : unionOf(seqs);
      };
      const parseSeq = (): Term | null => {
        const atoms: Term[] = [];
        let run = ""; // consecutive literal chars → one to_re
        const flush = (): void => { if (run) { atoms.push(ctx.app1("str.to_re", ctx.String.val(run), "RegLan") as Term); run = ""; } };
        while (peek() !== "" && peek() !== "|" && peek() !== ")") {
          const c = peek();
          if (c === "(") {
            eat();
            if (peek() === "?") { eat(); if (peek() === ":") eat(); else return null; }
            const inner = parseAlt();
            if (inner === null) return null;
            if (eat() !== ")") return null;
            flush(); atoms.push(postfix(inner));
          } else if (c === "[") {
            eat();
            const negate = peek() === "^" ? (eat(), true) : false;
            let body = "";
            while (peek() !== "]" && peek() !== "") body += eat();
            if (eat() !== "]") return null;
            const cre = classRe(body, negate);
            if (cre === null) return null;
            flush(); atoms.push(postfix(cre));
          } else if (c === ".") {
            eat(); flush();
            atoms.push(postfix(ctx.app2("re.diff", reAllChar, ctx.app1("str.to_re", ctx.String.val("\n"), "RegLan") as Term, "RegLan") as Term));
          } else if (c === "\\") {
            eat();
            const e = eat();
            if (e === "s" || e === "S") { flush(); atoms.push(postfix(wsCharClass())); }
            else if (e === "d") { flush(); atoms.push(postfix(ctx.app2("re.range", ctx.String.val("0"), ctx.String.val("9"), "RegLan") as Term)); }
            else if (e === "D" || e === "W" || e === "B" || e === "b") return null; // backrefs/boundaries: outside subset
            else if (e === "w") { flush(); atoms.push(postfix(unionOf([ctx.app2("re.range", ctx.String.val("a"), ctx.String.val("z"), "RegLan") as Term, ctx.app2("re.range", ctx.String.val("A"), ctx.String.val("Z"), "RegLan") as Term, ctx.app2("re.range", ctx.String.val("0"), ctx.String.val("9"), "RegLan") as Term, ctx.app1("str.to_re", ctx.String.val("_"), "RegLan") as Term]))); }
            else if (e === "x") { const h = pat.slice(i, i + 2); if (!/^[0-9a-fA-F]{2}$/.test(h)) return null; run += String.fromCharCode(parseInt(h, 16)); i += 2; }
            else if (e === "u") { const m = /^\{([0-9a-fA-F]{1,5})\}/.exec(pat.slice(i)); const m2 = /^([0-9a-fA-F]{4})/.exec(pat.slice(i)); if (m) { run += String.fromCodePoint(parseInt(m[1]!, 16)); i += m[0].length; } else if (m2) { run += String.fromCharCode(parseInt(m2[1]!, 16)); i += 4; } else return null; }
            else { run += e; } // \\ \/ \. \+ … literal
          } else {
            run += eat();
          }
        }
        flush();
        return concatOf(atoms);
      };
      const postfix = (base: Term): Term => {
        let t = base;
        for (;;) {
          const q = peek();
          if (q === "*") { eat(); t = ctx.app1("re.*", t, "RegLan") as Term; if (peek() === "?") eat(); }
          else if (q === "+") { eat(); t = ctx.app1("re.+", t, "RegLan") as Term; if (peek() === "?") eat(); }
          else if (q === "?") { eat(); t = ctx.app1("re.opt", t, "RegLan") as Term; if (peek() === "?") eat(); }
          else if (q === "{") {
            // {m}, {m,}, {m,n}: bounded repetition via m-fold concat
            const m = /^\{\d+(,\d*)?\}/.exec(pat.slice(i));
            if (!m) return t; // literal '{' falls through to the seq scanner
            i += m[0].length;
            const n0 = parseInt(/^\{\d+/.exec(m[0])![0].slice(1), 10);
            const unbounded = /,\}?$/.test(m[0]) && !/,\d+\}/.test(m[0]);
            const rep = concatOf(Array.from({ length: n0 }, () => t));
            t = unbounded ? ctx.app2("re.++", rep, ctx.app1("re.*", t, "RegLan") as Term, "RegLan") as Term : rep;
          } else return t;
        }
      };
      const out = parseAlt();
      if (out === null || i !== pat.length) return null;
      return out;
    };
    const regexAnchor = (patVal: SymVal): string | null => {
      if (!isStr(patVal)) return null;
      const pieces: string[] = [];
      const walk = (t: unknown): void => {
        const tt = t as { op?: string; kids?: unknown[]; c?: unknown; sort?: string };
        if (tt && typeof tt === "object" && Array.isArray(tt.kids)) {
          // concat shapes: app2("str.++", a, b) [facade] or op "str.++"/"concat" kids [a, b]
          const k0 = tt.kids[0] as { op?: unknown; c?: unknown } | undefined;
          const isConcat = tt.op === "concat" || tt.op === "str.++"
            || (tt.op === "app2" && (k0?.op === "str.++" || k0?.c === "str.++"));
          if (isConcat && (tt.kids.length === 2 || tt.kids.length === 3)) {
            for (const k of tt.kids.slice(tt.kids.length === 3 ? 1 : 0)) walk(k);
            return;
          }
        }
        if (tt && typeof tt === "object" && typeof tt.c === "string" && tt.sort === "String") {
          pieces.push(tt.c); return;
        }
        // symbolic piece (or non-const): stops accumulation — the anchor is
        // the const head collected so far (may be empty → null).
      };
      walk(patVal.t);
      if (pieces.length === 0) {
        const whole = strConst.get(patVal.t);
        if (whole === undefined) return null;
        pieces.push(whole);
      }
      if (!pieces[0]!.startsWith("^")) return null;
      const body = pieces.join("").slice(1);
      // Literal head: chars up to the first regex meta (backslash escapes
      // end the head too — their target is regex syntax, not plain text).
      const m = /^((?:\\.|[^[\](){}*+?|^$.\\])*)/.exec(body);
      const head = m?.[1] ?? "";
      return head === "" ? null : head;
    };
    const dynRegexTest = (recv: SymVal, patVal: SymVal, at: ts.Node, st: RunState): SymVal | null => {
      if (!isStr(recv)) return null;
      const anchor = regexAnchor(patVal);
      if (anchor === null || anchor === "") return null;
      const g = recv.t.prefixOf(ctx.String.val(anchor));
      const gb = constBool(g);
      if (gb === false) return { kind: "bool", t: bool(ctx, false) };
      const fresh = ctx.Bool.const(`__re_test_${reTestN++}`);
      if (gb !== true) degrade(st, at, "dynamic regex .test over-approx");
      return { kind: "bool", t: ctx.If(g, fresh, bool(ctx, false)) };
      
    };

    // ---- method ports: "__method_<name>" receives (recv, ...args) ----
    const mport = input.options?.portImpls ? input.options.portImpls["__method_" + m] : undefined;
    if (mport && (isObj(recv) || isArr(recv))) return (mport as (r: SymVal, ...a: SymVal[]) => SymVal)(recv, ...args);

    // ---- Math ----
    // (Math.x handled at plain-call sites in source; but method form via
    //  identifier "Math" reaches here only through plain calls.)

    // ---- array methods ----
    if (isArr(recv)) {
      switch (m) {
        case "length": return { kind: "num", t: recv.len };

        case "push": {
          const v = args[0];
          // `(cond ? a : b).push(x)` — a call on a TERNARY of identifiers.
          // JS mutates whichever array the condition selects; model BOTH
          // bindings with the push guarded by the leaf condition (a plain
          // evaluated receiver would be a merged array whose rebind target
          // does not exist — the write would be lost).
          if (ts.isPropertyAccessExpression(at.expression)) {
            let rootExpr: ts.Expression = at.expression.expression;
            while (ts.isParenthesizedExpression(rootExpr) || ts.isAsExpression(rootExpr) || ts.isNonNullExpression(rootExpr)) rootExpr = rootExpr.expression;
            if (ts.isConditionalExpression(rootExpr)) {
              const leaves: Array<{ cond: Bool<"main">; name: string }> = [];
              const collect = (e: ts.Expression, c: Bool<"main">): void => {
                let x: ts.Expression = e;
                while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
                if (ts.isConditionalExpression(x)) {
                  const xc = truthy(ctx, evalExpr(x.condition, frame, st, depth));
                  if (xc === null) return;
                  collect(x.whenTrue, andFold(c, xc) ?? bool(ctx, true));
                  collect(x.whenFalse, andFold(c, notFold(xc)) ?? bool(ctx, true));
                  return;
                }
                if (ts.isIdentifier(x)) leaves.push({ cond: c, name: x.text });
              };
              const rootC = truthy(ctx, evalExpr(rootExpr.condition, frame, st, depth));
              if (rootC !== null) {
                collect(rootExpr.whenTrue, rootC);
                collect(rootExpr.whenFalse, notFold(rootC));
                if (leaves.length > 0) {
                  for (const leaf of leaves) {
                    const cur = frame.vars.get(leaf.name);
                    if (isArr(cur) && cur.elems.length < N) {
                      const pushSlotLeaf = (e: SymVal, k: number): SymVal => {
                        const g = numEq(ctx, cur.len, num(ctx, k));
                        if (e.kind === "undef" || e.kind === "null") return guardedNeutral(g, v);
                        return iteVal(g, v, e);
                      };
                      const elems = cur.elems.map((e, k) => pushSlotLeaf(e, k));
                      elems.push(guardedNeutral(numEq(ctx, cur.len, num(ctx, cur.elems.length)), v));
                      const pushed: SymVal = { kind: "arr", elems, len: cur.len.add(num(ctx, 1)) };
                      frame.vars.set(leaf.name, iteVal(leaf.cond, pushed, cur));
                    }
                  }
                  return v;
                }
              }
            }
          }
          // append at the symbolic tail position (arrays built by push).
          // SLOT GUARDS: writing into an undef phantom-tail slot via plain
          // iteVal hits the undef-loses merge rule and drops the len==k
          // guard — the pushed value becomes unconditionally reachable (a
          // ghost push the solver can pick on paths where the push never
          // ran). guardedNeutral keeps the guard inside the slot value.
          const pushSlot = (e: SymVal, k: number, lenT: Num, arr: { elems: SymVal[] } | SymVal[]): SymVal => {
            const g = numEq(ctx, lenT, num(ctx, k));
            if (e.kind === "undef" || e.kind === "null") return guardedNeutral(g, v);
            return iteVal(g, v, e);
          };
          if (recv.elems.length < N) {
            const elems = recv.elems.map((e, k) => pushSlot(e, k, recv.len, recv.elems));
            elems.push(guardedNeutral(numEq(ctx, recv.len, num(ctx, recv.elems.length)), v));
            const newLen = recv.len.add(num(ctx, 1));
            return writeArrayAlias(recv, { kind: "arr", elems, len: newLen }, rebindArray(recv, { kind: "arr", elems, len: newLen }, at, st, frame));
          }
          // Bounded-slot wrap: the slot budget N is full (phantom tail slots
          // from ghost iterations may have consumed them), but the SYMBOLIC
          // length can still be far below N. A push at len == k must write
          // slot k — broadcasting the ite(len==k, v, e_k) write across ALL
          // slots (writing only the LAST slot dropped pushes whose len was
          // below N-1 entirely: real content vanished from the model —
          // buildView's row pushes died exactly there). We assume len ≤ N-1
          // before the push (post-push len ≤ N, the model's array bound).
          pushAsum(st, recv.len.le(num(ctx, N - 1)));
          const elems = recv.elems.map((e, k) => pushSlot(e, k, recv.len, recv.elems));
          const newLen = recv.len.add(num(ctx, 1));
          return writeArrayAlias(recv, { kind: "arr", elems, len: newLen }, rebindArray(recv, { kind: "arr", elems, len: newLen }, at, st, frame));
        }
        case "splice": {
          // `arr.splice(i, 1)` — reverse-iteration removal (dropWhitespace
          // drops items back-to-front). deleteCount must be the constant 1;
          // the INDEX may be symbolic (loop induction variable over a
          // symbolic length — every slot below i keeps old[j], every slot
          // at/above takes old[j+1] under len>j+1).
          const dv = args.length > 1 && args[1].kind === "num" ? numC((args[1] as { t: Num }).t) : undefined;
          if (args.length === 0 || args[0].kind !== "num" || dv !== 1) { degrade(st, at, "splice only modeled as (num, 1)"); return { kind: "any" }; }
          const iT = (args[0] as { t: Num }).t;
          if (recv.elems.length === 0) return recv;
          const M = recv.elems.length - 1;
          const elems: SymVal[] = [];
          for (let j = 0; j < M; j++) {
            elems.push(iteVal(iT.gt(num(ctx, j)), recv.elems[j]!, iteVal(recv.len.gt(num(ctx, j + 1)), recv.elems[j + 1]!, { kind: "undef" })));
          }
          const newLen = ctx.If(recv.len.gt(iT), recv.len.sub(num(ctx, 1)), recv.len);
          const removed: SymVal = { kind: "arr", elems: [guardedNeutral(recv.len.gt(iT), recv.elems[0] ?? { kind: "undef" })], len: ctx.If(recv.len.gt(iT), num(ctx, 1), num(ctx, 0)) };
          const shrunk: SymVal = { kind: "arr", elems, len: newLen };
          writeArrayAlias(recv, shrunk, rebindArray(recv, shrunk, at, st, frame));
          return removed;
        }
        case "includes": {
          const target = args[0];
          const eqs = recv.elems.map((e) => valEq(e, target));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc = bool(ctx, false);
          for (let k = 0; k < recv.elems.length; k++) {
            acc = acc.or(recv.len.gt(num(ctx, k)).and(eqs[k]!));
          }
          return { kind: "bool", t: acc };
        }
        case "indexOf": {
          const target = args[0];
          const eqs = recv.elems.map((e) => valEq(e, target));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc: Num = num(ctx, -1);
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            acc = ctx.If(recv.len.gt(num(ctx, k)).and(eqs[k]!), num(ctx, k), acc);
          }
          return { kind: "num", t: acc };
        }
        case "map": {
          const cb = at.arguments[0];
          if (!cbNode(cb)) { degrade(st, at, "map without function literal"); return { kind: "any" }; }
          const elems = recv.elems.map((e, k) => {
            const guarded = iteVal(recv.len.gt(num(ctx, k)), e, { kind: "undef" });
            const r = invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
            return r;
          });
          return { kind: "arr", elems, len: recv.len };
        }
        case "filter": {
          const cb = at.arguments[0];
          if (!cbNode(cb)) { degrade(st, at, "filter without function literal"); return { kind: "any" }; }
          // Unrolled two-pass: keep-slot[j] via counting.
          const keep: Bool<"main">[] = recv.elems.map((e, k) => {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, e, { kind: "undef" });
            const r = invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
            const t = truthy(ctx, r);
            if (!t) return g.not(); // out-of-length slots never keep
            return g.and(t);
          });
          const outElems: SymVal[] = [];
          for (let j = 0; j < recv.elems.length; j++) {
            // j-th kept element = elems[k] where keep[k] and exactly j keeps before k
            let pick: SymVal = { kind: "undef" };
            for (let k = recv.elems.length - 1; k >= 0; k--) {
              const before = countTrueBelow(keep, k);
              const cond = keep[k]!.and(before.eq(num(ctx, j)));
              pick = iteVal(cond, recv.elems[k], pick);
            }
            outElems.push(pick);
          }
          const newLen = keep.reduce((acc, kk) => ctx.If(kk, acc.add(num(ctx, 1)), acc), num(ctx, 0));
          return { kind: "arr", elems: outElems, len: newLen };
        }
        case "every":
        case "some": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, `${m} without function literal`); return { kind: "any" }; }
          let acc = bool(ctx, m === "every");
          for (let k = 0; k < recv.elems.length; k++) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, `${m} callback degraded`); return { kind: "any" }; }
            const effective = g.and(r);
            acc = m === "every" ? acc.and(effective) : acc.or(effective);
          }
          return { kind: "bool", t: acc };
        }
        case "entries": {
          // array iterator of [index, value] pairs, bounded to declared slots
          const pairs = recv.elems.map((e, k) => ({ kind: "arr", elems: [{ kind: "num", t: num(ctx, k) }, e], len: num(ctx, 2) }) as SymVal);
          return { kind: "arr", elems: pairs, len: recv.len };
        }
        case "find": {
          const cb = at.arguments[0];
          if (!cbNode(cb)) { degrade(st, at, "find without function literal"); return { kind: "any" }; }
          let acc: SymVal = { kind: "undef" };
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, "find callback degraded"); return { kind: "any" }; }
            acc = iteVal(g.and(r), recv.elems[k], acc);
          }
          return acc;
        }
        case "findIndex": {
          const cb = at.arguments[0];
          if (!cbNode(cb)) { degrade(st, at, "findIndex without function literal"); return { kind: "any" }; }
          let acc: Num = num(ctx, -1);
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, "findIndex callback degraded"); return { kind: "any" }; }
            acc = ctx.If(g.and(r), num(ctx, k), acc);
          }
          return { kind: "num", t: acc };
        }
        case "sort": {
          // Rank-based comparator sort, works for any slot count N (O(N²) comparator calls,
          // no permutation enumeration). rank_i = #{j real: cmp(v_i,v_j)<0} + #{j<i real: cmp==0}
          // (stable). Output slot k takes the element whose rank is k. Elements at
          // positions ≥ len are not "real" and keep rank undefined (slot falls through to undef).
          const cb = at.arguments[0];
          const n = recv.elems.length;
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) || !args[0] || args[0].kind !== "fn") {
            degrade(st, at, `sort (n=${n})`);
            return { kind: "any" };
          }
          const cbFn = args[0] as { kind: "fn"; node: ts.ArrowFunction; env: Frame };
          const real = (i: number): Bool<"main"> => recv.len.gt(num(ctx, i)); // i < len
          const ranks: Num[] = [];
          for (let i = 0; i < n; i++) {
            let rank = num(ctx, 0);
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              const realJ = real(j);
              if (recv.elems[i] === recv.elems[j]) {
                // identical values: comparator returns 0 (deterministic) — tie
                rank = rank.add(ctx.If(realJ.and(bool(ctx, j < i)), num(ctx, 1), num(ctx, 0)) as Num);
                continue;
              }
              const r = invokeCallback(cbFn.node, [recv.elems[i]!, recv.elems[j]!], st, depth, cbFn.env);
              if (!isNum(r)) { degrade(st, at, "sort comparator non-numeric"); return { kind: "any" }; }
              const less = r.t.lt(num(ctx, 0)).and(realJ);
              const tie = r.t.eq(num(ctx, 0)).and(realJ).and(bool(ctx, j < i));
              rank = rank.add(ctx.If(less.or(tie), num(ctx, 1), num(ctx, 0)) as Num);
            }
            ranks.push(rank);
          }
          const elems: SymVal[] = [];
          for (let k = 0; k < n; k++) {
            let slot: SymVal = { kind: "undef" };
            for (let i = 0; i < n; i++) {
              const hit = numEq(ctx, ranks[i]!, num(ctx, k)).and(real(i));
              slot = iteVal(hit, recv.elems[i]!, slot);
            }
            elems.push(slot);
          }
          return { kind: "arr", elems, len: recv.len };
        }
        case "forEach": {
          const cb = at.arguments[0];
          if (!cbNode(cb)) { degrade(st, at, "forEach without function literal"); return { kind: "any" }; }
          for (let k = 0; k < recv.elems.length; k++) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            invokeCallback(cbNode(cb)!, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
          }
          return { kind: "undef" };
        }
        case "slice": {
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const rawEnd = isNum(args[1]) ? args[1].t : recv.len;
          const start = ctx.If(a0.lt(num(ctx, 0)), ctx.If(a0.add(recv.len).ge(num(ctx, 0)), a0.add(recv.len), num(ctx, 0)), a0);
          const end = ctx.If(rawEnd.lt(num(ctx, 0)), ctx.If(rawEnd.add(recv.len).ge(num(ctx, 0)), rawEnd.add(recv.len), num(ctx, 0)), rawEnd);
          const elems: SymVal[] = [];
          for (let j = 0; j < recv.elems.length; j++) {
            const srcIdx = start.add(num(ctx, j));
            let pick: SymVal = { kind: "undef" };
            for (let k = recv.elems.length - 1; k >= 0; k--) {
              pick = iteVal(numEq(ctx, srcIdx, num(ctx, k)).and(end.gt(num(ctx, j))), recv.elems[k], pick);
            }
            elems.push(pick);
          }
          const len = end.sub(start);
          return { kind: "arr", elems, len: ctx.If(len.lt(num(ctx, 0)), num(ctx, 0), len) };
        }
        case "concat": {
          const other = args.find(isArr);
          const elems = [...recv.elems];
          if (other) {
            for (let k = 0; k < other.elems.length; k++) {
              elems.push(iteVal(other.len.gt(num(ctx, k)), other.elems[k], { kind: "undef" }));
            }
          }
          return { kind: "arr", elems, len: other ? recv.len.add(other.len) : recv.len };
        }
        case "join": {
          // Only when every element is a concrete/str; else degrade.
          // part[k] = elems[k] + (sep when more in-bounds elements follow).
          const sepS = strArgOrEmpty(args[0]);
          const parts: SymVal[] = [];
          for (let k = 0; k < recv.elems.length; k++) {
            const ek = recv.elems[k]!;
            const withSep: SymVal = isStr(ek) ? { kind: "str", t: ek.t.concat(sepS) } : ek;
            parts.push(iteVal(recv.len.gt(num(ctx, k + 1)), withSep, ek));
          }
          if (parts.some((p) => !isStr(p))) { degrade(st, at, "join with degraded parts"); return { kind: "any" }; }
          return parts.reduce<SymVal>((a, b) => (isStr(a) && isStr(b) ? { kind: "str" as const, t: a.t.concat(b.t) } : { kind: "any" as const }), { kind: "str" as const, t: ctx.String.val("") });
        }
        default:
          degrade(st, at, `array method .${m}`);
          return { kind: "any" };
      }
    }

    // ---- string methods ----
    if (isStr(recv)) {
      switch (m) {
        case "length": return { kind: "num", t: lenR(recv.t) };
        case "includes": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.includes(ac)) };
          return { kind: "bool", t: recv.t.contains(a0) };
        }
        case "startsWith": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.startsWith(ac)) };
          return { kind: "bool", t: recv.t.prefixOf(a0) };
        }
        case "endsWith": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.endsWith(ac)) };
          return { kind: "bool", t: recv.t.suffixOf(a0) };
        }
        case "indexOf": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "num", t: num(ctx, rc.indexOf(ac)) };
          return { kind: "num", t: recv.t.indexOf(a0) };
        }
        case "slice":
        case "substring": {
          // known string + full-range slice is the identity (keeps JSON.parse
          // of `raw.slice(raw.indexOf("{"))` concrete)
          const rcFold = strConst.get(recv.t);
          if (rcFold !== undefined && args.length === 1 && isNum(args[0])) {
            const s0 = numC(args[0].t);
            if (s0 === 0) return recv;
            if (s0 !== undefined && s0 > 0) return { kind: "str", t: ctx.String.val(rcFold.slice(s0)) };
          }
          // two concrete args (or none): JS slice folded exactly — the
          // module-init permutation loops slice(0, pos)/slice(pos) over
          // literal strings and downstream split("").map() needs the constant.
          if (rcFold !== undefined) {
            const s2 = args.length >= 1 && isNum(args[0]) ? numC(args[0].t) : 0;
            const e2 = args.length >= 2 && isNum(args[1]) ? numC(args[1].t) : undefined;
            if (s2 !== undefined && (args.length < 2 || isNum(args[1]))) {
              const cut = ctx.String.val(rcFold.slice(s2, e2));
              return { kind: "str", t: cut };
            }
          }
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const rawEnd = isNum(args[1]) ? args[1].t : lenR(recv.t);
          const start = ctx.If(a0.lt(num(ctx, 0)), ctx.If(a0.add(lenR(recv.t)).ge(num(ctx, 0)), a0.add(lenR(recv.t)), num(ctx, 0)), a0);
          const end = ctx.If(rawEnd.lt(num(ctx, 0)), ctx.If(rawEnd.add(lenR(recv.t)).ge(num(ctx, 0)), rawEnd.add(lenR(recv.t)), num(ctx, 0)), rawEnd);
          const len = ctx.If(end.sub(start).ge(num(ctx, 0)), end.sub(start), num(ctx, 0));
          // seq.extract is Int-indexed; our numbers are Real.
          pushAsum(st, ctx.IsInt(start)); pushAsum(st, ctx.IsInt(len));
          return { kind: "str", t: recv.t.extract(ctx.ToInt(start), ctx.ToInt(len)) };
        }
        case "charCodeAt": {
          const a0 = isNum(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          pushAsum(st, ctx.IsInt(a0));
          return { kind: "num", t: ctx.ToReal(recv.t.at(ctx.ToInt(a0)).toCode() as never) as Num }; // toCode is Int-sorted; numbers are Real
        }
        case "at": {
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const idx = ctx.If(a0.lt(num(ctx, 0)), a0.add(lenR(recv.t)), a0);
          return { kind: "str", t: recv.t.at(ctx.ToInt(idx)) };
        }
        case "trim": {
          // Exact on the decision our guarded files make with trim: whether
          // the result is EMPTY. trim(s) == "" ⟺ s ∈ ws*; for non-ws strings
          // the value is returned unchanged (identity approximation —
          // stripRenderTags(text).trim() === "" is the only consumer).
          const wsStar = ctx.app1("re.*", wsCharClass(), "RegLan") as Term;
          const inWs = ctx.app2("str.in_re", recv.t, wsStar, "Bool") as Bool<"main">;
          return iteVal(inWs, { kind: "str", t: ctx.String.val("") }, recv);
        }
        case "toLowerCase": return recv; // approximation: same, see README
        case "toUpperCase": {
          // Concrete fold only: the ci() helper builds `[${ch}${ch.toUpperCase()}]`
          // over literal chars — ASCII case map is exact there.
          const c = strConst.get(recv.t);
          if (c !== undefined && /^[ -~]*$/.test(c)) return { kind: "str", t: ctx.String.val(c.toUpperCase()) };
          return recv;
        }
        case "charAt": {
          const c = strConst.get(recv.t);
          const i0 = isNum(args[0]) ? numC(args[0].t) : undefined;
          if (c !== undefined && i0 !== undefined && Number.isInteger(i0) && i0 >= 0 && i0 < c.length) {
            return { kind: "str", t: ctx.String.val(c[i0]!) };
          }
          return { kind: "any" };
        }
        case "replace": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          const a1 = isStr(args[1]) ? args[1].t : null;
          if (a0 && a1) return { kind: "str", t: recv.t.replace(a0, a1) };
          // Const string × const regex-literal × const replacement: the
          // operation is a pure deterministic string function — evaluate it
          // concretely (e.g. escapeRegex(TAG_OPEN)).
          const rxC = isObj(args[0]) && args[0].fields.has("__regex") ? strConst.get((args[0].fields.get("__regex")! as { kind: "str"; t: Str }).t) : undefined;
          const repC = isStr(args[1]) ? strConst.get(args[1].t) : undefined;
          const recvC = strConst.get(recv.t);
          if (rxC !== undefined && repC !== undefined && recvC !== undefined) {
            const m = /^\/(.*)\/([a-z]*)$/.exec(rxC);
            if (m) return { kind: "str", t: ctx.String.val(recvC.replace(new RegExp(m[1]!, m[2]), repC)) };
          }
          // Symbolic receiver × regex object: compile the pattern to an SMT
          // Re term and strip ALL occurrences (str.replace_re_all is exactly
          // JS /g replace for leftmost-non-overlapping matches). Faithful
          // for the compiled subset (see regexToRe) — this is the real
          // stripRenderTags path.
          if (rxC !== undefined && repC === "" && isStr(recv)) {
            const m = /^\/(.*)\/([a-z]*)$/.exec(rxC);
            const patStr = m ? m[1]! : rxC;
            const reT = regexToRe(patStr);
            if (reT !== null) {
              return { kind: "str", t: ctx.app3("str.replace_re_all", recv.t, reT, ctx.String.val(""), "String") as Str };
            }
          }
          // Symbolic receiver against the escapeRegex shape (\. specials →
          // "\\$&"): deterministic uninterpreted function of the input.
          if (rxC === "/[.*+?^${}()|[\\]\\\\]/g" && repC === "\\$&" && isStr(recv)) {
            // deterministic uninterpreted escape: same input → same output
            (ctx as unknown as { pendingFnsS1: Set<string> }).pendingFnsS1.add("__esc1");
            return { kind: "str", t: (ctx as unknown as { app1: (f: string, a: never, s: string) => Str }).app1("__esc1", recv.t as never, "String") };
          }
          // dynamic-regex pattern with "" replacement (the render-refs
          // idempotency strip): anchored-prefix over-approximation.
          if (isObj(args[0]) && args[0].fields.has("__regex") && isStr(args[1]) && strConst.get(args[1].t) === "") {
            const patVal = args[0].fields.get("__regex")!;
            const anchor = regexAnchor(patVal);
            if (anchor !== null && anchor !== "" && isStr(recv)) {
              const g = recv.t.prefixOf(ctx.String.val(anchor));
              const gb = constBool(g);
              if (gb === false) return recv;
              // Deterministic FUNCTION of (input, anchor): a per-call-site
              // free const lets the same strip return different values in
              // turn A vs turn B — manufacturing phantom cross-turn flips.
              (ctx as unknown as { pendingFnsS2: Set<string> }).pendingFnsS2.add("__re_rep2");
              const fn = (ctx as unknown as { app2: (f: string, a: never, b: never, s: string) => Str }).app2("__re_rep2", recv.t as never, ctx.String.val(anchor) as never, "String");
              if (gb !== true) degrade(st, at, "dynamic regex .replace over-approx");
              return iteVal(g, { kind: "str", t: fn }, recv);
            }
          }
          return { kind: "any" };
        }
        case "padStart": {
          // Implemented exactly when the string is a decimal digit string
          // (the ref-tag use). General int→str is a documented gap.
          const w = isNum(args[0]) ? args[0].t : null;
          const pad = isStr(args[1]) ? args[1].t : null;
          if (!w || !pad) return { kind: "any" };
          // len < w ? pad*(w-len) ++ s : s   — construct via extract of pad^N
          let padded = recv.t;
          const reps: Str[] = [];
          for (let i = 0; i < 24; i++) reps.push(pad.power(num(ctx, i + 1)));
          // choose the rep whose length equals w - len
          let chosen: Str | null = null;
          for (const rp of reps) {
            const cond = lenR(rp).eq(w.sub(lenR(recv.t)));
            chosen = chosen ? ctx.If(cond, rp, chosen) : rp;
          }
          const need = w.sub(lenR(recv.t)).gt(num(ctx, 0));
          return { kind: "str", t: ctx.If(need, chosen!.concat(recv.t), recv.t) };
        }
        case "split": {
          // Concrete fast-path: str.split("") → the array of single chars
          // (module-init char permutation loops use exactly this). Symbolic
          // split stays unsupported (string theory has no split).
          const sepC = isStr(args[0]) ? strConst.get(args[0].t) : undefined;
          const recvC2 = strConst.get(recv.t);
          if (recvC2 !== undefined && sepC === "") {
            const chars = [...recvC2].map((ch) => ({ kind: "str" as const, t: ctx.String.val(ch) }));
            return { kind: "arr", elems: chars, len: num(ctx, chars.length) };
          }
          return { kind: "any" };
        }
        default:
          degrade(st, at, `string method .${m}`);
          return { kind: "any" };
      }
    }

    // ---- Number.prototype.toFixed: uninterpreted, deterministic per input ----
    if (isNum(recv) && m === "toFixed") {
      (ctx as unknown as { pendingFnsR1: Set<string> }).pendingFnsR1.add("__tofix1");
      return { kind: "str", t: (ctx as unknown as { app1: (f: string, a: never, s: string) => Str }).app1("__tofix1", recv.t as never, "String") };
    }

    // ---- dynamic regex carrier: .test(s) ----
    if (isObj(recv) && recv.fields.has("__regex") && m === "test") {
      const r = dynRegexTest(args[0] ?? { kind: "undef" }, recv.fields.get("__regex")!, at, st);
      if (r !== null) return r;
    }

    // ---- Map/Set methods ----
    if (isObj(recv) && (recv.fields.has("__map_entries") || recv.fields.has("__set_values"))) {
      const result = mapSetOp(recv, m, args, at, st);
      if ((m === "add" || m === "set" || m === "delete") && isObj(result) && ts.isPropertyAccessExpression(at.expression)) {
        const root = rootName(at.expression);
        if (root && frame.vars.has(root)) frame.vars.set(root, result);
      }
      return result;
    }

    degrade(st, at, `method .${m} on ${recv.kind}`);
    return { kind: "any" };
  };

  const strArgOrEmpty = (v: SymVal | undefined): Str =>
    v && isStr(v) ? v.t : ctx.String.val("");

  const countTrueBelow = (bs: Bool<"main">[], k: number): Num => {
    let acc = num(ctx, 0);
    for (let j = 0; j < k; j++) acc = ctx.If(bs[j]!, acc.add(num(ctx, 1)), acc);
    return acc;
  };

  const rebindArray = (oldArr: Extract<SymVal, { kind: "arr" }>, newArr: SymVal, at: ts.CallExpression, st: RunState, frame: Frame): SymVal => {
    // push() mutates in place. The receiver may be a NESTED property chain
    // (`pending.toolCalls.push(...)`): rebinding only the ROOT variable to
    // the new array CLOBBERS the root (replaces the obj with the arr!). We
    // must rebuild every container along the chain with its child replaced:
    // pending' = {…pending, toolCalls: newArr}.
    const chain: Array<ts.PropertyAccessExpression | ts.ElementAccessExpression> = [];
    let node: ts.Expression = at.expression;
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      chain.unshift(node);
      node = node.expression;
    }
    // The LAST chain element is the METHOD ACCESS itself (a.b.push → the
    // `push` hop). It is not a container link: without dropping it the
    // rebuild writes the new array under the field "push" and the real
    // receiver (`current.blocks`) keeps the stale array.
    if (chain.length > 0 && at.expression === chain[chain.length - 1] && ts.isPropertyAccessExpression(chain[chain.length - 1]!)) {
      chain.pop();
    }
    if (ts.isIdentifier(node)) {
      const root = node.text;
      let rebuilt: SymVal = newArr;
      for (let i = chain.length - 1; i >= 0; i--) {
        const hop = chain[i]!;
        const parentVal = evalExpr(hop.expression, frame, st, 0);
        if (parentVal.kind !== "obj") return newArr; // degrade silently: root rebind only
        const fields = new Map(parentVal.fields);
        if (!ts.isPropertyAccessExpression(hop)) return newArr; // element-middle chains: root rebind only
        fields.set(hop.name.text, rebuilt);
        rebuilt = { kind: "obj", fields, symFields: parentVal.symFields ? new Map(parentVal.symFields) : undefined } as Extract<SymVal, { kind: "obj" }>;
      }
      frame.vars.set(root, rebuilt);
      return rebuilt;
    }
    return newArr;
  };

  /** Invoke an arrow/function-literal argument (callback) concretely. */
  const invokeCallback = (
    cb: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    args: SymVal[],
    st: RunState,
    depth: number,
    env?: Frame,
    caller?: Frame,
  ): SymVal => {
    const inner: Frame = { vars: new Map((env ?? frame).vars) }; // lexical closure
    // bind parameters (earlier params visible to later default exprs)
    cb.parameters.forEach((prm, pi) => {
      const pv: SymVal | undefined = args[pi] ?? (prm.initializer ? evalExpr(prm.initializer, inner, innerState, depth + 1) : undefined);
      const pd: SymVal = pv === undefined ? { kind: "undef" } : pv;
      if (ts.isIdentifier(prm.name)) inner.vars.set(prm.name.text, pd);
      else if (ts.isArrayBindingPattern(prm.name)) prm.name.elements.forEach((el, j) => {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) return;
        inner.vars.set(el.name.text, elementAccess(pd, { kind: "num", t: num(ctx, j) }, el, st));
      });
    });
    const innerState = runState0();
    if (cb.body && ts.isBlock(cb.body)) execStmt(cb.body, inner, innerState, depth + 1);
    else if (cb.body) innerState.ret = evalExpr(cb.body, inner, innerState, depth + 1);
    const pushAll2 = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll2(st.assumptions, innerState.assumptions);
    // degradations shared
    if (innerState.thrown) st.thrown = orFold(st.thrown ?? bool(ctx, false), innerState.thrown) ?? null;
    // fold inner conditional returns (arrow bodies with early returns)
    let ret: SymVal | null = innerState.ret;
    for (let i = innerState.pendingRets.length - 1; i >= 0; i--) {
      const pr = innerState.pendingRets[i]!;
      ret = ret === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, ret);
    }
    // Shared-binding write-back: closures mutate captured vars (let cells).
    // Propagate changed values back to the DECLARING frame. Sound when the
    // call site's live frame is the declaration frame (top-level helper calls
    // like applyTo(...)); loop-body callbacks in the guarded subset never
    // write captured vars.
    // Write back to BOTH the declaring (closure) frame and the CALLING
    // frame. They are the same Map for top-level helper calls, but diverge
    // when the call happens inside a branch COPY: mergeBranch rebuilds
    // values from the copies, so a closure write that only landed in the
    // live declaring frame would be overwritten by the stale-copy merge
    // (the flush()-inside-if pattern lost every push this way).
    // caller = the frame the call site runs in (may be a branch COPY of the
    // declaring frame); without it, closure writes inside `if (...) flush()`
    // land only in the live frame and the branch merge resurrects stale state.
    const callerFrame = caller ?? frame;
    const targets = env && env.vars !== callerFrame.vars ? [env.vars, callerFrame.vars] : [env ? env.vars : callerFrame.vars];
    // Only keys the closure body actually MUTATED propagate (inner value
    // differs from the declaring frame's snapshot). Writing untouched
    // bindings would push the ENV's stale values into branch copies of the
    // caller — `...cc(m.id)` as a call ARGUMENT used to clobber
    // `current` (assigned in the caller's frame) with the top-level `null`
    // snapshot, degrading current.blocks.push to "method .push on undef".
    const envSnapshot: Frame["vars"] | null = env ? env.vars : null;
    for (const [k, v] of inner.vars) {
      // Read the PRE-CALL env value BEFORE any target write: when target0 IS
      // env.vars itself, its own set(k, v) would make later targets' skip
      // check see the updated map and skip the caller frame — the caller's
      // stale copy then wins the next merge and the closure's write is lost.
      const preEnv = envSnapshot !== null ? envSnapshot.get(k) : undefined;
      if (envSnapshot !== null && preEnv === v) continue; // untouched by the closure
      for (const tv of targets) {
        const old = tv.get(k);
        if (old === undefined || old === v) continue;
        const same =
          (isNum(old) && isNum(v) && old.t.hash() === v.t.hash()) ||
          (isStr(old) && isStr(v) && old.t.hash() === v.t.hash()) ||
          (isBool(old) && isBool(v) && old.t.hash() === v.t.hash()) ||
          (isArr(old) && isArr(v) && old.len.hash() === v.len.hash());
        if (!same) tv.set(k, v);
      }
    }
    return ret ?? { kind: "undef" };
  };

  /** Map/Set modeled as obj with special fields (bounded vector + len). */
  const mapSetOp = (recv: Extract<SymVal, { kind: "obj" }>, m: string, args: SymVal[], at: ts.Node, st: RunState): SymVal => {
    const entriesArr = recv.fields.get("__map_entries") ?? recv.fields.get("__set_values");
    if (!isArr(entriesArr)) return { kind: "any" };
    switch (m) {
      case "has": {
        const key = args[0];
        if (recv.fields.has("__map_entries") && isArr(entriesArr)) {
          // entries are {key, value} objs
          const eqs = entriesArr.elems.map((e) => (isObj(e) ? valEq(e.fields.get("key") ?? { kind: "any" }, key) : null));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc = bool(ctx, false);
          for (let k = 0; k < eqs.length; k++) {
            acc = acc.or(entriesArr.len.gt(num(ctx, k)).and(eqs[k]!));
          }
          return { kind: "bool", t: acc };
        }
        const eqs = entriesArr.elems.map((e) => valEq(e, args[0]));
        if (eqs.some((e) => e === null)) return { kind: "any" };
        let acc = bool(ctx, false);
        for (let k = 0; k < eqs.length; k++) {
          acc = acc.or(entriesArr.len.gt(num(ctx, k)).and(eqs[k]!));
        }
        return { kind: "bool", t: acc };
      }
      case "get": {
        const keyOf = (e: SymVal): SymVal => {
          if (!isObj(e)) return { kind: "undef" };
          const nu = e.nullUnder;
          if (!nu) return e.fields.get("key") ?? { kind: "undef" };
          return iteVal(nu.not(), e.fields.get("key") ?? { kind: "undef" }, { kind: "undef" });
        };
        const eqs = entriesArr.elems.map((e) => (isObj(e) ? valEq(keyOf(e), args[0]) : null));
        if (eqs.some((e) => e === null)) return { kind: "any" };
        // miss arm keeps an undefUnder tag (like the obj symFields fan):
        // `map.get(k) !== undefined` must stay symbolic when a guarded slot
        // may or may not match — a plain undef loses the tag through merges
        // and the lookup folds to "always found" (phantom reads).
        let acc: SymVal = { kind: "undef" };
        // JS reference semantics: a Map entry's array value can be mutated
        // through the alias `const l = m.get(k); l.push(...)`. Track every
        // entry the fan could have matched (with its key-match guard) so a
        // later push can write the new array back into each entry under
        // exactly the same guard.
        const aliasEntries: { entry: { fields: Map<string, SymVal> }; match: Bool<"main"> }[] = [];
        const accNull = (v: SymVal): Bool<"main"> | undefined => (v.kind === "arr" || v.kind === "obj")
          ? (v as { nullUnder?: Bool<"main"> }).nullUnder
          : (v.kind === "num" || v.kind === "str" || v.kind === "bool")
            ? (v as { undefUnder?: Bool<"main"> }).undefUnder
            : undefined;
        for (let k = eqs.length - 1; k >= 0; k--) {
          const slotVal = entriesArr.elems[k];
          const gotRaw: SymVal = isObj(slotVal) ? slotVal.fields.get("value") ?? { kind: "undef" } : { kind: "undef" };
          const got: SymVal = isObj(slotVal) && slotVal.nullUnder ? iteVal(slotVal.nullUnder.not(), gotRaw, { kind: "undef" }) : gotRaw;
          const live = entriesArr.len.gt(num(ctx, k)).and(eqs[k]!);
          if (isArr(got)) aliasEntries.push({ entry: { fields: (slotVal as { fields: Map<string, SymVal> }).fields }, match: live });
          // exact acc-chain nullness: result is nullish iff THIS slot did
          // not match AND the rest of the chain is nullish. mergeVal's
          // arr-arr path drops nullUnder (real arrays on other paths rely
          // on that), so compute it here: nullUnder = and(¬live, accNull).
          const gotNull = accNull(got), accN = accNull(acc);
          if ((gotNull !== undefined) || (accN !== undefined)) {
            const chainNull = andFold(live.not(), accN ?? bool(ctx, true)) ?? bool(ctx, true);
            // VALUE channel keeps BOTH arms: when the matching slot was
            // already consumed into acc (higher k processed first), the
            // bare `got` of the current slot is the WRONG object — the
            // post.get(i2)-returns-msg1 phantom (view-latch Q2).
            const mergedV = iteStrict(live, got, acc);
            acc = isArr(mergedV) && isArr(got)
              ? { kind: "arr", elems: (mergedV as { elems: SymVal[] }).elems, len: (mergedV as { len: Term }).len, nullUnder: chainNull }
              : isObj(mergedV) && isObj(got)
                ? { kind: "obj", fields: (mergedV as { fields: Map<string, SymVal> }).fields, nullUnder: chainNull, ...((mergedV as { symFields?: unknown }).symFields ? { symFields: (mergedV as { symFields: Map<Term, { g: Bool<"main">; v: SymVal }> }).symFields } : {}) }
                : (mergedV.kind === "num" || mergedV.kind === "str" || mergedV.kind === "bool")
                  ? { ...(mergedV as Extract<SymVal, { kind: "num" | "str" | "bool" }>), undefUnder: chainNull }
                  : mergedV;
          } else {
            acc = iteStrict(live, got, acc);
          }
        }
        if (isArr(acc) && aliasEntries.length > 0) {
          return { ...acc, aliasEntries };
        }
        return acc;
      }
      case "add":
      case "set": {
        const v = m === "set" && isObj(args[0]) === false
          ? { kind: "obj" as const, fields: new Map([["key", args[0]], ["value", args[1] ?? { kind: "undef" }]]) }
          : args[0];
        const entry = m === "set"
          ? { kind: "obj" as const, fields: new Map([["key", args[0]], ["value", args[1] ?? { kind: "undef" }]]) }
          : args[0];
        void v;
        const elems = entriesArr.elems.map((e, k) => {
          const exists = m === "set"
            ? isObj(e) ? (valEq(e.fields.get("key") ?? { kind: "any" }, args[0]) ?? bool(ctx, false)) : bool(ctx, false)
            : (valEq(e, args[0]) ?? bool(ctx, false));
          return iteVal(exists, entry, e);
        });
        // membership as a (possibly symbolic) predicate — a Term object is
        // always JS-truthy, so `elems.some(...)` could never work here.
        let anyEq = bool(ctx, false);
        for (let k = 0; k < entriesArr.elems.length; k++) {
          const e = entriesArr.elems[k]!;
          const eq = m === "set"
            ? (isObj(e) ? (valEq(e.fields.get("key") ?? { kind: "any" }, args[0]) ?? bool(ctx, false)) : bool(ctx, false))
            : (valEq(e, args[0]) ?? bool(ctx, false));
          anyEq = anyEq.or(entriesArr.len.gt(num(ctx, k)).and(eq));
        }
        // Slot-write at the SYMBOLIC length: a previously executed guarded
        // add may or may not have consumed its slot, so the physical tail
        // position is ambiguous. Writing the entry into slot `len` via per-
        // slot ITEs is correct in every model (a slot past the unchanged
        // length is never observed by length-guarded reads).
        const slotElems = entriesArr.elems.map((e, k) => iteVal(numEq(ctx, entriesArr.len, num(ctx, k)), entry, e));
        if (entriesArr.elems.length < N - 1) {
          // The phantom tail entry must keep its own guard: collapsing
          // ite(guard, entry, undef) via the undef-loses rule made the tail
          // entry look REAL in every model — later exists-checks and fan
          // reads matched keys from length epochs that never happened
          // (cross-epoch guards: solver picked branch-consistent-but-
          // unreachable keys). Tag with nullUnder instead: reads through
          // member()/truthy() are gated, exists-checks see undef -> false.
          const tailGuard = numEq(ctx, entriesArr.len, num(ctx, entriesArr.elems.length));
          if (isObj(entry)) slotElems.push({ kind: "obj", fields: entry.fields, nullUnder: notFold(tailGuard) });
          else slotElems.push(iteVal(tailGuard, entry, { kind: "undef" }));
        } else {
          degrade(st, at, "map/set add beyond bounded slots");
        }
        elems.length = 0;
        elems.push(...slotElems);
        const newLenV = iteVal(anyEq, { kind: "num", t: entriesArr.len }, { kind: "num", t: entriesArr.len.add(num(ctx, 1)) });
        const newLen: Num = newLenV.kind === "num" ? newLenV.t : entriesArr.len;
        const fields = new Map(recv.fields);
        fields.set(recv.fields.has("__map_entries") ? "__map_entries" : "__set_values", { kind: "arr", elems, len: newLen });
        return { kind: "obj", fields };
      }
      case "size": {
        return { kind: "num", t: entriesArr.len };
      }
      default:
        degrade(st, at, `map/set method .${m}`);
        return { kind: "any" };
    }
  };

  // new Map()/new Set()
  const evalNew = (call: ts.NewExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    const name = ts.isIdentifier(call.expression) ? call.expression.text : "";
    if (name === "Set") {
      // `new Set(iterable)` — seed the model from an array argument. Entries
      // are copied slot-for-slot with the argument's (possibly symbolic)
      // length; reads are len-guarded on the call side, so phantom slots
      // behind a shorter concrete length never surface.
      const a0 = call.arguments?.[0];
      const init = a0 ? evalExpr(a0, frame, st, depth) : undefined;
      if (init && isArr(init)) {
        return { kind: "obj", fields: new Map([["__set_values", { kind: "arr", elems: [...init.elems], len: init.len }]]) };
      }
      return { kind: "obj", fields: new Map([["__set_values", arrOf([])]]) };
    }
    if (name === "Map") {
      // `new Map(entries)` — seed from a [[k, v], ...] array argument.
      const a0 = call.arguments?.[0];
      const init = a0 ? evalExpr(a0, frame, st, depth) : undefined;
      if (init && isArr(init)) {
        const entries: SymVal[] = init.elems.map((p) => {
          if (!isArr(p) || p.elems.length < 2) return { kind: "obj", fields: new Map([["key", { kind: "undef" }], ["value", { kind: "undef" }]]) };
          return { kind: "obj", fields: new Map([["key", p.elems[0]!], ["value", p.elems[1]!]]) };
        });
        return { kind: "obj", fields: new Map([["__map_entries", { kind: "arr", elems: entries, len: init.len }]]) };
      }
      return { kind: "obj", fields: new Map([["__map_entries", arrOf([])]]) };
    }
    if (name === "RegExp") {
      // regex carried as an object; .test/.replace on it use the anchored-
      // prefix over-approximation at the call sites (see callMethod).
      const p0 = call.arguments?.[0];
      return { kind: "obj", fields: new Map([["__regex", p0 ? evalExpr(p0, frame, st, depth) : { kind: "str", t: ctx.String.val("") }]]) };
    }
    if (name === "Error" || name === "RangeError" || name === "TypeError") {
      return { kind: "obj", fields: new Map([["message", call.arguments?.[0] ? evalExpr(call.arguments[0], frame, st, depth) : { kind: "str", t: ctx.String.val("") }]]) };
    }
    // Constructor ports: environment-backed classes (crypto, counters) are
    // injectable exactly like function ports. Sound because ported outputs
    // are unconstrained symbolic values the property never depends on.
    const ctorPort = name && input.options?.portImpls ? input.options.portImpls[name] : undefined;
    if (ctorPort) {
      const args = (call.arguments ?? []).map((a) => evalExpr(a, frame, st, depth));
      return (ctorPort as (...a: SymVal[]) => SymVal)(...args);
    }
    degrade(st, call, `new ${name}`);
    return { kind: "any" };
  };

  const mathCall = (meth: string, args: SymVal[], at: ts.Node, st: RunState): SymVal => {
    const nums = args.map((a) => (isNum(a) ? a.t : null));
    if (nums.some((n) => n === null)) {
      if (meth === "min" || meth === "max") {
        // Math.min(x, y ?? inf) patterns: treat nulls as identity (skip)
        const present = nums.filter((n): n is Num => n !== null);
        if (present.length === 0) return { kind: "any" };
        return { kind: "num", t: present.reduce((a, b) => (meth === "min" ? minOf(a, b) : maxOf(a, b))) };
      }
      degrade(st, at, `Math.${meth} degraded arg`);
      return { kind: "any" };
    }
    const a = nums as Num[];
    switch (meth) {
      case "min": return { kind: "num", t: a.reduce((x, y) => minOf(x, y)) };
      case "max": return { kind: "num", t: a.reduce((x, y) => maxOf(x, y)) };
      case "abs": return { kind: "num", t: ctx.If(a[0].lt(num(ctx, 0)), a[0].neg(), a[0]) };
      case "round": {
        // JS Math.round = floor(x + 0.5); stays Real-sorted (numbers are Real)
        return { kind: "num", t: ctx.ToReal(ctx.ToInt(a[0].add(num(ctx, 0.5))) as never) as Num };
      }
      case "floor": return { kind: "num", t: ctx.ToReal(ctx.ToInt(a[0]) as never) as Num };
      case "ceil": {
        const f = ctx.ToReal(ctx.ToInt(a[0]) as never) as Num;
        return { kind: "num", t: ctx.If(f.eq(a[0]), f, f.add(num(ctx, 1))) };
      }
      case "trunc": {
        const tf = ctx.ToReal(ctx.ToInt(a[0]) as never) as Num;
        return { kind: "num", t: ctx.If(a[0].ge(num(ctx, 0)), tf, tf.add(num(ctx, 1))) };
      }
      default:
        degrade(st, at, `Math.${meth}`);
        return { kind: "any" };
    }
  };
  const minOf = (a: Num, b: Num): Num => ctx.If(a.le(b), a, b);
  const maxOf = (a: Num, b: Num): Num => ctx.If(a.ge(b), a, b);

  /* ---------------- run ---------------- */

  const frame: Frame = { vars: new Map(Object.entries(params)) };
  const st = runState0();
  // Bind declared entry params the caller did not pass: run their default
  // initializers (JS semantics — defaults may reference earlier params) or
  // bind undefined. Without this, later params are simply unbound.
  for (const p of decl.parameters) {
    if (!ts.isIdentifier(p.name)) continue;
    if (frame.vars.has(p.name.text)) continue;
    frame.vars.set(p.name.text, p.initializer ? evalExpr(p.initializer, frame, st, 0) : { kind: "undef" });
  }
  execStmt(decl.body!, frame, st, 0);
  let finalRet = st.ret;
  for (let i = st.pendingRets.length - 1; i >= 0; i--) {
    const pr = st.pendingRets[i]!;
    finalRet = finalRet === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, finalRet);
  }
  return {
    exec: () => ({
      ret: finalRet,
      thrown: st.thrown ? { kind: "bool", t: st.thrown } : null,
      assumptions: st.assumptions,
      degradations: st.degradations,
      ctx: input.ctx as import("./terms.js").Context,
    }),
  };
}
