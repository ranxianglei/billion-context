// #2751: search_context receipt semantics — candidate/truncation disclosure,
// evidence windowing around the distinctive match, and the narrowing hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import { executeSearchContext } from "../src/decompress-shared.ts";

function mkBlock(id: string, summary: string, topic?: string, active = true): CompressionBlock {
    return {
        blockId: id, runId: "run-test", tier: 1, topic, summary,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 0, createdAt: 0, survivedCount: 0, generation: "young", active,
    };
}

function stateWith(...blocks: CompressionBlock[]): CompressionState {
    const s = createInitialState();
    s.blocks.push(...blocks);
    return s;
}

const core = createCore();

test("#2751 S1: over-limit result discloses candidate count + truncation", () => {
    const blocks = Array.from({ length: 8 }, (_, i) => mkBlock(`b${i}`, `release notes audit log entry ${i}`));
    const out = executeSearchContext({ query: "audit" }, core, stateWith(...blocks)).text;
    assert.match(out, /^Found 5 block\(s\) for "audit":/, "default limit still 5");
    assert.ok(out.includes("[truncated: showing 5 of 8 candidates by relevance"), "truncation disclosed");
    assert.ok(out.includes("pass limit:8 to see the rest"), "recovery path named");
});

test("#2751 S1: exactly-limit result reports no truncation", () => {
    const blocks = Array.from({ length: 5 }, (_, i) => mkBlock(`b${i}`, `release notes audit log entry ${i}`));
    const out = executeSearchContext({ query: "audit" }, core, stateWith(...blocks)).text;
    assert.match(out, /^Found 5 block\(s\) for "audit":/);
    assert.ok(!out.includes("[truncated:"), "no truncation note when nothing was cut");
});

test("#2751 S2: distinctive term past char 200 is surfaced + marked in the window", () => {
    // Filler pushes the unique identifier well beyond the old 200-char head clamp.
    const filler = "audit deploy audit deploy ".repeat(9);           // 225 chars of generic
    const target = mkBlock("b-target", filler + "vaultwarden-password-audit v2.3 deployed and audited after review", "Vaultwarden research");
    const crowd1 = mkBlock("b-c1", "audit deploy audit deploy audit deploy release notes");
    const crowd2 = mkBlock("b-c2", "audit deploy rollout checklist and deploy audit log");
    const out = executeSearchContext({ query: "audit deploy vaultwarden" }, core, stateWith(target, crowd1, crowd2)).text;
    assert.match(out, /^Found 3 block\(s\)/);
    assert.ok(out.includes("\u3010vaultwarden\u3011"), "unique term marked inside its evidence window");
    // Old behavior (head-200) would show only the filler and hide "vaultwarden".
    const targetLine = out.split("\n\n").find((l) => l.startsWith("b-target")) ?? "";
    assert.ok(targetLine.includes("vaultwarden"), "target block's own line carries the match evidence");
});

test("#2751 S1+S3: unique term crowded out below the cutoff → truncation note + narrowing hint", () => {
    // Six generic-heavy crowders out-score the single target, pushing it to rank 7.
    const crowders = Array.from({ length: 6 }, (_, i) => mkBlock(`b-crowd${i}`, "audit deploy ".repeat(20) + `entry ${i}`));
    const target = mkBlock("b-target", "audit deploy vaultwarden final status only");
    const out = executeSearchContext({ query: "audit deploy vaultwarden" }, core, stateWith(target, ...crowders)).text;
    assert.match(out, /^Found 5 block\(s\)/, "only 5 of 7 returned");
    assert.ok(out.includes("[truncated: showing 5 of 7 candidates"), "truncation disclosed");
    assert.ok(!out.includes("b-target"), "low-ranked target is genuinely cut, not silently dropped as 'absent'");
    assert.ok(out.includes('try searching "vaultwarden" alone'), "narrowing hint names the distinctive term");
    assert.ok(out.includes("none of the top 5 results contain \"vaultwarden\""), "hint scopes the negative to the returned set");
});

test("#2751 S2: CJK distinctive term past char 200 is surfaced without breaking surrogates", () => {
    const filler = "部署审计进展记录 ".repeat(30);                        // 270 CJK chars of generic
    const target = mkBlock("b-cjk", filler + "密码管理器项目最终归档完成", "归档");
    const crowd = mkBlock("b-cjk2", "部署审计进展记录 " + "日常运维审计日志汇总");
    const out = executeSearchContext({ query: "密码管理器 部署 审计" }, core, stateWith(target, crowd)).text;
    assert.match(out, /^Found 2 block\(s\)/);
    assert.ok(out.includes("\u3010密码管理器\u3011"), "distinctive CJK term marked in its window");
    for (let i = 0; i < out.length; i++) {
        const c = out.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) assert.ok(out.charCodeAt(i + 1) >= 0xdc00 && out.charCodeAt(i + 1) <= 0xdfff, "no lone high surrogate");
        else if (c >= 0xdc00 && c <= 0xdfff) assert.fail("lone low surrogate leaked into the receipt");
    }
});
