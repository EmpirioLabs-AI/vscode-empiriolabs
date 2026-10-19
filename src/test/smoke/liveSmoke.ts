/**
 * Live smoke test. Runs the provider code outside the editor (with the local `vscode` stand-in)
 * against the real EmpirioLabs AI API: lists the models, streams one short chat, and runs one
 * tool call round trip. Costs a fraction of a cent.
 *
 *   EMPIRIOLABS_API_KEY=sk-empiriolabs-... npm run smoke:live
 *
 * Optional: EMPIRIOLABS_SMOKE_MODEL (default qwen3-7-flash), EMPIRIOLABS_SMOKE_VISION=1 to also
 * send one small image to a vision model.
 */
import { deflateSync } from "node:zlib";
import * as vscode from "vscode";
import { type EmpirioModelInfo, ModelCatalog } from "../../catalog";
import { API_BASE_URL } from "../../constants";
import { EmpirioChatProvider } from "../../provider";
import { CancellationTokenSource, LanguageModelThinkingPart } from "../vscodeMock";

const { User, Assistant } = vscode.LanguageModelChatMessageRole;

function message(role: vscode.LanguageModelChatMessageRole, ...content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role, content, name: undefined };
}

interface Run {
	text: string;
	thinkingChunks: number;
	toolCalls: vscode.LanguageModelToolCallPart[];
	usage?: { prompt_tokens: number; completion_tokens: number };
	firstTokenMs?: number;
	totalMs: number;
}

async function send(
	provider: EmpirioChatProvider,
	model: EmpirioModelInfo,
	messages: vscode.LanguageModelChatRequestMessage[],
	options: Record<string, unknown>,
): Promise<Run> {
	const started = Date.now();
	const run: Run = { text: "", thinkingChunks: 0, toolCalls: [], totalMs: 0 };
	await provider.provideLanguageModelChatResponse(
		model,
		messages,
		{ toolMode: vscode.LanguageModelChatToolMode.Auto, ...options } as vscode.ProvideLanguageModelChatResponseOptions,
		{
			report(part) {
				if (run.firstTokenMs === undefined) {
					run.firstTokenMs = Date.now() - started;
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					run.text += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					run.toolCalls.push(part);
				} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
					run.usage = JSON.parse(new TextDecoder().decode(part.data));
				} else if ((part as unknown) instanceof LanguageModelThinkingPart) {
					run.thinkingChunks++;
				}
			},
		},
		new CancellationTokenSource().token as unknown as vscode.CancellationToken,
	);
	run.totalMs = Date.now() - started;
	return run;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A solid-color PNG, built by hand so the smoke test needs no image files. */
