import * as vscode from "vscode";
import { USAGE_DATA_PART_MIME } from "./constants";
import { ToolNameMap, thinkingPartClass } from "./convert";
import { errorFromPayload } from "./errors";

/** Token usage in the shape the editor reads from a `usage` data part. */
export interface UsageInfo {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details: { cached_tokens: number };
}

interface ToolCallBuffer {
	id?: string;
	name?: string;
	args: string;
}

/**
 * Splits a server-sent event stream into `data:` payloads. Each `data:` line of an
 * OpenAI-compatible stream carries one complete JSON object, so every line is one payload.
 */
export class SseLineParser {
	private buffer = "";
	private readonly decoder = new TextDecoder();

	push(chunk: Uint8Array | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		const lines = this.buffer.split(/\r\n|\n|\r/);
		this.buffer = lines.pop() ?? "";
		return this.extract(lines);
	}

	end(): string[] {
		this.buffer += this.decoder.decode();
		const rest = this.buffer;
		this.buffer = "";
		return rest ? this.extract([rest]) : [];
	}

	private extract(lines: string[]): string[] {
		const payloads: string[] = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				const value = line.slice(5).replace(/^ /, "");
				if (value.length > 0) {
					payloads.push(value);
				}
			}
		}
		return payloads;
	}
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Normalize the API's usage object to the shape the editor expects. */
export function normalizeUsage(raw: unknown): UsageInfo | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const usage = raw as Record<string, unknown>;
	const prompt = toNumber(usage.prompt_tokens ?? usage.input_tokens);
	const completion = toNumber(usage.completion_tokens ?? usage.output_tokens);
	const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
	const cached = toNumber(details?.cached_tokens ?? usage.cache_read_tokens ?? usage.cached_tokens);
	const total = toNumber(usage.total_tokens) || prompt + completion;
	if (prompt === 0 && completion === 0 && total === 0) {
		return undefined;
	}
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, prompt_tokens_details: { cached_tokens: cached } };
}

/** Parse tool call arguments; an empty string means no arguments. */
export function parseToolArguments(raw: string, finishReason?: string): object {
	const text = raw.trim();
	if (!text) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
		if (typeof parsed === "string") {
			parsed = JSON.parse(parsed);
		}
	} catch {
		parsed = undefined;
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as object;
	}
	if (finishReason === "length") {
		throw new Error("The response reached its output limit before a tool call was complete. Try again, or lower the thinking effort.");
	}
	throw new Error("The model returned a tool call whose arguments could not be read. Try again, or choose another model.");
}

/**
 * Turns streamed chat completion chunks into editor response parts: text, thinking (when the
 * editor supports it), tool calls once their arguments are complete, and a final usage report.
 */
export class ChatStreamProcessor {
	private readonly toolCalls = new Map<string | number, ToolCallBuffer>();
	private readonly toolOrder: (string | number)[] = [];
	private readonly completedTools = new Set<string | number>();
	private lastToolKey: string | number | undefined;
	private usage: UsageInfo | undefined;
	private finishReason: string | undefined;
	private emittedText = false;
	private emittedThinking = false;
	private emittedToolCalls = 0;
	private generatedIds = 0;
	private done = false;

	constructor(
		private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		private readonly toolNames: ToolNameMap,
	) {}

	/** True once the stream sent `[DONE]`. */
	get isDone(): boolean {
		return this.done;
	}

	/** Handle one `data:` payload. Throws when the payload carries an API error. */
	handlePayload(data: string): void {
		const text = data.trim();
		if (!text) {
			return;
		}
		if (text === "[DONE]") {
			this.done = true;
			return;
		}
		let chunk: unknown;
		try {
			chunk = JSON.parse(text);
		} catch {
			return;
		}
		this.handleChunk(chunk);
	}

	/** Handle a parsed chunk, or a whole non-streamed completion. */
	handleChunk(chunk: unknown): void {
		if (!chunk || typeof chunk !== "object") {
			return;
		}
		const obj = chunk as Record<string, unknown>;
		if (obj.error) {
			throw errorFromPayload(obj, undefined);
		}
		const usage = normalizeUsage(obj.usage);
		if (usage) {
			this.usage = usage;
		}
		const choices = Array.isArray(obj.choices) ? obj.choices : [];
		const choice = (choices.find((c) => c && typeof c === "object" && ((c as Record<string, unknown>).index ?? 0) === 0) ?? choices[0]) as
			| Record<string, unknown>
			| undefined;
		if (!choice) {
			return;
		}
		const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
		if (delta && typeof delta === "object") {
			this.handleDelta(delta);
		}
		if (typeof choice.finish_reason === "string" && choice.finish_reason) {
			this.finishReason = choice.finish_reason;
			this.flushToolCalls();
		}
	}

