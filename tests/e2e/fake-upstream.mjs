// Deterministic fake Responses-API upstream for the real-codex E2E (#686): drives
// REAL `codex` through bili so compression ACTUALLY happens in-process, no model/network.
// Two contracts observed against codex-cli 0.147.0:
//   stream:true -> Responses SSE assistant turn; stream:false -> plain JSON body, which
//   bili's summarization call parses via extractSummaryText -> json.output[].content[].text.
// A summarization request is recognised by bili's exact TASK text in `instructions`; its
// reply is a faithful summary preserving the sentinel numbers found in the segment.
// Every /v1/responses request is appended to FAKE_REQLOG (JSONL) as the assertion oracle.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.FAKE_PORT || 8199);
const HOST = process.env.FAKE_HOST || "127.0.0.1";
const REQLOG = process.env.FAKE_REQLOG || path.join(process.cwd(), "tmp", "fake-requests.jsonl");
const MODEL = process.env.FAKE_MODEL || "qwen3.8-27b";
try { fs.mkdirSync(path.dirname(REQLOG), { recursive: true }); } catch { /* noop */ }

let n = 0;
const uid = () => `resp_${(++n).toString(16).padStart(6, "0")}`;
const estIn = (s) => Math.max(1, Math.round(s.length / 4));
const estOut = (s) => Math.max(1, Math.round(s.length / 4));

function flatContent(c) {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join("");
	return String(c ?? "");
}
function allInputText(input) {
	return (input || []).map((it) => flatContent(it.content)).join("\n");
}
function lastUserText(input) {
	return (input || [])
		.filter((it) => it.role === "user")
		.map((it) => flatContent(it.content))
		.join("\n");
}

// Chat turn: echo an ack tag so the test can confirm each round-trip landed.
function answerFor(userText) {
	const m = userText.match(/收到#(\d+)/);
	return m ? `收到#${m[1]}` : "收到";
}

// Faithful summarizer: keep the salient numbers (哨兵值 sentinels) from the
// segment being compressed, drop the bulk filler lines. >= MIN_SUMMARY_CHARS.
function buildFakeSummary(content) {
	const sents = [];
	const re = /哨兵值\s*[=:]\s*(\d+)/g;
	let m;
	while ((m = re.exec(content))) sents.push(m[1]);
	const uniq = [...new Set(sents)];
	const docs = [...new Set(content.match(/doc#\d+/g) || [])];
	let text =
		`[Compressed conversation section] — folded ${docs.length || "?"} archive fragment(s)` +
		` under window overflow. Preserved sentinel values: ${uniq.length ? uniq.join(", ") : "(none)"}.` +
		` Verbatim filler lines omitted to save tokens.`;
	while (text.length < 50) text += " (context preserved)";
	return text;
}

// Only bili's summarization calls carry this exact task text in instructions.
function isSummaryRequest(parsed) {
	const ins = typeof parsed.instructions === "string" ? parsed.instructions : "";
	return /must be compressed because the session context exceeds|Write a \*?\*?(tier-1|\d+-tier) compression summary/.test(ins);
}

function messageEvents(text) {
	const id = uid();
	const msgId = `msg_${id}`;
	const msg = { type: "message", id: msgId, role: "assistant", content: [{ type: "output_text", text }] };
	const inTok = 1, outTok = estOut(text);
	return [
		["response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }],
		["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", content: [] } }],
		["response.content_part.added", { type: "response.content_part.added", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }],
		["response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: text }],
		["response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text }],
		["response.content_part.done", { type: "response.content_part.done", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text } }],
		["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: msg }],
		["response.completed", { type: "response.completed", response: { id, status: "completed", output: [msg], usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok } } }],
	];
}
function sse(res, events) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}
function jsonResponse(res, text, inTok) {
	const id = uid();
	const msg = { type: "message", id: `msg_${id}`, role: "assistant", content: [{ type: "output_text", text }] };
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({
		id, object: "response", status: "completed", model: MODEL, output: [msg],
		usage: { input_tokens: inTok, output_tokens: estOut(text), total_tokens: inTok + estOut(text) },
	}));
}

const server = http.createServer((req, res) => {
	try {
		if (req.method === "GET" && /\/models$/.test(req.url)) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
			return;
		}
		if (req.method === "POST" && /\/responses$/.test(req.url)) {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				let parsed = {};
				try { parsed = JSON.parse(raw || "{}"); } catch { /* noop */ }
				const summary = isSummaryRequest(parsed);
				let text;
				if (summary) text = buildFakeSummary(allInputText(parsed.input));
				else text = answerFor(lastUserText(parsed.input));
				try {
					fs.appendFileSync(REQLOG, JSON.stringify({ t: Date.now(), model: parsed.model, stream: !!parsed.stream, isSummary: summary, inputLen: raw.length, input: parsed.input }) + "\n");
				} catch { /* noop */ }
				const inTok = estIn(raw);
				if (parsed.stream) sse(res, messageEvents(text));
				else jsonResponse(res, text, inTok);
			});
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
	} catch (e) {
		try { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(e) } })); } catch { /* noop */ }
	}
});
server.listen(PORT, HOST, () => console.log(`fake upstream listening on http://${HOST}:${PORT}/v1`));
