# EmpirioLabs AI for Copilot Chat

Use [EmpirioLabs AI](https://empiriolabs.ai) models in GitHub Copilot Chat in Visual Studio Code. The extension adds EmpirioLabs AI as a model provider, so its chat models appear in the chat model picker next to the built-in ones.

EmpirioLabs AI is a specialized AI inference and integration provider. It self-hosts open models on GPU infrastructure it manages, runs optimized endpoints for proprietary models, helps teams ship their own models, and offers GPU Cloud instances and hosted AI agents.

## Features

- **Live model list.** Every chat model in the EmpirioLabs AI catalog, read from `https://api.empiriolabs.ai/v1/models`. New models appear without an extension update.
- **Streaming.** Replies stream as they are generated. Reasoning models show their thinking separately from the answer.
- **Agent mode.** Models that support tool calling work in agent mode.
- **Images.** Vision models accept images you attach in chat.
- **Thinking effort.** Models with adjustable reasoning offer a Thinking Effort setting in the model picker.

## Requirements

- Visual Studio Code 1.109 or later.
- An EmpirioLabs AI API key. Keys start with `sk-empiriolabs-`. Create one at https://platform.empiriolabs.ai/dashboard/api-keys.
- Credits on your EmpirioLabs AI account. Add them at https://platform.empiriolabs.ai/dashboard/billing. Prices are listed at https://empiriolabs.ai/pricing.

Models from provider extensions work with any GitHub Copilot plan, and without one. On Copilot Business and Copilot Enterprise, an administrator must enable the **Bring Your Own Language Model Key in VS Code** policy.

## Install

Search for **EmpirioLabs AI** in the Extensions view, or open the Language Models editor (below) and select **Install Model Providers**.

## Add your API key

**In the Language Models editor.**

1. In the Chat view, open the model picker and select **Manage Language Models** (the gear icon), or run **Chat: Manage Language Models** from the Command Palette.
2. Select **Add Models**, then **EmpirioLabs AI**.
3. Enter a name, for example `EmpirioLabs AI`, and paste your API key.

**With a command.** Run **EmpirioLabs AI: Manage API Key** from the Command Palette and choose **Set API key**. Run it again to replace or remove the key.

Both store the key in VS Code's secret storage. A key added both ways is listed once.

## Choose a model

1. Open the Chat view.
2. Open the model picker and choose an EmpirioLabs AI model. In agent mode, the picker lists the models that support tool calling.
3. For a model with adjustable reasoning, set **Thinking Effort** in the model picker.

To show or hide models, use the eye icon in the Language Models editor. **EmpirioLabs AI: Refresh Models** reloads the list.

**Prompt size.** VS Code sends at most 262,144 tokens (256K) of prompt to an EmpirioLabs AI model, even when the model's context window is larger. To use more of the window, raise the `empiriolabs.maxInputTokens` setting in your user settings. The change applies without a reload. A larger setting lets long agent sessions send more tokens, so they cost more.

## Commands

| Command | Description |
| --- | --- |
| `EmpirioLabs AI: Manage API Key` | Set, replace or remove the key saved by this command, or open the page where keys are created. |
| `EmpirioLabs AI: Refresh Models` | Reload the model list. |

## Troubleshooting

- **"EmpirioLabs AI did not accept the API key"**: update the key in the Language Models editor or with **EmpirioLabs AI: Manage API Key**.
- **"Your EmpirioLabs AI balance is too low for this request"**: add credits at https://platform.empiriolabs.ai/dashboard/billing.
- **No EmpirioLabs AI models in the picker**: add a key as described above, then run **EmpirioLabs AI: Refresh Models**.

The **EmpirioLabs AI** output channel lists each request's model, duration and outcome.

## Data handling

The extension sends your chat messages, the context Copilot Chat attaches to them and the available tool definitions to the EmpirioLabs AI API at `https://api.empiriolabs.ai`, authenticated with your key. It has no telemetry. EmpirioLabs AI does not keep the content of requests or responses once a response is delivered and never uses it to train models. For third-party models, the provider that serves a request also receives it under its own terms. See the [Privacy Policy](https://empiriolabs.ai/privacy-policy).

## Links

- EmpirioLabs AI: https://empiriolabs.ai
- Documentation: https://docs.empiriolabs.ai
- API keys: https://platform.empiriolabs.ai/dashboard/api-keys
- Issues: https://github.com/EmpirioLabs-AI/vscode-empiriolabs/issues
- Support: support@empiriolabs.ai

## Development

```bash
npm ci
npm test                    # compile and run the unit tests (offline)
npm run smoke:live          # live check: model list, one streamed chat, one tool call; needs EMPIRIOLABS_API_KEY
npm run test:integration    # runs inside VS Code; set EMPIRIOLABS_API_KEY to include live requests
npx @vscode/vsce package
```

Press F5 in VS Code to start an Extension Development Host with the extension loaded.

## License

[MIT](LICENSE). Parts are adapted from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat) (MIT, Copyright (c) 2025 Hugging Face).
