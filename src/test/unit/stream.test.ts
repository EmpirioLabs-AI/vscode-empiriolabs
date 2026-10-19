import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ToolNameMap } from "../../convert";
import { EmpirioApiError } from "../../errors";
import { ChatStreamProcessor, SseLineParser, consumeEventStream, normalizeUsage, parseToolArguments } from "../../stream";
import { CancellationTokenSource, LanguageModelThinkingPart } from "../vscodeMock";

type Part = vscode.LanguageModelResponsePart | LanguageModelThinkingPart;

function collector() {
	const parts: Part[] = [];
	return { parts, progress: { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) } };
}

function sse(...events: unknown[]): string {
	return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
}

function delta(d: Record<string, unknown>, finish: string | null = null) {
	return { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] };
}

function bodyFrom(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
			}
			controller.close();
		},
	});
}

async function run(stream: string | (string | Uint8Array)[], names = new ToolNameMap()) {
	const { parts, progress } = collector();
	const processor = new ChatStreamProcessor(progress, names);
	await consumeEventStream(bodyFrom(typeof stream === "string" ? [stream] : stream), processor, new CancellationTokenSource().token);
	processor.finish();
	return { parts, processor };
}

const texts = (parts: Part[]) => parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart).map((p) => p.value);
const toolCalls = (parts: Part[]) => parts.filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);

describe("SseLineParser", () => {
	it("splits data lines across chunk boundaries, CRLF endings and multi-byte characters", () => {
		const parser = new SseLineParser();
		const bytes = new TextEncoder().encode('data: {"t":"é"}\r\n\r\n: keep-alive\n\ndata: [DONE]\n');
		const out: string[] = [];
		for (let i = 0; i < bytes.length; i++) {
			out.push(...parser.push(bytes.slice(i, i + 1)));
		}
		out.push(...parser.end());
		assert.deepEqual(out, ['{"t":"é"}', "[DONE]"]);
	});

	it("returns a final line that has no trailing newline", () => {
		const parser = new SseLineParser();
		assert.deepEqual(parser.push("data: a\ndata: b"), ["a"]);
		assert.deepEqual(parser.end(), ["b"]);
	});
});

