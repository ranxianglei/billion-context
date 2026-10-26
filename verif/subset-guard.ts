/**
 * verif subset guard — the sublanguage enforcement engine.
 *
 * Purpose: the files in verif/guarded-files.ts must stay inside the subset
 * that verif/symbolic.ts can translate to SMT. This module walks the real
 * TypeScript AST and reports every construct outside the subset. Anything
 * reported must either be fixed or be covered by an explicit, reviewed
 * exception in verif/exceptions.ts — there is no third option.
 *
 * Design rules:
 *  - The engine is driven by ALLOWLISTS, not denylists: an unknown builtin,
 *    method, or import is a violation until it is taught to the translator
 *    and added here. That is what keeps "cannot be verified" code out.
 *  - Matching an exception requires file + code (+ function); unused
 *    exceptions are reported so stale entries get deleted.
 */
import ts from "typescript";

type ViolationCode =
  | "ASYNC"
  | "GENERATOR"
  | "CLASS_DECL"
  | "INHERITANCE"
  | "ACCESSOR"
  | "DECORATOR"
  | "TAGGED_TEMPLATE"
  | "BIGINT"
  | "DYNAMIC_CODE"
  | "REFLECTION"
  | "ENV_ACCESS"
  | "NODE_BUILTIN_IMPORT"
  | "EXTERNAL_IMPORT"
  | "LABEL"
  | "WITH_STMT"
  | "DELETE_EXPR"
  | "VOID_EXPR"
  | "FOR_IN"
  | "FREE_CLOSURE"
  | "UNKNOWN_GLOBAL"
  | "UNKNOWN_METHOD"
  | "DYNAMIC_REGEX"
  | "REGEX_STATEFUL"
  | "EXCLUDED_FUNCTION";

interface Violation {
  file: string;
  line: number;
  code: ViolationCode;
  detail: string;
  fn: string | undefined;
}

interface GuardResult {
  violations: Violation[];
  /** Exceptions/entries that matched nothing — must be deleted. */
  stale: Array<{ kind: "exception" | "excluded"; label: string }>;
}

/* ---------------------------------------------------------------- allowlists */

const MATH_FNS = new Set(["abs", "min", "max", "round", "floor", "ceil", "trunc", "sign", "pow", "sqrt"]);

const JSON_FNS = new Set(["parse", "stringify"]);

const OBJECT_FNS = new Set(["keys", "values", "entries", "hasOwn"]);

const ARRAY_FNS = new Set(["isArray", "from", "of"]);

const NUMBER_FNS = new Set(["isFinite", "isNaN", "isInteger", "isSafeInteger", "parseInt", "parseFloat"]);

const STRING_CTOR_FNS = new Set(["fromCharCode", "fromCodePoint"]);

const NAMESPACE_MEMBERS: Record<string, Set<string>> = {
  Math: MATH_FNS,
  JSON: JSON_FNS,
  Object: OBJECT_FNS,
  Array: ARRAY_FNS,
  Number: NUMBER_FNS,
  String: STRING_CTOR_FNS,
};

/** Higher-order array methods whose callback arguments are the only legal
 * closure shape. The translator inlines these combinators. */
const HOF_ARRAY_METHODS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "findLastIndex",
  "every", "some", "reduce", "reduceRight", "flatMap", "forEach", "sort",
]);

const PLAIN_ARRAY_METHODS = new Set([
  "includes", "indexOf", "lastIndexOf", "slice", "concat", "join",
  "push", "pop", "shift", "unshift", "splice", "at", "flat", "reverse",
  "entries", "keys", "values",
]);

const STRING_METHODS = new Set([
  "slice", "substring", "indexOf", "lastIndexOf", "includes", "startsWith",
  "endsWith", "replace", "replaceAll", "split", "trim", "trimStart",
  "trimEnd", "toLowerCase", "toUpperCase", "normalize", "padStart",
  "padEnd", "repeat", "concat", "charAt", "charCodeAt", "codePointAt",
  "at", "match", "search",
]);

