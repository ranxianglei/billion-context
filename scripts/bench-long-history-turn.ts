import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createCore } from "../kernel/src/compress.js";
import { defaultConfig } from "../kernel/src/config.js";
import { createInitialState } from "../kernel/src/state.js";
import { assignRefs } from "../kernel/src/refs.js";
import { defaultCountTokens } from "../kernel/src/tokenize.js";
import type { CoreMessage } from "../kernel/src/types.js";

// End-to-end A/B on a long re-sent history. The two arms differ ONLY in the
// injected countTokens function: baseline is the shipped regex implementation,
// candidate is the charCodeAt scan. Everything else in processTurn is shared.
function regexCountTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

const count = Number(process.argv[2] ?? 25000);
const rounds = Number(process.argv[3] ?? 3);

const CJK =
  "上下文压缩水位判定折叠范围构建完整性撤回保护区覆盖历史会话性能测量";
function textOf(index: number): string {
  const cjk = CJK.repeat(6 + (index % 5));
  return `turn ${index}: ${cjk} function render(state) { return state.items.map((i) => i.name); }`;
}

const messages: CoreMessage[] = [];
for (let i = 0; i < count; i++) {
  messages.push({
    id: `raw-${i}`,
    role: i % 3 === 0 ? "user" : "assistant",
    contentType: "text",
    text: textOf(i),
  });
}
const baseConfig = defaultConfig(1_000_000);
const config = {
  ...baseConfig,
  compress: { ...baseConfig.compress, minCompressRange: 0 },
};

interface Sample {
  elapsedMs: number;
  cpuMs: number;
  outputSha256: string;
}

function makeArm(countTokens: (text: string) => number): () => Sample {
  const core = createCore({ countTokens });
  let state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: state.nextRunId,
  }).map;
  return () => {
    const hash = createHash("sha256");
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    const result = core.processTurn({
      messages,
      state,
      config,
      tokenCount: 900_000,
      renderTags: "none",
    });
    state = result.state;
    hash.update(JSON.stringify(result.messages));
    hash.update(JSON.stringify(result.state));
    const cpu = process.cpuUsage(cpuStart);
    return {
      elapsedMs: performance.now() - started,
      cpuMs: (cpu.user + cpu.system) / 1000,
      outputSha256: hash.digest("hex"),
    };
  };
}

const baseline = makeArm(regexCountTokens);
const candidate = makeArm(defaultCountTokens);
baseline();
candidate();

const samples: Record<"baseline" | "candidate", Sample[]> = {
  baseline: [],
  candidate: [],
};
for (let pair = 0; pair < rounds; pair++) {
  const order =
    pair % 2 === 0
      ? ([
          ["baseline", baseline],
          ["candidate", candidate],
        ] as const)
      : ([
          ["candidate", candidate],
          ["baseline", baseline],
        ] as const);
  for (const [name, arm] of order) samples[name].push(arm());
}

const lastBaseline = samples.baseline.at(-1)!;
const lastCandidate = samples.candidate.at(-1)!;
if (lastBaseline.outputSha256 !== lastCandidate.outputSha256) {
  throw new Error(
    `output diverged: ${lastBaseline.outputSha256} vs ${lastCandidate.outputSha256}`,
  );
}
const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const cpuBaseline = samples.baseline.map((s) => s.cpuMs);
const cpuCandidate = samples.candidate.map((s) => s.cpuMs);
console.log(
  JSON.stringify(
    {
      messages: count,
      pairs: rounds,
      outputSha256: lastBaseline.outputSha256,
      baseline: {
        cpuMs: cpuBaseline,
        cpuMedianMs: median(cpuBaseline),
      },
      candidate: {
        cpuMs: cpuCandidate,
        cpuMedianMs: median(cpuCandidate),
      },
    },
    null,
    2,
  ),
);
