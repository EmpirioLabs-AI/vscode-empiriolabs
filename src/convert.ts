import * as vscode from "vscode";

/** OpenAI-compatible request shapes sent to `POST /v1/chat/completions`. */
export type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface OpenAITool {
	type: "function";
	function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ConvertOptions {
	/** Whether the target model accepts image input; images are replaced by a note otherwise. */
	readonly supportsImages: boolean;
	/**
	 * Whether the target model accepts tools. When it does not, tool calls and results from
	 * earlier turns are sent as text, since the API rejects tool messages without tools.
	 */
	readonly supportsTools?: boolean;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_OMITTED_NOTE = "[An image was attached here, but this model does not accept image input.]";
const TOOL_IMAGE_OMITTED_NOTE = "[The tool returned an image, but this model does not accept image input.]";
const MISSING_TOOL_RESULT = "No result was returned for this tool call.";

type ThinkingCtor = new (value: string | string[], id?: string, metadata?: { readonly [key: string]: unknown }) => unknown;

/** The thinking part class, when the running editor provides it. */
export function thinkingPartClass(): ThinkingCtor | undefined {
	const ctor = (vscode as unknown as { LanguageModelThinkingPart?: unknown }).LanguageModelThinkingPart;
	return typeof ctor === "function" ? (ctor as ThinkingCtor) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isTextPart(part: unknown): part is { value: string } {
	return part instanceof vscode.LanguageModelTextPart;
}

function isThinkingPart(part: unknown): part is { value: string | string[] } {
	const ctor = thinkingPartClass();
	return !!ctor && part instanceof ctor;
}

function isToolCallPart(part: unknown): part is { callId: string; name: string; input: unknown } {
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return true;
	}
	return isObject(part) && typeof part.callId === "string" && typeof part.name === "string" && "input" in part;
}

function isToolResultPart(part: unknown): part is { callId: string; content: readonly unknown[] } {
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return true;
	}
	return isObject(part) && typeof part.callId === "string" && Array.isArray(part.content);
}

function isDataPart(part: unknown): part is { mimeType: string; data: Uint8Array } {
	if (part instanceof vscode.LanguageModelDataPart) {
		return true;
	}
	return isObject(part) && typeof part.mimeType === "string" && part.data instanceof Uint8Array;
}

function isImageMime(mime: string): boolean {
	return mime.toLowerCase().startsWith("image/");
}

function isTextualMime(mime: string): boolean {
	const m = mime.toLowerCase();
	return m.startsWith("text/") || m === "application/json" || m.endsWith("+json");
}

function toDataUrl(part: { mimeType: string; data: Uint8Array }): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
}

function thinkingText(value: string | string[]): string {
	return Array.isArray(value) ? value.join("") : value;
}

/** Collect the text inside a `@vscode/prompt-tsx` JSON tree; fall back to the JSON itself. */
export function promptTsxToText(value: unknown): string {
	const chunks: string[] = [];
	const walk = (node: unknown, depth: number): void => {
		if (depth > 64 || node === null || node === undefined) {
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				walk(child, depth + 1);
			}
			return;
		}
		if (isObject(node)) {
			if (typeof node.text === "string") {
				chunks.push(node.text);
			}
			for (const [key, child] of Object.entries(node)) {
				if (key !== "text" && typeof child === "object") {
					walk(child, depth + 1);
				}
			}
		}
	};
	walk(value, 0);
	if (chunks.length > 0) {
		return chunks.join("");
	}
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function roleOf(message: vscode.LanguageModelChatRequestMessage): "system" | "user" | "assistant" {
	if (message.role === vscode.LanguageModelChatMessageRole.User) {
		return "user";
	}
	if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
		return "assistant";
	}
	return "system";
}

/** Keeps tool names valid for the API and maps them back when the model calls a tool. */
export class ToolNameMap {
	private readonly toApi = new Map<string, string>();
	private readonly fromApi = new Map<string, string>();

