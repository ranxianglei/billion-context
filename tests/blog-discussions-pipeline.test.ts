/**
 * #5414 — the blog-pipeline script (scripts/blog-discussions.mjs) pinned with a
 * mocked fetch: three-layer idempotency, fail-loud on unverifiable state, and
 * the protection-aware write-back fallback (direct commit rejected -> fixed
 * branch + one PR). No network access happens anywhere in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_URL = new URL("../scripts/blog-discussions.mjs", import.meta.url).href;

type Rule = {
    name: string;
    match: (method: string, url: string, body: unknown) => boolean;
    status?: number;
    json?: unknown;
};

const isGql = (url: string) => url.endsWith("/graphql");
const gqlHas = (frag: string) => (_m: string, _u: string, body: unknown) =>
    isGql(_u) && String((body as { query?: string })?.query ?? "").includes(frag);

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function installFetch(rules: Rule[]) {
    const hits: string[] = [];
    const bodies: Array<{ name: string; body: unknown }> = [];
    (globalThis as Record<string, unknown>).fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        let bodyObj: unknown = null;
        if (typeof init?.body === "string") {
            try { bodyObj = JSON.parse(init.body); } catch { /* non-JSON body — leave null */ }
        }
        const rule = rules.find((r) => r.match(method, url, bodyObj));
        if (!rule) throw new Error(`blog-pipeline stub: no route for ${method} ${url}`);
        hits.push(rule.name);
        bodies.push({ name: rule.name, body: bodyObj });
        const status = rule.status ?? 200;
        const payload = rule.json ?? {};
        return {
            ok: status >= 200 && status < 400,
            status,
            json: async () => payload,
            text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
        } as unknown as Response;
    }) as typeof fetch;
    return { hits, bodies };
}

