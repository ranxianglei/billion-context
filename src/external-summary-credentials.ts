import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { configFile } from "./paths.js";
import { loadConfigFile, loadNamedProviders, loadRoutes, type NamedProviderRecipe } from "./config.js";
import { expandExternalSummaryChain, parseExternalSummaryChain, validSummaryCredentialName } from "./external-summary-settings.js";

function validKey(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
}

/** #3488: resolve() has three distinct failure shapes (reference unset, value
 *  unusable, store unreadable) plus success; configured() collapsed all of
 *  them to `false`, so the UI could not tell an unset env var from a value
 *  full of whitespace or a corrupt private store. */
export type SummaryCredentialState = "configured" | "missing" | "invalid_value" | "store_unreadable" | "invalid_reference";

export function describeCredentialState(reference: string, state: SummaryCredentialState): string {
    switch (state) {
        case "configured": return `${reference} resolves to a usable credential`;
        case "missing": return reference.startsWith("env:") ? `environment variable ${reference.slice(4)} is not set` : `credential "${reference.slice(7)}" is not in the private store`;
        case "invalid_value": return `environment variable ${reference.slice(4)} holds an unusable value (empty, whitespace/control characters, or over 8192 chars)`;
        case "store_unreadable": return "the private credential store is unreadable (permissions or contents)";
        case "invalid_reference": return `${reference} is not a valid credential reference`;
    }
}

/** Separate from configFile(): normal config GET/raw exports never read these bytes. */
export class SummaryCredentialStore {
    constructor(private readonly path: string = `${configFile()}.summary-credentials.json`) {}

    private read(): Record<string, string> {
        if (!existsSync(this.path)) return Object.create(null) as Record<string, string>;
        try {
            const stat = lstatSync(this.path);
            if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error();
            if (stat.size > 256 * 1024) throw new Error();
            const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
            const result = Object.create(null) as Record<string, string>;
            for (const [name, key] of Object.entries(data)) {
                if (!validSummaryCredentialName(name) || !validKey(key)) throw new Error();
                result[name] = key;
            }
            return result;
        } catch { throw new Error("External summary credentials unavailable; repair the private store permissions or contents"); }
    }

    resolve(reference: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
        let value: unknown;
        if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) value = env[reference.slice(4)];
        else if (reference.startsWith("secret:") && validSummaryCredentialName(reference.slice(7))) value = this.read()[reference.slice(7)];
        else throw new Error("Invalid external summary credential reference");
        if (value === undefined) return undefined;
        if (!validKey(value)) throw new Error("Invalid external summary credential");
        return value;
    }

    configured(reference: string, env: NodeJS.ProcessEnv = process.env): boolean {
        try { return this.resolve(reference, env) !== undefined; } catch { return false; }
    }

    status(reference: string, env: NodeJS.ProcessEnv = process.env): SummaryCredentialState {
        if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
            const value = env[reference.slice(4)];
            return value === undefined ? "missing" : validKey(value) ? "configured" : "invalid_value";
        }
        if (reference.startsWith("secret:") && validSummaryCredentialName(reference.slice(7))) {
            let values: Record<string, string>;
            try { values = this.read(); } catch { return "store_unreadable"; }
            // Stored values are validated on write, so a present entry is always usable.
            return values[reference.slice(7)] === undefined ? "missing" : "configured";
        }
        return "invalid_reference";
    }

    set(name: string, key: string | null): void {
        if (!validSummaryCredentialName(name) || (key !== null && !validKey(key))) throw new Error("Invalid external summary credential");
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        // Multiple proxy instances may share the same config directory.
        let lock: number;
        try { lock = openSync(`${this.path}.lock`, "wx", 0o600); }
        catch { throw new Error("External summary credential store is locked or unavailable"); }
        const temp = `${this.path}.${randomUUID()}.tmp`;
        let descriptor: number | undefined;
        try {
            const values = this.read();
            if (key === null) delete values[name];
            else values[name] = key;
            if (Object.keys(values).length > 16) throw new Error("External summary credential store is full");
            descriptor = openSync(temp, "wx", 0o600);
            writeFileSync(descriptor, JSON.stringify(values) + "\n", "utf8");
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temp, this.path);
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            try { unlinkSync(temp); } catch { /* rename already consumed the temporary file */ }
            closeSync(lock);
            unlinkSync(`${this.path}.lock`);
        }
    }
}

/** #3488: readable problems for ONE raw chain block (file form). Unparseable
 *  blocks and unresolvable references both return [] — those surfaces are
 *  owned elsewhere (config validation / web save 400 / the request-path
 *  one-shot warn), and boot cannot see agent-registered recipes (#2336), so
 *  reporting a reference problem here would false-alarm on every start for
 *  chains that resolve fine once the plugin host registers its layer. */
export function auditExternalSummaryCredentials(block: unknown, recipes: Record<string, NamedProviderRecipe>, env: NodeJS.ProcessEnv = process.env): string[] {
    let chain;
    try { chain = parseExternalSummaryChain(block); } catch { return []; }
    if (!chain.enabled) return [];
    let targets;
    try { targets = expandExternalSummaryChain(chain, recipes).targets; }
    catch { return []; }
    const store = new SummaryCredentialStore();
    const problems: string[] = [];
    for (const target of targets) {
        const ref = target.credentialRef ?? (target.apiKey === undefined ? "" : "(inline)");
        if (ref === "") problems.push(`target ${target.name}: recipe carries no apiKeyEnv/credentialRef and no inline key`);
        else if (ref !== "(inline)") {
            const state = store.status(ref, env);
            if (state !== "configured") problems.push(`target ${target.name}: ${describeCredentialState(ref, state)}`);
        }
    }
    return problems;
}

/** #3488: boot-time scan of every EFFECTIVE enabled external-summary chain.
 *  Walks the same cascade mergeCompress uses (global → route → model, whole
 *  chain replace) so shadowed blocks are not reported, and identity-dedupes
 *  because one file object can be effective for many slots. Returns
 *  human-readable problem lines (empty when everything resolves). */
export function auditStartupSummaryCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
    // #3572/#3488: read the global block through loadConfigFile()'s tolerant
    // JSONC parser (the same one the runtime loader uses). safeReadJson is
    // strict JSON — a commented config silently evaluated to `file === null`
    // here, skipping the boot audit for every global externalSummary chain
    // while route-level chains (loadRoutes → loadConfigFile) still audited.
    const compress = loadConfigFile().compress;
    const globalBlock = compress && typeof compress === "object" && !Array.isArray(compress) ? (compress as { externalSummary?: unknown }).externalSummary : undefined;
    const routes = loadRoutes(env);
    const recipes = loadNamedProviders(env);
    const seen = new Set<unknown>();
    const problems: string[] = [];
    const audit = (block: unknown): void => {
        if (block === undefined || seen.has(block)) return;
        seen.add(block);
        for (const problem of auditExternalSummaryCredentials(block, recipes, env)) problems.push(problem);
    };
    audit(globalBlock);
    for (const route of Object.values(routes)) {
        const routeBlock = route.compress?.externalSummary;
        audit(routeBlock ?? globalBlock);
        for (const model of Object.values(route.models ?? {})) audit(model.compress?.externalSummary ?? routeBlock ?? globalBlock);
    }
    return problems;
}