describe("ChatStreamProcessor", () => {
	it("streams text and reports usage last", async () => {
		const { parts } = await run(
			sse(
				delta({ role: "assistant", content: "" }),
				delta({ content: "Hello" }),
				delta({ content: ", world" }, "stop"),
				{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } },
				"[DONE]",
			),
		);
		assert.deepEqual(texts(parts), ["Hello", ", world"]);
		const usage = parts[parts.length - 1] as vscode.LanguageModelDataPart;
		assert.ok(usage instanceof vscode.LanguageModelDataPart);
		assert.equal(usage.mimeType, "usage");
		assert.deepEqual(JSON.parse(new TextDecoder().decode(usage.data)), {
			prompt_tokens: 12,
			completion_tokens: 3,
			total_tokens: 15,
			prompt_tokens_details: { cached_tokens: 4 },
		});
	});

	it("reports reasoning as thinking parts, separate from the answer", async () => {
		const { parts } = await run(sse(delta({ reasoning_content: "Thinking..." }), delta({ reasoning: " more" }), delta({ content: "Answer" }, "stop")));
		const thinking = parts.filter((p) => p instanceof LanguageModelThinkingPart).map((p) => (p as LanguageModelThinkingPart).value);
		assert.deepEqual(thinking, ["Thinking...", " more"]);
		assert.deepEqual(texts(parts), ["Answer"]);
	});

	it("assembles a tool call whose arguments arrive in pieces", async () => {
		const names = new ToolNameMap();
		names.apiName("mcp.weather/get");
		const { parts } = await run(
			[
				sse(delta({ content: "Let me check." })),
				sse(delta({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "mcp_weather_get", arguments: "" } }] })),
				sse(delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })),
				sse(delta({ tool_calls: [{ index: 0, function: { arguments: '"Paris","unit":"c"}' } }] })),
				sse(delta({}, "tool_calls"), "[DONE]"),
			],
			names,
		);
		const calls = toolCalls(parts);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].callId, "call_9");
		assert.equal(calls[0].name, "mcp.weather/get");
		assert.deepEqual(calls[0].input, { city: "Paris", unit: "c" });
		assert.deepEqual(texts(parts), ["Let me check."]);
	});

	it("keeps parallel tool calls apart, by index or by id", async () => {
		const byIndex = await run(
			sse(
				delta({
					tool_calls: [
						{ index: 0, id: "a", function: { name: "read", arguments: '{"p":1}' } },
						{ index: 1, id: "b", function: { name: "read", arguments: '{"p":2}' } },
					],
				}),
				delta({}, "tool_calls"),
			),
		);
		assert.deepEqual(
			toolCalls(byIndex.parts).map((c) => [c.callId, c.input]),
			[
				["a", { p: 1 }],
				["b", { p: 2 }],
			],
		);
		const byId = await run(
			sse(
				delta({ tool_calls: [{ id: "x", function: { name: "read", arguments: '{"p":' } }] }),
				delta({ tool_calls: [{ function: { arguments: "1}" } }] }),
				delta({ tool_calls: [{ id: "y", function: { name: "list", arguments: "" } }] }),
			),
		);
		assert.deepEqual(
			toolCalls(byId.parts).map((c) => [c.callId, c.name, c.input]),
			[
				["x", "read", { p: 1 }],
				["y", "list", {}],
			],
		);
	});

	it("reads a whole non-streamed completion", () => {
		const { parts, progress } = collector();
		const processor = new ChatStreamProcessor(progress, new ToolNameMap());
		processor.handleChunk({
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Done", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 5, completion_tokens: 2 },
		});
		processor.finish();
		assert.deepEqual(texts(parts), ["Done"]);
		assert.equal(toolCalls(parts).length, 1);
		assert.equal(processor.stats.usage?.total_tokens, 7);
	});

	it("turns an error inside the stream into a readable error", async () => {
		await assert.rejects(
			run(sse(delta({ content: "partial" }), { error: { code: "insufficient_credits", message: "Insufficient credits." } })),
			(error: unknown) => error instanceof EmpirioApiError && /Add credits at https:\/\/platform\.empiriolabs\.ai\/dashboard\/billing/.test(error.message),
		);
	});

	it("reports empty, cut-off and filtered responses clearly", async () => {
		await assert.rejects(run(sse(delta({}, "stop"), "[DONE]")), /empty response/);
		await assert.rejects(run(sse(delta({ reasoning_content: "hmm" }, "length"))), /output limit while thinking/);
		await assert.rejects(run(sse(delta({}, "content_filter"))), /declined to answer/);
		await assert.rejects(
			run(sse(delta({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: '{"a":' } }] }, "length"))),
			/output limit before a tool call was complete/,
		);
	});

	it("stops reading when the request is cancelled", async () => {
		const source = new CancellationTokenSource();
		const { parts, progress } = collector();
		const processor = new ChatStreamProcessor(progress, new ToolNameMap());
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode(sse(delta({ content: "x" }))));
				source.cancel();
			},
		});
		await consumeEventStream(body, processor, source.token);
		assert.ok(texts(parts).length <= 1);
	});
});

describe("stream helpers", () => {
	it("parses tool arguments, including double-encoded JSON", () => {
		assert.deepEqual(parseToolArguments(""), {});
		assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
		assert.deepEqual(parseToolArguments(JSON.stringify('{"a":1}')), { a: 1 });
		assert.throws(() => parseToolArguments("[1,2]"), /could not be read/);
	});

	it("normalizes usage field spellings", () => {
		assert.deepEqual(normalizeUsage({ input_tokens: 3, output_tokens: 4, cache_read_tokens: 2 }), {
			prompt_tokens: 3,
			completion_tokens: 4,
			total_tokens: 7,
			prompt_tokens_details: { cached_tokens: 2 },
		});
		assert.equal(normalizeUsage({}), undefined);
		assert.equal(normalizeUsage(null), undefined);
	});
});
