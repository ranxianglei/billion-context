/**
 * Fixed, synthetic retrieval cases, authored before the status-aware ranker.
 * These measure retrieval behavior, not autonomous-agent or production success.
 * Paired cases keep queries, task descriptions and blocks identical and swap
 * only task status. Keep failed cases in reports when changing the ranker.
 */
interface PlanRetrievalBlock {
    blockId: string;
    topic: string;
    summary: string;
}

interface PlanRetrievalMessage {
    toolName: string;
    text: string;
}

type PlanRetrievalCategory =
    | "status-switch"
    | "pending-only"
    | "stale-task-noise"
    | "explicit-history"
    | "dependency"
    | "compatibility"
    | "snapshot-recency";

export interface PlanRetrievalCase {
    id: string;
    category: PlanRetrievalCategory;
    language: "en" | "zh";
    query: string;
    blocks: readonly PlanRetrievalBlock[];
    planningMessages: readonly PlanRetrievalMessage[];
    relevantBlockIds: readonly string[];
    rationale: string;
    /** Unsupported inputs must preserve the pre-change plan-aware order. */
    preserveLegacyOrder?: boolean;
    protectedPatterns?: readonly string[];
}

type Todo = { content: string; status: string };

function snapshot(todos: readonly Todo[], toolName = "TodoWrite"): PlanRetrievalMessage {
    return { toolName, text: JSON.stringify({ todos }) };
}

const TOKEN: readonly PlanRetrievalBlock[] = [
    { blockId: "b1", topic: "JWT token validation", summary: "The authentication module verifies JWT signatures and issuer claims. JWT token validation rejects an expired token before login. The signing key is selected using the JWT kid header." },
    { blockId: "b2", topic: "Token bucket rate limiting", summary: "The request middleware uses a token bucket for per-account rate limiting. Capacity is 60 requests and refill is one token per second. A depleted bucket returns HTTP 429 with Retry-After." },
    { blockId: "b3", topic: "Token storage migration", summary: "The browser stores the access token in memory and the refresh token in an httpOnly cookie. The token storage migration removes localStorage reads from the client." },
    { blockId: "b4", topic: "Token usage accounting", summary: "The model gateway records input token and output token counts per request. The billing dashboard totals token usage by workspace and UTC date." },
    { blockId: "b5", topic: "Token rotation schedule", summary: "Service credentials use an opaque token rotated every seven days. The previous token remains valid during a ten-minute deployment overlap." },
    { blockId: "b6", topic: "Token audit export", summary: "The audit export redacts token values before writing event logs. It keeps request identifiers and token type so operators can investigate incidents." },
];

const CACHE: readonly PlanRetrievalBlock[] = [
    { blockId: "b1", topic: "CDN cache invalidation", summary: "Publishing an article purges its CDN cache key. The invalidation worker batches changed article URLs and retries failed purge requests. It does not purge unrelated cached images." },
    { blockId: "b2", topic: "Cache metrics dashboard", summary: "The cache dashboard displays hit ratio, storage occupancy and eviction counts. Metrics are grouped by environment and cache namespace." },
    { blockId: "b3", topic: "Database cache stampede", summary: "The database query cache uses a singleflight lock to prevent a cache stampede. One caller refreshes an expired entry while concurrent callers wait for the same result." },
    { blockId: "b4", topic: "Browser cache headers", summary: "The asset server sets immutable cache headers on fingerprinted JavaScript files. HTML uses a short cache lifetime so new deployments load the new bundle." },
    { blockId: "b5", topic: "Cache schema migration", summary: "The Redis cache schema adds a version prefix to serialized account records. The migration reads the old cache namespace until the rollout finishes." },
    { blockId: "b6", topic: "Build cache cleanup", summary: "The build cache stores compiler output by source digest. The cleanup job removes cache entries unused for thirty days and reports reclaimed space." },
];

const RETRY: readonly PlanRetrievalBlock[] = [
    { blockId: "b1", topic: "HTTP retry backoff", summary: "The HTTP client retries transient connection failures with exponential backoff and jitter. Retry attempts share one deadline and stop after three failures. HTTP 400 responses are not retried." },
    { blockId: "b2", topic: "Retry queue visibility", summary: "The queue worker extends message visibility during a retry. The dashboard lists retry age and routes exhausted jobs to a dead-letter queue." },
    { blockId: "b3", topic: "Deployment retry workflow", summary: "A deployment retry reuses the original artifact digest. The rollout records the retry operator and skips instances already running that digest." },
    { blockId: "b4", topic: "Payment retry idempotency", summary: "Payment retries carry the same idempotency key. The payment service stores the first charge result so a retry returns that result without charging the customer twice." },
    { blockId: "b5", topic: "Webhook retry delivery", summary: "Webhook delivery retries failed callbacks for twenty-four hours. Each retry includes the original event identifier and a fresh delivery timestamp." },
    { blockId: "b6", topic: "Test retry reporting", summary: "The test runner records flaky test retries separately from first-attempt failures. A passing retry does not erase the original failure trace." },
];

