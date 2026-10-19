import * as assert from "node:assert/strict";
import {
	type CatalogModel,
	type EmpirioModelInfo,
	ModelCatalog,
	isChatModel,
	reasoningEffortProperty,
	supportsImageInput,
	supportsToolCalling,
	toChatInformation,
	toChatInformationList,
	tokenLimits,
} from "../../catalog";
import { LIVE_CATALOG_SAMPLE } from "../fixtures/catalogSample";

function model(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
	return {
		supported_endpoints: ["POST /v1/chat/completions"],
		output_modalities: ["text"],
		...overrides,
	};
}

describe("catalog mapping", () => {
	const mapped = toChatInformationList(LIVE_CATALOG_SAMPLE);
	const get = (id: string): EmpirioModelInfo => {
		const found = mapped.find((m) => m.id === id);
		assert.ok(found, `expected ${id} in the mapped list`);
		return found;
	};

	it("keeps only models that accept POST /v1/chat/completions and answer with text", () => {
		assert.deepEqual(
			mapped.map((m) => m.id),
			["glm-5-3", "qwen3-7-flash", "glm-4-7-flash", "perplexity-sonar", "mimo-v2-5", "deepreasoning"],
		);
		// aplomb-1 lists chat completions but answers with decisions; kling-3-0-turbo is video only.
		assert.equal(isChatModel(LIVE_CATALOG_SAMPLE.find((m) => m.id === "aplomb-1")!), false);
		assert.equal(isChatModel(LIVE_CATALOG_SAMPLE.find((m) => m.id === "kling-3-0-turbo")!), false);
	});

	it("takes tool calling and image input from the catalog entry", () => {
		assert.deepEqual(get("glm-5-3").capabilities, { toolCalling: true, imageInput: false });
		assert.deepEqual(get("qwen3-7-flash").capabilities, { toolCalling: true, imageInput: true });
		assert.deepEqual(get("glm-4-7-flash").capabilities, { toolCalling: true, imageInput: false });
		assert.deepEqual(get("perplexity-sonar").capabilities, { toolCalling: false, imageInput: true });
		assert.deepEqual(get("deepreasoning").capabilities, { toolCalling: false, imageInput: false });
	});

	it("uses the display name, the id as family, and the catalog description as tooltip", () => {
		const glm = get("glm-5-3");
		assert.equal(glm.name, "GLM 5.3");
		assert.equal(glm.family, "glm-5-3");
		assert.match(glm.tooltip ?? "", /^Coding and agentic model/);
		assert.match(get("mimo-v2-5").tooltip ?? "", /Scheduled for retirement on 2026-10-20\.$/);
	});

	it("derives token limits so input plus output never exceeds the context window", () => {
		assert.deepEqual(
			[get("glm-5-3").maxInputTokens, get("glm-5-3").maxOutputTokens, get("glm-5-3").maxContextWindowTokens],
			[868_928, 131_072, 1_000_000],
		);
		// No max_output_tokens: 8,192 is assumed.
		assert.deepEqual([get("perplexity-sonar").maxInputTokens, get("perplexity-sonar").maxOutputTokens], [118_808, 8_192]);
		// No context length: 128K is assumed.
		assert.deepEqual([get("deepreasoning").maxInputTokens, get("deepreasoning").maxOutputTokens], [96_000, 32_000]);
		// An output allowance close to the window still leaves half the window for the prompt.
		assert.deepEqual(tokenLimits(model({ id: "x", context_length: 10_000, max_output_tokens: 9_000 })), {
			contextWindow: 10_000,
			maxInputTokens: 5_000,
			maxOutputTokens: 5_000,
		});
		for (const info of mapped) {
			assert.ok(info.maxInputTokens + info.maxOutputTokens <= info.maxContextWindowTokens, info.id);
			assert.ok(info.maxInputTokens > 0 && info.maxOutputTokens > 0, info.id);
		}
	});

	it("offers a Thinking Effort picker from the catalog's reasoning_effort options", () => {
		assert.deepEqual(get("glm-5-3").configurationSchema, {
			properties: {
				reasoningEffort: {
					type: "string",
					title: "Thinking Effort",
					enum: ["low", "high", "max"],
					enumItemLabels: ["Low", "High", "Max"],
					default: "max",
					group: "navigation",
				},
			},
		});
		assert.equal(get("glm-4-7-flash").configurationSchema, undefined);
		const effort = reasoningEffortProperty(
			model({ id: "x", supported_parameters: [{ name: "reasoning_effort", type: "enum", options: ["none", "xhigh"], default: "bogus" }] }),
		);
		assert.deepEqual(effort?.enumItemLabels, ["None", "Extra High"]);
		assert.equal(effort?.default, undefined);
	});

	it("records the catalog's default max_tokens for the request budget", () => {
		assert.equal(get("glm-5-3").catalogDefaultMaxTokens, 65_536);
		assert.equal(get("qwen3-7-flash").catalogDefaultMaxTokens, 4_096);
	});

	it("handles bare paths, other methods, unavailable entries, synonyms and duplicates", () => {
		assert.equal(isChatModel(model({ id: "a", supported_endpoints: ["/v1/chat/completions"] })), true);
		assert.equal(isChatModel(model({ id: "b", supported_endpoints: ["GET /v1/chat/completions"] })), false);
		assert.equal(isChatModel(model({ id: "c", status: "unavailable" })), false);
		assert.equal(isChatModel(model({ id: "d", output_modalities: [] })), true);
		assert.equal(supportsToolCalling(model({ id: "e", features: ["Tool_Calling"] })), true);
		assert.equal(supportsImageInput(model({ id: "f", capabilities: { images: true } })), true);
		const list = toChatInformationList([model({ id: "dup", display_name: "One" }), model({ id: "dup", display_name: "Two" })]);
		assert.deepEqual(
			list.map((m) => m.name),
			["One"],
		);
		assert.equal(toChatInformation(model({ id: "g", display_name: "  " }))?.name, "g");
	});
});

