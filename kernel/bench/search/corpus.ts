/**
 * Search quality benchmark — realistic ACP block corpus + ground-truth queries.
 *
 * Each query maps to the blockId that SHOULD rank #1. Queries probe specific
 * failure modes: exact match, morphological variants, CJK, cross-language
 * synonyms, typos, abbreviations, disambiguation.
 *
 * Run: node --import tsx bench/search/bench.ts
 */

export interface BenchBlock {
  blockId: string;
  topic: string;
  summary: string;
}

export const CORPUS: BenchBlock[] = [
  {
    blockId: "b1",
    topic: "auth-token-refresh",
    summary:
      "Implemented JWT auth token refresh in src/auth/token.ts. Token refresh logic uses refreshToken() to call /api/auth/refresh endpoint. Fixed 401 expired token handling. Access token stored in localStorage, refresh token in httpOnly cookie. Added interceptor for automatic refresh on 401 responses.",
  },
  {
    blockId: "b2",
    topic: "database-connection-pool",
    summary:
      "Database connection pooling for PostgreSQL. Configured pg Pool with max 20 connections, idle timeout 30s. Connection pool lives in src/db/pool.ts. Resolved connection leak where queries weren't releasing clients back to pool. Added pool.end() on graceful shutdown.",
  },
  {
    blockId: "b3",
    topic: "decompress-default-to-file",
    summary:
      "Changed decompress tool to write restored content to a file by default instead of returning inline. Prevents context bloat when decompressing large blocks. New API: decompress({blockId}) writes to ~/.cache/pi/acp-decompress/, decompress({blockId, inline:true}) for explicit inline.",
  },
  {
    blockId: "b4",
    topic: "compression-protected-zone",
    summary:
      "Soft-protect recent zone: filter protected refs instead of failing the whole compression call. NEVER_PRESERVE_RECENT_TOOLS excludes decompress results from the preserve set. applySingleRange now filters and warns rather than throwing on partial overlap.",
  },
  {
    blockId: "b5",
    topic: "用户认证模块",
    summary:
      "实现了用户登录认证流程，包含密码哈希（bcrypt）、session 管理、权限校验中间件。验证逻辑覆盖登录验证、token 验证、二次验证。登录接口 POST /api/login 返回 JWT token。身份验证失败返回 401。支持 OAuth2 第三方登录（Google、GitHub）。token 过期自动刷新机制。",
  },
  {
    blockId: "b6",
    topic: "npm-publish-workflow",
    summary:
      "CI release workflow: on merge of release-v* branch, CI runs typecheck + test + build, creates git tag, publishes to npm. Prerelease versions (containing -) published with --tag dev. NPM_TOKEN secret required.",
  },
  {
    blockId: "b7",
    topic: "context-token-estimation",
    summary:
      "Token estimation uses chars/4 heuristic. Real tokenizer differs — the gap lands in 'Framework' category in breakdown. displayTotal reflects real context size, not classified sum. systemPromptTokens measured separately from message categories.",
  },
  {
    blockId: "b8",
    topic: "review-fixes",
    summary:
      "Code review findings: config 150K context cap fix, token counting precision, protect-recent zone edge cases. Reviewer approved after addressing warnings field backward compatibility. Merged to master.",
  },
  {
    blockId: "b9",
    topic: "自动注入子agent工具",
    summary:
      "session_start 钩子自动把 compress/decompress/search_context/acp_status 注入到 9 个 builtin pi-subagents 的工具白名单。幂等检查，备份 settings.json.acp-bak，原子写 + mtime 乐观锁防并发。只追加不删除用户自定义工具。",
  },
  {
    blockId: "b10",
    topic: "webpack-build-config",
    summary:
      "Webpack 5 build configuration: code splitting with SplitChunksPlugin, tree shaking enabled, source maps in production. Configured babel-loader for TypeScript and JSX. Bundle analyzer via webpack-bundle-analyzer plugin.",
  },
  {
    blockId: "b11",
    topic: "api-rate-limiting",
    summary:
      "Implemented API rate limiting with token bucket algorithm. Redis-based sliding window counter. Rate limit middleware applies to /api/* routes. 429 Too Many Requests response with Retry-After header. Per-IP and per-user limits configurable.",
  },
  {
    blockId: "b12",
    topic: "测试框架搭建",
    summary:
      "使用 node --test 内置测试运行器。tsx 处理 TypeScript。测试文件放在 tests/ 目录。覆盖率用 c8。Mock 用 node:test 的 mock module。集成测试和单元测试分离。",
  },
  {
    blockId: "b13",
    topic: "websocket-realtime",
    summary:
      "WebSocket realtime updates via ws library. Server pushes events on data change. Client reconnect with exponential backoff. Heartbeat ping/pong every 30s to detect dead connections. Message queue for offline clients.",
  },
  {
    blockId: "b14",
    topic: "error-handling-middleware",
    summary:
      "Global error handling middleware. Custom AppError class with statusCode and code field. Error formatter sanitizes stack traces in production. Async error wrapping with catchAsync wrapper. Sentry integration for production error tracking.",
  },
  {
    blockId: "b15",
    topic: "国际化和i18n",
    summary:
      "i18n internationalization setup with i18next. Language detection from Accept-Language header and cookie. Translation JSON files in locales/ dir. Supports zh-CN, en-US, ja-JP. Pluralization rules and date/number formatting via Intl API.",
  },
  {
    blockId: "b16",
    topic: "git-rebase-conflict",
    summary:
      "Resolved git rebase conflicts on feature/auth branch. Cherry-picked commits from upstream. Force-pushed after rewriting history. merge conflict markers in auth.ts and pool.ts. Used git reflog to recover lost commit.",
  },
  {
    blockId: "b17",
    topic: "docker-container-setup",
    summary:
      "Dockerized the app with multi-stage build. Alpine base image, distroless final stage. Volume mounts for /data and /logs. docker-compose for local dev with postgres and redis services. Healthcheck endpoint /healthz.",
  },
  {
    blockId: "b18",
    topic: "css-grid-layout",
    summary:
      "Refactored layout from flexbox to CSS Grid. Responsive 12-column grid with auto-fit minmax. Subgrid support for nested layouts. Fixed Safari grid gap bug. Replaced media queries with container queries in sidebar component.",
  },
  {
    blockId: "b19",
    topic: "缓存策略redis",
    summary:
      "Redis 缓存层，LRU 淘汰策略，TTL 30 分钟。缓存击穿用互斥锁，缓存穿透用布隆过滤器。热点 key 永不过期，后台异步刷新。序列化用 MessagePack 替代 JSON 减少体积。",
  },
  {
    blockId: "b20",
    topic: "graphql-schema-stitching",
    summary:
      "GraphQL schema stitching to merge multiple microservice schemas. DataLoader for N+1 query batching. Federation v2 with @key directive for entity resolution. Persisted queries to reduce request size and block malicious queries.",
  },
  {
    blockId: "b21",
    topic: "csp-content-security-policy",
    summary:
      "Content Security Policy headers. nonce-based script-src to allow inline. report-uri for violation reporting. Upgraded insecure-requests. Blocked eval and inline styles. CSP violation reports aggregated in dashboard.",
  },
  {
    blockId: "b22",
    topic: "migration-sql-scripts",
    summary:
      "Database migration scripts with Knex. Up/down migrations in migrations/ dir. Added NOT NULL constraint with default backfill. Renamed column user_name to username. Transaction-wrapped for safety. Seed data separate from migrations.",
  },
  {
    blockId: "b23",
    topic: "日志收集elk",
    summary:
      "ELK 日志栈：Filebeat 采集 → Logstash 过滤 → Elasticsearch 存储 → Kibana 可视化。结构化日志 JSON 格式，含 request_id trace_id。日志级别 DEBUG/INFO/WARN/ERROR。按服务名分索引。",
  },
  {
    blockId: "b24",
    topic: "performance-profiling",
    summary:
      "CPU profiling with clinic.js. Flame graph showed hot loop in parser. Memoized expensive computation. Reduced 47MB allocation per request to 3MB. p99 latency dropped from 340ms to 89ms after optimizing regex compilation.",
  },
  {
    blockId: "b25",
    topic: "circuit-breaker",
    summary:
      "Circuit breaker pattern for downstream service calls. Half-open state after 5 failures. Exponential backoff retry. Hystrix-style fallback response. Breaker state shared via Redis for multi-instance sync.",
  },
  {
    blockId: "b26",
    topic: "payment-integration",
    summary:
      "Stripe payment integration. Checkout session for one-time, subscription via price ID. Webhook handler verifies signature with raw body. Idempotency key prevents double charge. Refund flow with partial amounts. PCI compliance: no card data on our servers.",
  },
  {
    blockId: "b27",
    topic: "权限管理rbac",
    summary:
      "RBAC 角色权限模型。用户-角色-权限三层。admin 角色拥有所有权限，editor 可编辑内容，viewer 只读。权限注解 @RequirePermission('post:write')。casbin 策略引擎。资源级细粒度授权。",
  },
  {
    blockId: "b28",
    topic: "ci-cache-optimization",
    summary:
      "GitHub Actions cache optimization. Cached node_modules and .turbo. Reduced CI time from 4min to 90s. Cache key includes lockfile hash. Used actions/cache@v3 with restore-keys fallback. Matrix build parallelized across node versions.",
  },
  {
    blockId: "b29",
    topic: "memory-leak-debug",
    summary:
      "Debugged memory leak in worker pool. Event listeners accumulated — removed on disconnect. WeakRef for cached objects. Heap snapshot comparison found detached DOM nodes. Set maxOldSpaceSize to 4096. Used --inspect to trace retention path.",
  },
  {
    blockId: "b30",
    topic: "文件上传oss",
    summary:
      "文件上传到阿里云 OSS。分片上传大文件（>5MB），断点续传。预签名 URL 直传前端，减轻服务端压力。图片自动压缩生成缩略图（sharp）。CDN 加速静态资源分发。",
  },
  {
    blockId: "b31",
    topic: "试验记录",
    summary: "试验记录表：记录三次批次的数据结果。",
  },
  {
    blockId: "b32",
    topic: "图表工具",
    summary: "图表组件用于绘制折线图和柱状图。",
  },
];

