// TS→z3 symbolic executor for the kernel decision core (#3848/#3853).
//
// Translates a REAL function body (parsed from source via the TypeScript
// compiler) into z3 constraints — the translator is a lens over real code,
// never a re-modeling of it. Control flow uses dynamic single assignment
// (DAW): each if merges its branches by conditioning values on the branch
// predicate (ITE chains), so path count stays linear in the number of ifs —
// no path enumeration.
//
// Soundness contract (honest limits, see README):
// - "No throw under φ" proofs are SOUND for loop-free bodies: every throw
//   site's condition is exactly the conjunction of the branch predicates on
//   its path.
// - Throw-reachability witnesses may be OVER-approximated (code after an
//   early return/throw gets a weaker condition than reality). That is why
//   every witness MUST be replayed through the real compiled function
//   (verif/replay.ts) before it counts — a non-reproducing witness means the
//   lens distorted, and the mismatch is exposed on the spot.
// - Anything outside the modeled shapes throws UnsupportedShape loudly.
//   Silent approximation is forbidden: an unmodeled shape is a stop-the-line
//   signal, not something to guess at.

import ts from "typescript";
import fs from "node:fs";
import { init } from "z3-solver";
import type { Arith, Bool, Context, Solver } from "z3-solver";

type Ctx = Context<"main">;
type SVal = Arith<"main">;
type SBool = Bool<"main">;

export class UnsupportedShape extends Error {
  constructor(readonly shape: string, readonly line: number) {
    super(`symbolic executor MVP does not model this shape: ${shape}${line > 0 ? ` (line ${line})` : ""}`);
  }
}

export interface ThrowSite {
  line: number;
  ctor: string;
  condition: SBool;
}

export interface SymexOptions {
  // Drift-control hook: pretend the source declared different constant
  // values. Used ONLY by tests to prove the replay lock catches a skewed lens.
  constantOverrides?: Record<string, number>;
}

const stripUnderscores = (t: string): string => t.replace(/_/g, "");

function collectModuleConstants(sf: ts.SourceFile): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const resolve = (n: ts.Expression): bigint | undefined => {
    if (ts.isNumericLiteral(n)) return BigInt(stripUnderscores(n.text));
    if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(n.operand)
    ) {
      return -BigInt(stripUnderscores(n.operand.text));
    }
    if (ts.isIdentifier(n) && out.has(n.text)) return out.get(n.text);
    return undefined;
  };
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const v = resolve(d.initializer);
      if (v !== undefined) out.set(d.name.text, v);
    }
  }
  return out;
}

function findFunctionDeclaration(root: ts.Node, name: string): ts.FunctionDeclaration | null {
  let found: ts.FunctionDeclaration | null = null;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(root);
  return found;
}

export class SymexFunction {
  constructor(
    public readonly file: string,
    public readonly name: string,
    public readonly paramNames: string[],
    public readonly constants: Map<string, bigint>,
    public readonly effectiveConstants: Map<string, bigint>,
    public readonly throwSites: ThrowSite[],
    public readonly returnCount: number,
    private readonly ctx: Ctx,
    private readonly paramSyms: Map<string, SVal>,
  ) {}

  anyThrow(): SBool {
    if (this.throwSites.length === 0) return this.ctx.Bool.val(false);
    return this.ctx.Or(...this.throwSites.map((t) => t.condition));
  }

  private applyBounds(s: Solver<"main">, bounds: Record<string, [number, number]>): void {
    for (const [p, [lo, hi]] of Object.entries(bounds)) {
      const sym = this.paramSyms.get(p);
      if (!sym) throw new Error(`unknown parameter '${p}' of ${this.name}`);
      s.add(sym.ge(lo), sym.le(hi));
    }
  }

  /** Prove: no throw reachable for any input satisfying bounds. */
  async noThrowUnder(bounds: Record<string, [number, number]> = {}): Promise<boolean> {
    const s = new this.ctx.Solver();
    this.applyBounds(s, bounds);
    s.add(this.anyThrow());
    return (await s.check()) === "unsat";
  }

  /** Find an input (within bounds) reaching some throw site, or null. */
  async throwWitness(bounds: Record<string, [number, number]> = {}): Promise<Record<string, number> | null> {
    const s = new this.ctx.Solver();
    this.applyBounds(s, bounds);
    s.add(this.anyThrow());
    if ((await s.check()) !== "sat") return null;
    const m = s.model();
    const out: Record<string, number> = {};
    for (const p of this.paramNames) {
      const sym = this.paramSyms.get(p);
      if (!sym) throw new Error(`unknown parameter '${p}' of ${this.name}`);
      out[p] = Number(String(m.get(sym)));
    }
    return out;
  }
}

