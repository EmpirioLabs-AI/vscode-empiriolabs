/**
 * Entries copied from the live public catalog (GET https://api.empiriolabs.ai/v1/models) on
 * 2026-10-19, trimmed to the fields the extension reads; some descriptions are shortened.
 */
import type { CatalogModel } from "../../catalog";

export const LIVE_CATALOG_SAMPLE: CatalogModel[] = [
	{
		"id": "glm-5-3",
		"display_name": "GLM 5.3",
		"description": "Coding and agentic model with a 1M token context, 128K output, always-on reasoning at low, high, or max effort, native web search, and tool calling.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/glm-5-3:generateContent"
		],
		"context_length": 1000000,
		"context_window": 1000000,
		"max_output_tokens": 131072,
		"input_modalities": [
			"text"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"reasoning",
			"function_calling",
			"web_search"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": true,
			"images": false,
			"audio": false,
			"video": false,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "max_tokens",
				"type": "number",
				"default": 65536,
				"min": 1,
				"max": 131072
			},
			{
				"name": "temperature",
				"type": "number",
				"default": 1,
				"min": 0,
				"max": 1
			},
			{
				"name": "reasoning_effort",
				"type": "enum",
				"default": "max",
				"options": [
					"low",
					"high",
					"max"
				]
			}
		]
	},
	{
		"id": "qwen3-7-flash",
		"display_name": "Qwen3.7 Flash",
		"description": "Fast Qwen3.7 vision-language model for text, image, video, tool use, and agentic tasks, with implicit caching and a 1M token context.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/qwen3-7-flash:generateContent"
		],
		"context_length": 1000000,
		"context_window": 1000000,
		"max_output_tokens": 65536,
		"input_modalities": [
			"text",
			"image",
			"video"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"reasoning",
			"vision",
			"video",
			"web_search",
			"code_interpreter",
			"function_calling",
			"prefix_continuation",
			"cache",
			"agentic_coding"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": true,
			"images": true,
			"audio": false,
			"video": true,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "temperature",
				"type": "number",
				"default": 0.7,
				"min": 0,
				"max": 2
			},
			{
				"name": "max_tokens",
				"type": "number",
				"default": 4096,
				"min": 1,
				"max": 65536
			},
			{
				"name": "reasoning_effort",
				"type": "enum",
				"default": "medium",
				"options": [
					"none",
					"low",
					"medium",
					"high",
					"max"
				]
			}
		]
	},
	{
		"id": "glm-4-7-flash",
		"display_name": "GLM 4.7 Flash",
		"description": "Free lightweight GLM-4.7 text model for coding, reasoning, long-context writing, and general chat.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/glm-4-7-flash:generateContent"
		],
		"context_length": 200000,
		"context_window": 200000,
		"max_output_tokens": 131072,
		"input_modalities": [
			"text"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"reasoning",
			"function_calling",
			"web_search"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": true,
			"images": false,
			"audio": false,
			"video": false,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "temperature",
				"type": "number",
				"default": 1,
				"min": 0,
				"max": 1
			},
			{
				"name": "max_tokens",
				"type": "number",
				"default": 4096,
				"min": 1,
				"max": 131072
			}
		]
	},
	{
		"id": "aplomb-1",
		"display_name": "Aplomb 1",
		"description": "Answers yes/no, choice, score and tool questions about text, JSON, images, video and audio in up to 1M tokens, and can tell when the input lacks the answer.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/decisions",
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/aplomb-1:generateContent"
		],
		"context_length": 1000000,
		"context_window": 1000000,
		"max_output_tokens": null,
		"input_modalities": [
			"text",
			"image",
			"video",
			"audio"
		],
		"output_modalities": [
			"decision"
		],
		"features": [
			"classification",
			"calibrated_probabilities",
			"tool_selection",
			"abstain",
			"long_context",
			"vision",
			"video",
			"audio_in",
			"multimodal"
		],
		"capabilities": {
			"streaming": false,
			"system_prompt": false,
			"web_search": false,
			"images": true,
			"audio": true,
			"video": true,
			"three_d": false,
			"reasoning": false
		},
		"supported_parameters": []
	},
	{
		"id": "perplexity-sonar",
		"display_name": "Perplexity Sonar",
		"description": "Real-time web-connected search with accurate citations and customizable sources for up-to-date AI search integration in production apps.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1/search",
			"POST /v1beta/models/perplexity-sonar:generateContent"
		],
		"context_length": 127000,
		"context_window": 127000,
		"max_output_tokens": null,
		"input_modalities": [
			"text",
			"image",
			"document"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"web_search"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": true,
			"images": true,
			"audio": false,
			"video": false,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "max_tokens",
				"type": "number",
				"default": 1024,
				"min": 1,
				"max": 32768
			}
		]
	},
	{
		"id": "mimo-v2-5",
		"display_name": "MiMo V2.5",
		"description": "Multimodal model with native visual and audio understanding on a 1M context, designed to reason and act across modalities in agentic workflows.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/mimo-v2-5:generateContent"
		],
		"context_length": 1000000,
		"context_window": 1000000,
		"max_output_tokens": 128000,
		"input_modalities": [
			"text",
			"image",
			"video",
			"audio"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"vision",
			"audio_in",
			"function_calling",
			"reasoning",
			"web_search"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": true,
			"images": true,
			"audio": true,
			"video": true,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "temperature",
				"type": "number",
				"default": 0.7,
				"min": 0,
				"max": 2
			},
			{
				"name": "max_tokens",
				"type": "number",
				"default": 4096,
				"min": 1,
				"max": 65536
			}
		],
		"deprecated": true,
		"deprecation_date": "2026-10-20"
	},
	{
		"id": "deepreasoning",
		"display_name": "DeepReasoning",
		"description": "Reasoning model for analysis and code.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/chat/completions",
			"POST /v1/responses",
			"POST /v1/messages",
			"POST /v1beta/models/deepreasoning:generateContent"
		],
		"context_length": null,
		"context_window": null,
		"max_output_tokens": 32000,
		"input_modalities": [
			"text"
		],
		"output_modalities": [
			"text"
		],
		"features": [
			"reasoning",
			"thinking"
		],
		"capabilities": {
			"streaming": true,
			"system_prompt": true,
			"web_search": false,
			"images": false,
			"audio": false,
			"video": false,
			"three_d": false,
			"reasoning": true
		},
		"supported_parameters": [
			{
				"name": "temperature",
				"type": "number",
				"default": 0.7,
				"min": 0,
				"max": 2
			},
			{
				"name": "max_tokens",
				"type": "number",
				"default": 8192,
				"min": 1,
				"max": 65536
			}
		]
	},
	{
		"id": "kling-3-0-turbo",
		"display_name": "Kling 3.0 Turbo",
		"description": "Text-to-video and image-to-video with synchronized native audio, at 720p or 1080p for 3 to 15 seconds, with aspect ratio and prompt control.",
		"status": "available",
		"supported_endpoints": [
			"POST /v1/videos/generations"
		],
		"context_length": null,
		"context_window": null,
		"max_output_tokens": null,
		"input_modalities": [
			"text",
			"image"
		],
		"output_modalities": [
			"video"
		],
		"features": [
			"text_to_video",
			"image_to_video",
			"audio",
			"video_generation"
		],
		"capabilities": {
			"streaming": false,
			"system_prompt": false,
			"web_search": false,
			"images": true,
			"audio": false,
			"video": true,
			"three_d": false,
			"reasoning": false
		},
		"supported_parameters": []
	}
];
