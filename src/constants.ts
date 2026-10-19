/** Vendor id registered with `vscode.lm.registerLanguageModelChatProvider`; must match package.json. */
export const VENDOR_ID = "empiriolabs";

/** Name shown wherever the provider is named in the editor UI. */
export const DISPLAY_NAME = "EmpirioLabs AI";

/** OpenAI-compatible base URL of the EmpirioLabs AI API. */
export const API_BASE_URL = "https://api.empiriolabs.ai/v1";

/** Where customers create API keys. */
export const API_KEYS_URL = "https://platform.empiriolabs.ai/dashboard/api-keys";

/** Where customers add credits. */
export const BILLING_URL = "https://platform.empiriolabs.ai/dashboard/billing";

/** Public documentation. */
export const DOCS_URL = "https://docs.empiriolabs.ai";

/** Every EmpirioLabs AI API key starts with this prefix. */
export const API_KEY_PREFIX = "sk-empiriolabs-";

/** SecretStorage slot for the key set through the "Manage API Key" command. */
export const SECRET_STORAGE_KEY = "empiriolabs.apiKey";

/** How long a fetched model list is reused before the catalog is read again. */
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Fallbacks for a catalog entry that does not state its limits. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Output budget requested when the caller does not set one. The catalog's own default for the
 * model wins when it is larger, and the model's maximum always caps the result.
 */
export const DEFAULT_REQUEST_MAX_TOKENS = 16_384;

/** Setting that caps the prompt VS Code builds for a model. */
export const MAX_INPUT_TOKENS_SETTING = "empiriolabs.maxInputTokens";

/** Default and lowest value of the prompt cap; must match package.json. */
export const DEFAULT_MAX_INPUT_TOKENS = 262_144;
export const MIN_MAX_INPUT_TOKENS = 8_192;

/** Copilot Chat reads token usage from a data part with this MIME type. */
export const USAGE_DATA_PART_MIME = "usage";