	apiName(original: string): string {
		const existing = this.toApi.get(original);
		if (existing) {
			return existing;
		}
		let candidate = TOOL_NAME_PATTERN.test(original) ? original : original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
		let suffix = 1;
		while (this.fromApi.has(candidate) && this.fromApi.get(candidate) !== original) {
			const tail = `_${suffix++}`;
			candidate = `${candidate.slice(0, 64 - tail.length)}${tail}`;
		}
		this.toApi.set(original, candidate);
		this.fromApi.set(candidate, original);
		return candidate;
	}

	originalName(apiName: string): string {
		return this.fromApi.get(apiName) ?? apiName;
	}
}

/** Content parts (text and images) of a message, in their original order. */
class ContentBuilder {
	private readonly parts: OpenAIContentPart[] = [];
	private hasImage = false;

	constructor(private readonly supportsImages: boolean) {}

	text(value: string): void {
		if (!value) {
			return;
		}
		const last = this.parts[this.parts.length - 1];
		if (last && last.type === "text") {
			last.text += value;
		} else {
			this.parts.push({ type: "text", text: value });
		}
	}

	image(part: { mimeType: string; data: Uint8Array }): void {
		if (this.supportsImages) {
			this.parts.push({ type: "image_url", image_url: { url: toDataUrl(part) } });
			this.hasImage = true;
		} else {
			this.text(IMAGE_OMITTED_NOTE);
		}
	}

	get isEmpty(): boolean {
		return this.parts.length === 0;
	}

	/** A plain string when there is no image, the parts array otherwise. */
	build(): string | OpenAIContentPart[] {
		if (!this.hasImage) {
			return this.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
		}
		return this.parts;
	}
}

function toolResultContent(part: { callId: string; content: readonly unknown[] }, images: ContentBuilder, supportsImages: boolean): string {
	let text = "";
	let imageCount = 0;
	for (const item of part.content ?? []) {
		if (isTextPart(item)) {
			text += item.value;
		} else if (typeof item === "string") {
			text += item;
		} else if (isDataPart(item)) {
			if (isImageMime(item.mimeType)) {
				if (supportsImages) {
					images.image(item);
					imageCount++;
				} else {
					text += text ? `\n${TOOL_IMAGE_OMITTED_NOTE}` : TOOL_IMAGE_OMITTED_NOTE;
				}
			} else if (isTextualMime(item.mimeType)) {
				text += new TextDecoder().decode(item.data);
			}
		} else if (isObject(item) && "value" in item) {
			text += promptTsxToText(item.value);
		} else if (item !== undefined && item !== null) {
			text += promptTsxToText(item);
		}
	}
	if (imageCount > 0) {
		const note = imageCount === 1 ? "[The tool returned an image, shown below.]" : `[The tool returned ${imageCount} images, shown below.]`;
		text = text ? `${text}\n${note}` : note;
	}
	return text;
}

