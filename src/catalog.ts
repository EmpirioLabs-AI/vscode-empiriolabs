import type * as vscode from "vscode";
import {
	API_BASE_URL,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_OUTPUT_TOKENS,
	MODEL_CACHE_TTL_MS,
} from "./constants";
import { readErrorResponse } from "./errors";

/** One parameter of a model's request schema, as published in the catalog. */
export interface CatalogParameter {
	readonly name: string;
	readonly type?: string;
	readonly default?: unknown;
	readonly options?: readonly unknown[];
	readonly min?: number;
	readonly max?: number;
}

/** The subset of a `GET /v1/models` entry this extension reads. */
export interface CatalogModel {
	readonly id: string;
	readonly display_name?: string | null;
	readonly description?: string | null;
	readonly status?: string | null;
	readonly supported_endpoints?: readonly string[] | null;
	readonly context_length?: number | null;
	readonly context_window?: number | null;
	readonly max_output_tokens?: number | null;
	readonly input_modalities?: readonly string[] | null;
	readonly output_modalities?: readonly string[] | null;
	readonly features?: readonly string[] | null;
	readonly capabilities?: Readonly<Record<string, unknown>> | null;
	readonly supported_parameters?: readonly CatalogParameter[] | null;
	readonly deprecated?: boolean | null;
	readonly deprecation_date?: string | null;
}

/** JSON-schema property rendered by the editor as a picker next to the model (proposed API shape). */
export interface ConfigurationProperty {
	readonly type: "string";
	readonly title: string;
	readonly enum: string[];
	readonly enumItemLabels: string[];
	readonly default?: string;
	readonly group: "navigation";
}

/**
 * Model information handed to the editor. The optional fields after `capabilities` belong to the
 * editor's proposed API: hosts that know them use them, older hosts ignore them.
 */
export interface EmpirioModelInfo extends vscode.LanguageModelChatInformation {
	readonly maxContextWindowTokens: number;
	readonly configurationSchema?: { readonly properties: Record<string, ConfigurationProperty> };
	/** Value of the catalog's `max_tokens` default for this model, when it has one. */
	readonly catalogDefaultMaxTokens?: number;
}

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const TOOL_FEATURES = new Set(["function_calling", "tool_calling", "tools"]);

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function lower(values: readonly string[] | null | undefined): string[] {
	return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
}

/** True when the entry lists `POST /v1/chat/completions` (a bare path counts as POST). */
export function supportsChatCompletions(model: CatalogModel): boolean {
	const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
	return endpoints.some((entry) => {
		if (typeof entry !== "string") {
			return false;
		}
		const parts = entry.trim().split(/\s+/);
		const path = parts[parts.length - 1];
		const method = parts.length > 1 ? parts[0].toUpperCase() : "POST";
		return method === "POST" && path === CHAT_COMPLETIONS_PATH;
	});
}

/** Whether a catalog entry belongs in the chat model picker. */
export function isChatModel(model: CatalogModel): boolean {
	if (!model || typeof model.id !== "string" || model.id.length === 0) {
		return false;
	}
	if (model.status && model.status !== "available") {
		return false;
	}
	if (!supportsChatCompletions(model)) {
		return false;
	}
	const outputs = lower(model.output_modalities);
	return outputs.length === 0 || outputs.includes("text");
}

/** Tool calling, from the catalog's feature tags. */
export function supportsToolCalling(model: CatalogModel): boolean {
	return lower(model.features).some((feature) => TOOL_FEATURES.has(feature));
}

/** Image input, from the catalog's input modalities and capability flags. */
export function supportsImageInput(model: CatalogModel): boolean {
	return (
		lower(model.input_modalities).includes("image") ||
		model.capabilities?.images === true ||
		lower(model.features).includes("vision")
	);
}

/**
 * Token limits the editor budgets with. The editor treats input plus output as the context
 * window, so the prompt budget is what the window leaves after the output allowance, and never
 * less than half the window.
 */
