#!/usr/bin/env node
// Commit-attribution gate (AGENTS.md §6, "Commit attribution markers"):
// every non-merge commit in a PR must declare who authored it via an
// Attribution marker line — `Attribution: ai <provider>/<model-id>` for
// agent-authored commits, `Attribution: human` for human-authored ones.
// Same provenance discipline as §7.2's `(ai: <provider>/<model-id>)` comment
// self-declaration, extended from posted comments to the commit itself: a
// silent mix of authors in git history is unauditable.
//
// Scope anchor ("only new PRs"): the rule binds a PR only when the PR's
// MERGE-BASE already carries the rule — checked by fetching AGENTS.md at the
// merge-base commit and requiring the rule's marker example to be present.
// A PR written before this gate merged is skipped (not failed); a PR rebased
// onto a master that carries the rule is checked in full.
//
// Only the PR's own authored commits are checked: GitHub's /pulls/{n}/commits
// list already excludes merge commits, which the merge button generates with
// no trailer and which are not authored work.
//
// Zero dependencies — plain node (global fetch), no install step.

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

// One line of a commit message qualifies when it is EXACTLY a marker:
//   Attribution: human
//   Attribution: ai <provider>/<model-id>   (segments: word chars, dot, dash)
// Trailing prose on the marker line invalidates it — the line is a machine-
// readable field, not prose.
const ATTRIBUTION_LINE = /^Attribution: (human|ai [\w.-]+\/[\w.-]+)$/;

export function commitHasAttribution(message) {
    if (typeof message !== "string") return false;
    return message.split(/\r?\n/).some((line) => ATTRIBUTION_LINE.test(line));
}

// The rule's marker example, verbatim as written in AGENTS.md. Its presence
// in AGENTS.md at the PR's merge-base is the "rule is in force" predicate.
export const RULE_ANCHOR = "Attribution: ai <provider>/<model-id>";

function api(pathname) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    return fetch(`https://api.github.com/repos/${repo}${pathname}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "billion-context-commit-attribution",
        },
    }).then(async (res) => {
        if (!res.ok) throw new Error(`GET ${pathname} -> HTTP ${res.status}`);
        return res.json();
    });
}

async function prCommits(pr) {
    const all = [];
    for (let page = 1; ; page++) {
        const batch = await api(`/pulls/${pr}/commits?per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 100) break;
    }
    return all;
}

export async function main() {
    const refMatch = /^refs\/pull\/(\d+)\/merge$/.exec(process.env.GITHUB_REF ?? "");
    if (!process.env.GITHUB_REPOSITORY || !refMatch) {
        console.error("commit-attribution: run inside a pull_request workflow (needs GITHUB_REPOSITORY and GITHUB_REF=refs/pull/N/merge).");
        process.exit(1);
    }
    const pr = Number(refMatch[1]);

    const pull = await api(`/pulls/${pr}`);
    const compare = await api(`/compare/${pull.base.sha}...${pull.head.sha}`);
    const mergeBase = compare.merge_base_commit?.sha;
    if (!mergeBase) throw new Error(`no merge base for ${pull.base.sha}...${pull.head.sha}`);

    const file = await api(`/contents/AGENTS.md?ref=${encodeURIComponent(mergeBase)}`);
    const agentsMd = Buffer.from(file.content ?? "", "base64").toString("utf8");
    if (!agentsMd.includes(RULE_ANCHOR)) {
        console.log(`commit-attribution: SKIP — AGENTS.md at merge-base ${mergeBase.slice(0, 10)} predates the attribution rule, so PR #${pr} was written before the gate merged.`);
        return;
    }

    const commits = await prCommits(pr);
    const bad = commits.filter((c) => !commitHasAttribution(c.commit.message));
    if (bad.length === 0) {
        console.log(`commit-attribution: OK — all ${commits.length} commits in PR #${pr} carry an Attribution marker.`);
        return;
    }

    console.error(`commit-attribution: FAIL — ${bad.length}/${commits.length} commits in PR #${pr} lack an Attribution marker line:`);
    for (const c of bad.slice(0, 20)) {
        const subject = (c.commit.message ?? "").split(/\r?\n/)[0];
        console.error(`  ${c.sha.slice(0, 10)}  ${subject}`);
    }
    if (bad.length > 20) console.error(`  … and ${bad.length - 20} more`);
    console.error("");
    console.error("Every non-merge commit must carry a marker line in its message (AGENTS.md §6, Commit attribution markers):");
    console.error("  Attribution: ai <provider>/<model-id>   # agent-authored (e.g. 'Attribution: ai anthropic/claude-opus-4-5')");
    console.error("  Attribution: human                      # human-authored");
    console.error("Fix: amend or rebase the offending commits, add the marker line, force-push.");
    process.exit(1);
}

const invoked = process.argv[1];
// Realpath both sides: Node resolves entry-point symlinks, so argv[1] can differ from import.meta.url
const isMain = !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
if (isMain) {
    main().catch((err) => {
        console.error(`commit-attribution: ERROR — ${err.message}`);
        process.exit(1);
    });
}