const TIMEOUT_ZH: readonly PlanRetrievalBlock[] = [
    { blockId: "b1", topic: "网关请求超时", summary: "网关为外部请求设置统一超时预算，向下游传递截止时间。网关超时后取消仍在执行的请求，避免继续消耗连接。" },
    { blockId: "b2", topic: "浏览器上传超时", summary: "浏览器上传大文件使用分片。上传超时后保留已完成的分片编号，下次继续上传缺失的分片。" },
    { blockId: "b3", topic: "消息队列确认超时", summary: "消息队列消费确认超时会触发重新投递。消费者利用业务键去重，防止重复执行已经完成的业务操作。" },
    { blockId: "b4", topic: "数据库查询超时", summary: "数据库慢查询设置语句超时和连接池等待上限。查询超时后回滚事务并释放连接，慢查询日志记录查询编号。" },
    { blockId: "b5", topic: "测试等待超时", summary: "集成测试等待服务启动存在超时限制。测试超时后输出服务日志并关闭子进程，避免后台进程残留。" },
    { blockId: "b6", topic: "登录会话超时", summary: "用户长时间没有操作时登录会话超时。会话超时后清除客户端凭据并跳转到登录页面。" },
];

const AUTH_TASK = "Implement JWT signatures and issuer claims for authentication token validation";
const RATE_TASK = "Implement token bucket rate limiting in the request middleware";
const CDN_TASK = "Implement CDN cache invalidation for published article URLs";
const STAMPEDE_TASK = "Prevent a database cache stampede with a singleflight lock";
const HTTP_TASK = "Implement HTTP retry exponential backoff and jitter";
const PAYMENT_TASK = "Protect payment retry idempotency using the original charge result";
const GATEWAY_TASK = "实现网关请求超时预算和下游截止时间传递";
const DATABASE_TASK = "修复数据库慢查询超时后的事务回滚与连接释放";

const completedAuthTasks = [
    "Document JWT signature verification",
    "Validate JWT issuer claims",
    "Reject an expired JWT token",
    "Select the JWT signing key by kid",
    "Record authentication failure reasons",
    "Test JWT login validation",
    "Review the authentication module",
    "Add JWT signature test vectors",
    "Document supported JWT algorithms",
    "Reject missing JWT issuer claims",
    "Check JWT token expiry boundaries",
    "Cache the authentication signing key",
    "Trace failed JWT login requests",
    "Update JWT validation documentation",
    "Check authentication error responses",
    "Cover JWT key selection failures",
    "Review token validation audit fields",
    "Remove obsolete JWT login fixtures",
].map((content): Todo => ({ content, status: "completed" }));