describe("ModelCatalog", () => {
	const body = JSON.stringify({ object: "list", data: LIVE_CATALOG_SAMPLE });

	function setup(responses: (() => Response)[]) {
		let clock = 0;
		const calls: string[] = [];
		const fetchImpl = async (url: string): Promise<Response> => {
			calls.push(url);
			const next = responses.shift();
			if (!next) {
				throw new TypeError("fetch failed");
			}
			return next();
		};
		const catalog = new ModelCatalog(fetchImpl, "test-agent", "https://api.example.test/v1", 1000, () => clock);
		return { catalog, calls, advance: (ms: number) => (clock += ms) };
	}

	it("reads GET /v1/models once and reuses the list until it expires", async () => {
		const { catalog, calls, advance } = setup([() => new Response(body), () => new Response(body)]);
		const [a, b] = await Promise.all([catalog.getModels(), catalog.getModels()]);
		assert.equal(a.length, 6);
		assert.equal(a, b);
		await catalog.getModels();
		assert.deepEqual(calls, ["https://api.example.test/v1/models"]);
		advance(1001);
		await catalog.getModels();
		assert.equal(calls.length, 2);
	});

	it("keeps serving the last good list when a refresh fails", async () => {
		const { catalog, advance } = setup([() => new Response(body), () => new Response("upstream down", { status: 503 })]);
		const first = await catalog.getModels();
		advance(5000);
		assert.equal(await catalog.getModels(), first);
	});

	it("throws a readable error when there is no list to fall back to", async () => {
		const { catalog } = setup([() => new Response("{}", { status: 503 })]);
		await assert.rejects(catalog.getModels(), /could not complete the request \(HTTP 503\)/);
		const empty = setup([() => new Response(JSON.stringify({ data: [] }))]);
		await assert.rejects(empty.catalog.getModels(), /model list is empty/);
	});

	it("re-reads after invalidate()", async () => {
		const { catalog, calls } = setup([() => new Response(body), () => new Response(body)]);
		await catalog.getModels();
		catalog.invalidate();
		await catalog.getModels();
		assert.equal(calls.length, 2);
	});
});
