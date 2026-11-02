#!/usr/bin/env node
/**
 * Blog pipeline — one GitHub Discussion per blog post, created automatically.
 *
 * Runs as a GitHub Action on pushes to master that touch the blog surface
 * (website/blog/posts/** or website/articles.json). For every manifest entry
 * without a recorded discussion number it creates ONE bilingual discussion
 * (English section first, then Chinese, per owner decision 2026-11-01) whose
 * body mirrors the article at creation time plus a canonical-source reference,
 * then records the numbers into website/articles.json on the fixed branch
 * bili-blog-pipeline-manifest plus one open PR (the same posture as
 * release-manual.yml). Repo policy: the pipeline NEVER pushes to master —
 * every manifest change lands in that one PR, which a human merges by house
 * rules; until it lands the button simply stays hidden. Write-back commits
 * are prefixed "[bili-blog-pipeline]": when that PR merges, the push event
 * consists only of our own write-backs and the run exits early.
 *
 * Idempotency is three-layered so a crash between "created" and "committed"
 * can never silently make a second thread:
 *   1. an entry whose recorded number still resolves is skipped outright;
 *   2. before creating, recent discussions are scanned for the invisible body
 *      marker  <!-- bili-blog:<slug> -->  left by an earlier run;
 *   3. the concurrency group in the workflow file serializes runs.
 *
 * No third-party service is ever contacted: api.github.com only (the raw host
 * is unreachable from large parts of the world; api.github.com works everywhere).
 * Node >= 20 (global fetch). Fails loud: any error exits non-zero and the next
 * qualifying push retries from scratch.
 *
 * BILI_BLOG_DRY_RUN=1 runs the entire pipeline (manifest read, category
 * resolution, idempotency scans, title/body build) against a real repository
 * but makes NO write calls: creations are printed instead and no write-back
 * commit is pushed. Used for pre-merge verification.
 */
import { readFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY || "ranxianglei/billion-context";
const [OWNER, NAME] = REPO.split("/");
const TOKEN = process.env.GITHUB_TOKEN || "";
const BRANCH = process.env.GITHUB_REF_NAME || "master";
const BASE = "https://api.github.com";
const GRAPHQL = `${BASE}/graphql`;
const MANIFEST_REL = "website/articles.json";
const WRITE_BACK_PREFIX = "[bili-blog-pipeline]";
const DRY_RUN = process.env.BILI_BLOG_DRY_RUN === "1";
const DISCUSSION_SCAN_PAGES = 2; // 100 per page — plenty for a human-sized repo
if (!TOKEN) {
    console.error("blog-discussions: GITHUB_TOKEN is required");
    process.exit(1);
}

/* ---------------------------- small HTTP layer ---------------------------- */

const authHeaders = () => ({
    authorization: `Bearer ${TOKEN}`,
    "user-agent": "bili-blog-pipeline",
});

async function rawFetch(url, init = {}) {
    return fetch(url, {
        ...init,
        headers: { accept: "application/vnd.github+json", ...authHeaders(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
    });
}

async function ghJson(url, init = {}) {
    const res = await rawFetch(url, init);
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json();
}

async function gql(query, variables) {
    const res = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${TOKEN}`,
            "user-agent": "bili-blog-pipeline",
            "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (Array.isArray(data.errors) && data.errors.length > 0)) {
        throw new Error(`graphql → ${res.status} ${(data.errors ?? []).map((e) => e.message).join("; ") || "unknown"}`);
    }
    return data.data;
}

async function readRepoFile(rel) {
    // Contents API (base64 JSON) — see header note about the raw host.
    const j = await ghJson(`${BASE}/repos/${REPO}/contents/${rel}?ref=${BRANCH}`);
    if (j.encoding !== "base64" || typeof j.content !== "string") {
        throw new Error(`contents API for ${rel} returned no decodable content`);
    }
    return Buffer.from(j.content, "base64").toString("utf8");
}

async function headSha(ref) {
    const j = await ghJson(`${BASE}/repos/${REPO}/commits/${ref}`);
    return j.sha;
}

const WRITE_BACK_BRANCH = "bili-blog-pipeline-manifest";
const AUTOPR_BODY = [
    "Automated by the blog pipeline (scripts/blog-discussions.mjs).",
    "",
    "Records newly created Discussion thread numbers into website/articles.json.",
    "Repo policy: the pipeline never pushes " + BRANCH + " directly; numbers land here",
    "as exactly one PR for a human merge (same posture as release-manual.yml).",
    "",
    "- One file changed: website/articles.json.",
    "- Safe to squash-merge. If the pipeline runs again before this merges,",
    "  the same branch/PR is refreshed in place.",
    "- Until merged, the discussion button stays hidden — nothing breaks.",
].join("\n");

/** The ONLY write-back path: a commit on the fixed branch + exactly one PR.
 *  Never touches "master" (owner decision 2026-11-02: no direct pushes, ever). */
async function writeBackViaPr(next, summary) {
    // 1) make sure the fixed branch exists at the branch head
    const refRes = await rawFetch(`${BASE}/repos/${REPO}/git/ref/heads/${WRITE_BACK_BRANCH}`);
    if (refRes.status === 404) {
        await ghJson(`${BASE}/repos/${REPO}/git/refs`, {
            method: "POST",
            body: JSON.stringify({ ref: `refs/heads/${WRITE_BACK_BRANCH}`, sha: await headSha(BRANCH) }),
        });
    }
    // 2) update the file ON THAT BRANCH (the contents API cannot create branches itself)
    let sha;
    try { sha = await shaOf(MANIFEST_REL, WRITE_BACK_BRANCH); } catch { sha = null; }
    await ghJson(`${BASE}/repos/${REPO}/contents/${MANIFEST_REL}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            message: `${WRITE_BACK_PREFIX} record discussion threads (${summary})`,
            content: Buffer.from(next, "utf8").toString("base64"),
            branch: WRITE_BACK_BRANCH,
            ...(sha ? { sha } : {}),
        }),
    });
    // 3) open — or reuse — exactly one PR for it
    const openPrs = await ghJson(`${BASE}/repos/${REPO}/pulls?head=${OWNER}:${WRITE_BACK_BRANCH}&state=open`);
    if (Array.isArray(openPrs) && openPrs.length > 0) {
        console.log(`write-back branch updated; PR #${openPrs[0].number} now carries the latest numbers — merge it to finish recording`);
    } else {
        const pr = await ghJson(`${BASE}/repos/${REPO}/pulls`, {
            method: "POST",
            body: JSON.stringify({
                title: `${WRITE_BACK_PREFIX} record discussion threads (${summary})`,
                body: AUTOPR_BODY,
                head: WRITE_BACK_BRANCH,
                base: BRANCH,
            }),
        });
        console.log(`write-back opened as PR #${pr.number} — merge it to finish recording`);
    }
}

