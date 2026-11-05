// #3496: the THREE LEDGERS of a dsh profile — the manifest's declared dep spec
// (package.json), the lockfile's recorded resolution (pnpm-lock.yaml /
// package-lock.json), and the on-disk bundle copy (node_modules/billion-context)
// — read, compared, and CONVERGED.
//
// Why this module exists: bili's desktop-lane self-heal swaps the on-disk copy
// in place (#1575) and #2894 taught it to follow the manifest spec — but the
// lockfile record stayed behind on purpose, so every in-place write left a
// latent wedge: dsh's in-app plugin manager reconciles node_modules against
// that stale record (silently reverting the update), or a hand-edited manifest
// (#3160: a spec the registry cannot resolve) makes the next
// `pnpm install` 404. This module closes the loop:
//   - the self-heal hook (src/update.ts) converges manifest + lockfile in the
//     SAME operation as the copy swap, so drift is never produced;
//   - `bili doctor --fix` (src/doctor.ts) converges pre-existing drift to the
//     on-disk copy version, printing exactly what changed.
//
// Comparison semantics are deliberately identical to #3231's provenance
// detection (same three rungs, same skip conditions, same loose specAdmits) so
// "detection says clean" and "convergence says done" can never disagree. When
// both land, the duplicated readers collapse into this module (follow-up).

import fs from "node:fs";
import path from "node:path";
import { DSH_DESKTOP_PROFILE, DSH_PACKAGE, dshProfileDepSpec, isRegistryDepSpec, planDshProfileManifestSpec } from "./dsh-channel.js";

type LedgerLockKind = "pnpm" | "npm" | "none";

interface DshLedgerState {
    /** The manifest's declared spec for billion-context (registry form or pin). */
    spec?: string;
    /** What the lockfile records as the DECLARED spec (may differ from the manifest). */
    lockSpecifier?: string;
    /** What the lockfile records as the RESOLVED version. */
    lockVersion?: string;
    /** The version of the on-disk bundle copy, or undefined when unreadable. */
    copyVersion?: string;
    lockKind: LedgerLockKind;
}

type LedgerFindingKind = "copy-vs-lock" | "manifest-vs-lock" | "copy-vs-manifest";

export interface LedgerFinding {
    profile: string;
    kind: LedgerFindingKind;
    copyVersion?: string;
    lockVersion?: string;
    spec?: string;
    detail: string;
}

export interface LedgerChangeDetail {
    file: string;
    field: string;
    before: string;
    after: string;
}

interface LedgerConvergenceResult {
    /** Profile-relative file names that were rewritten. Empty when nothing written. */
    changed: string[];
    /** Before→after for every ledger fact that moved (for the explicit report). */
    details: LedgerChangeDetail[];
    /** Human-readable notes (respected pins, missing lockfile, …). */
    notes: string[];
    /** Set when the state is not safely convergable — NOTHING was written. */
    error?: string;
}

const PKG_ESCAPED = DSH_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PKG_ENTRY_RE = new RegExp(`^([ \\t]+)${PKG_ESCAPED}:([ \\t]*(\\S+))?[ \\t]*$`);

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