export const PLAN_RETRIEVAL_CASES: readonly PlanRetrievalCase[] = [
    {
        id: "token-switch-to-rate", category: "status-switch", language: "en", query: "token", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "completed" }, { content: RATE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b2"], rationale: "The broad token query should recover the currently implemented rate limiter after authentication is complete.",
    },
    {
        id: "token-switch-to-auth", category: "status-switch", language: "en", query: "token", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "in_progress" }, { content: RATE_TASK, status: "completed" }])],
        relevantBlockIds: ["b1"], rationale: "Only statuses differ from token-switch-to-rate; authentication is now the current task.",
    },
    {
        id: "cache-switch-to-stampede", category: "status-switch", language: "en", query: "cache", blocks: CACHE,
        planningMessages: [snapshot([{ content: CDN_TASK, status: "completed" }, { content: STAMPEDE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b3"], rationale: "The broad cache query concerns the current singleflight implementation, not the finished CDN purge work.",
    },
    {
        id: "cache-switch-to-cdn", category: "status-switch", language: "en", query: "cache", blocks: CACHE,
        planningMessages: [snapshot([{ content: CDN_TASK, status: "in_progress" }, { content: STAMPEDE_TASK, status: "completed" }])],
        relevantBlockIds: ["b1"], rationale: "Only statuses differ from cache-switch-to-stampede; CDN invalidation is now the current task.",
    },
    {
        id: "retry-switch-to-payment", category: "status-switch", language: "en", query: "retry", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "completed" }, { content: PAYMENT_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b4"], rationale: "The ambiguous retry query should recover the payment idempotency decision needed for the current implementation.",
    },
    {
        id: "retry-switch-to-http", category: "status-switch", language: "en", query: "retry", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "in_progress" }, { content: PAYMENT_TASK, status: "completed" }])],
        relevantBlockIds: ["b1"], rationale: "Only statuses differ from retry-switch-to-payment; HTTP transport retries are now being implemented.",
    },
    {
        id: "chinese-switch-to-database", category: "status-switch", language: "zh", query: "超时", blocks: TIMEOUT_ZH,
        planningMessages: [snapshot([{ content: GATEWAY_TASK, status: "completed" }, { content: DATABASE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b4"], rationale: "查询只说超时，当前任务是数据库事务回滚与连接释放，应召回数据库决策。",
    },
    {
        id: "chinese-switch-to-gateway", category: "status-switch", language: "zh", query: "超时", blocks: TIMEOUT_ZH,
        planningMessages: [snapshot([{ content: GATEWAY_TASK, status: "in_progress" }, { content: DATABASE_TASK, status: "completed" }])],
        relevantBlockIds: ["b1"], rationale: "与数据库场景仅交换状态；当前任务变为网关截止时间传递，检索目标也应随之切换。",
    },
    {
        id: "pending-after-completed-auth", category: "pending-only", language: "en", query: "token", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "completed" }, { content: RATE_TASK, status: "pending" }])],
        relevantBlockIds: ["b2"], rationale: "There is no in-progress task; rate limiting is the only remaining task and supplies the retrieval context.",
    },
    {
        id: "multiple-pending-cache-tasks", category: "pending-only", language: "en", query: "cache", blocks: CACHE,
        planningMessages: [snapshot([{ content: "Complete cache dashboard metrics", status: "completed" }, { content: CDN_TASK, status: "pending" }, { content: STAMPEDE_TASK, status: "pending" }])],
        relevantBlockIds: ["b1", "b3"], rationale: "Both unfinished tasks are valid next work; either supporting memory is relevant, while completed dashboard work is not.",
    },
    {
        id: "many-completed-auth-tasks", category: "stale-task-noise", language: "en", query: "token", blocks: TOKEN,
        planningMessages: [snapshot([...completedAuthTasks, { content: RATE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b2"], rationale: "Eighteen completed authentication subtasks must not drown out the one current rate-limiting task. The complete snapshot stays below the existing text cap.",
    },
    {
        id: "repeated-completed-description", category: "stale-task-noise", language: "en", query: "cache", blocks: CACHE,
        planningMessages: [snapshot([{ content: "Implement CDN cache invalidation; test CDN cache invalidation after article publication; document CDN cache invalidation failures and CDN cache invalidation retries", status: "completed" }, { content: STAMPEDE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b3"], rationale: "A verbose completed task repeats its own terms; repetition should not override the current database cache work.",
    },
    {
        id: "cancelled-transport-retry", category: "stale-task-noise", language: "en", query: "retry", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "cancelled" }, { content: PAYMENT_TASK, status: "in_progress" }], "todowrite")],
        relevantBlockIds: ["b4"], rationale: "Cancelled transport work supplies no current task intent; the payment retry design is still required.",
    },
    {
        id: "explicit-completed-jwt", category: "explicit-history", language: "en", query: "token JWT issuer", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "completed" }, { content: RATE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b1"], rationale: "The query explicitly asks about the finished JWT issuer decision. Current task state must not replace that search intent.",
    },
    {
        id: "explicit-completed-cdn", category: "explicit-history", language: "en", query: "cache CDN article purge", blocks: CACHE,
        planningMessages: [snapshot([{ content: CDN_TASK, status: "completed" }, { content: STAMPEDE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b1"], rationale: "The user explicitly revisits completed CDN purge work while implementing the database cache; historical evidence remains retrievable.",
    },
    {
        id: "explicit-completed-gateway", category: "explicit-history", language: "zh", query: "网关 超时 截止时间", blocks: TIMEOUT_ZH,
        planningMessages: [snapshot([{ content: GATEWAY_TASK, status: "completed" }, { content: DATABASE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b1"], rationale: "中文查询明确指定已完成的网关截止时间设计，当前数据库任务不应遮蔽这段历史。",
    },
    {
        id: "rate-limiter-auth-dependency", category: "dependency", language: "en", query: "token JWT signing key", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "completed" }, { content: "Implement token bucket rate limiting using the authenticated account identifier", status: "in_progress" }])],
        relevantBlockIds: ["b1"], rationale: "Current rate-limiter work depends on earlier authentication. The targeted query asks for that dependency, so completed-task evidence must remain accessible.",
    },
    {
        id: "payment-transport-dependency", category: "dependency", language: "en", query: "retry HTTP deadline", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "completed" }, { content: "Protect payment retry idempotency while respecting the shared request deadline", status: "in_progress" }])],
        relevantBlockIds: ["b1"], rationale: "The payment implementation needs the existing HTTP deadline contract; the query explicitly names that prerequisite.",
    },
    {
        id: "no-plan", category: "compatibility", language: "en", query: "token JWT issuer", blocks: TOKEN,
        planningMessages: [], relevantBlockIds: ["b1"], preserveLegacyOrder: true,
        rationale: "Without a plan, the concrete JWT query must retain the existing lexical behavior.",
    },
    {
        id: "malformed-plan-json", category: "compatibility", language: "en", query: "token JWT issuer", blocks: TOKEN,
        planningMessages: [{ toolName: "TodoWrite", text: '{"todos":[{"content":"JWT token issuer validation","status":"in_progress"}' }],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "An incomplete JSON payload cannot establish task state; keep legacy extraction and ordering.",
    },
    {
        id: "unknown-plan-schema", category: "compatibility", language: "en", query: "cache CDN", blocks: CACHE,
        planningMessages: [{ toolName: "TodoWrite", text: JSON.stringify({ items: [{ description: CDN_TASK, state: "active" }] }) }],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "An items/state payload is outside the supported TodoWrite snapshot contract and must use the old behavior.",
    },
    {
        id: "unknown-task-status", category: "compatibility", language: "en", query: "retry HTTP", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "blocked" }, { content: PAYMENT_TASK, status: "pending" }])],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "The status blocked has unspecified semantics here; the implementation must not silently interpret it as completed or current.",
    },
    {
        id: "custom-planning-tool", category: "compatibility", language: "en", query: "cache CDN", blocks: CACHE,
        planningMessages: [snapshot([{ content: CDN_TASK, status: "in_progress" }], "project_board")],
        protectedPatterns: ["project_board"], relevantBlockIds: ["b1"], preserveLegacyOrder: true,
        rationale: "A custom protected planning tool keeps its legacy text extraction; a familiar-looking payload is not sufficient evidence of TodoWrite semantics.",
    },
    {
        id: "incremental-task-update", category: "compatibility", language: "en", query: "token JWT", blocks: TOKEN,
        planningMessages: [{ toolName: "TaskCreate", text: JSON.stringify({ subject: AUTH_TASK }) }, { toolName: "TaskUpdate", text: JSON.stringify({ taskId: "1", status: "completed" }) }],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "Incremental task events lack a complete snapshot and reliable result-side ID linkage; preserve their existing handling.",
    },
    {
        id: "oversized-plan-json", category: "compatibility", language: "en", query: "token JWT issuer", blocks: TOKEN,
        planningMessages: [snapshot([{ content: `${AUTH_TASK}. ${"Review JWT issuer validation evidence. ".repeat(120)}`, status: "completed" }, { content: RATE_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "The snapshot exceeds the existing 4000-character inspection cap. Do not infer state from a partially inspected JSON document.",
    },
    {
        id: "all-tasks-completed", category: "compatibility", language: "en", query: "token JWT issuer", blocks: TOKEN,
        planningMessages: [snapshot([{ content: AUTH_TASK, status: "completed" }, { content: RATE_TASK, status: "completed" }])],
        relevantBlockIds: ["b1"], rationale: "No unfinished task establishes a current phase; fall back to lexical ranking for the explicit JWT query.",
    },
    {
        id: "missing-task-status", category: "compatibility", language: "en", query: "cache CDN", blocks: CACHE,
        planningMessages: [{ toolName: "TodoWrite", text: JSON.stringify({ todos: [{ content: CDN_TASK }] }) }],
        relevantBlockIds: ["b1"], preserveLegacyOrder: true, rationale: "A task without a status does not satisfy the complete snapshot contract; preserve legacy behavior.",
    },
    {
        id: "latest-snapshot-wins", category: "snapshot-recency", language: "en", query: "retry", blocks: RETRY,
        planningMessages: [snapshot([{ content: HTTP_TASK, status: "in_progress" }, { content: PAYMENT_TASK, status: "pending" }]), snapshot([{ content: HTTP_TASK, status: "completed" }, { content: PAYMENT_TASK, status: "in_progress" }])],
        relevantBlockIds: ["b4"], rationale: "The later complete snapshot supersedes the earlier phase, so HTTP task terms must not regain current-task priority.",
    },
];
