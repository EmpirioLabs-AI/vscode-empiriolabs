import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { type EmpirioModelInfo, ModelCatalog } from "../../catalog";
import { MissingApiKeyError } from "../../errors";
import { type ApiKeyStore, EmpirioChatProvider, resolveMaxTokens } from "../../provider";
import { LIVE_CATALOG_SAMPLE } from "../fixtures/catalogSample";
import { CancellationTokenSource } from "../vscodeMock";

const CATALOG_BODY = JSON.stringify({ object: "list", data: LIVE_CATALOG_SAMPLE });
const GROUP_KEY = "sk-empiriolabs-group-key";
const STORED_KEY = "sk-empiriolabs-stored-key";

interface Recorded {
	url: string;
	init?: RequestInit;
}

function sseResponse(...events: unknown[]): Response {
	const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setup(options: { stored?: string; chat?: (() => Response)[] } = {}) {
	const requests: Recorded[] = [];
	const chat = [...(options.chat ?? [])];
	let stored = options.stored;
	let prompts = 0;
	const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push({ url, init });
		if (url.endsWith("/models")) {
			return new Response(CATALOG_BODY, { status: 200, headers: { "content-type": "application/json" } });
		}
		const next = chat.shift();
		assert.ok(next, `unexpected request to ${url}`);
		return next();
	};
	const keys: ApiKeyStore = {
		get: async () => stored,
		prompt: async () => {
			prompts++;
			return undefined;
		},
	};
	const catalog = new ModelCatalog(fetchImpl, "ua", "https://api.example.test/v1");
	const provider = new EmpirioChatProvider(keys, catalog, fetchImpl, "ua", () => undefined, "https://api.example.test/v1");
	let changes = 0;
	provider.onDidChangeLanguageModelChatInformation(() => changes++);
	return {
		provider,
		requests,
		chatRequests: () => requests.filter((r) => r.url.endsWith("/chat/completions")),
		setStored: (key: string | undefined) => (stored = key),
		get changes() {
			return changes;
		},
		get prompts() {
			return prompts;
		},
	};
}

const token = () => new CancellationTokenSource().token;
const user = (text: string): vscode.LanguageModelChatRequestMessage => ({
	role: vscode.LanguageModelChatMessageRole.User,
	content: [new vscode.LanguageModelTextPart(text)],
	name: undefined,
});
const options = (extra: Partial<vscode.ProvideLanguageModelChatResponseOptions> & Record<string, unknown> = {}) =>
	({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: {}, ...extra }) as vscode.ProvideLanguageModelChatResponseOptions;

async function listGroup(provider: EmpirioChatProvider, apiKey = GROUP_KEY): Promise<EmpirioModelInfo[]> {
	return provider.provideLanguageModelChatInformation({ silent: true, configuration: { apiKey } }, token());
}

function bodyOf(request: Recorded): Record<string, unknown> {
	return JSON.parse(String(request.init?.body));
}

function headerOf(request: Recorded, name: string): string | undefined {
	return (request.init?.headers as Record<string, string>)[name];
}

