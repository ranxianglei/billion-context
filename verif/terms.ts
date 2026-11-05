/**
 * DAG-backed SMT2 term factory.
 *
 * Every constructor interns nodes by (op, kids, sort, const) so structurally
 * equal terms are the SAME object — ITE-merges across loop iterations share
 * structure instead of doubling string bytes (the pre-DAG build OOM'd at GBs
 * on hide-consumed: rest-on-copy wraps the whole frame per iteration).
 * `smt2Of` prints shared nodes as SMT-LIB `let` bindings, keeping the emitted
 * file linear too.
 */

type Sort = "Real" | "Int" | "Bool" | "String" | "RegLan";

/** method surface installed onto Term.prototype by bindMethods() */
export interface Term {
  eq(o: Term): Term;
  neq(o: Term): Term;
  ge(o: Term): Term;
  le(o: Term): Term;
  gt(o: Term): Term;
  lt(o: Term): Term;
  add(o: Term): Term;
  sub(o: Term): Term;
  mul(o: Term): Term;
  div(o: Term): Term;
  mod(o: Term): Term;
  neg(): Term;
  and(o: Term): Term;
  or(o: Term): Term;
  not(): Term;
  xor(o: Term): Term;
  implies(o: Term): Term;
  power(o: Term): Term;
  concat(o: Term): Term;
  length(): Term;
  at(i: Term): Term;
  extract(off: Term, len: Term): Term;
  indexOf(s: Term, from?: Term): Term;
  contains(s: Term): Term;
  prefixOf(s: Term): Term;
  suffixOf(s: Term): Term;
  replace(a: Term, b: Term): Term;
  toCode(): Term;
  toInt(): Term;
}
/** compat aliases for the previous z3-flavored facade */
export type Arith = Term;
export type Num = Term;
export type Bool<_T = unknown> = Term;
export type Seq<_T = unknown> = Term;

export class Term {
  /** cached inline print */
  private p?: string;
  constructor(
    readonly op: string,
    readonly sort: Sort,
    readonly kids: readonly Term[] = [],
    /** concrete value when statically known */
    readonly c?: number | string | boolean,
    readonly varName?: string,
    readonly ctx?: Context,
  ) {}

  toString(): string {
    if (this.p !== undefined) return this.p;
    const k = this.kids;
    let s: string;
    // SMT-LIB string literals: only "" doubles a quote — JSON's \" is ILLEGAL
    // in SMT-LIB 2.6 (cvc5: 'Illegal string character'). Control chars go
    // through \u{...}; printable Unicode stays raw (cvc5 reads UTF-8).
    if (!k.length && this.sort === "String" && typeof this.c === "string") s = smtStr(this.c);
    else if (!k.length) s = this.op; // var/literal pre-rendered as op
    else if (this.op === "ite") s = `(ite ${k[0]!} ${k[1]!} ${k[2]!})`;
    else s = `(${k.map(String).join(" ")})`;
    this.p = s;
    return s;
  }

  /** DAG-safe structural hash (memoized, linear in DAG size). Use this —
   *  NEVER toString() — for equality checks and dedupe keys on terms that
   *  may be large: tree-printing a shared DAG is exponential. */
  private h?: number;
  hash(): number {
    if (this.h !== undefined) return this.h;
    let acc = 2166136261;
    const mix = (x: number): void => { acc ^= x; acc = Math.imul(acc, 16777619); };
    for (let i = 0; i < this.op.length; i++) mix(this.op.charCodeAt(i));
    mix(this.sort.length);
    if (this.c !== undefined) mix(typeof this.c === "number" ? this.c : typeof this.c === "boolean" ? (this.c ? 1 : 0) : this.c.length);
    for (const k of this.kids) mix(k.hash());
    this.h = acc >>> 0;
    return this.h;
  }
}

/** SMT-LIB 2.6 string literal: quotes double; control chars as \u{...}. */
function smtStr(v: string): string {
  let out = '"';
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '""';
    // SMT-LIB string literals: only printable ASCII may appear raw;
    // cvc5 rejects non-ASCII bytes as "Non-printable character" even when
    // they are printable Unicode (advice strings carry em-dashes, ·, etc).
    else if (cp < 0x20 || cp === 0x7f || cp > 0x7e) out += `\\u{${cp.toString(16).padStart(4, "0")}}`;
    else out += ch;
  }
  return out + '"';
}