const MAP_SET_METHODS = new Set([
  "get", "set", "has", "delete", "clear", "add", "keys", "values", "entries", "forEach",
]);

/** Methods callable on regex literals (stateless flags only; the stateful
 * exec/test-with-g combination is rejected separately). */
const REGEX_METHODS = new Set(["test", "exec"]);

/** Function-typed fields on options/state objects (injected ports). Calls to
 * these are modeled as uninterpreted functions — they are extension seams,
 * not logic the verifier reasons about. */
const PORT_METHODS = new Set(["countTokens", "shouldSkip", "isProtected"]);

/** Deterministic number formatting. */
const NUMBER_INSTANCE_METHODS = new Set(["toFixed"]);

/** Methods on instances/records produced by kernel-internal code. */
const KERNEL_INSTANCE_METHODS = new Set([
  "next", "namespaceFor",
  // createCore() entry-point record:
  "applyCompression", "processTurn",
]);

/** new X is allowed only for these. */
const NEWABLE = new Set(["Map", "Set", "Error", "RangeError", "TypeError", "RegExp"]);
/** Kernel classes (imported from other guarded/Tier-B modules) that may be
 * constructed; their instance methods are registered below. */
const IMPORTED_NEWABLE = new Set(["ClusterCounter"]);

/** Bare callables allowed as plain functions. */
const GLOBAL_FNS = new Set([
  "isNaN", "isFinite", "parseFloat", "parseInt",
  "String", "Number", "Boolean", "Object", "Array",
  // function-typed parameters (injected ports, uninterpreted):
  "countTokens", "predicate", "isCompressTool",
]);

/** Namespace roots (Math.x etc.) handled via NAMESPACE_MEMBERS. */
const NAMESPACE_ROOTS = new Set(Object.keys(NAMESPACE_MEMBERS));

/** Namespace roots also usable as bare coercion calls: String(x), Number(x)… */
const COERCION_ROOTS = new Set(["String", "Number", "Boolean", "Object", "Array"]);

/** Reads that reach the environment / nondeterminism. */
const ENV_ROOTS = new Set([
  "Date", "Math.random", "crypto", "performance", "process", "console",
  "fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
  "require", "Buffer", "globalThis", "global", "WebAssembly",
]);

const REFLECTION_ROOTS = new Set(["Proxy", "Reflect", "WeakMap", "WeakSet", "Symbol", "Function", "eval"]);

const STATEFUL_REGEX_FLAGS = new Set(["g", "y"]);

const ALL_VALUE_METHODS = new Set<string>([
  ...HOF_ARRAY_METHODS, ...PLAIN_ARRAY_METHODS, ...STRING_METHODS,
  ...MAP_SET_METHODS, ...REGEX_METHODS, ...PORT_METHODS,
  ...NUMBER_INSTANCE_METHODS, ...KERNEL_INSTANCE_METHODS,
]);

/* ------------------------------------------------------------------ helpers */

function unwrap(node: ts.Node): ts.Node {
  let cur = node;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function dottedName(expr: ts.Expression): string | undefined {
  let node = unwrap(expr);
  const parts: string[] = [];
  while (ts.isPropertyAccessExpression(node)) {
    parts.unshift(node.name.text);
    node = unwrap(node.expression);
  }
  if (ts.isIdentifier(node)) {
    parts.unshift(node.text);
    return parts.join(".");
  }
  return undefined;
}

function nearestFunctionName(node: ts.Node): string | undefined {
  // Walk up to the nearest enclosing function; report its binding name.
  // Module-level constructs report undefined (no enclosing function).
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      const parent = cur.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isFunctionDeclaration(parent)) return parent.name?.text; // IIFE-ish, rare
    }
    cur = cur.parent;
  }
  return undefined;
}

/* ------------------------------------------------------------------- engine */

interface CheckInput {
  /** Repo-relative path, e.g. kernel/src/refs.ts */
  file: string;
  source: string;
  excludedFunctions: ReadonlySet<string>;
}

