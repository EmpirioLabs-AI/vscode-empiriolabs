import * as vscode from "vscode";
import { promptTsxToText } from "./convert";

/** Rough cost of one image; the editor only needs a budget, not an exact count. */
const IMAGE_TOKENS = 768;

/**
 * Estimate tokens for a string. Latin text and code average about 3.5 characters per token;
 * other scripts are closer to one character per token, so they are counted separately.
 * The estimate leans high so a prompt is trimmed before it overflows the context window.
 */
export function estimateTextTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let ascii = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 128) {
			ascii++;
		} else {
			other++;
		}
	}
	return Math.ceil(ascii / 3.5 + other);
}

function estimatePart(part: unknown): number {
	if (part instanceof vscode.LanguageModelTextPart) {
		return estimateTextTokens(part.value);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		let args = "";
		try {
			args = JSON.stringify(part.input ?? {}) ?? "";
		} catch {
			args = "";
		}
		return estimateTextTokens(part.name) + estimateTextTokens(args) + 8;
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return (part.content ?? []).reduce<number>((sum, item) => sum + estimatePart(item), 8);
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		if (part.mimeType.toLowerCase().startsWith("image/")) {
			return IMAGE_TOKENS;
		}
		if (part.mimeType.startsWith("text/") || part.mimeType.includes("json")) {
			return estimateTextTokens(new TextDecoder().decode(part.data));
		}
		return 0;
	}
	if (part && typeof part === "object" && "value" in part) {
		const value = (part as { value: unknown }).value;
		if (typeof value === "string") {
			return estimateTextTokens(value);
		}
		if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
			return estimateTextTokens(value.join(""));
		}
		return estimateTextTokens(promptTsxToText(value));
	}
	return 0;
}

/** Estimate tokens for a string or a whole chat message. */
export function estimateTokens(input: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof input === "string") {
		return estimateTextTokens(input);
	}
	const parts = input.content ?? [];
	return parts.reduce<number>((sum, part) => sum + estimatePart(part), 4);
}
