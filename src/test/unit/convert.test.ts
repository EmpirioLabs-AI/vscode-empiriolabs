import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ToolNameMap, convertMessages, convertTools, normalizeSchema, promptTsxToText } from "../../convert";
import { LanguageModelThinkingPart } from "../vscodeMock";

const { User, Assistant } = vscode.LanguageModelChatMessageRole;
const System = 3 as vscode.LanguageModelChatMessageRole;

function msg(role: vscode.LanguageModelChatMessageRole, ...content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role, content, name: undefined };
}
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const call = (id: string, name: string, input: object) => new vscode.LanguageModelToolCallPart(id, name, input);
const result = (id: string, ...content: unknown[]) => new vscode.LanguageModelToolResultPart(id, content);
const png = new vscode.LanguageModelDataPart(new Uint8Array([137, 80, 78, 71]), "image/png");

describe("convertMessages", () => {
	it("maps system, user and assistant text in order", () => {
		const out = convertMessages([msg(System, text("Be brief.")), msg(User, text("Hi "), text("there")), msg(Assistant, text("Hello"))], {
			supportsImages: false,
		});
		assert.deepEqual(out, [
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "Hi there" },
			{ role: "assistant", content: "Hello" },
		]);
	});

	it("turns tool calls and their results into tool_calls and tool messages", () => {
		const out = convertMessages(
			[
				msg(User, text("Weather in Paris?")),
				msg(Assistant, text("Checking."), call("call_1", "get_weather", { city: "Paris" })),
				msg(User, result("call_1", text('{"temp":18}'))),
			],
			{ supportsImages: false },
		);
		assert.deepEqual(out, [
			{ role: "user", content: "Weather in Paris?" },
			{
				role: "assistant",
				content: "Checking.",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
			},
			{ role: "tool", tool_call_id: "call_1", content: '{"temp":18}' },
		]);
	});

	it("keeps parallel results together and answers calls that never got a result", () => {
		const out = convertMessages(
			[
				msg(Assistant, call("a", "read", { path: "x" }), call("b", "read", { path: "y" }), call("c", "read", { path: "z" })),
				msg(User, result("b", text("B"))),
				msg(User, result("a", text("A"))),
				msg(User, result("zzz", text("orphan"))),
				msg(User, text("next question")),
			],
			{ supportsImages: false },
		);
		assert.deepEqual(
			out.map((m) => [m.role, m.tool_call_id ?? "", typeof m.content === "string" ? m.content : ""]),
			[
				["assistant", "", ""],
				["tool", "b", "B"],
				["tool", "a", "A"],
				["tool", "c", "No result was returned for this tool call."],
				["user", "", "next question"],
			],
		);
		assert.equal(out[0].content, null);
	});

	it("sends images as data URLs to vision models and a note to others", () => {
		const vision = convertMessages([msg(User, text("What is this?"), png)], { supportsImages: true });
		assert.deepEqual(vision, [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is this?" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
				],
			},
		]);
		const plain = convertMessages([msg(User, text("What is this? "), png)], { supportsImages: false });
		assert.equal(plain[0].content, "What is this? [An image was attached here, but this model does not accept image input.]");
	});

	it("attaches tool images after all tool results of the batch", () => {
		const out = convertMessages(
			[
				msg(Assistant, call("a", "screenshot", {}), call("b", "read", {})),
				msg(User, result("a", text("captured"), png)),
				msg(User, result("b", text("file"))),
			],
			{ supportsImages: true },
		);
		assert.deepEqual(
			out.map((m) => m.role),
			["assistant", "tool", "tool", "user"],
		);
		assert.equal(out[1].content, "captured\n[The tool returned an image, shown below.]");
		assert.deepEqual(out[3].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } }]);

		const noVision = convertMessages([msg(Assistant, call("a", "screenshot", {})), msg(User, result("a", png))], { supportsImages: false });
		assert.deepEqual(
			noVision.map((m) => m.role),
			["assistant", "tool"],
		);
		assert.equal(noVision[1].content, "[The tool returned an image, but this model does not accept image input.]");
	});

	it("sends earlier thinking back as reasoning_content and drops thinking-only turns", () => {
		const out = convertMessages(
			[
				msg(User, text("q")),
				msg(Assistant, new LanguageModelThinkingPart(["Let me ", "look."]), call("a", "read", {})),
				msg(User, result("a", text("r"))),
				msg(Assistant, new LanguageModelThinkingPart("only thinking")),
			],
			{ supportsImages: false },
		);
		assert.equal(out.length, 3);
		assert.equal(out[1].reasoning_content, "Let me look.");
	});

	it("reads text, JSON data and prompt-tsx content in tool results", () => {
		const tsx = { node: { type: 1, children: [{ type: 2, text: "line one" }, { type: 2, text: " and two" }] } };
		const out = convertMessages(
			[
				msg(Assistant, call("a", "t", {})),
				msg(User, result("a", "plain ", vscode.LanguageModelDataPart.json({ ok: true }), new vscode.LanguageModelPromptTsxPart(tsx))),
			],
			{ supportsImages: false },
		);
		assert.equal(out[1].content, 'plain {"ok":true}line one and two');
	});

	it("sends tool history as text to a model without tool calling", () => {
		const out = convertMessages(
			[
				msg(User, text("Weather?")),
				msg(Assistant, text("Checking."), call("a", "get_weather", { city: "Paris" })),
				msg(User, result("a", text('{"temp":18}'))),
				msg(User, text("Thanks")),
			],
			{ supportsImages: false, supportsTools: false },
		);
		assert.deepEqual(out, [
			{ role: "user", content: "Weather?" },
			{ role: "assistant", content: 'Checking.\n[Called tool get_weather with {"city":"Paris"}]' },
			{ role: "user", content: '[Tool result: {"temp":18}]' },
			{ role: "user", content: "Thanks" },
		]);
	});

	it("ignores editor-internal data parts such as cache markers", () => {
		const marker = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
		const out = convertMessages([msg(User, text("hi"), marker)], { supportsImages: true });
		assert.deepEqual(out, [{ role: "user", content: "hi" }]);
	});
});