export async function translateFunction(
  file: string,
  functionName: string,
  opts: SymexOptions = {},
): Promise<SymexFunction> {
  const z3mod = await init();
  const ctx = new z3mod.Context("main");
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const constants = collectModuleConstants(sf);
  const effectiveConstants = new Map(constants);
  for (const [k, v] of Object.entries(opts.constantOverrides ?? {})) {
    if (!constants.has(k)) throw new Error(`constantOverrides: '${k}' is not a module constant in ${file}`);
    effectiveConstants.set(k, BigInt(v));
  }

  const fnNode = findFunctionDeclaration(sf, functionName);
  if (!fnNode) throw new Error(`function '${functionName}' not found in ${file}`);

  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.pos).line + 1;
  const kindName = (n: ts.Node): string => ts.SyntaxKind[n.kind] ?? String(n.kind);

  const TRUE = ctx.Bool.val(true);
  const FALSE = ctx.Bool.val(false);

  // DAW environment: per variable, (value, condition) pairs, newest first.
  // Reading folds the pairs into an ITE chain; assigning prepends the new
  // value under the current path condition.
  const pairs = new Map<string, { v: SVal | SBool; c: SBool }[]>();

  const isSBool = (e: SVal | SBool): e is SBool =>
    (e as { __typename: string }).__typename === "Bool";

  const read = (name: string, line: number): SVal | SBool => {
    const ps = pairs.get(name);
    if (!ps) throw new UnsupportedShape(`unbound identifier '${name}'`, line);
    if (ps.some((p) => isSBool(p.v) !== isSBool(ps[0].v))) {
      throw new UnsupportedShape(`mixed-type variable '${name}'`, line);
    }
    if (isSBool(ps[0].v)) {
      let acc: SBool = ps[ps.length - 1].v as SBool;
      for (let i = ps.length - 1; i >= 0; i--) {
        acc = ctx.If(ps[i].c, ps[i].v as SBool, acc);
      }
      return acc;
    }
    let acc: SVal = ps[ps.length - 1].v as SVal;
    for (let i = ps.length - 1; i >= 0; i--) {
      acc = ctx.If(ps[i].c, ps[i].v as SVal, acc);
    }
    return acc;
  };

  const assign = (name: string, v: SVal | SBool, c: SBool): void => {
    const ps = pairs.get(name) ?? [];
    ps.unshift({ v, c });
    pairs.set(name, ps);
  };

  const paramNames: string[] = [];
  const paramSyms = new Map<string, SVal>();
  for (const p of fnNode.parameters) {
    if (!ts.isIdentifier(p.name)) throw new UnsupportedShape("non-identifier parameter", lineOf(p));
    paramNames.push(p.name.text);
    const sym = ctx.Int.const(`__p_${p.name.text}`);
    paramSyms.set(p.name.text, sym);
    pairs.set(p.name.text, [{ v: sym, c: TRUE }]);
  }
  for (const [k, v] of effectiveConstants) {
    pairs.set(k, [{ v: ctx.Int.val(v), c: TRUE }]);
  }

  const condStack: SBool[] = [];
  const curCond = (): SBool => (condStack.length === 0 ? TRUE : ctx.And(...condStack));

  const throwSites: ThrowSite[] = [];
  let returnCount = 0;

  const evalValue = (n: ts.Expression): SVal => {
    if (ts.isNumericLiteral(n)) return ctx.Int.val(BigInt(stripUnderscores(n.text)));
    if (ts.isPrefixUnaryExpression(n)) {
      if (n.operator === ts.SyntaxKind.MinusToken) return evalValue(n.operand).neg();
      throw new UnsupportedShape(kindName(n), lineOf(n));
    }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      const l = evalValue(n.left);
      const r = evalValue(n.right);
      if (k === ts.SyntaxKind.PlusToken) return l.add(r);
      if (k === ts.SyntaxKind.MinusToken) return l.sub(r);
      if (k === ts.SyntaxKind.AsteriskToken) return l.mul(r);
      throw new UnsupportedShape(`operator '${ts.SyntaxKind[k]}'`, lineOf(n));
    }
    if (ts.isConditionalExpression(n)) {
      return ctx.If(evalCond(n.condition), evalValue(n.whenTrue), evalValue(n.whenFalse));
    }
    if (ts.isIdentifier(n)) {
      const v = read(n.text, lineOf(n));
      if (isSBool(v)) throw new UnsupportedShape(`boolean '${n.text}' used arithmetically`, lineOf(n));
      return v;
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      const meth = n.expression.name.text;
      if (ts.isIdentifier(obj) && obj.text === "Math") {
        if (meth === "min" || meth === "max") {
          if (n.arguments.length === 0) throw new UnsupportedShape(`Math.${meth}()`, lineOf(n));
          let acc = evalValue(n.arguments[0]!);
          for (let i = 1; i < n.arguments.length; i++) {
            const a = evalValue(n.arguments[i]!);
            acc = meth === "min" ? ctx.If(acc.le(a), acc, a) : ctx.If(acc.ge(a), acc, a);
          }
          return acc;
        }
        if (meth === "round" || meth === "floor" || meth === "ceil") {
          // Integer domain: all three are the identity (documented modeling decision).
          return evalValue(n.arguments[0]!);
        }
      }
    }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
      return evalValue(n.expression);
    }
    if (ts.isNonNullExpression(n)) return evalValue(n.expression);
    throw new UnsupportedShape(kindName(n), lineOf(n));
  };

  const evalCond = (n: ts.Expression): SBool => {
    if (n.kind === ts.SyntaxKind.TrueKeyword) return TRUE;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return FALSE;
    if (ts.isPrefixUnaryExpression(n)) {
      if (n.operator === ts.SyntaxKind.ExclamationToken) return ctx.Not(evalCond(n.operand));
      throw new UnsupportedShape(kindName(n), lineOf(n));
    }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) return ctx.And(evalCond(n.left), evalCond(n.right));
      if (k === ts.SyntaxKind.BarBarToken) return ctx.Or(evalCond(n.left), evalCond(n.right));
      const l = evalValue(n.left);
      const r = evalValue(n.right);
      if (k === ts.SyntaxKind.LessThanToken) return l.lt(r);
      if (k === ts.SyntaxKind.LessThanEqualsToken) return l.le(r);
      if (k === ts.SyntaxKind.GreaterThanToken) return l.gt(r);
      if (k === ts.SyntaxKind.GreaterThanEqualsToken) return l.ge(r);
      if (k === ts.SyntaxKind.EqualsEqualsEqualsToken) return l.eq(r);
      if (k === ts.SyntaxKind.ExclamationEqualsEqualsToken) return ctx.Not(l.eq(r));
      throw new UnsupportedShape(`operator '${ts.SyntaxKind[k]}'`, lineOf(n));
    }
    if (ts.isConditionalExpression(n)) {
      return ctx.If(evalCond(n.condition), evalCond(n.whenTrue), evalCond(n.whenFalse));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      const meth = n.expression.name.text;
      // Integer domain: integrality is vacuous (documented modeling decision).
      if (ts.isIdentifier(obj) && obj.text === "Number" && meth === "isInteger") return TRUE;
    }
    // JS truthiness of a numeric value: x !== 0.
    const v = evalValue(n);
    return ctx.Not(v.eq(ctx.Int.val(0)));
  };

  const execStatement = (st: ts.Statement): void => {
    if (ts.isBlock(st)) {
      for (const s of st.statements) execStatement(s);
      return;
    }
    if (ts.isIfStatement(st)) {
      const c = evalCond(st.expression);
      condStack.push(c);
      execStatement(st.thenStatement);
      condStack.pop();
      if (st.elseStatement) {
        condStack.push(ctx.Not(c));
        execStatement(st.elseStatement);
        condStack.pop();
      }
      return;
    }
    if (ts.isThrowStatement(st)) {
      let ctor = "unknown";
      if (ts.isNewExpression(st.expression) && ts.isIdentifier(st.expression.expression)) {
        ctor = st.expression.expression.text;
      }
      throwSites.push({ line: lineOf(st), ctor, condition: curCond() });
      return;
    }
    if (ts.isReturnStatement(st)) {
      returnCount++;
      return;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) throw new UnsupportedShape("destructuring declaration", lineOf(d));
        if (!d.initializer) throw new UnsupportedShape("uninitialized binding", lineOf(d));
        assign(d.name.text, evalValue(d.initializer), curCond());
      }
      return;
    }
    if (ts.isExpressionStatement(st)) {
      evalValue(st.expression);
      return;
    }
    if (
      ts.isForOfStatement(st) ||
      ts.isForInStatement(st) ||
      ts.isWhileStatement(st) ||
      ts.isDoStatement(st) ||
      ts.isForStatement(st)
    ) {
      throw new UnsupportedShape("loop", lineOf(st));
    }
    if (ts.isSwitchStatement(st)) throw new UnsupportedShape("switch", lineOf(st));
    throw new UnsupportedShape(kindName(st), lineOf(st));
  };

  const body = fnNode.body;
  if (!body) throw new UnsupportedShape("function without body", lineOf(fnNode));
  execStatement(body);

  return new SymexFunction(
    file,
    functionName,
    paramNames,
    constants,
    effectiveConstants,
    throwSites,
    returnCount,
    ctx,
    paramSyms,
  );
}