function setEnv(manifestJson: string, extra?: Record<string, string | undefined>) {
    process.env.GITHUB_REPOSITORY = "o/r";
    process.env.GITHUB_TOKEN = "stub-token";
    process.env.GITHUB_REF_NAME = "master";
    process.env.BILI_BLOG_PIPELINE_TEST = "1";
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.BILI_BLOG_DRY_RUN;
    for (const [k, v] of Object.entries(extra ?? {})) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

async function runScript(facet: number) {
    (globalThis as Record<string, unknown>).__biliBlogPipelineError = undefined;
    await import(`${SCRIPT_URL}?facet=${facet}`);
    return (globalThis as Record<string, unknown>).__biliBlogPipelineError as Error | undefined;
}

const manifestRule = (name: string, entries: unknown[]): Rule => ({
    name,
    match: (m, u) => m === "GET" && u.includes("/repos/o/r/contents/website/articles.json"),
    json: { encoding: "base64", content: b64(JSON.stringify({ articles: entries })) },
});

const verifyRule = (name: string, num: number, resolves: boolean, httpStatus = 200): Rule => ({
    name,
    match: (m, u, body) => gqlHas("discussion(number")(m, u, body)
        && Number((body as { variables?: { num?: number } })?.variables?.num) === num,
    status: httpStatus,
    json: resolves
        ? { data: { repository: { discussion: { number: num } } } }
        : { errors: [{ message: "boom — network said no" }] },
});

const categoriesRule: Rule = {
    name: "gql-categories",
    match: (_m, _u, body) => gqlHas("discussionCategories")(_m, _u, body),
    json: { data: { repository: { discussionCategories: { nodes: [{ id: "CAT1", slug: "general" }] } } } },
};

const repoIdRule: Rule = {
    name: "gql-repo-id",
    match: (_m, u, body) => {
        const q = String((body as { query?: string } | null)?.query ?? "");
        return isGql(u) && !q.includes("createDiscussion") && !q.includes("discussionCategories")
            && !q.includes("discussions(first") && !q.includes("discussion(number");
    },
    json: { data: { repository: { id: "RID1" } } },
};

const threadNodesRule = (name: string, nodes: unknown[]): Rule => ({
    name,
    match: (_m, _u, body) => gqlHas("discussions(first")(_m, _u, body),
    json: { data: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
});

const createRule = (name: string, number: number): Rule => ({
    name,
    match: (_m, _u, body) => gqlHas("createDiscussion")(_m, _u, body),
    json: { data: { createDiscussion: { node: { number, url: `https://example.invalid/d/${number}` } } } },
});

const putMasterRule = (name: string, opts: { blocked?: boolean } = {}): Rule => ({
    name,
    match: (m, _u, body) => m === "PUT" && _u.includes("/contents/website/articles.json")
        && (body as { branch?: string })?.branch === "master",
    status: opts.blocked ? 403 : 200,
    json: opts.blocked
        ? { message: "You are not allowed to push here. The branch master is protected." }
        : {},
});

/* ---------------------------------- facets ---------------------------------- */

test("recorded number still resolves -> entry skipped; nothing created, nothing written", async () => {
    const entries = [{ file: "website/blog/posts/a.md", slug: "a", discussion: 7 }];
    setEnv(JSON.stringify({ articles: entries }));
    const { hits } = installFetch([
        manifestRule("manifest-get", entries),
        verifyRule("verify-7", 7, true),
        categoriesRule,
        repoIdRule,
        threadNodesRule("gql-thread-scan", []),
        createRule("gql-create", 88),
        putMasterRule("put-master"),
    ]);
    const err = await runScript(1);
    assert.equal(err, undefined);
    assert.ok(hits.includes("verify-7"));
    assert.ok(!hits.includes("gql-create"), "must not create when the recorded thread still exists");
    assert.ok(!hits.includes("put-master"), "no numbers changed -> no write-back");
});

test("unverifiable recorded number -> fails loud, never duplicates the thread", async () => {
    const entries = [{ file: "website/blog/posts/a.md", slug: "a", discussion: 7 }];
    setEnv(JSON.stringify({ articles: entries }));
    const { hits } = installFetch([
        manifestRule("manifest-get", entries),
        verifyRule("verify-7-dead", 7, false, 500),
        categoriesRule,
        repoIdRule,
        createRule("gql-create", 88),
        putMasterRule("put-master"),
    ]);
    const err = await runScript(2);
    assert.ok(err instanceof Error);
    assert.match(err!.message, /aborting to avoid duplicates/);
    assert.ok(!hits.includes("gql-create"));
    assert.ok(!hits.includes("put-master"));
});

test("marker already present in a recent thread -> records that number without creating", async () => {
    const entries = [{ file: "website/blog/posts/a.md", slug: "a" }];
    setEnv(JSON.stringify({ articles: entries }));
    const { hits, bodies } = installFetch([
        manifestRule("manifest-get", entries),
        categoriesRule,
        repoIdRule,
        threadNodesRule("gql-thread-scan", [{ number: 42, bodyText: "mirror <!-- bili-blog:a --> tail" }]),
        createRule("gql-create", 88),
        putMasterRule("put-master"),
    ]);
    const err = await runScript(3);
    assert.equal(err, undefined);
    assert.ok(!hits.includes("gql-create"), "marker found -> no second thread");
    assert.ok(hits.includes("put-master"), "the discovered number must be recorded");
    const pb = bodies.find((b) => b.name === "put-master")!.body as { content: string; message: string };
    const decoded = JSON.parse(Buffer.from(pb.content, "base64").toString("utf8")) as { articles: Array<{ discussion?: number }> };
    assert.equal(decoded.articles[0].discussion, 42);
    assert.match(pb.message, /^\[bili-blog-pipeline\] record discussion threads \(a→#42\)$/);
});

test("direct write-back blocked by branch protection -> fixed branch + exactly one PR", async () => {
    const entries = [{ file: "website/blog/posts/a.md", slug: "a" }];
    setEnv(JSON.stringify({ articles: entries }));
    const { hits, bodies } = installFetch([
        manifestRule("manifest-get", entries),
        categoriesRule,
        repoIdRule,
        threadNodesRule("gql-thread-scan", []),
        createRule("gql-create", 99),
        {
            name: "get-post-a",
            match: (m, u) => m === "GET" && u.includes("/repos/o/r/contents/website/blog/posts/a.md"),
            json: { encoding: "base64", content: b64("---\ntitle: Test A\ntitle_zh: 测试A\n---\n\n# Test A\n\nEnglish body line.\n") },
        },
        putMasterRule("put-master-blocked", { blocked: true }),
        {
            name: "get-wb-ref-missing",
            match: (m, u) => m === "GET" && u === "https://api.github.com/repos/o/r/git/ref/heads/bili-blog-pipeline-manifest",
            status: 404,
            json: { message: "Not Found" },
        },
        { name: "post-wb-ref", match: (m, u) => m === "POST" && u === "https://api.github.com/repos/o/r/git/refs", json: {} },
        { name: "get-head-sha", match: (m, u) => m === "GET" && u === "https://api.github.com/repos/o/r/commits/master", json: { sha: "abc123" } },
        {
            name: "get-wb-file-sha",
            match: (m, u) => m === "GET" && u.includes("/contents/website/articles.json?ref=bili-blog-pipeline-manifest"),
            json: { sha: "filesha1" },
        },
        {
            name: "put-wb-branch",
            match: (m, _u, body) => m === "PUT" && _u.includes("/contents/website/articles.json")
                && (body as { branch?: string })?.branch === "bili-blog-pipeline-manifest",
            json: {},
        },
        { name: "get-open-prs-none", match: (m, u) => m === "GET" && u.includes("/repos/o/r/pulls?head=o:bili-blog-pipeline-manifest"), json: [] },
        { name: "post-pr-open", match: (m, u) => m === "POST" && u === "https://api.github.com/repos/o/r/pulls", json: { number: 77 } },
    ]);
    const err = await runScript(4);
    assert.equal(err, undefined);
    assert.ok(hits.filter((h) => h.startsWith("put-master")).length === 1, "exactly one (rejected) attempt on master");
    assert.ok(hits.includes("post-wb-ref"), "fallback must cut the fixed branch");
    assert.ok(hits.includes("put-wb-branch"), "numbers land on the fixed branch");
    assert.ok(hits.includes("post-pr-open"), "one PR opened for the human merge step");
    const pr = bodies.find((b) => b.name === "post-pr-open")!.body as { title: string; head: string; base: string };
    assert.match(pr.title, /^\[bili-blog-pipeline\] record discussion threads \(a→#99\)$/);
    assert.equal(pr.head, "bili-blog-pipeline-manifest");
    assert.equal(pr.base, "master");
});

test("push made only of our own write-back commits -> early no-op after reading the manifest", async () => {
    const entries = [{ file: "website/blog/posts/a.md", slug: "a", discussion: 7 }];
    const eventFile = join(tmpdir(), `blog-event-${process.pid}-${Date.now()}.json`);
    writeFileSync(eventFile, JSON.stringify({ commits: [{ message: "[bili-blog-pipeline] record discussion threads (a→#7)" }] }));
    setEnv(JSON.stringify({ articles: entries }), { GITHUB_EVENT_PATH: eventFile });
    try {
        const { hits } = installFetch([
            manifestRule("manifest-get", entries),
            categoriesRule,
            repoIdRule,
            verifyRule("verify-7", 7, true),
            threadNodesRule("gql-thread-scan", []),
            createRule("gql-create", 88),
            putMasterRule("put-master"),
        ]);
        const err = await runScript(5);
        assert.equal(err, undefined);
        assert.deepEqual(hits, ["manifest-get"], "nothing but the manifest read may happen");
    } finally {
        unlinkSync(eventFile);
    }
});