describe("tool translation", () => {
	it("converts tools and maps the tool mode to tool_choice", () => {
		const names = new ToolNameMap();
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
			{ name: "no_args", description: "" },
		];
		assert.deepEqual(convertTools(tools, vscode.LanguageModelChatToolMode.Auto, names), {
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Weather for a city",
						parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
					},
				},
				{ type: "function", function: { name: "no_args", parameters: { type: "object", properties: {} } } },
			],
			tool_choice: "auto",
		});
		assert.equal(convertTools(tools, vscode.LanguageModelChatToolMode.Required, names).tool_choice, "required");
		assert.deepEqual(convertTools([], vscode.LanguageModelChatToolMode.Auto, names), {});
	});

	it("renames tools the API would reject and maps the name back", () => {
		const names = new ToolNameMap();
		const converted = convertTools([{ name: "mcp.github/search", description: "d" }], undefined, names);
		const apiName = converted.tools?.[0].function.name ?? "";
		assert.equal(apiName, "mcp_github_search");
		assert.equal(names.originalName(apiName), "mcp.github/search");
		assert.equal(names.apiName("mcp_github_search"), "mcp_github_search_1");
		assert.equal(names.originalName("mcp_github_search_1"), "mcp_github_search");
		// Tool calls in the history use the same mapping.
		const out = convertMessages([msg(Assistant, call("x", "mcp.github/search", { q: 1 }))], { supportsImages: false }, names);
		assert.equal(out[0].tool_calls?.[0].function.name, "mcp_github_search");
	});

	it("normalizes schemas to object schemas", () => {
		assert.deepEqual(normalizeSchema(undefined), { type: "object", properties: {} });
		assert.deepEqual(normalizeSchema({ $schema: "http://json-schema.org/draft-07/schema#", properties: { a: { type: "number" } } }), {
			type: "object",
			properties: { a: { type: "number" } },
		});
	});

	it("extracts text from prompt-tsx trees", () => {
		assert.equal(promptTsxToText({ node: { children: [{ text: "a" }, { children: [{ text: "b" }] }] } }), "ab");
		assert.equal(promptTsxToText({ x: 1 }), '{"x":1}');
	});
});