function solidPng(size: number, rgb: [number, number, number]): Uint8Array {
	const chunk = (type: string, data: Buffer): Buffer => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed));
		return Buffer.concat([length, typed, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolor
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
	const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

function describe(run: Run): string {
	const usage = run.usage ? `${run.usage.prompt_tokens} in / ${run.usage.completion_tokens} out` : "no usage reported";
	return `${run.totalMs} ms (first part ${run.firstTokenMs ?? "-"} ms), ${usage}, thinking chunks ${run.thinkingChunks}`;
}

async function reportSpend(apiKey: string, since: Date): Promise<void> {
	// Settlement is asynchronous; give the last request a moment to land.
	await new Promise((resolve) => setTimeout(resolve, 4000));
	const url = `${API_BASE_URL}/account/usage?limit=50&from=${encodeURIComponent(since.toISOString())}`;
	const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
	if (!response.ok) {
		console.log(`Spend: could not read account usage (HTTP ${response.status}).`);
		return;
	}
	const body = (await response.json()) as {
		summary?: { requests?: number; total_cost?: number };
		data?: { model?: string; status?: string; cost?: { amount?: number; included?: boolean }; tokens?: { input?: number; output?: number } }[];
	};
	for (const event of body.data ?? []) {
		console.log(
			`  usage event: ${event.model} ${event.status} cost $${(event.cost?.amount ?? 0).toFixed(6)}${event.cost?.included ? " (plan)" : ""} ` +
				`tokens ${event.tokens?.input ?? 0}/${event.tokens?.output ?? 0}`,
		);
	}
	console.log(`Spend since start: ${body.summary?.requests ?? 0} requests, $${(body.summary?.total_cost ?? 0).toFixed(6)}`);
}

async function main(): Promise<void> {
	const apiKey = process.env.EMPIRIOLABS_API_KEY?.trim();
	if (!apiKey) {
		console.error("Set EMPIRIOLABS_API_KEY to run the live smoke test.");
		process.exit(2);
	}
	const modelId = process.env.EMPIRIOLABS_SMOKE_MODEL?.trim() || "qwen3-7-flash";
	const since = new Date(Date.now() - 1000);
	const userAgent = "empiriolabs-vscode-chat/smoke";
	const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);
	const provider = new EmpirioChatProvider(
		{ get: async () => undefined, prompt: async () => undefined },
		new ModelCatalog(fetchImpl, userAgent),
		fetchImpl,
		userAgent,
		(line) => console.log(`  [provider] ${line}`),
	);
	const token = new CancellationTokenSource().token as unknown as vscode.CancellationToken;
	let failures = 0;
	const check = (ok: boolean, label: string): void => {
		console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
		if (!ok) {
			failures++;
		}
	};

	// 1. Model list from the public catalog.
	const models = await provider.provideLanguageModelChatInformation({ silent: true, configuration: { apiKey } }, token);
	const tools = models.filter((m) => m.capabilities.toolCalling).length;
	const vision = models.filter((m) => m.capabilities.imageInput).length;
	const effort = models.filter((m) => m.configurationSchema).length;
	console.log(`Models: ${models.length} chat models (${tools} with tool calling, ${vision} with image input, ${effort} with a thinking effort picker)`);
	console.log(`  sample: ${models.slice(0, 6).map((m) => `${m.id} (${m.name})`).join(", ")}`);
	check(models.length > 0, "model list is not empty");
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		throw new Error(`Model ${modelId} is not in the chat model list.`);
	}
	console.log(`Using ${model.id}: input ${model.maxInputTokens}, output ${model.maxOutputTokens}, tools ${model.capabilities.toolCalling}, images ${model.capabilities.imageInput}`);

	// 2. One short streamed chat.
	const chat = await send(provider, model, [message(User, new vscode.LanguageModelTextPart("In one short sentence, what is a tide?"))], {
		modelOptions: { max_tokens: 400 },
		modelConfiguration: { reasoningEffort: "low" },
	});
	console.log(`Chat: "${chat.text.trim()}"`);
	console.log(`  ${describe(chat)}`);
	check(chat.text.trim().length > 0, "streamed chat returned text");

	// 3. One tool call, then the tool result back to the model.
	const weatherTool: vscode.LanguageModelChatTool = {
		name: "get_weather",
		description: "Get the current weather for a city.",
		inputSchema: {
			type: "object",
			properties: {
				city: { type: "string", description: "City name" },
				unit: { type: "string", enum: ["celsius", "fahrenheit"] },
			},
			required: ["city"],
		},
	};
	const ask = message(User, new vscode.LanguageModelTextPart("What is the weather in Paris right now? Use the get_weather tool."));
	const first = await send(provider, model, [ask], { tools: [weatherTool], modelOptions: { max_tokens: 400 }, modelConfiguration: { reasoningEffort: "low" } });
	const toolCall = first.toolCalls[0];
	console.log(`Tool call: ${toolCall ? `${toolCall.name}(${JSON.stringify(toolCall.input)}) id=${toolCall.callId}` : "none"}`);
	console.log(`  ${describe(first)}`);
	check(!!toolCall && toolCall.name === "get_weather" && typeof (toolCall.input as { city?: unknown }).city === "string", "model called get_weather with a city");
	if (toolCall) {
		const followUp = await send(
			provider,
			model,
			[
				ask,
				message(Assistant, toolCall),
				message(User, new vscode.LanguageModelToolResultPart(toolCall.callId, [new vscode.LanguageModelTextPart('{"temperature_c":18,"condition":"sunny"}')])),
			],
			{ tools: [weatherTool], modelOptions: { max_tokens: 400 }, modelConfiguration: { reasoningEffort: "low" } },
		);
		console.log(`Answer after tool result: "${followUp.text.trim()}"`);
		console.log(`  ${describe(followUp)}`);
		check(/18/.test(followUp.text), "answer uses the tool result");
	}

	// 4. Optional: one small image to a vision model.
	if (process.env.EMPIRIOLABS_SMOKE_VISION === "1" && model.capabilities.imageInput) {
		const image = new vscode.LanguageModelDataPart(solidPng(32, [220, 20, 20]), "image/png");
		const seen = await send(provider, model, [message(User, new vscode.LanguageModelTextPart("What color is this image? Answer with one word."), image)], {
			modelOptions: { max_tokens: 300 },
			modelConfiguration: { reasoningEffort: "low" },
		});
		console.log(`Vision: "${seen.text.trim()}"`);
		console.log(`  ${describe(seen)}`);
		check(/red/i.test(seen.text), "vision model named the color");
	}

	await reportSpend(apiKey, since);
	console.log(failures === 0 ? "Smoke test passed." : `Smoke test failed: ${failures} check(s).`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error(`Smoke test error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
