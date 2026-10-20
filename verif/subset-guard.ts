// Sub-language guard for the kernel decision core (#3848/#3853).
//
// Allowlist discipline, fail closed: anything the symbolic translator
// (verif/symbolic.ts) cannot model soundly must be impossible to WRITE into
// a guarded file. Every rule below reports a violation for any construct it
// does not recognize; the only way past a violation is an explicit entry in
// verif/exceptions.ts (file + rule + function + reason). evaluate() fails in
// both directions: unregistered violations AND registered exceptions that no
// longer match anything live (stale inventory) turn CI red.

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { GUARDED_FILES } from "./guarded-files.js";
import { EXCEPTIONS, EXCLUDED_FUNCTIONS } from "./exceptions.js";
import type { ExcludedFunction, GuardException } from "./exceptions.js";

export const RULE_IDS = [
  "import-specifier",
  "async",
  "generator",
  "class",
  "decorator",
  "eval",
  "env-access",
  "unknown-global",
  "unwhitelisted-method",
  "unwhitelisted-constructor",
  "closure-escape",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  "import-specifier":
    "imports must stay relative-inside-kernel/src or use an allowlisted node: builtin",
  async: "no async functions or await — the decision core is fully synchronous",
  generator: "no generators or yield — control flow must stay translatable",
  class: "no classes or inheritance — plain functions and records only",
  decorator: "no decorators",
  eval: "no eval/new Function/dynamic import/require — code cannot spawn code",
  "env-access": "no process/globalThis/global/import.meta — the core reads no environment",
  "unknown-global": "identifier is neither locally bound nor on the global allowlist",
  "unwhitelisted-method": "method call name outside the allowlist",
  "unwhitelisted-constructor": "new X with X outside the constructor allowlist",
  "closure-escape":
    "a same-file closure escapes its defining scope (returned, or passed around by identifier)",
};

// Evidence-based allowlists: every entry exists in the current Tier A surface
// (the #3853 inventory). Adding an entry weakens the guard — justify it like
// an exception entry, not silently.
export const GLOBAL_ALLOWLIST = new Set<string>([
  "Math",
  "String",
  "Number",
  "Object",
  "Array",
  "Set",
  "Map",
  "JSON",
  "Error",
  "RangeError",
  "RegExp",
  "undefined",
]);

// Built-in constructors plus imported deterministic helpers the decision core
// instantiates per call (ClusterCounter: wire/message-id.js, pure id-suffix
// counter — no I/O, clock, or randomness).
export const CONSTRUCTOR_ALLOWLIST = new Set<string>([
  "Error",
  "RangeError",
  "RegExp",
  "Set",
  "Map",
  "ClusterCounter",
]);

export const METHOD_ALLOWLIST = new Set<string>([
  // array / iterable combinators
  "map",
  "filter",
  "find",
  "every",
  "some",
  "reduce",
  "flatMap",
  "sort",
  "forEach",
  "push",
  "splice",
  "slice",
  "includes",
  "indexOf",
  "startsWith",
  "entries",
  "values",
  "keys",
  "add",
  "has",
  "get",
  "set",
  "split",
  "join",
  "trim",
  "toLowerCase",
  "replace",
  "padStart",
  "charCodeAt",
  "match",
  "exec",
  "next",
  // statics reachable through allowlisted global roots
  "min",
  "max",
  "round",
  "floor",
  "ceil",
  "isInteger",
  "isFinite",
  "isArray",
  "parse",
  "stringify",
  // local-object protocols used by the decision core (name-based; see README limits)
  "warn",
  "toFixed",
  "applyCompression",
  "shouldSkip",
  "isProtected",
  "namespaceFor",
  "countTokens",
]);

const ENV_ROOTS = new Set(["process", "globalThis", "global"]);

export const BUILTIN_IMPORT_ALLOWLIST = new Set<string>(["node:module"]);

export interface Violation {
  file: string;
  rule: RuleId;
  line: number;
  column: number;
  fn: string;
  expr: string;
  message: string;
}

export interface GuardFileResult {
  violations: Violation[];
  functions: Set<string>;
}

export interface GuardResult {
  violations: Violation[];
  unregistered: Violation[];
  expired: GuardException[];
  expiredExclusions: ExcludedFunction[];
}

export interface GuardOptions {
  exceptions?: GuardException[];
  excluded?: ExcludedFunction[];
}

