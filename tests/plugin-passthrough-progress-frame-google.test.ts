import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #5848 shipped the inert-frame guard on the chat (OpenAI) lane only. The
// Google lane still drained the tag-echo filter on ANY text-less frame, so the
// same split-tag leak survived there: a render tag split at the frame boundary
// lost its held head and the remainder (` type="text" …>mNNNNN`) no longer
// started with `<`, so it reached the host as prose — the #5192 shape. Google
// frames that carry nothing but empty parts must not drain; a frame with a
// finishReason / functionCall / functionResponse / usageMetadata still must.

function makeSession(): Session {
  return {
    id: "testsess",
    protocol: "google",
    upstreamOrigin: "http://127.0.0.1:9/v1",
    label: "test",
    createdAt: 0,
    lastUsedAt: 0,
    requests: 0,
    lastInputTokens: 0,
    stats: {},
    dirty: false,
  } as unknown as Session;
}

function makeRes(chunks: string[]) {
  return {
    writes: chunks,
    write(b: Buffer | string) {
      chunks.push(typeof b === "string" ? b : b.toString("utf8"));
      return true;
    },
    end(b?: Buffer | string) {
      if (b !== undefined)
        chunks.push(typeof b === "string" ? b : b.toString("utf8"));
    },
    once() {},
    destroyed: false,
    writableEnded: false,
  } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < events.length) {
        controller.enqueue(enc.encode(events[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

const DONE = "data: [DONE]\n\n";

function gframe(
  parts: Array<Record<string, unknown>>,
  finishReason?: string,
): string {
  const candidate: Record<string, unknown> = {
    index: 0,
    content: { role: "model", parts },
  };
  if (finishReason) candidate["finishReason"] = finishReason;
  return `data: ${JSON.stringify({ modelVersion: "gemini-test", candidates: [candidate] })}\n\n`;
}

/** A progress frame in Gemini's own dialect: no usable text parts at all. */
function gprogress(): string {
  return `data: ${JSON.stringify({ modelVersion: "gemini-test", candidates: [{ index: 0, content: { role: "model", parts: [{ text: "" }] } }] })}\n\n`;
}

function gTexts(f: Record<string, unknown>): string[] {
  const out: string[] = [];
  const c = f["candidates"];
  if (!Array.isArray(c)) return out;
  for (const cand of c) {
    if (!cand || typeof cand !== "object") continue;
    const content = (cand as Record<string, unknown>)["content"];
    if (!content || typeof content !== "object") continue;
    const parts = (content as Record<string, unknown>)["parts"];
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (
        p &&
        typeof p === "object" &&
        typeof (p as Record<string, unknown>)["text"] === "string"
      ) {
        out.push((p as Record<string, unknown>)["text"] as string);
      }
    }
  }
  return out;
}

/** Concatenate every text part the client would render. */
function visibleText(text: string): string {
  let out = "";
  for (const block of text.split("\n\n")) {
    const payload = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!payload || payload === "[DONE]") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const t of gTexts(obj)) out += t;
  }
  return out;
}

async function visible(
  contents: string[],
  inertAfter: (i: number) => boolean,
): Promise<string> {
  const events: string[] = [gframe([{ text: "" }])];
  contents.forEach((c, i) => {
    events.push(gframe([{ text: c }]));
    if (inertAfter(i)) events.push(gprogress());
  });
  events.push(gframe([], "STOP"), DONE);
  const chunks: string[] = [];
  await pipePluginChatWithStrip(
    streamOf(events),
    makeRes(chunks),
    "google",
    makeSession(),
  );
  return visibleText(chunks.join(""));
}

const HEAD = '<acp tokens="3';
const REST = '1" type="text" time="2026-11-06 15:30:10">m00039';

test("google: a text-less progress frame inside a paired render tag does not leak the tag's tail", async () => {
  const out = await visible(
    ["前の文章。", HEAD, REST + "</acp>", "後の文章"],
    (i) => i === 1,
  );
  assert.equal(out, "前の文章。後の文章");
  assert.doesNotMatch(out, /type="text"|m00039/);
});

test("google: a text-less progress frame inside an unclosed render tag yields the same text as without it", async () => {
  const contents = [HEAD, REST + "\n", "子作成完了"];
  const without = await visible(contents, () => false);
  const withProgress = await visible(contents, (i) => i === 0);
  assert.equal(withProgress, without);
  assert.doesNotMatch(withProgress, /type="text"|m00039/);
});

test("google: a text-less progress frame at every chunk boundary leaves the visible text unchanged", async () => {
  const contents = [
    ..."前の文章。",
    ...`<acp tokens="31" type="text" time="2026-11-06 15:30:10">m00039</acp>`,
    ..."後の文章",
  ];
  const without = await visible(contents, () => false);
  const withProgress = await visible(contents, () => true);
  assert.equal(without, "前の文章。後の文章");
  assert.equal(withProgress, without);
});

test("google: a frame carrying usageMetadata still drains the held tail (guard is not a blanket hold)", async () => {
  const out: string[] = [];
  const usage = `data: ${JSON.stringify({
    modelVersion: "gemini-test",
    candidates: [{ index: 0, content: { role: "model", parts: [] } }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 3,
      totalTokenCount: 13,
    },
  })}\n\n`;
  await pipePluginChatWithStrip(
    streamOf([
      gframe([{ text: "hello <a" }]),
      usage,
      gframe([{ text: "b> world" }], "STOP"),
      DONE,
    ]),
    makeRes(out),
    "google",
    makeSession(),
  );
  const text = visibleText(out.join(""));
  // The held `<a` must not be lost: whatever the filter decides about the tag,
  // the bytes the client sees must be the same as the run without the usage frame.
  const control: string[] = [];
  await pipePluginChatWithStrip(
    streamOf([
      gframe([{ text: "hello <a" }]),
      gframe([{ text: "b> world" }], "STOP"),
      DONE,
    ]),
    makeRes(control),
    "google",
    makeSession(),
  );
  assert.equal(text, visibleText(control.join("")));
});

test("google: ordinary streams with no held tail are unchanged by the guard", async () => {
  const out: string[] = [];
  await pipePluginChatWithStrip(
    streamOf([
      gframe([{ text: "plain " }]),
      gprogress(),
      gframe([{ text: "answer" }], "STOP"),
      DONE,
    ]),
    makeRes(out),
    "google",
    makeSession(),
  );
  assert.equal(visibleText(out.join("")), "plain answer");
});