	private handleDelta(delta: Record<string, unknown>): void {
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === "string" && reasoning) {
			const ThinkingPart = thinkingPartClass();
			if (ThinkingPart) {
				this.progress.report(new ThinkingPart(reasoning) as vscode.LanguageModelResponsePart);
				this.emittedThinking = true;
			}
		}

		const content = delta.content;
		if (typeof content === "string") {
			this.reportText(content);
		} else if (Array.isArray(content)) {
			for (const piece of content) {
				if (piece && typeof piece === "object" && typeof (piece as Record<string, unknown>).text === "string") {
					this.reportText((piece as { text: string }).text);
				}
			}
		}

		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				if (call && typeof call === "object") {
					this.collectToolCall(call as Record<string, unknown>);
				}
			}
		}
	}

	private reportText(value: string): void {
		if (value.length > 0) {
			this.progress.report(new vscode.LanguageModelTextPart(value));
			this.emittedText = true;
		}
	}

	private collectToolCall(call: Record<string, unknown>): void {
		const id = typeof call.id === "string" && call.id ? call.id : undefined;
		const key = typeof call.index === "number" ? call.index : id ? this.keyForId(id) : (this.lastToolKey ?? 0);
		if (this.completedTools.has(key)) {
			return;
		}
		let buffer = this.toolCalls.get(key);
		if (!buffer) {
			buffer = { args: "" };
			this.toolCalls.set(key, buffer);
			this.toolOrder.push(key);
		}
		this.lastToolKey = key;
		if (id) {
			buffer.id = id;
		}
		const fn = call.function as Record<string, unknown> | undefined;
		if (fn && typeof fn === "object") {
			if (typeof fn.name === "string" && fn.name && !buffer.name) {
				buffer.name = fn.name;
			}
			if (typeof fn.arguments === "string") {
				buffer.args += fn.arguments;
			} else if (fn.arguments && typeof fn.arguments === "object") {
				buffer.args = JSON.stringify(fn.arguments);
			}
		}
	}

	private keyForId(id: string): string | number {
		for (const [key, buffer] of this.toolCalls) {
			if (buffer.id === id) {
				return key;
			}
		}
		return `id:${id}`;
	}

	private flushToolCalls(): void {
		for (const key of this.toolOrder) {
			if (this.completedTools.has(key)) {
				continue;
			}
			this.completedTools.add(key);
			const buffer = this.toolCalls.get(key);
			if (!buffer?.name) {
				continue;
			}
			const input = parseToolArguments(buffer.args, this.finishReason);
			const callId = buffer.id ?? `call_${Date.now().toString(36)}_${this.generatedIds++}`;
			this.progress.report(new vscode.LanguageModelToolCallPart(callId, this.toolNames.originalName(buffer.name), input));
			this.emittedToolCalls++;
		}
	}

	/** Emit what is still buffered and report usage. Throws when the response was empty. */
	finish(): void {
		this.flushToolCalls();
		if (this.usage) {
			this.progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(this.usage)), USAGE_DATA_PART_MIME));
		}
		if (this.emittedText || this.emittedToolCalls > 0) {
			return;
		}
		if (this.finishReason === "length") {
			throw new Error(
				this.emittedThinking
					? "The model used its whole output limit while thinking and returned no answer. Try again, or lower the thinking effort."
					: "The model reached its output limit before answering. Try again with a shorter request.",
			);
		}
		if (this.finishReason === "content_filter") {
			throw new Error("The model declined to answer this request.");
		}
		throw new Error("The model returned an empty response. Try again, or choose another model.");
	}

	/** Counters used by tests and logs. */
	get stats(): { text: boolean; thinking: boolean; toolCalls: number; finishReason?: string; usage?: UsageInfo } {
		return {
			text: this.emittedText,
			thinking: this.emittedThinking,
			toolCalls: this.emittedToolCalls,
			finishReason: this.finishReason,
			usage: this.usage,
		};
	}
}

/** Read an SSE response body to the end, feeding the processor. Stops early on cancellation. */
export async function consumeEventStream(
	body: ReadableStream<Uint8Array>,
	processor: ChatStreamProcessor,
	token: vscode.CancellationToken,
): Promise<void> {
	const reader = body.getReader();
	const parser = new SseLineParser();
	try {
		while (!token.isCancellationRequested) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			for (const payload of parser.push(value)) {
				processor.handlePayload(payload);
			}
			if (processor.isDone) {
				break;
			}
		}
		if (!token.isCancellationRequested) {
			for (const payload of parser.end()) {
				processor.handlePayload(payload);
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The stream is already closed.
		}
		reader.releaseLock();
	}
}
