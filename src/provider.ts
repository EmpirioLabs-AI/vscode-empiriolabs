import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { type EmpirioModelInfo, type FetchLike, ModelCatalog } from "./catalog";
import { API_BASE_URL, DEFAULT_MAX_INPUT_TOKENS, DEFAULT_REQUEST_MAX_TOKENS, MIN_MAX_INPUT_TOKENS } from "./constants";
import { ToolNameMap, convertMessages, convertTools } from "./convert";
import { EmpirioApiError, MissingApiKeyError, readErrorResponse } from "./errors";
import { ChatStreamProcessor, consumeEventStream } from "./stream";
import { estimateTokens } from "./tokens";

/** Where the key set with the "Manage API Key" command lives. */
export interface ApiKeyStore {
	get(): Promise<string | undefined>;
	/** Ask for a key and save it; resolves to `undefined` when the user cancels. */
	prompt(): Promise<string | undefined>;
}

/** Options the editor passes when it lists models. `configuration` is set for a provider group. */
export interface ModelListOptions {
	readonly silent: boolean;
	readonly configuration?: { readonly apiKey?: unknown; readonly [key: string]: unknown };
}

/** Request options, including the per-model settings newer editors pass along. */
export type ChatRequestOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: { readonly [key: string]: unknown };
};

export type Logger = (message: string) => void;

const SAMPLING_OPTIONS = ["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed"] as const;

function cleanKey(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function keyHash(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** The prompt cap from the `empiriolabs.maxInputTokens` setting: the default when unset or invalid, never below the minimum. */
export function normalizeMaxInputTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_MAX_INPUT_TOKENS;
	}
	return Math.max(MIN_MAX_INPUT_TOKENS, Math.floor(value));
}

/**
 * A model's limits under the prompt cap: the input budget is the smaller of the catalog budget
 * and the cap. The editor shows context use against the context window, so the window shrinks
 * with the input budget instead of advertising room the editor will not fill.
 */
export function applyInputCap(model: EmpirioModelInfo, cap: number): EmpirioModelInfo {
	const maxInputTokens = Math.min(model.maxInputTokens, cap);
	const maxContextWindowTokens = Math.min(model.maxContextWindowTokens, maxInputTokens + model.maxOutputTokens);
	return { ...model, capabilities: { ...model.capabilities }, maxInputTokens, maxContextWindowTokens };
}

/** The output budget for a request: the caller's value, else a default sized for agent work. */
export function resolveMaxTokens(model: EmpirioModelInfo, modelOptions: { readonly [name: string]: unknown } | undefined): number {
	const requested = positiveInt(modelOptions?.max_tokens) ?? positiveInt(modelOptions?.maxTokens) ?? positiveInt(modelOptions?.max_output_tokens);
	const fallback = Math.max(DEFAULT_REQUEST_MAX_TOKENS, model.catalogDefaultMaxTokens ?? 0);
	return Math.max(1, Math.min(requested ?? fallback, model.maxOutputTokens));
}

/** Build the `POST /v1/chat/completions` body for one request. */
export function buildRequestBody(
	model: EmpirioModelInfo,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: ChatRequestOptions,
	toolNames: ToolNameMap,
): Record<string, unknown> {
	const supportsImages = !!model.capabilities?.imageInput;
	const supportsTools = !!model.capabilities?.toolCalling;
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(messages, { supportsImages, supportsTools }, toolNames),
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: resolveMaxTokens(model, options.modelOptions),
	};

	if (supportsTools) {
		Object.assign(body, convertTools(options.tools, options.toolMode, toolNames));
	}

	const modelOptions = (options.modelOptions ?? {}) as Record<string, unknown>;
	for (const name of SAMPLING_OPTIONS) {
		const value = modelOptions[name];
		if (typeof value === "number" && Number.isFinite(value)) {
			body[name] = value;
		}
	}
	const stop = modelOptions.stop;
	if (typeof stop === "string" || (Array.isArray(stop) && stop.every((s) => typeof s === "string"))) {
		body.stop = stop;
	}

	const allowedEfforts = model.configurationSchema?.properties.reasoningEffort?.enum;
	const effort = options.modelConfiguration?.reasoningEffort ?? modelOptions.reasoning_effort ?? modelOptions.reasoningEffort;
	if (typeof effort === "string" && allowedEfforts?.includes(effort)) {
		body.reasoning_effort = effort;
	}
	return body;
}

/**
 * Language model chat provider for EmpirioLabs AI.
 *
 * Keys come from two places: a provider group added in the editor's Language Models view (the
 * editor stores the key and passes it as `configuration.apiKey`), or the "Manage API Key"
 * command, which saves it in this extension's SecretStorage and serves the models without a
 * group. When both hold the same key, the models are listed once, under the group.
 */