/**
 * Convert editor chat messages to OpenAI chat messages.
 *
 * - System, user and assistant text keeps its order; images become `image_url` data URLs.
 * - Assistant tool calls become `tool_calls`; thinking from earlier turns goes back as
 *   `reasoning_content`, which models that need it read and others ignore.
 * - Tool results become `tool` messages. Images returned by tools follow the batch's results in
 *   one user message.
 * - Every tool call is answered before the conversation continues and results that answer no
 *   call are dropped, so an interrupted tool run cannot make the request invalid.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: ConvertOptions,
	toolNames: ToolNameMap = new ToolNameMap(),
): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];
	const supportsTools = options.supportsTools !== false;
	let pendingCalls: string[] = [];
	let answered = new Set<string>();
	let toolImages = new ContentBuilder(options.supportsImages);

	const closeToolBatch = (): void => {
		for (const id of pendingCalls) {
			if (!answered.has(id)) {
				out.push({ role: "tool", tool_call_id: id, content: MISSING_TOOL_RESULT });
			}
		}
		if (!toolImages.isEmpty) {
			out.push({ role: "user", content: toolImages.build() });
		}
		pendingCalls = [];
		answered = new Set();
		toolImages = new ContentBuilder(options.supportsImages);
	};

	for (const message of messages) {
		const role = roleOf(message);
		const content = new ContentBuilder(options.supportsImages && role === "user");
		const toolCalls: OpenAIToolCall[] = [];
		let reasoning = "";

		for (const part of message.content ?? []) {
			if (isTextPart(part)) {
				content.text(part.value);
			} else if (isThinkingPart(part)) {
				reasoning += thinkingText(part.value);
			} else if (isToolCallPart(part)) {
				let args = "{}";
				try {
					args = JSON.stringify(part.input ?? {}) ?? "{}";
				} catch {
					args = "{}";
				}
				if (!supportsTools) {
					content.text(`${content.isEmpty ? "" : "\n"}[Called tool ${part.name} with ${args}]`);
					continue;
				}
				toolCalls.push({
					id: part.callId || `call_${out.length}_${toolCalls.length}`,
					type: "function",
					function: { name: toolNames.apiName(part.name), arguments: args },
				});
			} else if (isToolResultPart(part)) {
				if (!supportsTools) {
					const resultText = toolResultContent(part, content, options.supportsImages && role === "user");
					content.text(`${content.isEmpty ? "" : "\n"}[Tool result: ${resultText}]`);
					continue;
				}
				const id = part.callId;
				if (pendingCalls.includes(id) && !answered.has(id)) {
					answered.add(id);
					out.push({ role: "tool", tool_call_id: id, content: toolResultContent(part, toolImages, options.supportsImages) });
				}
			} else if (isDataPart(part)) {
				if (isImageMime(part.mimeType)) {
					content.image(part);
				} else if (isTextualMime(part.mimeType) && role !== "assistant") {
					// Text attachments are rare here; editor-internal markers use other MIME types.
					content.text(new TextDecoder().decode(part.data));
				}
			} else if (isObject(part) && typeof part.value === "string") {
				content.text(part.value);
			}
		}

		if (role === "assistant") {
			const built = content.build();
			const text = typeof built === "string" ? built : "";
			if (toolCalls.length === 0 && !text) {
				continue;
			}
			closeToolBatch();
			const assistant: OpenAIMessage = { role: "assistant", content: text || null };
			if (toolCalls.length > 0) {
				assistant.tool_calls = toolCalls;
				pendingCalls = toolCalls.map((call) => call.id);
			}
			if (reasoning) {
				assistant.reasoning_content = reasoning;
			}
			out.push(assistant);
			continue;
		}

		if (!content.isEmpty) {
			closeToolBatch();
			out.push({ role, content: content.build() });
		}
	}

	closeToolBatch();
	return out;
}

/** Make sure a tool's input schema is an object schema the API accepts. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
	if (!isObject(schema) || Array.isArray(schema)) {
		return { type: "object", properties: {} };
	}
	const copy: Record<string, unknown> = { ...schema };
	delete copy.$schema;
	if (copy.type === undefined) {
		copy.type = "object";
	}
	if (copy.type === "object" && !isObject(copy.properties)) {
		copy.properties = {};
	}
	return copy;
}

/** Convert the editor's tool list and tool mode to OpenAI `tools` and `tool_choice`. */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	toolMode: vscode.LanguageModelChatToolMode | undefined,
	toolNames: ToolNameMap,
): { tools?: OpenAITool[]; tool_choice?: "auto" | "required" } {
	if (!tools || tools.length === 0) {
		return {};
	}
	const converted: OpenAITool[] = tools.map((tool) => ({
		type: "function",
		function: {
			name: toolNames.apiName(tool.name),
			...(tool.description ? { description: tool.description } : {}),
			parameters: normalizeSchema(tool.inputSchema),
		},
	}));
	const required = toolMode === vscode.LanguageModelChatToolMode.Required;
	return { tools: converted, tool_choice: required ? "required" : "auto" };
}
