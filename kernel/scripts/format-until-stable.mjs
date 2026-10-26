// prettier's layout heuristic is occasionally non-idempotent: a single
// --write can land on an intermediate layout its own --check rejects (#416).
// Rewrite until --check is green; fail after MAX_PASSES instead of looping.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.platform === "win32" ? "prettier.cmd" : "prettier";
const MAX_PASSES = 5;

// prettier is hoisted to the repo-root node_modules in the monorepo layout;
// `npm --prefix kernel run format` puts the ancestor .bin dirs on PATH.
function run(args) {
  execFileSync(bin, args, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

let writes = 0;
for (;;) {
  try {
    run(["--check", "."]);
    console.log(
      `format: stable after ${writes} rewrite pass${writes === 1 ? "" : "es"}`,
    );
    process.exit(0);
  } catch {}
  if (writes >= MAX_PASSES) {
    console.error(
      `format: prettier did not converge after ${MAX_PASSES} passes`,
    );
    process.exit(1);
  }
  run(["--write", "."]);
  writes++;
}