async function shaOf(rel, ref = BRANCH) {
    const res = await rawFetch(`${BASE}/repos/${REPO}/contents/${rel}?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.sha === "string" ? j.sha : null;
}

/* ------------------------- article-side preparation ----------------------- */

function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const fm = {};
    if (m) {
        for (const line of m[1].split(/\r?\n/)) {
            const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
            if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
        }
    }
    let body = m ? text.slice(m[0].length) : text;
    const h1 = body.match(/^#[ \t]+(.+?)\r?\n?/);
    if (h1) body = body.slice(h1[0].length); // the web render strips the H1 too
    return { fm, body };
}

const markerOf = (slug) => `<!-- bili-blog:${slug} -->`;
const slugOf = (entry) =>
    (typeof entry.slug === "string" && entry.slug) || entry.file.replace(/\.md$/, "").split("/").pop();
const hasRecorded = (entry) =>
    typeof entry.discussion === "number" && Number.isInteger(entry.discussion) && entry.discussion > 0;

function threadTitle(fm) {
    // English first, Chinese after (owner decision 2026-11-01); one readable line.
    const en = fm.title || "";
    const zh = fm.title_zh || "";
    if (en && zh && zh !== en) return `${en} · ${zh}`;
    return en || zh;
}

/** Mirror body — English section first, then Chinese; reference lines first;
 *  invisible marker last so a crashed run can be detected before re-creating. */
function threadBody(slug, fileRel, title, enRaw, zhRaw) {
    const enBody = parseFrontmatter(enRaw).body.trim();
    const zhBody = zhRaw === undefined ? "" : parseFrontmatter(zhRaw).body.trim();
    const refUrl = `https://github.com/${REPO}/blob/master/${fileRel}`;
    const lines = [
        `> This thread mirrors the blog post **${title}** at creation time; later edits to the article do not rewrite this post.`,
        `> 本帖是博客文章的创建时镜像；文章后续更新不会改写本帖。权威来源：[${refUrl}](${refUrl})`,
        "",
        "## English",
        "",
        enBody,
    ];
    if (zhBody) lines.push("", "## 中文版", "", zhBody);
    lines.push("", markerOf(slug));
    return lines.join("\n");
}

/* --------------------------------- main flow ------------------------------ */

async function repoId() {
    const d = await gql(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
        { owner: OWNER, name: NAME },
    );
    return d.repository.id;
}

async function resolveCategoryId() {
    const d = await gql(
        `query($owner: String!, $name: String!) {
           repository(owner: $owner, name: $name) {
             discussionCategories(first: 20) { nodes { id slug } }
           }
         }`,
        { owner: OWNER, name: NAME },
    );
    const cats = d.repository.discussionCategories.nodes;
    const general = cats.find((c) => c.slug === "General") ?? cats.find((c) => c.slug === "general") ?? cats[0];
    if (!general) throw new Error("no discussion categories exist on this repository");
    return general.id;
}

async function verifyRecorded(entry, slug) {
    try {
        const d = await gql(
            `query($owner: String!, $name: String!, $num: Int!) {
               repository(owner: $owner, name: $name) { discussion(number: $num) { number __typename } }
             }`,
            { owner: OWNER, name: NAME, num: entry.discussion },
        );
        if (!d.repository.discussion) {
            // Deliberate (owner-reviewed): a vanished thread is NOT resurrected
            // automatically. The recorded value stays authoritative; removing
            // the discussion field from the manifest is how one asks for a new
            // thread. Keeps "deleted a thread on purpose" from coming back.
            console.log(`recorded number #${entry.discussion} for "${slug}" no longer resolves — keeping the recorded value; remove the discussion field to request a new thread`);
            return false;
        }
        return true;
    } catch (e) {
        // Unverifiable ≠ deleted: refusing to recreate avoids duplicate threads.
        throw new Error(`cannot verify recorded discussion #${entry.discussion} for "${slug}" (${e.message}) — aborting to avoid duplicates`);
    }
}

async function findMarkerInRecentDiscussions(slug) {
    const marker = markerOf(slug);
    let cursor;
    for (let page = 0; page < DISCUSSION_SCAN_PAGES; page++) {
        const d = await gql(
            `query($owner: String!, $name: String!, $after: String) {
               repository(owner: $owner, name: $name) {
                 discussions(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
                   pageInfo { hasNextPage endCursor }
                   nodes { number bodyText }
                 }
               }
             }`,
            { owner: OWNER, name: NAME, after: cursor ?? null },
        );
        const conn = d.repository.discussions;
        for (const node of conn.nodes) {
            if (node.bodyText?.includes(marker)) return node.number;
        }
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }
    return null;
}

async function writeBackManifest(manifestText, updatesByIndex) {
    const obj = JSON.parse(manifestText);
    updatesByIndex.forEach(({ index, num }) => { obj.articles[index].discussion = num; });
    const next = JSON.stringify(obj, null, 2) + "\n";
    const summary = updatesByIndex.map((u) => `${slugOf(obj.articles[u.index])}→#${u.num}`).join(", ");
    if (DRY_RUN) {
        console.log(`[dry-run] would record ${summary} (commit on ${WRITE_BACK_BRANCH} + one PR, per repo policy: the pipeline never pushes ${BRANCH})`);
        return;
    }
    await writeBackViaPr(next, summary);
}

/** Loop guard: our own manifest write-back lands on master and would re-match
 *  the path filter — pushes consisting only of those commits do nothing. */
function thisPushIsOnlyOurOwnWriteBack() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) return false; // manual/local run — never skip
    try {
        const payload = JSON.parse(readFileSync(eventPath, "utf8"));
        const commits = Array.isArray(payload.commits) ? payload.commits : [];
        if (commits.length === 0) return false;
        return commits.every((c) => typeof c.message === "string" && c.message.startsWith(WRITE_BACK_PREFIX));
    } catch {
        return false;
    }
}

