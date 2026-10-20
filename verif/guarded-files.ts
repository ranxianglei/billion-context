// Tier A decision-core files under the sub-language guard (#3848/#3853).
// Repo-relative paths. Adding a file here subjects it to every rule in
// subset-guard.ts; removing one needs the same justification bar as adding
// an exception (the list itself is audited inventory).

export const GUARDED_FILES = [
  "kernel/src/compress.ts",
  "kernel/src/hide-consumed.ts",
  "kernel/src/refs.ts",
  "kernel/src/render-refs.ts",
  "kernel/src/truncate.ts",
  "kernel/src/truncate-tools.ts",
  "kernel/src/tokenize.ts",
  "kernel/src/rebuild.ts",
  "kernel/src/wire/openai.ts",
  "kernel/src/wire/responses.ts",
] as const;

export type GuardedFile = (typeof GUARDED_FILES)[number];