describe("EmpirioChatProvider: model list", () => {
	it("lists catalog models for a provider group added in the editor", async () => {
		const env = setup();
		const models = await listGroup(env.provider);
		assert.equal(models.length, 6);
		assert.equal(env.requests[0].url, "https://api.example.test/v1/models");
		assert.equal(headerOf(env.requests[0], "Authorization"), undefined, "the public catalog is read without a key");
	});

	it("lists models for the stored key when there is no group, and nothing without a key", async () => {
		const withKey = setup({ stored: STORED_KEY });
		assert.equal((await withKey.provider.provideLanguageModelChatInformation({ silent: true }, token())).length, 6);
		const without = setup();
		assert.deepEqual(await without.provider.provideLanguageModelChatInformation({ silent: true }, token()), []);
		assert.equal(without.prompts, 0);
		await without.provider.provideLanguageModelChatInformation({ silent: false }, token());
		assert.equal(without.prompts, 1, "asks for a key only when the editor allows prompting");
	});

	it("lists a key once when it is both stored and configured as a group", async () => {
		const env = setup({ stored: GROUP_KEY });
		// Cycle 1: the group-less listing comes first, then the group.
		assert.equal((await env.provider.provideLanguageModelChatInformation({ silent: true }, token())).length, 6);
		assert.equal((await listGroup(env.provider)).length, 6);
		assert.equal(env.changes, 1, "asks the editor to list again");
		// Cycle 2: the duplicate group-less list is gone.
		assert.deepEqual(await env.provider.provideLanguageModelChatInformation({ silent: true }, token()), []);
		assert.equal((await listGroup(env.provider)).length, 6);
		assert.equal(env.changes, 1);
		// A different stored key is a different account and stays listed.
		env.setStored(STORED_KEY);
		assert.equal((await env.provider.provideLanguageModelChatInformation({ silent: true }, token())).length, 6);
		env.provider.dispose();
	});

	it("lists again once the catalog answers after a failed read", async () => {
		let catalogUp = false;
		const fetchImpl = async (): Promise<Response> =>
			catalogUp ? new Response(CATALOG_BODY, { status: 200 }) : new Response("unavailable", { status: 503 });
		const provider = new EmpirioChatProvider(
			{ get: async () => undefined, prompt: async () => undefined },
			new ModelCatalog(fetchImpl, "ua", "https://api.example.test/v1"),
			fetchImpl,
			"ua",
		);
		let changes = 0;
		provider.onDidChangeLanguageModelChatInformation(() => changes++);
		await assert.rejects(listGroup(provider), /could not complete the request \(HTTP 503\)/);
		catalogUp = true;
		await provider.refreshCatalog(false);
		assert.equal(changes, 1, "asks the editor to list again");
		assert.equal((await listGroup(provider)).length, 6);
		await provider.refreshCatalog(false);
		assert.equal(changes, 1, "an unchanged catalog does not trigger another listing");
		provider.dispose();
	});

	it("serves each model with the key it was listed for", async () => {
		const env = setup({ stored: STORED_KEY, chat: [() => sseResponse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })] });
		const [model] = await listGroup(env.provider);
		await env.provider.provideLanguageModelChatResponse(model, [user("hi")], options(), { report: () => undefined }, token());
		assert.equal(headerOf(env.chatRequests()[0], "Authorization"), `Bearer ${GROUP_KEY}`);
	});
});

