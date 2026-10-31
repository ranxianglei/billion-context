/** Review-time diagnostic cases. Labels precede execution, but these are not a held-out benchmark. */
import type { CoreMessage } from "acp-kernel";
import type { PlanRetrievalCase } from "./plan-state-retrieval-cases.ts";

export interface PlanChallengeCase extends Omit<PlanRetrievalCase, "category" | "language" | "planningMessages"> {
    category: string;
    language: "en" | "zh" | "mixed";
    domain: "payments" | "rag" | "agent" | "deployment";
    planningMessages: readonly Pick<CoreMessage, "text" | "toolName" | "role" | "contentType">[];
}

function snapshot(tasks: readonly [string, string][], toolName = "TodoWrite") {
    return {
        role: "assistant" as const, contentType: "tool-call" as const, toolName,
        text: JSON.stringify({ todos: tasks.map(([content, status]) => ({ content, status })) }),
    };
}

function blocks(rows: readonly [string, string][]) {
    return rows.map(([topic, summary], index) => ({ blockId: `b${index + 1}`, topic, summary }));
}

const PAYMENTS = blocks([
    ["Payment capture", "The payment capture API uses idempotency_key and deduplicates retries by order_id."],
    ["Payment refund", "A payment refund requires refund_id and restores the original amount."],
    ["Payment ledger", "The payment ledger settles balances at UTC midnight and preserves a balanced journal."],
    ["Payment webhook", "A payment webhook verifies HMAC signatures before accepting provider events."],
    ["Payment dispute", "A payment dispute records evidence and blocks settlement until review completes."],
]);
const RAG = blocks([
    ["RAG vector index", "The rag vector index stores embedding vectors in dimension 768."],
    ["RAG reranking", "The rag reranking stage scores document pairs and returns the best five passages."],
    ["RAG ACL isolation", "The rag ACL filter enforces 租户 isolation before fetching document text."],
    ["RAG ingestion", "The rag ingestion worker applies OCR before chunking scanned PDFs."],
    ["RAG citations", "The rag citations stage preserves source page numbers and document provenance."],
]);
const AGENT = blocks([
    ["Agent retry", "The agent retry policy reuses an idempotency key for each retried tool call."],
    ["Agent budget", "The agent budget reserves estimated cost before dispatch and refunds unused capacity."],
    ["Agent checkpoint", "The agent checkpoint stores tool results so resume can skip completed side effects."],
    ["Agent audit", "The agent audit removes secret values from traces while retaining call identifiers."],
    ["Agent schema", "The agent schema validator rejects tool arguments with unknown fields."],
]);
const DEPLOYMENT = blocks([
    ["部署网关", "部署网关灰度按租户分流，异常时立即关闭灰度入口。"],
    ["部署数据库", "部署数据库回滚需要先恢复旧表结构，再回放增量日志。"],
    ["部署监控", "部署监控检查错误率和延迟分位数，并为新版本建立观察窗口。"],
    ["部署队列", "部署队列消费者先停止拉取消息，再等待正在处理的请求结束。"],
    ["部署密钥", "部署密钥轮换保留短暂重叠时间，并记录撤销审计。"],
]);
const captureNoise = "capture ".repeat(12);
const paymentPlan = () => snapshot([[captureNoise, "completed"], ["refund", "in_progress"]]);
function paddedPlan(length: number) {
    const plan = paymentPlan();
    const input = { ...JSON.parse(plan.text), padding: "" };
    input.padding = "x".repeat(length - JSON.stringify(input).length);
    return { ...plan, text: JSON.stringify(input) };
}
const user = (text: string) => ({ role: "user" as const, contentType: "text" as const, text });
const filler = (count: number) => Array.from({ length: count }, () => ({ role: "assistant" as const, contentType: "text" as const, text: "Routine observation." }));

