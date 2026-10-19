/**
 * Runs the integration tests inside a real VS Code with this folder as the extension under
 * development and a throwaway profile.
 *
 *   npm run test:integration
 *
 * Optional: EMPIRIOLABS_API_KEY to also list models and send live requests through the editor,
 * VSCODE_EXECUTABLE_PATH to use an installed VS Code instead of downloading one.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, "../../../");
	const extensionTestsPath = path.resolve(__dirname, "./index");
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "empiriolabs-vscode-test-"));
	const userDataDir = path.join(profileDir, "user-data");
	const extensionsDir = path.join(profileDir, "extensions");
	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
			version: process.env.VSCODE_EXECUTABLE_PATH ? undefined : process.env.VSCODE_TEST_VERSION || "stable",
			launchArgs: [
				"--disable-extensions",
				"--user-data-dir",
				userDataDir,
				"--extensions-dir",
				extensionsDir,
				"--skip-welcome",
				"--skip-release-notes",
				"--disable-workspace-trust",
			],
			extensionTestsEnv: {
				EMPIRIOLABS_API_KEY: process.env.EMPIRIOLABS_API_KEY ?? "",
				EMPIRIOLABS_SMOKE_MODEL: process.env.EMPIRIOLABS_SMOKE_MODEL ?? "",
			},
		});
	} finally {
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