export interface BenchQuery {
  query: string;
  expectFirst: string;
  note: string;
}

export const QUERIES: BenchQuery[] = [
  { query: "auth token", expectFirst: "b1", note: "exact multi-term" },
  {
    query: "authentication",
    expectFirst: "b1",
    note: "morphology (auth→authentication)",
  },
  { query: "登录", expectFirst: "b5", note: "CJK exact" },
  { query: "身份验证", expectFirst: "b5", note: "CJK synonym" },
  { query: "login", expectFirst: "b5", note: "cross-lang synonym" },
  {
    query: "credentials",
    expectFirst: "b5",
    note: "deep synonym (credentials≈auth)",
  },
  { query: "signin", expectFirst: "b5", note: "synonym signin≈login" },
  { query: "database pool", expectFirst: "b2", note: "exact multi-term" },
  { query: "postgres", expectFirst: "b2", note: "abbreviation" },
  { query: "connection leak", expectFirst: "b2", note: "phrase from content" },
  { query: "npm publish", expectFirst: "b6", note: "exact" },
  { query: "release workflow", expectFirst: "b6", note: "phrase" },
  { query: "子agent工具", expectFirst: "b9", note: "CJK multi-term" },
  { query: "subagent", expectFirst: "b9", note: "stem" },
  { query: "decompress file", expectFirst: "b3", note: "exact" },
  { query: "protected zone", expectFirst: "b4", note: "exact" },
  { query: "token bucket", expectFirst: "b11", note: "disambiguation" },
  { query: "tokan", expectFirst: "b1", note: "typo" },
  {
    query: "authentication tokan",
    expectFirst: "b1",
    note: "multi-word typo+morph",
  },
  {
    query: "redis",
    expectFirst: "b19",
    note: "ambiguous — b19 is the actual Redis cache block (bigram bloat had buried it under b11)",
  },
  { query: "缓存", expectFirst: "b19", note: "CJK exact (redis cache)" },
  { query: "cache", expectFirst: "b19", note: "synonym (缓存=cache)" },
  { query: "webpack", expectFirst: "b10", note: "exact" },
  { query: "bundle size", expectFirst: "b10", note: "phrase" },
  { query: "rate limit", expectFirst: "b11", note: "exact" },
  { query: "websocket", expectFirst: "b13", note: "exact" },
  { query: "i18n", expectFirst: "b15", note: "abbreviation" },
  { query: "国际化", expectFirst: "b15", note: "CJK exact" },
  { query: "error handler", expectFirst: "b14", note: "stem" },
  { query: "测试", expectFirst: "b12", note: "CJK exact" },
  { query: "payment", expectFirst: "b26", note: "exact" },
  { query: "stripe", expectFirst: "b26", note: "brand name" },
  { query: "权限", expectFirst: "b27", note: "CJK exact" },
  { query: "rbac", expectFirst: "b27", note: "abbreviation" },
  { query: "circuit breaker", expectFirst: "b25", note: "exact" },
  { query: "memory leak", expectFirst: "b29", note: "exact" },
  { query: "upload", expectFirst: "b30", note: "exact" },
  { query: "文件上传", expectFirst: "b30", note: "CJK exact" },
  { query: "docker", expectFirst: "b17", note: "exact" },
  { query: "git conflict", expectFirst: "b16", note: "exact" },
  { query: "migration", expectFirst: "b22", note: "exact" },
  { query: "profiling", expectFirst: "b24", note: "exact" },
  { query: "graphql", expectFirst: "b20", note: "exact" },
  { query: "日志", expectFirst: "b23", note: "CJK exact" },
  { query: "elk", expectFirst: "b23", note: "abbreviation" },
  { query: "security header", expectFirst: "b21", note: "phrase (csp)" },
  {
    query: "试验证明",
    expectFirst: "b31",
    note: "CJK anti-fragment (must not match 验证 in b5)",
  },
  {
    query: "图表可视化",
    expectFirst: "b32",
    note: "CJK phrase must not match b23 可视化 char-run",
  },
];