export const PLAN_RETRIEVAL_CHALLENGES: readonly PlanChallengeCase[] = [
    {
        id: "multi-active-payment", category: "multi-task", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [snapshot([[captureNoise, "completed"], ["refund", "in_progress"], ["ledger", "in_progress"], ["webhook", "pending"]])],
        relevantBlockIds: ["b2", "b3"], rationale: "Both active tasks are acceptable; completed capture noise and pending webhook must not displace them.",
    },
    {
        id: "pending-after-cancelled", category: "multi-task", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [snapshot([[captureNoise, "cancelled"], ["refund", "pending"], ["ledger", "pending"]], "todowrite")],
        relevantBlockIds: ["b2", "b3"], rationale: "OpenCode cancelled work is terminal; either pending task is a valid continuation.",
    },
    {
        id: "terminal-plan-user-budget", category: "snapshot-lifecycle", domain: "agent", language: "en", query: "agent", blocks: AGENT,
        planningMessages: [snapshot([["retry ".repeat(12), "completed"]]), user("Continue budget")],
        relevantBlockIds: ["b2"], rationale: "The latest user request still contributes after every planned task is completed.",
    },
    {
        id: "empty-plan-user-citations", category: "snapshot-lifecycle", domain: "rag", language: "en", query: "rag", blocks: RAG,
        planningMessages: [snapshot([["vector ".repeat(12), "in_progress"]]), snapshot([]), user("Continue citations")],
        relevantBlockIds: ["b5"], rationale: "A cleared snapshot must not revive the old vector task; user citations intent remains.",
    },
    {
        id: "latest-payment-snapshot", category: "snapshot-lifecycle", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [snapshot([[captureNoise, "in_progress"]]), snapshot([["refund", "in_progress"]])],
        relevantBlockIds: ["b2"], rationale: "Only the latest full snapshot of the same tool contributes.",
    },
    {
        id: "independent-agent-tools", category: "multi-task", domain: "agent", language: "en", query: "agent", blocks: AGENT,
        planningMessages: [snapshot([["budget", "in_progress"]]), snapshot([["checkpoint", "in_progress"]], "todowrite")],
        relevantBlockIds: ["b2", "b3"], rationale: "Different planning tools remain independent sources; either current task is relevant.",
    },
    {
        id: "mixed-rag-acl-history", category: "explicit-query", domain: "rag", language: "mixed", query: "rag ACL 租户", blocks: RAG,
        planningMessages: [snapshot([["ACL 租户", "completed"], ["reranking ".repeat(12), "in_progress"]])],
        relevantBlockIds: ["b3"], rationale: "Mixed English identifiers and Chinese tenant evidence identify the completed ACL prerequisite.",
    },
    {
        id: "payment-identifier-history", category: "explicit-query", domain: "payments", language: "en", query: "payment idempotency_key", blocks: PAYMENTS,
        planningMessages: [snapshot([["capture", "completed"], ["refund ".repeat(12), "in_progress"]])],
        relevantBlockIds: ["b1"], rationale: "A punctuation-bearing identifier explicitly requests capture evidence during refund work.",
    },
    {
        id: "agent-query-whitespace-case", category: "explicit-query", domain: "agent", language: "en", query: "AGENT\tCHECKPOINT\nresume", blocks: AGENT,
        planningMessages: [snapshot([["checkpoint", "completed"], ["budget ".repeat(12), "in_progress"]])],
        relevantBlockIds: ["b3"], rationale: "Case and whitespace variation must preserve the explicit checkpoint resume query.",
    },
    {
        id: "deployment-unmatched-modifier", category: "explicit-query", domain: "deployment", language: "zh", query: "部署 网关 灰度 说明", blocks: DEPLOYMENT,
        planningMessages: [snapshot([["网关灰度", "completed"], ["数据库回滚".repeat(12), "in_progress"]])],
        relevantBlockIds: ["b1"], rationale: "An unmatched generic word must not erase the gateway evidence in a Chinese historical query.",
    },
    {
        id: "payment-repeated-query", category: "explicit-query", domain: "payments", language: "en", query: "payment payment payment idempotency_key", blocks: PAYMENTS,
        planningMessages: [snapshot([["capture", "completed"], ["refund ".repeat(12), "in_progress"]])],
        relevantBlockIds: ["b1"], rationale: "Repeated broad words must not outweigh the distinct historical identifier.",
    },
    {
        id: "trailing-text-fallback", category: "schema-fallback", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [{ ...paymentPlan(), text: paymentPlan().text + " trailing" }], preserveLegacyOrder: true,
        relevantBlockIds: ["b1"], rationale: "Invalid JSON retains the existing bounded raw-text ranking rather than partially parsing tasks.",
    },
    {
        id: "invalid-entry-fallback", category: "schema-fallback", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [{ ...paymentPlan(), text: JSON.stringify({ todos: [{ content: captureNoise, status: "completed" }, { content: "refund", status: "in_progress" }, { content: 42, status: "pending" }] }) }], preserveLegacyOrder: true,
        relevantBlockIds: ["b1"], rationale: "One invalid entry rejects the entire structured projection, including otherwise valid entries.",
    },
    {
        id: "claude-cancelled-fallback", category: "schema-fallback", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [snapshot([[captureNoise, "cancelled"], ["refund", "pending"]])], preserveLegacyOrder: true,
        relevantBlockIds: ["b1"], rationale: "Uppercase TodoWrite does not declare cancelled support; preserve legacy behavior instead of borrowing OpenCode semantics.",
    },
    {
        id: "namespaced-custom-fallback", category: "schema-fallback", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [{ ...paymentPlan(), toolName: "mcp__planner__TodoWrite" }], protectedPatterns: ["mcp__planner__TodoWrite"], preserveLegacyOrder: true,
        relevantBlockIds: ["b1"], rationale: "A configured namespaced tool may share a payload shape without sharing the recognized snapshot contract.",
    },
    {
        id: "exact-source-cap", category: "source-boundary", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [paddedPlan(4000)], relevantBlockIds: ["b2"],
        rationale: "A complete snapshot exactly at the inspection bound still selects its active task.",
    },
    {
        id: "over-source-cap", category: "source-boundary", domain: "payments", language: "en", query: "payment", blocks: PAYMENTS,
        planningMessages: [paddedPlan(4001)], preserveLegacyOrder: true, relevantBlockIds: ["b1"],
        rationale: "One character beyond the bound must use the existing capped raw-text fallback.",
    },
    {
        id: "plan-at-window-boundary", category: "context-window", domain: "agent", language: "en", query: "agent", blocks: AGENT,
        planningMessages: [snapshot([["budget", "in_progress"]]), ...filler(39)], relevantBlockIds: ["b2"],
        rationale: "A planning call exactly 40 messages from the end still contributes.",
    },
    {
        id: "plan-outside-window", category: "context-window", domain: "agent", language: "en", query: "agent", blocks: AGENT,
        planningMessages: [snapshot([["budget", "in_progress"]]), ...filler(40)], preserveLegacyOrder: true, relevantBlockIds: ["b1"],
        rationale: "An expired planning call contributes nothing; retain the original lexical first block.",
    },
    {
        id: "empty-plan-no-user", category: "snapshot-lifecycle", domain: "rag", language: "en", query: "rag", blocks: RAG,
        planningMessages: [snapshot([["reranking", "in_progress"]]), snapshot([])], relevantBlockIds: ["b1"],
        rationale: "With no remaining plan or user terms, use lexical order rather than reviving an earlier task.",
    },
];