export class EmpirioChatProvider implements vscode.LanguageModelChatProvider<EmpirioModelInfo>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	/** Which key serves each model object handed to the editor. */
	private readonly modelKeys = new WeakMap<object, string>();
	/** Hashes of keys seen in group listings since the last group-less listing. */
	private groupKeyHashes = new Set<string>();
	/** Hash of the stored key when the last group-less listing returned models. */
	private servedStoredKeyHash: string | undefined;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private lastSignature: string | undefined;
	/** Set when listing failed, so the next successful catalog read asks the editor to list again. */
	private listingFailed = false;
	private retryScheduled = false;
	private maxInputTokens = DEFAULT_MAX_INPUT_TOKENS;

	constructor(
		private readonly keys: ApiKeyStore,
		private readonly catalog: ModelCatalog,
		private readonly fetchImpl: FetchLike,
		private readonly userAgent: string,
		private readonly log: Logger = () => undefined,
		private readonly baseUrl: string = API_BASE_URL,
	) {}

	dispose(): void {
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.changeEmitter.dispose();
	}

	/** Ask the editor to list the models again. */
	notifyChanged(): void {
		this.changeEmitter.fire();
	}

	/** The prompt cap in effect. */
	get promptCap(): number {
		return this.maxInputTokens;
	}

	/**
	 * Apply a new `empiriolabs.maxInputTokens` value. When the cap in effect changes, the editor
	 * is asked to list the models again, so no reload is needed.
	 */
	setMaxInputTokens(value: unknown): void {
		const next = normalizeMaxInputTokens(value);
		if (next !== this.maxInputTokens) {
			this.maxInputTokens = next;
			this.notifyChanged();
		}
	}

	/** Read the catalog again and tell the editor when the model list changed. */
	async refreshCatalog(force: boolean): Promise<void> {
		if (force) {
			this.catalog.invalidate();
		}
		const models = await this.catalog.getModels();
		const signature = JSON.stringify(models);
		if (force || this.listingFailed || (this.lastSignature !== undefined && signature !== this.lastSignature)) {
			this.listingFailed = false;
			this.notifyChanged();
		}
		this.lastSignature = signature;
	}

	async provideLanguageModelChatInformation(options: ModelListOptions, _token: vscode.CancellationToken): Promise<EmpirioModelInfo[]> {
		try {
			const configuredKey = cleanKey(options.configuration?.apiKey);
			if (configuredKey) {
				return await this.listForGroup(configuredKey);
			}
			return await this.listWithoutGroup(options.silent);
		} catch (error) {
			this.listingFailed = true;
			this.log(`model list failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRetry();
			throw error;
		}
	}

	/** After a failed listing, read the catalog again in a minute and list again once it answers. */
	private scheduleRetry(): void {
		if (this.retryScheduled) {
			return;
		}
		this.retryScheduled = true;
		this.schedule(() => {
			this.retryScheduled = false;
			this.refreshCatalog(false).catch(() => this.scheduleRetry());
		}, 60_000);
	}

	private async listForGroup(apiKey: string): Promise<EmpirioModelInfo[]> {
		const hash = keyHash(apiKey);
		const isNew = !this.groupKeyHashes.has(hash);
		this.groupKeyHashes.add(hash);
		const models = await this.modelsFor(apiKey);
		if (isNew && this.servedStoredKeyHash === hash) {
			// The stored key is also configured as a group: list its models once, under the group.
			this.servedStoredKeyHash = undefined;
			this.notifyChanged();
		}
		return models;
	}

	private async listWithoutGroup(silent: boolean): Promise<EmpirioModelInfo[]> {
		const previousGroupKeys = this.groupKeyHashes;
		this.groupKeyHashes = new Set();
		let stored = cleanKey(await this.keys.get());
		if (!stored && !silent) {
			stored = cleanKey(await this.keys.prompt());
		}
		if (!stored) {
			this.servedStoredKeyHash = undefined;
			return [];
		}
		const hash = keyHash(stored);
		if (previousGroupKeys.has(hash)) {
			this.servedStoredKeyHash = undefined;
			// If that group was removed, no group listing follows; list the stored key again then.
			this.schedule(() => {
				if (!this.groupKeyHashes.has(hash)) {
					this.notifyChanged();
				}
			}, 3000);
			return [];
		}
		this.servedStoredKeyHash = hash;
		return this.modelsFor(stored);
	}

	private schedule(fn: () => void, ms: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			fn();
		}, ms);
		(timer as { unref?: () => void }).unref?.();
		this.timers.add(timer);
	}

	private async modelsFor(apiKey: string): Promise<EmpirioModelInfo[]> {
		const models = await this.catalog.getModels();
		this.lastSignature = JSON.stringify(models);
		return models.map((model) => {
			const copy = applyInputCap(model, this.maxInputTokens);
			this.modelKeys.set(copy, apiKey);
			return copy;
		});
	}

	async provideLanguageModelChatResponse(
		model: EmpirioModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const apiKey = this.modelKeys.get(model) ?? cleanKey(await this.keys.get());
		if (!apiKey) {
			throw new MissingApiKeyError();
		}
		const toolNames = new ToolNameMap();
		const body = buildRequestBody(model, messages, options as ChatRequestOptions, toolNames);
		const processor = new ChatStreamProcessor(progress, toolNames);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const started = Date.now();
		this.log(`request model=${model.id} messages=${messages.length} tools=${options.tools?.length ?? 0}`);

		try {
			const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"User-Agent": this.userAgent,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw await readErrorResponse(response);
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("application/json")) {
				processor.handleChunk(await response.json());
			} else if (response.body) {
				await consumeEventStream(response.body, processor, token);
			}
			if (token.isCancellationRequested) {
				return;
			}
			processor.finish();
			const stats = processor.stats;
			this.log(
				`done model=${model.id} ms=${Date.now() - started} finish=${stats.finishReason ?? "-"} toolCalls=${stats.toolCalls} ` +
					`promptTokens=${stats.usage?.prompt_tokens ?? "-"} completionTokens=${stats.usage?.completion_tokens ?? "-"}`,
			);
		} catch (error) {
			if (token.isCancellationRequested) {
				return;
			}
			if (error instanceof Error && error.name === "AbortError") {
				return;
			}
			if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
				this.log(`network error model=${model.id}`);
				throw new Error("EmpirioLabs AI could not be reached. Check your network connection, then try again.");
			}
			if (error instanceof EmpirioApiError) {
				this.log(`error model=${model.id} status=${error.status ?? "-"} code=${error.code ?? "-"} request=${error.requestId ?? "-"}`);
			}
			throw error;
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: EmpirioModelInfo,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokens(text);
	}
}