async function main() {
    let manifestText;
    try {
        manifestText = await readRepoFile(MANIFEST_REL);
    } catch (e) {
        console.log(`no ${MANIFEST_REL} on ${BRANCH} yet (${e.message}) — nothing to do`);
        return;
    }
    if (thisPushIsOnlyOurOwnWriteBack()) {
        console.log("push consists only of pipeline write-back commits — nothing to do");
        return;
    }
    const manifest = JSON.parse(manifestText);
    if (!Array.isArray(manifest.articles)) {
        console.log("manifest has no articles array — nothing to do");
        return;
    }
    const entries = manifest.articles
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => typeof entry?.file === "string" && entry.file.length > 0);

    // Verify every recorded number BEFORE any creation (fail loud, never dupes).
    for (const { entry } of entries) {
        if (hasRecorded(entry)) await verifyRecorded(entry, slugOf(entry));
    }

    const categoryId = await resolveCategoryId();
    const repoIdValue = await repoId(); // stable — resolved once, not per entry
    const toRecord = [];
    for (const { entry, index } of entries) {
        if (hasRecorded(entry)) continue;
        const slug = slugOf(entry);
        const existing = await findMarkerInRecentDiscussions(slug);
        if (existing) {
            console.log(`marker already present in discussion #${existing} for "${slug}" — recording only`);
            toRecord.push({ index, num: existing });
            continue;
        }
        const enRaw = await readRepoFile(entry.file);
        const { fm } = parseFrontmatter(enRaw);
        const title = threadTitle(fm);
        if (!title) throw new Error(`post ${entry.file} has no usable title (frontmatter title/title_zh or H1)`);
        let zhRaw;
        if (typeof entry.zh_file === "string" && entry.zh_file) {
            try {
                zhRaw = await readRepoFile(entry.zh_file);
            } catch {
                console.log(`zh_file ${entry.zh_file} unreadable — English-only mirror`);
            }
        }
        const body = threadBody(slug, entry.file, title, enRaw, zhRaw);
        if (DRY_RUN) {
            console.log(`[dry-run] would create discussion "${title}" (categoryId=${categoryId}, repositoryId=${repoIdValue})`);
            console.log(`[dry-run] body chars=${body.length}`);
            console.log("[dry-run] --- head ---\n" + body.slice(0, 300));
            console.log("[dry-run] --- tail ---\n" + body.slice(-160));
            continue;
        }
        const d = await gql(
            `mutation($input: CreateDiscussionInput!) {
               createDiscussion(input: $input) { node { number url } }
             }`,
            { input: { repositoryId: repoIdValue, categoryId, title, body } },
        );
        console.log(`created discussion #${d.createDiscussion.node.number}: ${title}`);
        toRecord.push({ index, num: d.createDiscussion.node.number });
    }

    if (toRecord.length > 0) {
        await writeBackManifest(manifestText, toRecord);
    } else {
        console.log(DRY_RUN ? "dry-run complete — nothing was created or written" : "all posts have verifiable threads — nothing to do");
    }
}

{
    const failed = await main().catch((e) => {
        console.error(`blog-discussions failed: ${e?.message ?? e}`);
        return e;
    });
    if (failed) {
        if (process.env.NODE_TEST_CONTEXT !== undefined || process.env.BILI_BLOG_PIPELINE_TEST === "1") {
            globalThis.__biliBlogPipelineError = failed; // test mode: surface, don't exit
        } else {
            process.exit(1);
        }
    }
}
