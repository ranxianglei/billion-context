import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compressToolArgs,
  toolCallNames,
  toolResultTextsCore,
  findCompressCallsCore,
  corePieceKey,
  spanFingerprintCore,
  spanFingerprintCoreIdx,
  boundaryRawCore,
  boundaryIndexCore,
  staleRangeCore,
  rangeFingerprintsCore,
  rangePositionsCore,
} from "../src/wire/compress-detect.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

function msg(
  partial: Partial<BiliMessage> & { id: string; role: BiliMessage["role"] },
): BiliMessage {
  return {
    contentType: "text",
    text: "",
    ...partial,
  } as BiliMessage;
}

const stream: BiliMessage[] = [
  msg({ id: "h1", role: "user", text: "hello world alpha" }),
  msg({ id: "h2", role: "assistant", text: "thinking about it" }),
  msg({ id: "h3", role: "assistant", text: "the answer is 42" }),
  msg({ id: "h4", role: "user", text: "another question" }),
  msg({ id: "h5", role: "assistant", text: "final answer" }),
];

const byRef: Record<string, string> = {
  m00001: "h1",
  m00002: "h2",
  m00003: "h3",
  m00004: "h4",
  m00005: "h5",
};

test("compressToolArgs accepts direct compress and legacy xd://compress write shapes", () => {
  const direct = compressToolArgs({
    name: "compress",
    arguments: JSON.stringify({
      content: [{ startId: "m00001", endId: "m00002", summary: "s" }],
      topic: "T",
    }),
  });
  assert.ok(direct);
  assert.equal(direct.content.length, 1);
  assert.equal(direct.topic, "T");

  const legacy = compressToolArgs({
    name: "write",
    arguments: {
      path: "xd://compress",
      content: JSON.stringify({
        content: [{ startId: "m00001", endId: "m00003", summary: "s" }],
      }),
    },
  });
  assert.ok(legacy);
  assert.equal(legacy.content.length, 1);

  const legacySingle = compressToolArgs({
    name: "write",
    arguments: {
      path: "xd://compress",
      content: JSON.stringify({
        startId: "m00001",
        endRef: "m00002",
        summary: "s",
      }),
    },
  });
  assert.ok(legacySingle);
  assert.equal(legacySingle.content.length, 1);

  assert.equal(
    compressToolArgs({
      name: "write",
      arguments: { path: "xd://other", content: "x" },
    }),
    null,
  );
  assert.equal(compressToolArgs({ name: "bogus", arguments: {} }), null);
});

test("findCompressCallsCore validates ranges and stamps compressCallId", () => {
  const call = msg({
    id: "h9",
    role: "assistant",
    contentType: "tool-call",
    toolCallId: "call-7",
    toolName: "compress",
    text: JSON.stringify({
      content: [
        { startId: "m00001", endId: "m00003", summary: "first" },
        { startId: "m00001", endId: "m00002" }, // no summary -> skipped
        { summary: "no ids" }, // skipped
      ],
    }),
  });
  const calls = findCompressCallsCore(call);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "call-7");
  assert.equal(calls[0]!.ranges.length, 1);
  assert.equal(calls[0]!.ranges[0]!.compressCallId, "call-7");
  assert.equal(calls[0]!.ranges[0]!.summary, "first");
  assert.deepEqual(
    findCompressCallsCore(msg({ id: "h1", role: "user", text: "x" })),
    [],
  );
});

test("toolCallNames and toolResultTextsCore map by toolCallId", () => {
  const s: BiliMessage[] = [
    msg({
      id: "a",
      role: "assistant",
      contentType: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      text: "{}",
    }),
    msg({
      id: "b",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "t1",
      text: "out",
    }),
  ];
  assert.deepEqual([...toolCallNames(s)], [["t1", "bash"]]);
  assert.deepEqual([...toolResultTextsCore(s)], [["t1", "out"]]);
});

test("span fingerprints hash first/last piece content keys (index and id forms agree)", () => {
  const fp = spanFingerprintCore(stream, "h1", "h3");
  const fpIdx = spanFingerprintCoreIdx(stream, 0, 2);
  assert.equal(fp, fpIdx);
  assert.match(fp, /^[0-9a-f]{8}$/);
  // same boundaries, different content -> different fp
  assert.notEqual(
    spanFingerprintCoreIdx(stream, 0, 2),
    spanFingerprintCoreIdx(stream, 0, 4),
  );
  // drift BEYOND the first 4096 chars keeps the key; drift inside it does not
  const longBase = ["x".repeat(5000), "x".repeat(4096) + "y".repeat(1000)].map(
    (text, i) => msg({ id: `t${i}`, role: "assistant", text }),
  );
  assert.equal(corePieceKey(longBase[0]!), corePieceKey(longBase[1]!));
  const shortDrift = msg({
    id: "t2",
    role: "assistant",
    text: "x".repeat(4095) + "y",
  });
  assert.notEqual(corePieceKey(longBase[0]!), corePieceKey(shortDrift));
  // role/contentType/toolName participate in the key
  assert.notEqual(
    corePieceKey({ id: "h1", role: "user", text: "a", contentType: "text" }),
    corePieceKey({
      id: "h1",
      role: "assistant",
      text: "a",
      contentType: "text",
    }),
  );
});

