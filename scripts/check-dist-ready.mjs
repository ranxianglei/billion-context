// Install gate (#2471): the manifest entry points (main/bin/exports) exist
// only inside built dist/, which the repository does not carry. A consumer
// install from a git source used to pass as "success" and leave a package
// whose entries all dangle — the dsh profile loader then skips the bundle
// silently. prepare is the one checkpoint every such install passes through:
// pass when dist/ is ready, pass when a dev checkout can build it itself,
// and fail loudly — naming the supported install forms — for a consumer
// source install.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function distEntryReady(dir) {
    return existsSync(path.join(dir, "dist", "index.js"));
}

// The marker is .git, not a toolchain: package managers install devDependencies
// before running a git dependency's prepare (measured on pnpm 11.7.0 — the
// manager DSH Desktop bundles — which installed the full 537-package dev tree
// ahead of prepare), so "tsup is present" is true in exactly the consumer case
// this gate exists to catch. A dev/CI checkout carries .git; the fetched copy
// a package manager prepares a dependency from does not.
export function selfBuildableCheckout(dir) {
    return existsSync(path.join(dir, ".git"));
}

// npm runs a git dependency's prepare inside its cached clone, which KEEPS
// .git (measured in review on npm 10.9.8/pacote: prepare executes in
// _cacache/tmp/git-clone*, hasGit=true, exit 0, dangling entries) — so the
// .git marker alone cannot catch the npm lane. What separates it from a dev
// checkout is npm_config_local_prefix: npm points it at the CONSUMING
// install's root (the project or the -g prefix), never at the cloned
// package itself (#2471 review F2).
function sameDir(a, b) {
    const norm = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
    return norm(a) === norm(b);
}

export function distReadyVerdict(state) {
    if (state.distReady) return { ok: true, reason: "dist/ is present" };
    if (state.npmCommand === "pack" || state.npmCommand === "publish") {
        return { ok: false, reason: "packing/publishing requires a built dist/ — run npm run build first" };
    }
    if (state.localPrefix !== undefined && state.root !== undefined && !sameDir(state.localPrefix, state.root)) {
        return { ok: false, reason: "installed as a dependency from source — this copy belongs to a consuming install and has no loadable entry" };
    }
    if (state.selfBuildable) return { ok: true, reason: "dev checkout without dist/ — build it with npm run build" };
    return { ok: false, reason: "source install without dist/ — main/bin/exports all point into dist/, so the package has no loadable entry" };
}

const invoked = process.argv[1];
// Realpath both sides: Node resolves entry-point symlinks, so argv[1] can differ from import.meta.url
const isMain = !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
if (isMain) {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const verdict = distReadyVerdict({
        distReady: distEntryReady(root),
        selfBuildable: selfBuildableCheckout(root),
        npmCommand: process.env.npm_command,
        localPrefix: process.env.npm_config_local_prefix,
        root,
    });
    if (!verdict.ok) {
        console.error(`dist-ready: FAIL — ${verdict.reason}.`);
        console.error("dist-ready: install the published package instead of the git source:");
        console.error("dist-ready:   npm install -g billion-context");
        console.error("dist-ready:   dsh plugin --profile <name> add billion-context");
        console.error("dist-ready: (dev checkouts build dist/ with: npm run build)");
        process.exit(1);
    }
    console.log(`dist-ready: OK (${verdict.reason})`);
}