export function tokenLimits(model: CatalogModel): { contextWindow: number; maxInputTokens: number; maxOutputTokens: number } {
	const contextWindow = positiveInt(model.context_length) ?? positiveInt(model.context_window) ?? DEFAULT_CONTEXT_WINDOW;
	let maxOutputTokens = Math.min(positiveInt(model.max_output_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS, contextWindow);
	let maxInputTokens = contextWindow - maxOutputTokens;
	const minInputTokens = Math.floor(contextWindow / 2);
	if (maxInputTokens < minInputTokens) {
		maxInputTokens = minInputTokens;
		maxOutputTokens = contextWindow - minInputTokens;
	}
	return { contextWindow, maxInputTokens, maxOutputTokens };
}

function effortLabel(value: string): string {
	if (value === "xhigh") {
		return "Extra High";
	}
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function findParameter(model: CatalogModel, name: string): CatalogParameter | undefined {
	return (Array.isArray(model.supported_parameters) ? model.supported_parameters : []).find((p) => p && p.name === name);
}

/** A "Thinking Effort" picker for models whose catalog schema has a `reasoning_effort` enum. */
export function reasoningEffortProperty(model: CatalogModel): ConfigurationProperty | undefined {
	const parameter = findParameter(model, "reasoning_effort");
	if (!parameter || parameter.type !== "enum" || !Array.isArray(parameter.options)) {
		return undefined;
	}
	const options = parameter.options.filter((o): o is string => typeof o === "string" && o.length > 0);
	if (options.length === 0) {
		return undefined;
	}
	const property: ConfigurationProperty = {
		type: "string",
		title: "Thinking Effort",
		enum: options,
		enumItemLabels: options.map(effortLabel),
		group: "navigation",
	};
	return typeof parameter.default === "string" && options.includes(parameter.default)
		? { ...property, default: parameter.default }
		: property;
}

function tooltipFor(model: CatalogModel): string {
	const parts: string[] = [];
	const description = typeof model.description === "string" ? model.description.trim() : "";
	if (description) {
		parts.push(description);
	}
	if (model.deprecation_date) {
		parts.push(`Scheduled for retirement on ${model.deprecation_date}.`);
	}
	return parts.length > 0 ? parts.join(" ") : (model.display_name ?? model.id);
}

/** Map one catalog entry to editor model information, or `undefined` when it is not a chat model. */
export function toChatInformation(model: CatalogModel): EmpirioModelInfo | undefined {
	if (!isChatModel(model)) {
		return undefined;
	}
	const { contextWindow, maxInputTokens, maxOutputTokens } = tokenLimits(model);
	const effort = reasoningEffortProperty(model);
	const catalogDefaultMaxTokens = positiveInt(findParameter(model, "max_tokens")?.default);
	const name = typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : model.id;
	return {
		id: model.id,
		name,
		family: model.id,
		version: "1.0.0",
		tooltip: tooltipFor(model),
		maxInputTokens,
		maxOutputTokens,
		maxContextWindowTokens: contextWindow,
		capabilities: {
			toolCalling: supportsToolCalling(model),
			imageInput: supportsImageInput(model),
		},
		...(effort ? { configurationSchema: { properties: { reasoningEffort: effort } } } : {}),
		...(catalogDefaultMaxTokens ? { catalogDefaultMaxTokens } : {}),
	};
}

/** Map a whole catalog, keeping its order and dropping duplicates and non-chat entries. */
export function toChatInformationList(models: readonly CatalogModel[]): EmpirioModelInfo[] {
	const seen = new Set<string>();
	const out: EmpirioModelInfo[] = [];
	for (const model of models) {
		const info = toChatInformation(model);
		if (info && !seen.has(info.id)) {
			seen.add(info.id);
			out.push(info);
		}
	}
	return out;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads the public catalog (`GET /v1/models`, no key needed) and keeps the mapped list for a few
 * minutes. A failed read falls back to the last good list; with none, the error is thrown so the
 * editor can show it next to the provider.
 */
export class ModelCatalog {
	private cache: { at: number; models: EmpirioModelInfo[] } | undefined;
	private inflight: Promise<EmpirioModelInfo[]> | undefined;

	constructor(
		private readonly fetchImpl: FetchLike,
		private readonly userAgent: string,
		private readonly baseUrl: string = API_BASE_URL,
		private readonly ttlMs: number = MODEL_CACHE_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** Drop the cached list so the next read goes to the network. */
	invalidate(): void {
		this.cache = undefined;
	}

	async getModels(): Promise<EmpirioModelInfo[]> {
		if (this.cache && this.now() - this.cache.at < this.ttlMs) {
			return this.cache.models;
		}
		if (!this.inflight) {
			this.inflight = this.fetchModels().finally(() => {
				this.inflight = undefined;
			});
		}
		try {
			const models = await this.inflight;
			this.cache = { at: this.now(), models };
			return models;
		} catch (error) {
			if (this.cache) {
				return this.cache.models;
			}
			throw error;
		}
	}

	private async fetchModels(): Promise<EmpirioModelInfo[]> {
		const response = await this.fetchImpl(`${this.baseUrl}/models`, {
			method: "GET",
			headers: { Accept: "application/json", "User-Agent": this.userAgent },
		});
		if (!response.ok) {
			throw await readErrorResponse(response);
		}
		const body = (await response.json()) as { data?: unknown };
		if (!body || !Array.isArray(body.data)) {
			throw new Error("The EmpirioLabs AI model list could not be read. Try again in a moment.");
		}
		const models = toChatInformationList(body.data as CatalogModel[]);
		if (models.length === 0) {
			throw new Error("The EmpirioLabs AI model list is empty. Try again in a moment.");
		}
		return models;
	}
}