const blocks = [{ blockId: "b1", effectiveMessageIds: ["h1", "h2", "h3"] }];

test("boundaryRawCore resolves refs, and blocks by stream-order min/max", () => {
  assert.equal(boundaryRawCore("m00002", byRef, blocks, stream, "min"), "h2");
  assert.equal(boundaryRawCore("b1", byRef, blocks, stream, "min"), "h1");
  assert.equal(boundaryRawCore("b1", byRef, blocks, stream, "max"), "h3");
  assert.equal(boundaryRawCore("b9", byRef, blocks, stream, "min"), "");
  assert.equal(boundaryIndexCore("m00003", byRef, blocks, stream, "min"), 2);
  assert.equal(boundaryIndexCore("m00099", byRef, blocks, stream, "min", 2), 2); // fallback
  assert.equal(boundaryIndexCore("m00099", byRef, blocks, stream, "min"), -1);
});

function resultTextFor(fp: string, pos: string): string {
  return `Compressed 3 ranges [fp=${fp}] [pos=${pos}]`;
}

test("staleRangeCore: matching fp passes, mismatch rejects with diagnostics", () => {
  const fp = spanFingerprintCore(stream, "h1", "h3");
  const ok = staleRangeCore(
    { startRef: "m00001", endRef: "m00003" },
    0,
    resultTextFor(fp, "0-2"),
    stream,
    4,
    byRef,
    blocks,
  );
  assert.deepEqual(ok, {});
  const bad = staleRangeCore(
    { startRef: "m00001", endRef: "m00003" },
    0,
    resultTextFor("deadbeef", "0-2"),
    stream,
    4,
    byRef,
    blocks,
  );
  assert.match(bad.reject ?? "", /fp m00001\.\.m00003 want deadbeef got/);
  assert.equal(bad.hint, true);
});

test("staleRangeCore: unresolved refs and end-after-call reject; block refs defer to kernel", () => {
  const unresolved = staleRangeCore(
    { startRef: "m00042", endRef: "m00043" },
    0,
    "x",
    stream,
    4,
    byRef,
    blocks,
  );
  assert.match(unresolved.reject ?? "", /unresolved m00042\.\.m00043/);
  const fp = spanFingerprintCore(stream, "h1", "h3");
  const afterCall = staleRangeCore(
    { startRef: "m00001", endRef: "m00005" },
    0,
    resultTextFor(fp, "0-4"),
    stream,
    2,
    byRef,
    blocks,
  );
  assert.match(afterCall.reject ?? "", /end idx 4 > callIndex 2/);
  const blockRef = staleRangeCore(
    { startRef: "b1", endRef: "b1" },
    0,
    "x",
    stream,
    4,
    byRef,
    blocks,
  );
  assert.deepEqual(blockRef, {}); // unresolved block refs: kernel resolves itself
});

test("staleRangeCore: benign tail drift recovers by position and remaps dangling m-refs", () => {
  // h3 drifted (re-hashed): its recorded ref dangles, but [pos=] recovers the index.
  const drifted = [...stream];
  drifted[2] = msg({
    id: "h3x",
    role: "assistant",
    text: "the answer is 42 (edited)",
  });
  const driftedByRef = { ...byRef, m00003: "h3x" };
  const fpWant = spanFingerprintCoreIdx(stream, 0, 2);
  const v = staleRangeCore(
    { startRef: "m00001", endRef: "m00003" },
    0,
    resultTextFor(fpWant, "0-2"),
    drifted,
    4,
    driftedByRef,
    blocks,
  );
  // content changed -> fp mismatch rejects (edit beyond first-4096 changes the key)
  assert.match(v.reject ?? "", /want/);
  assert.equal(v.hint, true);
});

test("staleRangeCore: protected recovered piece without a ref fails closed", () => {
  const fpWant = spanFingerprintCoreIdx(stream, 0, 2);
  // start ref dangles and the recovered piece has no ref in byRef
  const emptyByRef: Record<string, string> = {};
  const v = staleRangeCore(
    { startRef: "m00001", endRef: "m00003" },
    0,
    resultTextFor(fpWant, "0-2"),
    stream,
    4,
    emptyByRef,
    blocks,
  );
  // fp still computed from positions 0..2 and matches; m00001 remap finds no ref
  assert.match(v.reject ?? "", /no ref \(protected piece\)/);
});

test("rangeFingerprintsCore and rangePositionsCore emit per-range pairs", () => {
  const fps = rangeFingerprintsCore(
    [
      { startRef: "m00001", endRef: "m00003" },
      { startRef: "m00009", endRef: "m00010" },
    ],
    stream,
    byRef,
    blocks,
  );
  assert.match(fps[0]!, /^[0-9a-f]{8}$/);
  assert.equal(fps[1], "-"); // unresolvable range
  const pos = rangePositionsCore(
    [
      { startRef: "m00001", endRef: "m00003" },
      { startRef: "b1", endRef: "b1" },
    ],
    stream,
    byRef,
    blocks,
  );
  assert.equal(pos[0], "0-2");
  assert.equal(pos[1], "0-2"); // block resolves to h1..h3 = 0..2
});