// Node kinds that only ever contain type-level identifiers. An identifier
// with any such ancestor is a type mention, not a value reference.
const TYPE_NODE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.TypeReference,
  ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.TypeLiteral,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypeOperator,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.TupleType,
  ts.SyntaxKind.ArrayType,
  ts.SyntaxKind.UnionType,
  ts.SyntaxKind.IntersectionType,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.ParenthesizedType,
  ts.SyntaxKind.ExpressionWithTypeArguments,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.IndexSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.TemplateLiteralType,
  ts.SyntaxKind.ImportType,
  ts.SyntaxKind.InferType,
  ts.SyntaxKind.ConditionalType,
  ts.SyntaxKind.IndexedAccessType,
  ts.SyntaxKind.MappedType,
  ts.SyntaxKind.OptionalType,
]);

const inTypePosition = (node: ts.Node): boolean => {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (TYPE_NODE_KINDS.has(cur.kind)) return true;
    // Stop at value boundaries. Parameters are NOT stops: a parameter inside a
    // function-TYPE is still type-level, while a value parameter sits directly
    // under a function declaration/expression, which does stop the climb.
    if (ts.isStatement(cur) || ts.isExpression(cur) || ts.isBindingName(cur)) {
      return false;
    }
    cur = cur.parent;
  }
  return false;
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n);

// Collect function-declaration names declared anywhere inside root, without
// crossing into other function bodies (those bind in their own scopes).
function collectNestedDeclNames(root: ts.Node, out: Set<string>): void {
  ts.forEachChild(root, (c) => {
    if (isFunctionLike(c)) {
      if (ts.isFunctionDeclaration(c) && c.name) out.add(c.name.text);
    } else {
      collectNestedDeclNames(c, out);
    }
  });
}

function chainRoot(e: ts.Expression): ts.Identifier | null {
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e : null;
}