function fmtReal(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

const lit = (ctx: Context, s: string, sort: Sort, c?: number | string | boolean): Term =>
  ctx.intern(s, sort, [], c);

export class Context {
  readonly decls: string[] = [];
  readonly declSort = new Map<string, Sort>();
  readonly pendingFns = new Set<string>();
  readonly pendingFnsR1 = new Set<string>();
  readonly pendingFnsS1 = new Set<string>();
  /** global side assumptions (digit-only __numstr, etc.) — asserted in smt2Of */
  readonly pendingAsums: Term[] = [];
  /** (String, String) → String, deterministic in both args. */
  readonly pendingFnsS2 = new Set<string>();
  private readonly varCache = new Map<string, Term>();
  private nextVar = 0;

  fresh(prefix: string): string {
    return `__${prefix}_${this.nextVar++}`;
  }

  intern(op: string, sort: Sort, kids: readonly Term[], c?: number | string | boolean): Term {
    // NOTE: deliberately NOT hash-consed into a global table — a retaining
    // intern map blew the heap exponentially on loop-heavy merges (every
    // discarded intermediate wrapper stayed reachable). Structural sharing
    // happens at smt2Of emission time via canonical keys instead.
    return new Term(op, sort, kids, c, undefined, this);
  }

  app1(f: string, a: Term, sort: Sort): Term {
    return this.intern("app1", sort, [lit(this, f, "String"), a]);
  }
  app2(f: string, a: Term, b: Term, sort: Sort): Term {
    return this.intern("app2", sort, [lit(this, f, "String"), a, b]);
  }
  app3(f: string, a: Term, b: Term, c: Term, sort: Sort): Term {
    return this.intern("app3", sort, [lit(this, f, "String"), a, b, c]);
  }

  Real = {
    val: (n: number): Term => lit(this, fmtReal(n), "Real", n),
    const: (name: string): Term => this.declare(name, "Real"),
  };
  Int = {
    val: (n: number): Term => lit(this, String(n), "Int", n),
    const: (name: string): Term => this.declare(name, "Int"),
  };
  Bool = {
    val: (b: boolean): Term => lit(this, b ? "true" : "false", "Bool", b),
    const: (name: string): Term => this.declare(name, "Bool"),
  };
  String = {
    val: (s: string): Term => lit(this, JSON.stringify(s), "String", s),
    const: (name: string): Term => this.declare(name, "String"),
  };

  private declare(name: string, sort: Sort): Term {
    if (!this.decls.includes(name)) {
      this.decls.push(name);
      this.declSort.set(name, sort);
    }
    // leaf vars get canonical objects so identity-based folding works for
    // repeated const(name) calls (bounded by declared names — no blowup risk)
    const key = `${sort}:${name}`;
    let t = this.varCache.get(key);
    if (!t) { t = this.intern(name, sort, [], undefined); this.varCache.set(key, t); }
    return t;
  }

  If(c: Term, a: Term, b: Term): Term {
    if (c.c === true) return a;
    if (c.c === false) return b;
    if (a === b) return a;
    return this.intern("ite", a.sort, [c, a, b]);
  }
  ToReal(a: Term): Term {
    if (a.sort === "Real") return a;
    return this.app1("to_real", a, "Real");
  }
  ToInt(a: Term): Term {
    if (a.sort === "Int") return a;
    if (a.c !== undefined && typeof a.c === "number") return lit(this, String(a.c), "Int", a.c);
    return this.app1("to_int", a, "Int");
  }
  IsInt(a: Term): Term {
    if (a.sort === "Int") return lit(this, "true", "Bool", true);
    if (a.c !== undefined && typeof a.c === "number")
      return lit(this, String(Number.isInteger(a.c)), "Bool", Number.isInteger(a.c));
    return this.app1("is_int", a, "Bool");
  }
}

// ---------------------------------------------------------------------------
// arithmetic / boolean / string ops — bound per-Context onto Term.prototype
// ---------------------------------------------------------------------------

const numSortOf = (a: Term, b: Term): Sort => (a.sort === "Int" && b.sort === "Int" ? "Int" : "Real");
const asReal = (t: Term): Term => (t.sort === "Int" ? t.ctx!.ToReal(t) : t);

function foldArith(ctx: Context, op: string, a: Term, b: Term, sign: number, mul: boolean): Term {
  const sort = numSortOf(a, b);
  const av = typeof a.c === "number" ? a.c : undefined;
  const bv = typeof b.c === "number" ? b.c : undefined;
  if (av !== undefined && bv !== undefined) {
    const v = mul ? av * bv : sign > 0 ? av + bv : av - bv;
    return sort === "Real" ? lit(ctx, fmtReal(v), "Real", v) : lit(ctx, String(v), "Int", v);
  }
  if (mul) {
    if (av === 0 || bv === 0) return sort === "Real" ? lit(ctx, "0.0", "Real", 0) : lit(ctx, "0", "Int", 0);
    if (av === 1) return b;
    if (bv === 1) return a;
  } else {
    if (sign > 0 && av === 0) return b;
    if (sign > 0 && bv === 0) return a;
    if (sign < 0 && bv === 0) return a;
  }
  return ctx.app2(op, a, b, sort);
}

function foldCmp(ctx: Context, op: string, a: Term, b: Term): Term {
  const av = typeof a.c === "number" ? a.c : undefined;
  const bv = typeof b.c === "number" ? b.c : undefined;
  if (av !== undefined && bv !== undefined) {
    const v = op === "<" ? av < bv : op === "<=" ? av <= bv : op === ">" ? av > bv : av >= bv;
    return lit(ctx, String(v), "Bool", v);
  }
  if (a === b && (op === "<=" || op === ">=")) return lit(ctx, "true", "Bool", true);
  return ctx.app2(op, a, b, "Bool");
}

function foldBool(ctx: Context, op: string, a: Term, b: Term): Term {
  const av = typeof a.c === "boolean" ? a.c : undefined;
  const bv = typeof b.c === "boolean" ? b.c : undefined;
  if (op === "and") {
    if (av === false || bv === false) return lit(ctx, "false", "Bool", false);
    if (av === true) return b;
    if (bv === true) return a;
    if (a === b) return a;
    return ctx.app2("and", a, b, "Bool");
  }
  if (op === "or") {
    if (av === true || bv === true) return lit(ctx, "true", "Bool", true);
    if (av === false) return b;
    if (bv === false) return a;
    if (a === b) return a;
    return ctx.app2("or", a, b, "Bool");
  }
  if (op === "xor") {
    if (av !== undefined && bv !== undefined) return lit(ctx, String(av !== bv), "Bool", av !== bv);
    if (a === b) return lit(ctx, "false", "Bool", false);
    return ctx.app2("xor", a, b, "Bool");
  }
  // implies
  if (av === false || bv === true) return lit(ctx, "true", "Bool", true);
  if (av === true) return b;
  return ctx.app2("=>", a, b, "Bool");
}

function foldStrEq(ctx: Context, eq: boolean, a: Term, b: Term): Term {
  const av = typeof a.c === "string" ? a.c : undefined;
  const bv = typeof b.c === "string" ? b.c : undefined;
  if (av !== undefined && bv !== undefined) {
    const v = eq ? av === bv : av !== bv;
    return lit(ctx, String(v), "Bool", v);
  }
  if (a === b) return lit(ctx, String(eq), "Bool", eq);
  return ctx.app2(eq ? "=" : "distinct", a, b, "Bool");
}

function bindMethods(ctx: Context): void {
  const proto: Record<string, (this: Term, ...args: Term[]) => Term> = {
    eq(o) {
      const c = this.ctx ?? ctx;
      if (this.sort === "Bool" && o.sort === "Bool") {
        if (this.c !== undefined && o.c !== undefined) return lit(c, String(this.c === o.c), "Bool", this.c === o.c);
        if (this === o) return lit(c, "true", "Bool", true);
        return foldBool(c, "xor", this.not.call(this), o); // (= a b) ≡ ¬a⊕b folded via not+xor
      }
      if (this.sort === "String" || o.sort === "String") return foldStrEq(c, true, this, o);
      if (this.sort !== o.sort) return foldCmp(c, "=", asReal(this), asReal(o));
      return foldCmp(c, "=", this, o);
    },
    neq(o) {
      const c = this.ctx ?? ctx;
      if (this.sort === "String" || o.sort === "String") return foldStrEq(c, false, this, o);
      const e = proto.eq!.call(this, o);
      if (e.c !== undefined) return lit(c, String(!e.c), "Bool", !e.c);
      return e.not.call(e);
    },
    ge(o) { return foldCmp(this.ctx ?? ctx, ">=", asReal(this), asReal(o)); },
    le(o) { return foldCmp(this.ctx ?? ctx, "<=", asReal(this), asReal(o)); },
    gt(o) { return foldCmp(this.ctx ?? ctx, ">", asReal(this), asReal(o)); },
    lt(o) { return foldCmp(this.ctx ?? ctx, "<", asReal(this), asReal(o)); },
    add(o) { return foldArith(this.ctx ?? ctx, "+", asReal(this), asReal(o), 1, false); },
    sub(o) { return foldArith(this.ctx ?? ctx, "-", asReal(this), asReal(o), -1, false); },
    mul(o) { return foldArith(this.ctx ?? ctx, "*", asReal(this), asReal(o), 1, true); },
    div(o) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "number" ? this.c : undefined;
      const bv = typeof o.c === "number" ? o.c : undefined;
      if (av !== undefined && bv !== undefined && Number.isInteger(av) && Number.isInteger(bv) && bv !== 0 && av % bv === 0)
        return lit(c, `${av / bv}.0`, "Real", av / bv);
      return c.app2("/", asReal(this), asReal(o), "Real");
    },
    mod(o) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "number" ? this.c : undefined;
      const bv = typeof o.c === "number" ? o.c : undefined;
      if (av !== undefined && bv !== undefined && Number.isInteger(av) && Number.isInteger(bv) && bv !== 0)
        return lit(c, String(av % bv), "Int", av % bv);
      return c.app2("mod", this, o, "Int");
    },
    neg() {
      const av = typeof this.c === "number" ? this.c : undefined;
      if (av !== undefined) return this.sort === "Real" ? lit(this.ctx ?? ctx, fmtReal(-av), "Real", -av) : lit(this.ctx ?? ctx, String(-av), "Int", -av);
      return (this.ctx ?? ctx).app1("-", this, this.sort);
    },
    and(o) { return foldBool(this.ctx ?? ctx, "and", this, o); },
    or(o) { return foldBool(this.ctx ?? ctx, "or", this, o); },
    not() {
      const av = typeof this.c === "boolean" ? this.c : undefined;
      if (av !== undefined) return lit(this.ctx ?? ctx, String(!av), "Bool", !av);
      return (this.ctx ?? ctx).app1("not", this, "Bool");
    },
    xor(o) { return foldBool(this.ctx ?? ctx, "xor", this, o); },
    implies(o) { return foldBool(this.ctx ?? ctx, "=>", this, o); },
    power(o) {
      const c = this.ctx ?? ctx;
      const sv = typeof this.c === "string" ? this.c : undefined;
      const nv = typeof o.c === "number" ? o.c : undefined;
      if (sv !== undefined && nv !== undefined && sv.length * Math.max(0, nv) <= 4096) {
        const s = sv.repeat(Math.max(0, nv));
        return lit(c, JSON.stringify(s), "String", s);
      }
      c.pendingFns.add("__str_repeat");
      return c.app2("__str_repeat", this, o, "String");
    },
    concat(o) {
      const av = typeof this.c === "string" ? this.c : undefined;
      const bv = typeof o.c === "string" ? o.c : undefined;
      if (av !== undefined && bv !== undefined) return lit(this.ctx ?? ctx, JSON.stringify(av + bv), "String", av + bv);
      if (av === "") return o;
      if (bv === "") return this;
      return (this.ctx ?? ctx).app2("str.++", this, o, "String");
    },
    length() {
      const av = typeof this.c === "string" ? this.c : undefined;
      if (av !== undefined) return lit(this.ctx ?? ctx, String(av.length), "Int", av.length);
      return (this.ctx ?? ctx).app1("str.len", this, "Int");
    },
    at(i) { return (this.ctx ?? ctx).app2("str.at", this, i, "String"); },
    extract(off, len) { return (this.ctx ?? ctx).app3("str.substr", this, off, len, "String"); },
    indexOf(s, from) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "string" ? this.c : undefined;
      const bv = typeof s.c === "string" ? s.c : undefined;
      if (av !== undefined && bv !== undefined && from === undefined)
        return lit(c, String(av.indexOf(bv)), "Int", av.indexOf(bv));
      return from === undefined
        ? c.app2("str.indexof", this, s, "Int")
        : c.app3("str.indexof", this, s, from, "Int");
    },
    contains(s) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "string" ? this.c : undefined;
      const bv = typeof s.c === "string" ? s.c : undefined;
      if (av !== undefined && bv !== undefined) return lit(c, String(av.includes(bv)), "Bool", av.includes(bv));
      if (this === s) return lit(c, "true", "Bool", true);
      return c.app2("str.contains", this, s, "Bool");
    },
    prefixOf(s) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "string" ? this.c : undefined;
      const bv = typeof s.c === "string" ? s.c : undefined;
      if (av !== undefined && bv !== undefined) return lit(c, String(bv.startsWith(av)), "Bool", bv.startsWith(av));
      // SMT-LIB (str.prefixof s t) = "s is a prefix of t" — the RECEIVER (this)
      // is the string being tested, the ARG is the prefix, so arg goes FIRST.
      return c.app2("str.prefixof", s, this, "Bool");
    },
    suffixOf(s) {
      const c = this.ctx ?? ctx;
      const av = typeof this.c === "string" ? this.c : undefined;
      const bv = typeof s.c === "string" ? s.c : undefined;
      if (av !== undefined && bv !== undefined) return lit(c, String(bv.endsWith(av)), "Bool", bv.endsWith(av));
      // (str.suffixof s t) = "s is a suffix of t" — arg (the suffix) goes FIRST.
      return c.app2("str.suffixof", s, this, "Bool");
    },
    replace(a, b) {
      const c = this.ctx ?? ctx;
      const sv = typeof this.c === "string" ? this.c : undefined;
      const av = typeof a.c === "string" ? a.c : undefined;
      const bv = typeof b.c === "string" ? b.c : undefined;
      if (sv !== undefined && av !== undefined && bv !== undefined)
        return lit(c, JSON.stringify(sv.replace(av, bv)), "String", sv.replace(av, bv));
      return c.app3("str.replace", this, a, b, "String");
    },
    toCode() {
      const av = typeof this.c === "string" ? this.c : undefined;
      if (av !== undefined) return lit(this.ctx ?? ctx, String(av.codePointAt(0) ?? 0), "Int", av.codePointAt(0) ?? 0);
      return (this.ctx ?? ctx).app1("str.to_code", this, "Int");
    },
    toInt() {
      const av = typeof this.c === "string" ? this.c : undefined;
      if (av !== undefined) {
        const n = Number(av);
        return lit(this.ctx ?? ctx, String(n), "Int", n);
      }
      return (this.ctx ?? ctx).app1("str.to_int", this, "Int");
    },
  };
  for (const [name, fn] of Object.entries(proto)) {
    (Term.prototype as any)[name] = fn;
  }
}