export function checkGuardedFile({ file, source, excludedFunctions }: CheckInput): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const violations: Violation[] = [];
  const add = (node: ts.Node, code: ViolationCode, detail: string) => {
    violations.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      code,
      detail,
      fn: nearestFunctionName(node),
    });
  };

  const kernelImports = new Set<string>();
  const localFunctions = new Set<string>();

  // Pre-pass: collect function declarations and named const functions/calls
  // (calls may appear textually before the declaration — hoisting).
  const moduleConsts = new Set<string>();
  const prepass = (node: ts.Node, top: boolean): void => {
    if (ts.isFunctionDeclaration(node) && node.name) localFunctions.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        localFunctions.add(node.name.text);
      } else if (top) {
        moduleConsts.add(node.name.text);
      }
    }
    ts.forEachChild(node, (c) => prepass(c, false));
  };
  prepass(sf, true);

  /** Resolve a call's callee into either a dotted path (root is an
   * identifier) or the trailing method name on an arbitrary receiver. */
  const resolveCallee = (
    callee: ts.Expression,
  ): { dotted?: string; methodName?: string } => {
    const dotted = dottedName(callee);
    if (dotted !== undefined) return { dotted };
    const c = unwrap(callee);
    if (ts.isPropertyAccessExpression(c)) {
      return { methodName: c.name.text };
    }
    return {};
  };

  const checkCall = (node: ts.CallExpression): void => {
    const { dotted, methodName } = resolveCallee(node.expression);

    if (dotted !== undefined) {
      const segs = dotted.split(".");
      const root = segs[0];
      const last = segs[segs.length - 1];

      if (REFLECTION_ROOTS.has(root) || REFLECTION_ROOTS.has(dotted)) {
        add(node, "REFLECTION", dotted);
        return;
      }
      if (ENV_ROOTS.has(dotted) || ENV_ROOTS.has(root)) {
        add(node, "ENV_ACCESS", dotted);
        return;
      }
      if (NAMESPACE_ROOTS.has(root)) {
        if (segs.length === 1 && COERCION_ROOTS.has(root)) return; // String(x)/Number(x)/...
        // Namespace calls must be exactly Root.member with member allowed.
        const allowed = NAMESPACE_MEMBERS[root];
        if (segs.length !== 2 || !allowed.has(segs[1])) {
          add(node, "UNKNOWN_METHOD", dotted);
        }
        return;
      }
      if (segs.length === 1) {
        // Bare call of a local/imported/whitelisted global function.
        if (!kernelImports.has(root) && !localFunctions.has(root) && !GLOBAL_FNS.has(root)) {
          add(node, "UNKNOWN_GLOBAL", dotted);
        }
        return;
      }
      // Method call on a local/imported/module-const value: check the
      // trailing method against the registered method families.
      if (!ALL_VALUE_METHODS.has(last)) {
        add(node, "UNKNOWN_METHOD", `.${last} on local value (${dotted})`);
        return;
      }
      return;
    }

    if (methodName !== undefined) {
      // Receiver is a computed expression (call result, literal, ...).
      if (!ALL_VALUE_METHODS.has(methodName)) {
        add(node, "UNKNOWN_METHOD", `.${methodName} on computed receiver`);
      }
      return;
    }

    add(node, "UNKNOWN_GLOBAL", `indirect call (${node.expression.getText(sf)})`);
  };

  /** Legal closure = argument of a whitelisted HOF / kernel-internal call,
   * or part of a record returned from a local function (entry-point table). */
  const isLegalCallback = (fn: ts.ArrowFunction | ts.FunctionExpression): boolean => {
    // Default value in a parameter list: pure deterministic fallback.
    if (ts.isParameter(fn.parent)) return true;
    // Right side of a ?? fallback: const x = provided ?? (() => default).
    {
      let holder: ts.Node = fn;
      while (ts.isParenthesizedExpression(holder.parent)) holder = holder.parent;
      const bp = holder.parent;
      if (
        ts.isBinaryExpression(bp) &&
        bp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        bp.right === holder
      ) {
        return true;
      }
    }
    let cur: ts.Node | undefined = fn.parent;
    while (
      cur &&
      !ts.isCallExpression(cur) &&
      !ts.isStatement(cur) &&
      !ts.isVariableDeclaration(cur) &&
      !ts.isBinaryExpression(cur)
    ) {
      cur = cur.parent;
    }
    if (cur && ts.isCallExpression(cur)) {
      const { dotted, methodName } = resolveCallee(cur.expression);
      const m = methodName ?? (dotted !== undefined && dotted.includes(".") ? dotted.split(".").pop() : undefined);
      if (m !== undefined && (HOF_ARRAY_METHODS.has(m) || MAP_SET_METHODS.has(m))) return true;
      const root = dotted?.split(".")[0];
      if (root !== undefined && (kernelImports.has(root) || localFunctions.has(root))) return true;
      return false;
    }
    if (cur && ts.isReturnStatement(cur)) {
      // Arrow inside a record returned by a local function — dispatch table.
      return true;
    }
    if (cur && ts.isVariableDeclaration(cur)) {
      // Named local helper (const f = (x) => ...). Statically call-graphable;
      // every use is checked as a call/argument elsewhere in this file.
      return true;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    /* ---- exclusions: skip whole excluded function bodies ---- */
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      excludedFunctions.has(`${file}#${node.name.text}`)
    ) {
      add(node, "EXCLUDED_FUNCTION", `function ${node.name.text} is excluded from the verified subset`);
      violations[violations.length - 1].fn = node.name.text;
      return;
    }

    switch (node.kind) {
      case ts.SyntaxKind.AwaitExpression:
        add(node, "ASYNC", "await — the verified subset is fully synchronous");
        return;
      case ts.SyntaxKind.YieldExpression:
        add(node, "GENERATOR", "yield");
        return;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
        add(node, "CLASS_DECL", "class declarations are outside the subset");
        return;
      case ts.SyntaxKind.HeritageClause:
        add(node, "INHERITANCE", "extends/implements");
        return;
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
        add(node, "ACCESSOR", "get/set accessor");
        return;
      case ts.SyntaxKind.Decorator:
        add(node, "DECORATOR", "decorator");
        return;
      case ts.SyntaxKind.TaggedTemplateExpression:
        add(node, "TAGGED_TEMPLATE", "tagged template");
        return;
      case ts.SyntaxKind.BigIntLiteral:
        add(node, "BIGINT", "bigint literal");
        return;
      case ts.SyntaxKind.LabeledStatement:
        add(node, "LABEL", "labeled statement");
        return;
      case ts.SyntaxKind.WithStatement:
        add(node, "WITH_STMT", "with statement");
        return;
      case ts.SyntaxKind.DeleteExpression: {
        const operand = unwrap((node as ts.DeleteExpression).expression);
        if (ts.isIdentifier(operand)) {
          add(node, "DELETE_EXPR", "delete of a binding");
          return;
        }
        break; // delete obj.k / delete obj[k]: bounded-map removal, allowed
      }
      case ts.SyntaxKind.VoidExpression:
        add(node, "VOID_EXPR", "void expression");
        return;
      case ts.SyntaxKind.ForInStatement:
        add(node, "FOR_IN", "for-in enumeration");
        return;
      default:
        break;
    }

    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.getText(sf).replace(/^['"]|['"]$/g, "");
      if (spec.startsWith("node:")) {
        add(node, "NODE_BUILTIN_IMPORT", `import from "${spec}"`);
      } else if (!spec.startsWith(".")) {
        add(node, "EXTERNAL_IMPORT", `import from "${spec}"`);
      } else if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const el of node.importClause.namedBindings.elements) {
          kernelImports.add((el.propertyName ?? el.name).text);
        }
      }
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, "DYNAMIC_CODE", "dynamic import()");
      return;
    }

    if (ts.isNewExpression(node)) {
      const name = dottedName(node.expression);
      const root = name?.split(".")[0];
      const okNew =
        name !== undefined &&
        root !== undefined &&
        (NEWABLE.has(root) || (IMPORTED_NEWABLE.has(root) && kernelImports.has(root)));
      if (!okNew) {
        add(node, "UNKNOWN_GLOBAL", `new ${name ?? "<expr>"}`);
        return;
      }
      if (name === "RegExp") {
        const first = node.arguments?.[0];
        const literal = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first));
        if (!literal) {
          add(node, "DYNAMIC_REGEX", "new RegExp with non-literal pattern");
          return;
        }
        const flags = node.arguments?.[1];
        if (flags && ts.isStringLiteral(flags)) {
          for (const ch of flags.text) {
            if (STATEFUL_REGEX_FLAGS.has(ch)) {
              add(node, "REGEX_STATEFUL", `RegExp flags "${flags.text}" carry lastIndex state`);
              return;
            }
          }
        }
      }
    }

    /* Stateful regex use: /re/g.exec(...) or /re/g.test(...) on the SAME
     * literal — string.match(re) never touches lastIndex, so /g/ is fine
     * there. This is the precise case; blanket flagging would be wrong. */
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isRegularExpressionLiteral(callee.expression) &&
        (callee.name.text === "exec" || callee.name.text === "test")
      ) {
        const text = callee.expression.getText(sf);
        const flags = text.slice(text.lastIndexOf("/") + 1);
        if ([...flags].some((ch) => STATEFUL_REGEX_FLAGS.has(ch))) {
          add(node, "REGEX_STATEFUL", `.${callee.name.text} on /${flags}/ regex literal mutates lastIndex`);
          return;
        }
      }
    }

    if (ts.isCallExpression(node)) {
      checkCall(node);
      // fall through to children (arguments may contain closures etc.)
    }

    /* Environment reads (not calls): process.env.X, Date.now as a value, …
     * Callee positions are skipped here — checkCall reports those once. */
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const dotted = dottedName(node);
      if (dotted) {
        const root = dotted.split(".")[0];
        if (ENV_ROOTS.has(dotted) || ENV_ROOTS.has(root)) {
          add(node, "ENV_ACCESS", `read ${dotted}`);
        }
      }
    }

    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !isLegalCallback(node)) {
      add(node, "FREE_CLOSURE", "function value escapes the allowed callback positions");
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

/* -------------------------------------------------------------- top level */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXCEPTIONS, EXCLUDED_FUNCTIONS, type SubsetException } from "./exceptions.js";
import { GUARDED_FILES } from "./guarded-files.js";