export function guardSource(
  file: string,
  source: string,
  opts: Pick<GuardOptions, "excluded"> = {},
): GuardFileResult {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const functions = new Set<string>();

  const fileExclusions = (opts.excluded ?? []).filter((e) => e.file === file);
  const excludedFns = new Set(fileExclusions.map((e) => e.fn));
  const regions = fileExclusions.flatMap((e) => e.regions ?? []);

  interface Scope {
    names: Set<string>;
    closureVars: Map<string, ts.Node>;
    parent: Scope | null;
  }
  const moduleScope: Scope = { names: new Set(), closureVars: new Map(), parent: null };

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.pos).line + 1;

  const addViolation = (rule: RuleId, node: ts.Node, exprText?: string): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart());
    const expr = norm(exprText ?? node.getText(sf));
    violations.push({
      file,
      rule,
      line: pos.line + 1,
      column: pos.character + 1,
      fn: enclosingFn(node),
      expr,
      message: `${RULE_DESCRIPTIONS[rule]} (${expr})`,
    });
  };

  const enclosingFn = (node: ts.Node): string => {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
      if (ts.isMethodDeclaration(cur)) return cur.name.getText();
      if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        ts.isVariableDeclaration(cur.parent) &&
        ts.isIdentifier(cur.parent.name)
      ) {
        return cur.parent.name.text;
      }
      cur = cur.parent;
    }
    return "<module>";
  };

  const inRegion = (node: ts.Node): boolean => {
    const l = lineOf(node);
    return regions.some(([a, b]) => l >= a && l <= b);
  };

  const resolveIdentifier = (
    name: string,
    scope: Scope,
  ): { kind: "closure" | "bound" } | null => {
    let s: Scope | null = scope;
    while (s) {
      if (s.closureVars.has(name)) return { kind: "closure" };
      if (s.names.has(name)) return { kind: "bound" };
      s = s.parent;
    }
    return null;
  };

  const checkClosurePassThrough = (node: ts.Identifier, scope: Scope): void => {
    if (resolveIdentifier(node.text, scope)?.kind === "closure") {
      addViolation("closure-escape", node, node.text);
    }
  };

  const isEnvRoot = (name: string): boolean => ENV_ROOTS.has(name);

  const checkIdentifierReference = (node: ts.Identifier, scope: Scope): void => {
    if (inTypePosition(node)) return;
    const p = node.parent;
    const isMemberName =
      (ts.isPropertyAccessExpression(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessor(p) ||
        ts.isSetAccessor(p)) &&
      p.name === node;
    if (isMemberName) return;
    if (ts.isQualifiedName(p) && p.right === node) return;
    const res = resolveIdentifier(node.text, scope);
    if (res) return;
    if (isEnvRoot(node.text)) {
      addViolation("env-access", node, node.text);
      return;
    }
    if (!GLOBAL_ALLOWLIST.has(node.text)) {
      addViolation("unknown-global", node, node.text);
    }
  };

  const bindPattern = (name: ts.BindingName, scope: Scope): void => {
    if (ts.isIdentifier(name)) {
      scope.names.add(name.text);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) bindPattern(el.name, scope);
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if ("name" in el && el.name) bindPattern(el.name, scope);
      }
    }
  };

  const bindImportNames = (node: ts.ImportDeclaration, scope: Scope): void => {
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) scope.names.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb) {
      if (ts.isNamedImports(nb)) {
        for (const el of nb.elements) scope.names.add((el.propertyName ?? el.name).text);
      } else if (ts.isNamespaceImport(nb)) {
        scope.names.add(nb.name.text);
      }
    }
  };

  const checkImport = (node: ts.ImportDeclaration): void => {
    const spec = node.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) {
      addViolation("import-specifier", spec, "?");
      return;
    }
    const s = spec.text;
    if (s.startsWith(".")) {
      const baseDir = path.posix.dirname(file);
      const resolved = path.posix.normalize(path.posix.join(baseDir, s.replace(/\.js$/, ".ts")));
      const insideKernel = resolved.startsWith("kernel/src/");
      const candidates = insideKernel
        ? [resolved, resolved.replace(/\.ts$/, ".js"), `${resolved}.d.ts`]
        : [];
      if (!insideKernel || !candidates.some((c) => fs.existsSync(c))) {
        addViolation("import-specifier", spec, s);
      }
    } else if (s.startsWith("node:")) {
      if (!BUILTIN_IMPORT_ALLOWLIST.has(s)) addViolation("import-specifier", spec, s);
    } else {
      addViolation("import-specifier", spec, s);
    }
  };

  const registerFunctionName = (name: string | undefined): void => {
    if (name) functions.add(name);
  };

  const visit = (node: ts.Node, scope: Scope): void => {
    if (!node || inRegion(node)) return;

    if (
      (ts.isFunctionDeclaration(node) && node.name && excludedFns.has(node.name.text)) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        excludedFns.has(node.name.text) &&
        !!node.initializer &&
        isFunctionLike(node.initializer))
    ) {
      if (ts.isFunctionDeclaration(node)) registerFunctionName(node.name?.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        scope.names.add(node.name.text);
        registerFunctionName(node.name.text);
      }
      return;
    }

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.Decorator)) {
        addViolation("decorator", node, "@decorated");
      }
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        addViolation("async", node, "async");
      }
      const anyFn = node as ts.FunctionLikeDeclaration;
      if (anyFn.asteriskToken) addViolation("generator", node, "*generator");
      if (ts.isFunctionDeclaration(node) && node.name) {
        registerFunctionName(node.name.text);
        scope.names.add(node.name.text);
      }
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        registerFunctionName(node.name.text);
      }
      const child: Scope = { names: new Set(), closureVars: new Map(), parent: scope };
      for (const p of anyFn.parameters) bindPattern(p.name, child);
      // Hoist nested function-declaration names so forward references resolve
      // (JS hoists declarations; the guard's sequential walk must mirror that).
      collectNestedDeclNames(node, child.names);
      ts.forEachChild(node, (c) => visit(c, child));
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.Decorator)) {
        addViolation("decorator", node, "@decorated");
      }
      addViolation("class", node, ts.isClassDeclaration(node) && node.name ? node.name.text : "class");
      return;
    }

    if (ts.isMetaProperty(node)) {
      addViolation("env-access", node, node.getText());
      return;
    }

    if (ts.isAwaitExpression(node)) {
      addViolation("async", node, "await");
      visit(node.expression, scope);
      return;
    }

    if (node.kind === ts.SyntaxKind.YieldExpression) {
      addViolation("generator", node, "yield");
      return;
    }

    if (ts.isReturnStatement(node)) {
      if (node.expression) {
        if (isFunctionLike(node.expression)) {
          addViolation("closure-escape", node.expression, `return ${norm(node.expression.getText(sf)).slice(0, 40)}…`);
          return;
        }
        if (ts.isIdentifier(node.expression)) {
          checkClosurePassThrough(node.expression, scope);
          return;
        }
        visit(node.expression, scope);
      }
      return;
    }

    if (ts.isThrowStatement(node)) {
      visit(node.expression, scope);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, scope);
      bindPattern(node.name, scope);
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isFunctionLike(node.initializer)
      ) {
        scope.closureVars.set(node.name.text, node.initializer);
      }
      return;
    }

    if (ts.isImportDeclaration(node)) {
      checkImport(node);
      bindImportNames(node, scope);
      return;
    }

    if (ts.isCatchClause(node)) {
      if (node.variableDeclaration) bindPattern(node.variableDeclaration.name, scope);
      ts.forEachChild(node, (c) => visit(c, scope));
      return;
    }

    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "Function") {
          addViolation("eval", callee, "new Function");
          return;
        }
        if (!CONSTRUCTOR_ALLOWLIST.has(callee.text)) {
          addViolation("unwhitelisted-constructor", callee, callee.text);
        }
        checkIdentifierReference(callee, scope);
      } else {
        visit(callee, scope);
      }
      for (const a of node.arguments ?? []) visit(a, scope);
      return;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        addViolation("eval", node, "import(...)");
      } else if (ts.isIdentifier(callee)) {
        if (callee.text === "eval" || callee.text === "require") {
          addViolation("eval", callee, callee.text);
        } else {
          checkIdentifierReference(callee, scope);
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const root = chainRoot(callee);
        const rootIsForeignGlobal =
          root !== null &&
          !resolveIdentifier(root.text, scope) &&
          !GLOBAL_ALLOWLIST.has(root.text);
        if (!rootIsForeignGlobal && !METHOD_ALLOWLIST.has(callee.name.text)) {
          addViolation("unwhitelisted-method", callee.name, callee.name.text);
        }
        visit(callee.expression, scope);
      } else {
        visit(callee, scope);
      }
      for (const a of node.arguments ?? []) {
        if (ts.isIdentifier(a)) checkClosurePassThrough(a, scope);
        visit(a, scope);
      }
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      if (ts.isIdentifier(node.initializer)) checkClosurePassThrough(node.initializer, scope);
      visit(node.initializer, scope);
      return;
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      if (ts.isIdentifier(node.name)) checkClosurePassThrough(node.name, scope);
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (ts.isIdentifier(node.right)) checkClosurePassThrough(node.right, scope);
      visit(node.left, scope);
      visit(node.right, scope);
      return;
    }

    if (ts.isIdentifier(node)) {
      checkIdentifierReference(node, scope);
      return;
    }

    ts.forEachChild(node, (c) => visit(c, scope));
  };

  // Module-scope pre-scan: bind top-level declaration names before walking,
  // so references resolve regardless of statement order.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      bindImportNames(stmt, moduleScope);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          moduleScope.names.add(d.name.text);
          if (d.initializer && isFunctionLike(d.initializer)) {
            moduleScope.closureVars.set(d.name.text, d.initializer);
            registerFunctionName(d.name.text);
          }
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      moduleScope.names.add(stmt.name.text);
      registerFunctionName(stmt.name.text);
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      moduleScope.names.add(stmt.name.text);
    }
  }

  ts.forEachChild(sf, (c) => visit(c, moduleScope));

  return { violations, functions };
}

export function evaluate(opts: GuardOptions = {}): GuardResult {
  const exceptions = opts.exceptions ?? EXCEPTIONS;
  const excluded = opts.excluded ?? EXCLUDED_FUNCTIONS;

  const allViolations: Violation[] = [];
  const functionsByFile = new Map<string, Set<string>>();
  for (const file of GUARDED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    const r = guardSource(file, source, { excluded });
    allViolations.push(...r.violations);
    functionsByFile.set(file, r.functions);
  }

  const usedExceptions = new Set<GuardException>();
  const unregistered: Violation[] = [];
  for (const v of allViolations) {
    const hit = exceptions.find(
      (e) =>
        e.file === v.file &&
        e.rule === v.rule &&
        e.fn === v.fn &&
        norm(e.expr) === v.expr,
    );
    if (hit) usedExceptions.add(hit);
    else unregistered.push(v);
  }

  const expired = exceptions.filter((e) => !usedExceptions.has(e));
  const expiredExclusions = excluded.filter((ex) => {
    const fns = functionsByFile.get(ex.file);
    return !fns || !fns.has(ex.fn);
  });

  return { violations: allViolations, unregistered, expired, expiredExclusions };
}