describe("EmpirioChatProvider: chat requests", () => {
	it("streams a response and builds an OpenAI-compatible request", async () => {
		const env = setup({
			chat: [
				() =>
					sseResponse(
						{ choices: [{ index: 0, delta: { content: "Hel" } }] },
						{ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
						{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
						"[DONE]",
					),
			],
		});
		const models = await listGroup(env.provider);
		const glm = models.find((m) => m.id === "glm-5-3")!;
		const parts: unknown[] = [];
		await env.provider.provideLanguageModelChatResponse(
			glm,
			[user("Say hello")],
			options({
				tools: [{ name: "get_time", description: "Current time", inputSchema: { type: "object", properties: {} } }],
				modelOptions: { temperature: 0.2, _capturingTokenCorrelationId: "internal", stop: ["END"] },
				modelConfiguration: { reasoningEffort: "low" },
			}),
			{ report: (p) => parts.push(p) },
			token(),
		);
		assert.deepEqual(
			parts.filter((p) => p instanceof vscode.LanguageModelTextPart).map((p) => (p as vscode.LanguageModelTextPart).value),
			["Hel", "lo"],
		);
		const request = env.chatRequests()[0];
		assert.equal(request.url, "https://api.example.test/v1/chat/completions");
		assert.equal(headerOf(request, "Content-Type"), "application/json");
		assert.deepEqual(bodyOf(request), {
			model: "glm-5-3",
			messages: [{ role: "user", content: "Say hello" }],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 65_536,
			tools: [{ type: "function", function: { name: "get_time", description: "Current time", parameters: { type: "object", properties: {} } } }],
			tool_choice: "auto",
			temperature: 0.2,
			stop: ["END"],
			reasoning_effort: "low",
		});
	});

	it("does not send tools to models without tool calling, nor unknown effort values", async () => {
		const env = setup({ chat: [() => sseResponse({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] })] });
		const sonar = (await listGroup(env.provider)).find((m) => m.id === "perplexity-sonar")!;
		await env.provider.provideLanguageModelChatResponse(
			sonar,
			[user("q")],
			options({ tools: [{ name: "t", description: "d" }], modelConfiguration: { reasoningEffort: "max" } }),
			{ report: () => undefined },
			token(),
		);
		const body = bodyOf(env.chatRequests()[0]);
		assert.equal(body.tools, undefined);
		assert.equal(body.tool_choice, undefined);
		assert.equal(body.reasoning_effort, undefined);
		assert.equal(body.max_tokens, 8_192, "capped by the model's output limit");
	});

	it("round-trips a tool call", async () => {
		const env = setup({
			chat: [
				() =>
					sseResponse(
						{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }] },
						{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					),
				() => sseResponse({ choices: [{ index: 0, delta: { content: "18 C in Paris." }, finish_reason: "stop" }] }),
			],
		});
		const qwen = (await listGroup(env.provider)).find((m) => m.id === "qwen3-7-flash")!;
		const tools = [{ name: "get_weather", description: "Weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }];
		const first: unknown[] = [];
		await env.provider.provideLanguageModelChatResponse(qwen, [user("Weather in Paris?")], options({ tools }), { report: (p) => first.push(p) }, token());
		const callPart = first.find((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
		assert.deepEqual([callPart.callId, callPart.name, callPart.input], ["call_1", "get_weather", { city: "Paris" }]);

		const history: vscode.LanguageModelChatRequestMessage[] = [
			user("Weather in Paris?"),
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [callPart], name: undefined },
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart('{"temp_c":18}')])],
				name: undefined,
			},
		];
		await env.provider.provideLanguageModelChatResponse(qwen, history, options({ tools }), { report: () => undefined }, token());
		const second = bodyOf(env.chatRequests()[1]);
		assert.deepEqual(second.messages, [
			{ role: "user", content: "Weather in Paris?" },
			{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
			{ role: "tool", tool_call_id: "call_1", content: '{"temp_c":18}' },
		]);
	});

	it("explains 401 and 402 responses", async () => {
		const env = setup({
			chat: [
				() => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "The API key is invalid, inactive, or expired." } }), { status: 401 }),
				() => new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "Insufficient credits." } }), { status: 402 }),
				() => new Response("<html>bad gateway</html>", { status: 502, headers: { "x-request-id": "req_123" } }),
			],
		});
		const [model] = await listGroup(env.provider);
		const ask = () => env.provider.provideLanguageModelChatResponse(model, [user("hi")], options(), { report: () => undefined }, token());
		await assert.rejects(ask(), /did not accept the API key\. Update it in the Language Models editor or with "EmpirioLabs AI: Manage API Key"/);
		await assert.rejects(ask(), /balance is too low for this request\. Add credits at https:\/\/platform\.empiriolabs\.ai\/dashboard\/billing/);
		await assert.rejects(ask(), /could not complete the request \(HTTP 502\)\. Try again in a moment\. \(request req_123\)/);
	});

	it("asks for a key when none is configured", async () => {
		const env = setup();
		const catalogOnly = await listGroup(env.provider);
		const detached = { ...catalogOnly[0] };
		await assert.rejects(
			env.provider.provideLanguageModelChatResponse(detached, [user("hi")], options(), { report: () => undefined }, token()),
			(error: unknown) => error instanceof MissingApiKeyError && /platform\.empiriolabs\.ai\/dashboard\/api-keys/.test(error.message),
		);
	});

	it("returns quietly when the request is cancelled", async () => {
		const source = new CancellationTokenSource();
		const env = setup({
			chat: [
				() => {
					source.cancel();
					throw Object.assign(new Error("aborted"), { name: "AbortError" });
				},
			],
		});
		const [model] = await listGroup(env.provider);
		await env.provider.provideLanguageModelChatResponse(model, [user("hi")], options(), { report: () => undefined }, source.token);
	});

	it("estimates tokens for text and messages", async () => {
		const env = setup();
		const [model] = await listGroup(env.provider);
		assert.equal(await env.provider.provideTokenCount(model, "abcdefg", token()), 2);
		assert.ok((await env.provider.provideTokenCount(model, user("こんにちは"), token())) >= 5);
	});
});

describe("resolveMaxTokens", () => {
	const base = { maxOutputTokens: 100_000 } as EmpirioModelInfo;
	it("uses the caller's value, else the larger of 16K and the catalog default, capped by the model", () => {
		assert.equal(resolveMaxTokens(base, { max_tokens: 500 }), 500);
		assert.equal(resolveMaxTokens(base, { maxTokens: 700 }), 700);
		assert.equal(resolveMaxTokens(base, {}), 16_384);
		assert.equal(resolveMaxTokens({ ...base, catalogDefaultMaxTokens: 65_536 }, undefined), 65_536);
		assert.equal(resolveMaxTokens({ ...base, maxOutputTokens: 5_000 }, { max_tokens: 9_999 }), 5_000);
	});
});