function unquote(v: string): string {
    return v.replace(/^["']|["']$/g, "");
}

/** Plain-YAML-safe scalar: quote anything that could be misread (leading
 *  indicators like `>` or the alias indicator `*`, whitespace, …). Versions
 *  and ^/~ specs stay bare; a leading `*` is quoted because YAML would parse
 *  it as an alias token, not a spec (pnpm's own writer quotes it too). */
function yamlScalar(v: string): string {
    return /^[A-Za-z0-9.^~_-][\w.^~*-]*$/.test(v) ? v : JSON.stringify(v);
}

/** Read all three ledgers of one profile. Never throws; every absent part is
 *  simply undefined. */
export function readDshLedgerState(profileDir: string): DshLedgerState {
    const state: DshLedgerState = { spec: dshProfileDepSpec(profileDir), lockKind: "none" };
    const doc = readJsonFile(path.join(profileDir, "node_modules", DSH_PACKAGE, "package.json")) as { version?: unknown } | undefined;
    if (typeof doc?.version === "string") state.copyVersion = doc.version;
    const pnpm = readPnpmLockResolution(profileDir);
    if (pnpm !== undefined) {
        state.lockKind = "pnpm";
        state.lockSpecifier = pnpm.specifier;
        state.lockVersion = pnpm.version;
        return state;
    }
    const npm = readPackageLockResolution(profileDir);
    if (npm !== undefined) {
        state.lockKind = "npm";
        state.lockSpecifier = npm.specifier;
        state.lockVersion = npm.version;
    }
    return state;
}

interface LockResolution {
    specifier?: string;
    version?: string;
}

/** Read the lockfile's recorded resolution for billion-context. Handles the
 *  shapes pnpm emits (ported verbatim from #3231's provenance reader):
 *   - nested (lockfile ≥6): `billion-context:` entries with indented
 *     `specifier:`/`version:` fields (under `importers:` in v9, top-level
 *     `dependencies:` in v6–v8);
 *   - flat (lockfile ≤5.4): same-line values — under the top-level
 *     `specifiers:` section the value is the declared spec, under the flat
 *     `dependencies:` map it is the RESOLVED version.
 * Returns undefined when no lockfile exists or records no entry. */
function readPnpmLockResolution(profileDir: string): LockResolution | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8");
    } catch {
        return undefined;
    }
    const lines = text.split("\n");
    const out: LockResolution = {};
    let section = "";
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/^[ \t]/.test(line)) {
            section = line.match(/^([A-Za-z_][\w-]*):/)?.[1] ?? "";
            continue;
        }
        const m = line.match(PKG_ENTRY_RE);
        if (m === null) continue;
        if (m[3] !== undefined) {
            if (section === "specifiers" && out.specifier === undefined) out.specifier = unquote(m[3]);
            else if (section === "dependencies" && out.version === undefined) out.version = unquote(m[3]);
            continue;
        }
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
            const inner = lines[j];
            if (inner.trim() === "") continue;
            const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
            if (innerIndent <= indent) break;
            const spec = inner.match(/^\s*specifier:\s*(\S+)/);
            if (spec && out.specifier === undefined) out.specifier = unquote(spec[1]);
            const ver = inner.match(/^\s*version:\s*(\S+)/);
            if (ver && out.version === undefined) out.version = unquote(ver[1]);
        }
    }
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/** npm-materialized profiles record the same two facts in package-lock.json. */
function readPackageLockResolution(profileDir: string): LockResolution | undefined {
    const doc = readJsonFile(path.join(profileDir, "package-lock.json")) as
        | { packages?: Record<string, { version?: unknown; dependencies?: Record<string, unknown> }> }
        | undefined;
    if (doc?.packages === undefined) return undefined;
    const out: LockResolution = {};
    const spec = doc.packages[""]?.dependencies?.[DSH_PACKAGE];
    if (typeof spec === "string") out.specifier = spec;
    const resolved = doc.packages[`node_modules/${DSH_PACKAGE}`];
    if (resolved !== undefined && typeof resolved.version === "string") out.version = resolved.version;
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/** Does `spec` admit `version`? Exact/caret/tilde only; anything else
 *  (dist-tag, range, URL) returns undefined — UNJUDGABLE must stay silent,
 *  never a finding. Deliberately loose where semver would be stricter (same
 *  semantics as #3231's specAdmits, which gates a warning — err on fewer
 *  false positives). */
export function specAdmits(spec: string, version: string): boolean | undefined {
    const base = spec.replace(/^[~^]/, "");
    const parse = (s: string): [number, number, number] | undefined => {
        const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
    };
    const b = parse(base);
    const v = parse(version);
    if (b === undefined || v === undefined) return undefined;
    if (v[0] !== b[0]) return false;
    if (spec.startsWith("^")) return v[1] > b[1] || (v[1] === b[1] && v[2] >= b[2]);
    if (spec.startsWith("~")) return v[1] === b[1] && v[2] >= b[2];
    return v[1] === b[1] && v[2] === b[2];
}

function remediation(profile: string): string {
    return `run \`bili doctor --fix\` to converge the ledgers to the on-disk copy, or reinstall through the host channel (\`dsh plugin --profile ${profile} add ${DSH_PACKAGE}\` / \`bili plugin install dsh\`)`;
}

/** Pure per-profile audit: compare manifest spec / lockfile resolution /
 *  on-disk copy version (the three rungs of #3231). Never throws; [] for every
 *  skip condition (no dep, non-registry pin, no copy). The DETECTION surface
 *  (startup audit, plain `bili doctor`) excludes the desktop profile by design
 *  (#3224 option A — bili is its in-place writer); `--fix` passes
 *  includeDesktop because explicit repair must reach the very profile where
 *  the #3160 incident happened. */
export function dshProfileLedgerFindings(profileDir: string, opts?: { includeDesktop?: boolean }): LedgerFinding[] {
    const profile = path.basename(profileDir);
    if (profile === DSH_DESKTOP_PROFILE && !opts?.includeDesktop) return [];
    const spec = dshProfileDepSpec(profileDir);
    if (spec === undefined) return [];
    if (!isRegistryDepSpec(spec)) return [];
    const state = readDshLedgerState(profileDir);
    const copyVersion = state.copyVersion;
    if (copyVersion === undefined) return [];
    const findings: LedgerFinding[] = [];
    if (state.lockVersion !== undefined && state.lockVersion !== copyVersion) {
        findings.push({
            profile, kind: "copy-vs-lock", copyVersion, lockVersion: state.lockVersion, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not match the lockfile resolution v${state.lockVersion} — the copy was written out-of-band (the host package manager never resolved it); ${remediation(profile)}`,
        });
    }
    if (state.lockSpecifier !== undefined && state.lockSpecifier !== spec) {
        findings.push({
            profile, kind: "manifest-vs-lock", copyVersion, lockVersion: state.lockVersion, spec,
            detail: `profile manifest declares ${spec} but the lockfile records ${state.lockSpecifier} — the declaration changed without an install; the next package-manager run may fail or roll the copy back; ${remediation(profile)}`,
        });
    }
    if (state.lockKind === "none" && specAdmits(spec, copyVersion) === false) {
        findings.push({
            profile, kind: "copy-vs-manifest", copyVersion, spec,
            detail: `${DSH_PACKAGE} copy v${copyVersion} does not satisfy the manifest spec ${spec}, and no lockfile exists to explain the difference; ${remediation(profile)}`,
        });
    }
    return findings;
}

// — convergence (the fix half of #3496) ——————————————————————————————————————

type PnpmPatch = { kind: "ok"; next: string; details: LedgerChangeDetail[] } | { kind: "fail"; reason: string };

/** Index the top-level sections of a pnpm lockfile: key → [startLine, endLine)
 *  where endLine is the next column-0 line (or EOF). */
function topLevelSections(lines: string[]): Map<string, [number, number]> {
    const sections = new Map<string, [number, number]>();
    let current: [string, number] | undefined;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(/^([A-Za-z_][\w-]*):/);
        if (m !== null) {
            if (current !== undefined) sections.set(current[0], [current[1], i]);
            current = [m[1], i];
        } else if (current !== undefined && lines[i]!.trim() !== "" && !/^[ \t]/.test(lines[i]!)) {
            // a column-0 line that is not a `key:` line still ends the section
            sections.set(current[0], [current[1], i]);
            current = undefined;
        }
    }
    if (current !== undefined) sections.set(current[0], [current[1], lines.length]);
    return sections;
}

/** Patch every nested `billion-context:` entry (indented specifier:/version:
 *  children) inside the given line range. Returns the details of every field
 *  that actually changed. Fails (no partial result) when the expected entry or
 *  its fields cannot be found. */
function patchNestedEntries(lines: string[], from: number, to: number, spec: string, version: string): PnpmPatch {
    const details: LedgerChangeDetail[] = [];
    let patched = 0;
    for (let i = from; i < to; i++) {
        const m = lines[i]!.match(PKG_ENTRY_RE);
        if (m === null || m[3] !== undefined) continue; // same-line value — not a nested entry
        const indent = m[1].length;
        let sawSpecifier = false;
        let sawVersion = false;
        for (let j = i + 1; j < to; j++) {
            const inner = lines[j]!;
            if (inner.trim() === "") continue;
            const innerIndent = inner.match(/^[ \t]*/)?.[0].length ?? 0;
            if (innerIndent <= indent) break;
            const sm = inner.match(/^([ \t]*)specifier:[ \t]*(\S.*)?$/);
            if (sm !== null) {
                sawSpecifier = true;
                const want = yamlScalar(spec);
                if (unquote(sm[2] ?? "") !== spec) {
                    lines[j] = `${sm[1]}specifier: ${want}`;
                    details.push({ file: "pnpm-lock.yaml", field: "specifier", before: unquote(sm[2] ?? ""), after: spec });
                }
                continue;
            }
            const vm = inner.match(/^([ \t]*)version:[ \t]*(\S.*)?$/);
            if (vm !== null) {
                sawVersion = true;
                if (unquote(vm[2] ?? "") !== version) {
                    lines[j] = `${vm[1]}version: ${yamlScalar(version)}`;
                    details.push({ file: "pnpm-lock.yaml", field: "version", before: unquote(vm[2] ?? ""), after: version });
                }
            }
        }
        if (!sawSpecifier || !sawVersion) {
            return { kind: "fail", reason: "the lockfile's billion-context entry lacks both specifier: and version: fields — structure not recognized, manual repair needed" };
        }
        patched++;
    }
    if (patched === 0) return { kind: "fail", reason: "no billion-context entry found in the lockfile — run 'dsh plugin --profile <name> add billion-context' once so the package manager records the resolution, then retry" };
    return { kind: "ok", next: lines.join("\n"), details };
}

/** Patch the flat ≤5.4 same-line entries: `specifiers:` section carries the
 *  declared spec, `dependencies:` carries the resolved version. */
function patchFlatEntries(lines: string[], spec: string, version: string): PnpmPatch {
    const sections = topLevelSections(lines);
    const details: LedgerChangeDetail[] = [];
    const patchSection = (key: "specifiers" | "dependencies", value: string, field: string): string | undefined => {
        const range = sections.get(key);
        if (range === undefined) return `no top-level '${key}:' section in the lockfile`;
        for (let i = range[0] + 1; i < range[1]; i++) {
            const m = lines[i]!.match(PKG_ENTRY_RE);
            if (m === null || m[3] === undefined) continue;
            const cur = unquote(m[3]);
            if (cur !== value) {
                lines[i] = `${m[1]}${DSH_PACKAGE}: ${yamlScalar(value)}`;
                details.push({ file: "pnpm-lock.yaml", field, before: cur, after: value });
            }
            return undefined;
        }
        return `no ${DSH_PACKAGE} entry under the '${key}:' section`;
    };
    const err1 = patchSection("specifiers", spec, "specifier");
    if (err1 !== undefined) return { kind: "fail", reason: err1 };
    const err2 = patchSection("dependencies", version, "version");
    if (err2 !== undefined) return { kind: "fail", reason: err2 };
    return { kind: "ok", next: lines.join("\n"), details };
}

/** Rewrite the pnpm lockfile so it records (spec, version). Pure: returns the
 *  new text or a reason; never touches disk. */
export function patchPnpmLock(text: string, spec: string, version: string): PnpmPatch {
    const lines = text.split("\n");
    const sections = topLevelSections(lines);
    if (sections.has("importers")) {
        const range = sections.get("importers")!;
        return patchNestedEntries(lines, range[0], range[1], spec, version);
    }
    if (sections.has("specifiers")) {
        return patchFlatEntries(lines, spec, version);
    }
    // v6–v8: no importers, no specifiers — nested entries live under the
    // top-level dependencies:/devDependencies: maps.
    const candidates = ["dependencies", "devDependencies"].filter((k) => sections.has(k));
    if (candidates.length > 0) {
        const details: LedgerChangeDetail[] = [];
        let patched = 0;
        for (const key of candidates) {
            const range = sections.get(key)!;
            const sub = patchNestedEntries(lines.slice(range[0], range[1]), 0, range[1] - range[0], spec, version);
            if (sub.kind === "fail") {
                // an entry-less section is fine when another section holds the entry
                if (patched === 0 && !sub.reason.startsWith("no billion-context entry")) return sub;
                continue;
            }
            lines.splice(range[0], range[1] - range[0], ...sub.next.split("\n"));
            details.push(...sub.details);
            patched++;
        }
        if (patched === 0) return { kind: "fail", reason: "no billion-context entry found in the lockfile — run 'dsh plugin --profile <name> add billion-context' once so the package manager records the resolution, then retry" };
        return { kind: "ok", next: lines.join("\n"), details };
    }
    return { kind: "fail", reason: "lockfile shape not recognized (no importers/specifiers/dependencies sections)" };
}

/** Rewrite an npm package-lock.json so it records (spec, version). Pure. The
 *  stale integrity hash of the displaced version cannot be recomputed offline,
 *  so it is DROPPED when the version moves — npm re-fetches metadata on the
 *  next install instead of hard-failing verification against the old bytes. */
export function patchNpmLock(raw: string, spec: string, version: string): PnpmPatch {
    let doc: { packages?: Record<string, Record<string, unknown>> };
    try {
        doc = JSON.parse(raw) as { packages?: Record<string, Record<string, unknown>> };
    } catch {
        return { kind: "fail", reason: "malformed package-lock.json — manual repair needed" };
    }
    if (doc.packages === undefined) return { kind: "fail", reason: "package-lock.json has no packages map" };
    const details: LedgerChangeDetail[] = [];
    const root = doc.packages[""];
    if (root === undefined) return { kind: "fail", reason: "package-lock.json has no root (\"\") package entry" };
    const deps = (typeof root.dependencies === "object" && root.dependencies !== null ? root.dependencies : {}) as Record<string, unknown>;
    if (typeof deps[DSH_PACKAGE] === "string" && deps[DSH_PACKAGE] !== spec) {
        details.push({ file: "package-lock.json", field: "root dependencies[billion-context]", before: String(deps[DSH_PACKAGE]), after: spec });
    }
    deps[DSH_PACKAGE] = spec;
    root.dependencies = deps;
    const entry = doc.packages[`node_modules/${DSH_PACKAGE}`];
    if (entry === undefined) return { kind: "fail", reason: `package-lock.json has no node_modules/${DSH_PACKAGE} entry — manual repair needed` };
    if (typeof entry.version === "string" && entry.version !== version) {
        details.push({ file: "package-lock.json", field: "version", before: entry.version, after: version });
        entry.version = version;
        if (typeof entry.resolved === "string" && entry.resolved.includes(`/${DSH_PACKAGE}/-/${DSH_PACKAGE}-`)) {
            const nextResolved = entry.resolved.replace(new RegExp(`${PKG_ESCAPED}-[^/"]*\\.tgz$`), `${DSH_PACKAGE}-${version}.tgz`);
            if (nextResolved !== entry.resolved) details.push({ file: "package-lock.json", field: "resolved", before: entry.resolved, after: nextResolved });
            entry.resolved = nextResolved;
        }
        if (entry.integrity !== undefined) {
            details.push({ file: "package-lock.json", field: "integrity", before: "stale hash dropped", after: "(removed — re-fetched on next install)" });
            delete entry.integrity;
        }
    }
    return { kind: "ok", next: JSON.stringify(doc, null, 2) + "\n", details };
}

/** Atomic text write with the #2972-M1/#3157 discipline (tmp sibling + fsync
 *  + rename): a crash mid-write leaves the host-owned file byte-identical. */
function atomicWriteText(file: string, content: string): string | undefined {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        const fd = fs.openSync(tmp, "w");
        try {
            fs.writeFileSync(fd, content);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (e) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            /* best-effort cleanup */
        }
        return e instanceof Error ? e.message : String(e);
    }
    return undefined;
}

/**
 * Converge a profile's three ledgers to `targetVersion` (the on-disk copy's
 * version — the caller verifies copy === target before calling; this function
 * re-checks as a guard against racing writers). Single transaction: EVERY
 * planned write is computed and validated BEFORE anything is touched; a
 * healthy profile produces ZERO writes. Never throws — failures carry a
 * reason and leave all files untouched (a partially-written state is worse
 * than an untouched wedge, which detection still reports).
 *
 * Authority boundary: bili only rewrites the manifest spec in the forms
 * #2894 owns (^x.y.z / x.y.z). A spec that does not admit the copy but lies
 * outside that authority (tilde, dist-tag, range, local pin) is REFUSED, not
 * papered over — syncing the lockfile to the copy under such a spec would
 * produce a record pnpm itself calls unsatisfiable, i.e. a wedge wearing a
 * green badge. The finding stays visible; the user aligns the declaration.
 */
export function convergeDshLedger(profileDir: string, targetVersion: string): LedgerConvergenceResult {
    const notes: string[] = [];
    const state = readDshLedgerState(profileDir);
    const fail = (error: string): LedgerConvergenceResult => ({ changed: [], details: [], notes, error });

    const spec = state.spec;
    if (spec === undefined) return fail("no billion-context dependency declared in the profile manifest — nothing to converge");
    if (!isRegistryDepSpec(spec)) {
        notes.push(`local pin ${spec} respected — nothing written`);
        return { changed: [], details: [], notes };
    }
    if (state.copyVersion === undefined) return fail("no readable bundle copy under node_modules — converge needs the on-disk version as the meeting point (reinstall through the host channel first)");
    if (state.copyVersion !== targetVersion) {
        return fail(`on-disk copy is v${state.copyVersion}, not v${targetVersion} — refusing to converge against a moving target`);
    }

    // Manifest half — the exact #2894 rules, shared with the self-heal hook.
    const plan = planDshProfileManifestSpec(profileDir, targetVersion);
    let finalSpec = spec;
    if (plan.action === "rewrite") {
        finalSpec = plan.nextSpec ?? spec;
    } else if (plan.reason !== undefined && plan.reason.startsWith("non-version spec")) {
        // dist-tag / range / tilde: bili may not rewrite it. Admitting (or
        // unjudgeable) specs can still ride along — the lockfile converges and
        // the declaration stays the user's.
        if (specAdmits(spec, targetVersion) === false) {
            return fail(`manifest spec ${spec} does not admit the on-disk v${targetVersion} and is outside bili's rewrite authority (only ^x.y.z / x.y.z forms are converged) — align the declaration yourself, or reinstall through the host channel`);
        }
        notes.push(`spec ${spec} kept as declared (not a convergable form)`);
    } else if (plan.reason !== undefined) {
        // Defensive: spec was readable above, so plan's remaining reasons
        // ("no readable/malformed package.json") are unreachable here — but a
        // racing writer could change that between the two reads; fail clean.
        return fail(plan.reason);
    }

    // Lockfile half — planned in memory before any disk touch.
    let lockNext: string | undefined;
    let lockDetails: LedgerChangeDetail[] = [];
    if (state.lockKind === "none") {
        notes.push("no lockfile present — manifest/copy agreement is the whole story");
    } else {
        const lockFile = state.lockKind === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
        let raw: string;
        try {
            raw = fs.readFileSync(path.join(profileDir, lockFile), "utf8");
        } catch {
            return fail(`lockfile ${lockFile} vanished between read and patch — retry`);
        }
        const patch = state.lockKind === "pnpm" ? patchPnpmLock(raw, finalSpec, targetVersion) : patchNpmLock(raw, finalSpec, targetVersion);
        if (patch.kind === "fail") return fail(patch.reason);
        // Zero-writes contract: an already-in-step record produces NO write —
        // not even a byte-identical re-serialization (mtime churn on a
        // host-owned file is a write the user did not ask for).
        if (patch.details.length > 0) {
            lockNext = patch.next;
            lockDetails = patch.details;
        }
    }

    // Execute — both plans validated; each write is atomic on its own.
    const changed: string[] = [];
    const details: LedgerChangeDetail[] = [];
    if (plan.action === "rewrite") {
        const err = atomicWriteText(path.join(profileDir, "package.json"), plan.nextRaw ?? "");
        if (err !== undefined) return { changed, details, notes, error: `manifest write failed: ${err}` };
        changed.push("package.json");
        details.push({ file: "package.json", field: "dependencies[billion-context]", before: spec, after: finalSpec });
    }
    if (lockNext !== undefined) {
        const lockFile = state.lockKind === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
        const err = atomicWriteText(path.join(profileDir, lockFile), lockNext);
        if (err !== undefined) return { changed, details, notes, error: `lockfile write failed: ${err}${changed.length > 0 ? ` (package.json already updated — rerun to finish)` : ""}` };
        changed.push(lockFile);
        details.push(...lockDetails);
    }
    return { changed, details, notes };
}
