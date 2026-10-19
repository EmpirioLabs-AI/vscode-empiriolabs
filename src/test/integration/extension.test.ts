import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "empiriolabs.empiriolabs-vscode-chat";
const VENDOR = "empiriolabs";
const apiKey = process.env.EMPIRIOLABS_API_KEY?.trim();
const smokeModel = process.env.EMPIRIOLABS_SMOKE_MODEL?.trim() || "qwen3-7-flash";

type TestApi = { setStoredKey(key: string): Thenable<void> } | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The editor exposes capabilities on chat models; the stable typings do not declare them yet. */
function capabilities(model: vscode.LanguageModelChat): { supportsToolCalling?: boolean; supportsImageToText?: boolean } {
	return (model as unknown as { capabilities?: { supportsToolCalling?: boolean; supportsImageToText?: boolean } }).capabilities ?? {};
}

async function waitForModels(min: number): Promise<vscode.LanguageModelChat[]> {
	let models: vscode.LanguageModelChat[] = [];
	for (let attempt = 0; attempt < 60 && models.length < min; attempt++) {
		models = await vscode.lm.selectChatModels({ vendor: VENDOR });
		if (models.length < min) {
			await sleep(1000);
		}
	}
	return models;
}

describe("EmpirioLabs AI provider in VS Code", function () {
	this.timeout(180_000);
	let api: TestApi;

	before(async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `${EXTENSION_ID} is installed`);
		if (!extension.isActive) {
			// Asking for the vendor's models must activate the extension by itself.
			await vscode.lm.selectChatModels({ vendor: VENDOR });
		}
		assert.equal(extension.isActive, true, "the extension activates when its models are requested");
		api = extension.exports as TestApi;
	});

	it("registers the empiriolabs vendor and its commands", async () => {
		const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
		assert.ok(Array.isArray(models));
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes("empiriolabs.manageApiKey"));
		assert.ok(commands.includes("empiriolabs.refreshModels"));
	});

	describe("with an API key", function () {
		let models: vscode.LanguageModelChat[] = [];

		before(async function () {
			if (!apiKey) {
				this.skip();
			}
			if (api) {
				// Extension test mode: the key goes where "Manage API Key" stores it.
				await api.setStoredKey(apiKey);
			} else {
				// Installed build: add a provider group the way the Language Models editor does.
				await vscode.commands.executeCommand("lm.migrateLanguageModelsProviderGroup", { vendor: VENDOR, name: "EmpirioLabs AI", apiKey });
			}
			models = await waitForModels(10);
		});

		it("lists the catalog's chat models with their capabilities", () => {
			assert.ok(models.length >= 10, `expected catalog models, got ${models.length}`);
			assert.ok(models.every((m) => m.vendor === VENDOR));
			assert.ok(models.some((m) => capabilities(m).supportsToolCalling));
			assert.ok(models.some((m) => capabilities(m).supportsImageToText));
			const tools = models.filter((m) => capabilities(m).supportsToolCalling).length;
			const images = models.filter((m) => capabilities(m).supportsImageToText).length;
			console.log(`      ${models.length} models; ${tools} with tool calling, ${images} with image input`);
		});

		it("streams a reply through the editor", async () => {
			const model = models.find((m) => m.id === smokeModel);
			assert.ok(model, `${smokeModel} is listed`);
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Reply with exactly one word: ready")],
				{ modelOptions: { max_tokens: 1500, reasoning_effort: "low" } },
				new vscode.CancellationTokenSource().token,
			);
			let text = "";
			for await (const chunk of response.text) {
				text += chunk;
			}
			console.log(`      reply: ${JSON.stringify(text.trim())}`);
			assert.ok(text.trim().length > 0);
		});

		it("returns a tool call through the editor", async () => {
			const model = models.find((m) => m.id === smokeModel);
			assert.ok(model);
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("What is the weather in Paris? Use the get_weather tool.")],
				{
					tools: [
						{
							name: "get_weather",
							description: "Get the current weather for a city.",
							inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
						},
					],
					toolMode: vscode.LanguageModelChatToolMode.Required,
					modelOptions: { max_tokens: 1500, reasoning_effort: "low" },
				},
				new vscode.CancellationTokenSource().token,
			);
			const calls: vscode.LanguageModelToolCallPart[] = [];
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					calls.push(part);
				}
			}
			console.log(`      tool call: ${calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ")}`);
			assert.equal(calls[0]?.name, "get_weather");
			assert.equal(typeof (calls[0]?.input as { city?: unknown }).city, "string");
		});
	});
});