export function runGuard(repoRoot: string): GuardResult {
  const excluded = new Set(EXCLUDED_FUNCTIONS.map((e) => `${e.file}#${e.fn}`));
  const used = new Set<string>();
  const violations: Violation[] = [];

  for (const rel of GUARDED_FILES) {
    const source = readFileSync(resolve(repoRoot, rel), "utf8");
    for (const v of checkGuardedFile({ file: rel, source, excludedFunctions: excluded })) {
      if (v.code === "EXCLUDED_FUNCTION") {
        const key = `${v.file}#${v.fn}`;
        if (excluded.has(key)) {
          used.add(`excluded:${key}`);
          continue;
        }
      }
      const match = findException(v);
      if (match) {
        used.add(exceptionLabel(match));
        continue;
      }
      violations.push(v);
    }
  }

  const stale: GuardResult["stale"] = [];
  for (const e of EXCEPTIONS) {
    if (!used.has(exceptionLabel(e))) {
      stale.push({ kind: "exception", label: exceptionLabel(e) });
    }
  }
  for (const e of EXCLUDED_FUNCTIONS) {
    const key = `${e.file}#${e.fn}`;
    if (!used.has(`excluded:${key}`)) {
      stale.push({ kind: "excluded", label: `excluded:${key}` });
    }
  }

  return { violations, stale };
}

function findException(v: Violation): SubsetException | undefined {
  return EXCEPTIONS.find(
    (e) =>
      e.file === v.file &&
      e.code === v.code &&
      (e.fn === undefined || e.fn === v.fn) &&
      (e.detail === undefined || e.detail === v.detail),
  );
}

function exceptionLabel(e: SubsetException): string {
  return `${e.file}:${e.code}:${e.fn ?? "*"}`;
}
