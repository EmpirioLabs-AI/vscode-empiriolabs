# Changelog

## 0.1.2

- **Maintenance.** No functional changes.

## 0.1.1

- **Open VSX.** The extension is also published on Open VSX. No functional changes.

## 0.1.0

First release.

- **Models.** Every chat model in the EmpirioLabs AI catalog appears in the GitHub Copilot Chat model picker, read from the live catalog so new models appear without an update.
- **Responses.** Replies stream as they are generated, and reasoning models show their thinking separately from the answer.
- **Agent mode.** Models that support tool calling work in agent mode.
- **Images.** Vision models accept images attached in chat.
- **Thinking effort.** Models with adjustable reasoning offer a Thinking Effort setting in the model picker.
- **Prompt size.** The `empiriolabs.maxInputTokens` setting sets the largest prompt sent to a model, 262,144 tokens by default. Raise it to use more of a model's context window.
- **API key.** Add your key in the Language Models editor or with the `EmpirioLabs AI: Manage API Key` command.
