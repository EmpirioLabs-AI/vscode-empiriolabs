import * as vscode from "vscode";
import { ModelCatalog } from "./catalog";
import { API_KEY_PREFIX, API_KEYS_URL, DISPLAY_NAME, SECRET_STORAGE_KEY, VENDOR_ID } from "./constants";
import { type ApiKeyStore, EmpirioChatProvider } from "./provider";

/** How often the catalog is read again so new models appear without a reload. */
const CATALOG_REFRESH_MS = 30 * 60 * 1000;

/** Stores the key set through the "Manage API Key" command in the editor's SecretStorage. */
class SecretKeyStore implements ApiKeyStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	get(): Promise<string | undefined> {
		return Promise.resolve(this.secrets.get(SECRET_STORAGE_KEY));
	}

	async set(key: string): Promise<void> {
		await this.secrets.store(SECRET_STORAGE_KEY, key);
	}

	async clear(): Promise<void> {
		await this.secrets.delete(SECRET_STORAGE_KEY);
	}

	async prompt(): Promise<string | undefined> {
		const key = await askForKey(false);
		if (key) {
			await this.set(key);
		}
		return key;
	}
}

async function askForKey(replacing: boolean): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: `${DISPLAY_NAME} API Key`,
		prompt: `${replacing ? "Paste a new" : "Paste your"} ${DISPLAY_NAME} API key. Create one at ${API_KEYS_URL}`,
		placeHolder: `${API_KEY_PREFIX}...`,
		password: true,
		ignoreFocusOut: true,
		validateInput: (input) => {
			const trimmed = input.trim();
			if (!trimmed) {
				return "Enter an API key.";
			}
			if (!trimmed.startsWith(API_KEY_PREFIX)) {
				return { message: `${DISPLAY_NAME} API keys start with ${API_KEY_PREFIX}`, severity: vscode.InputBoxValidationSeverity.Warning };
			}
			return undefined;
		},
	});
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

type ManageAction = "set" | "clear" | "create";

async function manageApiKey(keys: SecretKeyStore): Promise<void> {
	const hasKey = !!(await keys.get());
	const items: (vscode.QuickPickItem & { action: ManageAction })[] = [
		{ label: "$(key) Set API key", description: hasKey ? "Replace the saved key" : "No key saved yet", action: "set" },
	];
	if (hasKey) {
		items.push({ label: "$(trash) Remove API key", description: "Delete the key saved by this command", action: "clear" });
	}
	items.push({ label: "$(link-external) Create an API key", description: "Opens the EmpirioLabs AI dashboard", action: "create" });

	const pick = await vscode.window.showQuickPick(items, {
		title: `${DISPLAY_NAME}: Manage API Key`,
		placeHolder: "Choose an action",
	});
	switch (pick?.action) {
		case "set": {
			const key = await askForKey(hasKey);
			if (key) {
				await keys.set(key);
				void vscode.window.showInformationMessage(`${DISPLAY_NAME} API key saved. Choose an ${DISPLAY_NAME} model in the chat model picker.`);
			}
			break;
		}
		case "clear":
			await keys.clear();
			void vscode.window.showInformationMessage(
				`${DISPLAY_NAME} API key removed. Keys added in the Language Models editor are removed there.`,
			);
			break;
		case "create":
			await vscode.env.openExternal(vscode.Uri.parse(API_KEYS_URL));
			break;
		default:
			break;
	}
}

export function activate(context: vscode.ExtensionContext): { setStoredKey(key: string): Thenable<void> } | undefined {
	const version = (context.extension.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";
	const userAgent = `empiriolabs-vscode-chat/${version} VSCode/${vscode.version}`;
	const output = vscode.window.createOutputChannel(DISPLAY_NAME, { log: true });
	const log = (message: string): void => output.info(message);

	const keys = new SecretKeyStore(context.secrets);
	const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);
	const catalog = new ModelCatalog(fetchImpl, userAgent);
	const provider = new EmpirioChatProvider(keys, catalog, fetchImpl, userAgent, log);

	context.subscriptions.push(
		output,
		provider,
		vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider),
		context.secrets.onDidChange((event) => {
			if (event.key === SECRET_STORAGE_KEY) {
				provider.notifyChanged();
			}
		}),
		vscode.commands.registerCommand("empiriolabs.manageApiKey", () => manageApiKey(keys)),
		vscode.commands.registerCommand("empiriolabs.refreshModels", async () => {
			try {
				await provider.refreshCatalog(true);
				void vscode.window.showInformationMessage(`${DISPLAY_NAME} models refreshed.`);
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),
	);

	const timer = setInterval(() => {
		provider.refreshCatalog(false).catch((error: unknown) => log(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`));
	}, CATALOG_REFRESH_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	log(`activated ${userAgent}`);

	// Integration tests use this to exercise the stored-key path; it is not exposed otherwise.
	if (context.extensionMode === vscode.ExtensionMode.Test) {
		return { setStoredKey: (key: string) => context.secrets.store(SECRET_STORAGE_KEY, key) };
	}
	return undefined;
}

export function deactivate(): void {
	// Disposables registered in activate() are released by the editor.
}