/** convenience: build a string-constant Term bound to ctx */
export function strc(ctx: Context, sv: string): Term {
  return ctx.String.val(sv);
}

export function newCtx(): Context {
  const ctx = new Context();
  bindMethods(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// SMT2 emission with let-sharing
// ---------------------------------------------------------------------------

interface Smt2Out {
  smt2: string;
  lets: number;
}

export function smt2Of(
  ctx: Context,
  asserts: readonly Term[],
  getValue: readonly string[] = [],
): Smt2Out {
  // canonical structural key per node (bottom-up, memoized by object)
  const canon = new Map<Term, string>();
  let seq = 0;
  // DAG-safe hashing: string keys blow up quadratically on deep chains
  // (Invalid string length). Numbers via Term.hash() are memoized+linear.
  const seenObj = new Set<Term>();
  const counts = new Map<number, number>();
  const walk = (t: Term): void => {
    if (seenObj.has(t)) return;
    seenObj.add(t);
    for (const k of t.kids) {
      counts.set(k.hash(), (counts.get(k.hash()) ?? 0) + 1);
      walk(k);
    }
  };
  for (const a of asserts) {
    counts.set(a.hash(), (counts.get(a.hash()) ?? 0) + 1);
    walk(a);
  }
  const sizeCache = new Map<number, number>();
  const sizeOf = (t: Term): number => {
    const h = t.hash();
    const hit = sizeCache.get(h);
    if (hit !== undefined) return hit;
    let n = 1;
    for (const kk of t.kids) n += sizeOf(kk);
    sizeCache.set(h, n);
    return n;
  };
  // assign let names by hash, post-order
  const names = new Map<number, string>();
  let counter = 0;
  const seen2 = new Set<Term>();
  const assign = (t: Term): void => {
    if (seen2.has(t)) return;
    seen2.add(t);
    for (const k of t.kids) assign(k);
    const key = t.hash();
    if (t.kids.length && (counts.get(key) ?? 0) > 1 && sizeOf(t) > 24 && !names.has(key)) {
      names.set(key, `!t${counter++}`);
    }
  };
  for (const a of asserts) assign(a);
  const render = (t: Term, allowName = true): string => {
    const key = t.hash();
    const n = allowName ? names.get(key) : undefined;
    if (n !== undefined) return n;
    if (!t.kids.length) return t.toString();
    if (t.op === "ite") return `(ite ${render(t.kids[0]!)} ${render(t.kids[1]!)} ${render(t.kids[2]!)})`;
    if (t.op === "app1" || t.op === "app2" || t.op === "app3")
      return `(${t.kids.map((k) => render(k)).join(" ")})`; // kids keep allowName; kid0 is the fn name
    return `(${t.op} ${t.kids.map((k) => render(k)).join(" ")})`; // kids keep allowName
  };

  const lines: string[] = ["(set-logic ALL)"];
  for (const fn of ctx.pendingFns) lines.push(`(declare-fun ${fn} (String Int) String)`);
  for (const fn of ctx.pendingFnsR1) lines.push(`(declare-fun ${fn} (Real) String)`);
  for (const fn of ctx.pendingFnsS1) lines.push(`(declare-fun ${fn} (String) String)`);
  for (const fn of (ctx as unknown as { pendingFnsS2: Set<string> }).pendingFnsS2) lines.push(`(declare-fun ${fn} (String String) String)`);
  for (const d of ctx.decls) lines.push(`(declare-fun ${d} () ${ctx.declSort.get(d) ?? "Real"})`);
  for (const a of ctx.pendingAsums) lines.push(`(assert ${render(a, false)})`);
  if (names.size) {
    // Shared subterms become top-level define-funs — sequential commands,
    // so later definitions may reference earlier ones. (SMT-LIB `let`
    // bindings are PARALLEL: a binding cannot reference its siblings —
    // cvc5 rejects chained lets with "Symbol not declared".)
    const defFor = new Map<number, Term>();
    const seen3 = new Set<Term>();
    const collect = (t: Term): void => {
      if (seen3.has(t)) return;
      seen3.add(t);
      const k = t.hash();
      if (names.has(k) && !defFor.has(k)) defFor.set(k, t);
      t.kids.forEach(collect);
    };
    asserts.forEach(collect);
    for (const [k, n] of names) {
      const d = defFor.get(k)!;
      lines.push(`(define-fun ${n} () ${d.sort} ${render(d, false)})`);
    }
  }
  for (const a of asserts) lines.push(`(assert ${render(a)})`);
  lines.push("(check-sat)");
  if (getValue.length) lines.push(`(get-value (${getValue.join(" ")}))`);
  lines.push("(exit)");
  return { smt2: lines.join("\n") + "\n", lets: names.size };
}
