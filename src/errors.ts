import { API_KEYS_URL, BILLING_URL } from "./constants";

/** An API failure with a message written for the person using the editor. */
export class EmpirioApiError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		readonly code?: string,
		readonly requestId?: string,
	) {
		super(message);
		this.name = "EmpirioApiError";
	}
}

/** Thrown when no API key is configured for a request. */
export class MissingApiKeyError extends Error {
	constructor() {
		super(
			"Add your EmpirioLabs AI API key to use this model: open the Language Models editor and add EmpirioLabs AI, or run \"EmpirioLabs AI: Manage API Key\". " +
				`Create a key at ${API_KEYS_URL}`,
		);
		this.name = "MissingApiKeyError";
	}
}

const INVALID_KEY_MESSAGE =
	"EmpirioLabs AI did not accept the API key. Update it in the Language Models editor or with \"EmpirioLabs AI: Manage API Key\". " +
	`Create a key at ${API_KEYS_URL}`;

const NO_CREDITS_MESSAGE = `Your EmpirioLabs AI balance is too low for this request. Add credits at ${BILLING_URL}, then try again.`;

const RATE_LIMIT_MESSAGE = "EmpirioLabs AI is receiving too many requests from this key. Wait a moment, then try again.";

function withRequestId(message: string, requestId: string | undefined): string {
	return requestId ? `${message} (request ${requestId})` : message;
}

function cleanApiMessage(message: unknown): string | undefined {
	if (typeof message !== "string") {
		return undefined;
	}
	const trimmed = message.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

/** The message shown for an HTTP status and the API's error code and message. */
export function friendlyErrorMessage(status: number | undefined, code: string | undefined, apiMessage: string | undefined, requestId?: string): string {
	const normalizedCode = (code ?? "").toLowerCase();
	if (status === 401 || normalizedCode === "invalid_api_key" || normalizedCode === "missing_api_key") {
		return INVALID_KEY_MESSAGE;
	}
	if (status === 402 || normalizedCode === "insufficient_credits" || normalizedCode === "insufficient_balance") {
		return NO_CREDITS_MESSAGE;
	}
	if (status === 429 || normalizedCode === "rate_limit_exceeded" || normalizedCode === "rate_limited") {
		return apiMessage ? `${RATE_LIMIT_MESSAGE} ${apiMessage}` : RATE_LIMIT_MESSAGE;
	}
	if (status === 404 && (normalizedCode.includes("model") || !apiMessage)) {
		return "This model is not available on EmpirioLabs AI. Choose another model in the model picker.";
	}
	if (status !== undefined && status >= 500) {
		return withRequestId(`EmpirioLabs AI could not complete the request (HTTP ${status}). Try again in a moment.`, requestId);
	}
	if (apiMessage) {
		return withRequestId(`EmpirioLabs AI: ${apiMessage}`, requestId);
	}
	return withRequestId(status ? `EmpirioLabs AI request failed (HTTP ${status}).` : "EmpirioLabs AI request failed.", requestId);
}

/** Build an error from an `{ "error": { code, message, request_id } }` body, or from a bare string. */
export function errorFromPayload(payload: unknown, status: number | undefined, fallbackRequestId?: string): EmpirioApiError {
	let code: string | undefined;
	let message: string | undefined;
	let requestId: string | undefined = fallbackRequestId;
	const source = payload && typeof payload === "object" && "error" in payload ? (payload as { error: unknown }).error : payload;
	if (typeof source === "string") {
		message = cleanApiMessage(source);
	} else if (source && typeof source === "object") {
		const obj = source as Record<string, unknown>;
		code = typeof obj.code === "string" ? obj.code : typeof obj.type === "string" ? obj.type : undefined;
		message = cleanApiMessage(obj.message);
		requestId = typeof obj.request_id === "string" ? obj.request_id : requestId;
		if (status === undefined && typeof obj.status === "number") {
			status = obj.status;
		}
	}
	return new EmpirioApiError(friendlyErrorMessage(status, code, message, requestId), status, code, requestId);
}

/** Read a non-2xx response into an {@link EmpirioApiError}. */
export async function readErrorResponse(response: Response): Promise<EmpirioApiError> {
	const headerRequestId = response.headers.get("x-request-id") ?? undefined;
	let text = "";
	try {
		text = await response.text();
	} catch {
		// The body is optional; the status alone still produces a useful message.
	}
	let payload: unknown = undefined;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = undefined;
		}
	}
	return errorFromPayload(payload, response.status, headerRequestId);
}
