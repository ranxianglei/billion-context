import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SessionStore } from "../src/persist.ts";
import { gcSessionFiles } from "../src/session-gc.ts";

const now = 1_800_000_000_000;
const day = 86_400_000;
const root = mkdtempSync(path.join(tmpdir(), "bili-gc-suffix-"));
const env = {
    BILI_CONFIG_FILE: path.join(root, "no-config.json"), BILI_STORAGE_UNIFIED: "legacy",
    BILI_PERSIST_ZSTD: "0", BILI_SESSION_GC: "1", BILI_SESSION_GC_MAX_AGE_DAYS: "7",
    BILI_SESSION_GC_MAX_TOKENS: "1000000",
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
after(() => {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

async function fixture(run: (f: {
    write: (name: string, value: unknown, old?: boolean) => string;
    session: (name: string, old?: boolean) => string;
    companion: (name: string, value?: unknown, old?: boolean) => string;
    sweep: () => ReturnType<typeof gcSessionFiles>;
    store: SessionStore;
    dir: string;
}) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(root, "case-"));
    const store = new SessionStore({ dir });
    const write = (name: string, value: unknown, old = true) => {
        const full = path.join(dir, name);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
        const time = new Date(old ? now - 10 * day : now);
        utimesSync(full, time, time);
        return full;
    };
    try {
        await run({ write, store, dir,
            session: (name, old = false) => write(name, {
                version: 1, id: name, savedAt: old ? now - 10 * day : now,
                state: { blocks: [] }, contextTokens: 12,
            }, old),
            companion: (name, value = { version: 1, byHash: { h: "original" }, byRef: {} }, old = true) => write(name, value, old),
            sweep: () => gcSessionFiles({ dir, store, now, imgRoot: path.join(root, "images") }),
        });
    } finally {
        store.closeQuietly();
    }
}

for (const stem of ["abc", "a_b", "雪🧭"]) {
    test(`orphan checks preserve arbitrary suffix matches across namespaces: ${stem}`, async () => {
        await fixture(async ({ session, companion, sweep }) => {
            session(`openai/any-prefix${stem}.json`);
            const content = companion(`_unknown/${stem}.content-store.json`);
            const original = readFileSync(content);
            const result = await sweep();
            assert.equal(result.kept, 2);
            assert.equal(result.companionsRemoved, 0);
            assert.deepEqual(readFileSync(content), original);
        });
    });
}

test("similar nonmatching suffixes do not keep orphaned content", async () => {
    await fixture(async ({ session, companion, sweep }) => {
        const live = session("openai/host_abc-other.json");
        const orphan = companion("_unknown/abc.content-store.json");
        assert.equal((await sweep()).companionsRemoved, 1);
        assert.equal(existsSync(orphan), false);
        assert.equal(existsSync(live), true);
    });
});

for (const unreadable of ["{bad-json", { version: 7, byHash: {}, byRef: {} }]) {
    test(`co-deletion retains a live fallback when a twin's own store is unreadable: ${typeof unreadable}`, async () => {
        await fixture(async ({ session, companion, sweep }) => {
            const stale = session("_unknown/abc.json", true);
            const fallback = companion("_unknown/abc.content-store.json");
            const live = session("openai/host_abc.json");
            const own = companion("openai/host_abc.content-store.json", unreadable);
            const result = await sweep();
            assert.equal(result.removed, 1);
            assert.equal(result.companionsRemoved, 0);
            assert.equal(existsSync(stale), false);
            for (const file of [fallback, live, own]) assert.equal(existsSync(file), true);
        });
    });
}

test("deleted twins no longer reference either companion in the same sweep", async () => {
    await fixture(async ({ session, companion, sweep }) => {
        const files = [session("_unknown/abc.json", true), companion("_unknown/abc.content-store.json"),
            session("openai/host_abc.json", true), companion("openai/host_abc.content-store.json")];
        const result = await sweep();
        assert.equal(result.removed, 2);
        assert.equal(result.companionsRemoved, 2);
        for (const file of files) assert.equal(existsSync(file), false);
    });
});

test("co-deletion probes adopted twin stores in the original filesystem-walk order", async () => {
    await fixture(async ({ session, companion, sweep, store, dir }) => {
        session("_unknown/key.json", true);
        const fallback = companion("_unknown/key.content-store.json");
        session("a/zzkey.json");
        const a = companion("a/zzkey.content-store.json");
        session("z/aakey.json");
        const z = companion("z/aakey.content-store.json");
        const expected = readdirSync(dir).filter((name) => name === "a" || name === "z").map((name) => name === "a" ? a : z);
        const observed: string[] = [];
        const read = store.readRawFile.bind(store);
        store.readRawFile = async (file) => {
            if (file === a || file === z) observed.push(file);
            return read(file);
        };
        const result = await sweep();
        assert.equal(result.companionsRemoved, 1);
        assert.equal(existsSync(fallback), false);
        assert.deepEqual(observed, expected);
        assert.equal(existsSync(a), true);
        assert.equal(existsSync(z), true);
    });
});

test("empty-session snapshots still collect old orphans but keep fresh stores", async () => {
    await fixture(async ({ companion, sweep }) => {
        const old = companion("_unknown/old.content-store.json");
        const fresh = companion("_unknown/new.content-store.json", undefined, false);
        const result = await sweep();
        assert.equal(result.companionsRemoved, 1);
        assert.equal(result.kept, 1);
        assert.equal(existsSync(old), false);
        assert.equal(existsSync(fresh), true);
    });
});

test("each sweep rebuilds its lookup from the current filesystem snapshot", async () => {
    await fixture(async ({ session, companion, sweep }) => {
        const live = session("openai/host_abc.json");
        const content = companion("_unknown/abc.content-store.json");
        assert.equal((await sweep()).companionsRemoved, 0);
        rmSync(live);
        assert.equal((await sweep()).companionsRemoved, 1);
        assert.equal(existsSync(content), false);
    });
});
