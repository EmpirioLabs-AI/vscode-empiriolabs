/**
 * A small stand-in for the `vscode` module so the provider can run in plain Node: unit tests
 * and the live smoke script. It implements only what the provider code touches.
 */

export const version = "1.142.0-test";

export class Disposable {
	constructor(private readonly fn: () => void = () => undefined) {}
	static from(...items: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => items.forEach((i) => i.dispose()));
	}
	dispose(): void {
		this.fn();
	}
}

export class EventEmitter<T> {
	private listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void): Disposable => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
	dispose(): void {
		this.listeners.clear();
	}
}

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: (e: unknown) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]): Disposable;
}

export class CancellationTokenSource {
	private cancelled = false;
	private readonly emitter = new EventEmitter<void>();
	readonly token: CancellationToken;

	constructor() {
		const isCancelled = (): boolean => this.cancelled;
		const emitter = this.emitter;
		this.token = {
			get isCancellationRequested(): boolean {
				return isCancelled();
			},
			onCancellationRequested: (listener: (e: unknown) => unknown): Disposable => emitter.event(() => listener(undefined)),
		};
	}

	cancel(): void {
		if (!this.cancelled) {
			this.cancelled = true;
			this.emitter.fire();
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
	System = 3,
}

export enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2,
}

export enum InputBoxValidationSeverity {
	Info = 1,
	Warning = 2,
	Error = 3,
}

export class LanguageModelTextPart {
	constructor(public value: string) {}
}

export class LanguageModelThinkingPart {
	constructor(
		public value: string | string[],
		public id?: string,
		public metadata?: { readonly [key: string]: unknown },
	) {}
}

export class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: object,
	) {}
}

export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: unknown[],
	) {}
}

export class LanguageModelPromptTsxPart {
	constructor(public value: unknown) {}
}

export class LanguageModelDataPart {
	constructor(
		public data: Uint8Array,
		public mimeType: string,
	) {}
	static image(data: Uint8Array, mime: string): LanguageModelDataPart {
		return new LanguageModelDataPart(data, mime);
	}
	static json(value: unknown, mime = "application/json"): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
	}
	static text(value: string, mime = "text/plain"): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
	}
}

export class LanguageModelChatMessage {
	constructor(
		public role: LanguageModelChatMessageRole,
		public content: unknown[],
		public name?: string,
	) {}
	static User(content: string | unknown[], name?: string): LanguageModelChatMessage {
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, typeof content === "string" ? [new LanguageModelTextPart(content)] : content, name);
	}
	static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage {
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, typeof content === "string" ? [new LanguageModelTextPart(content)] : content, name);
	}
}
