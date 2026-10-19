import * as path from "node:path";
import Mocha = require("mocha");

/** Entry point VS Code calls with `--extensionTestsPath`. */
export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "bdd", timeout: 180_000, color: true });
	mocha.addFile(path.resolve(__dirname, "extension.test.js"));
	return new Promise((resolve, reject) => {
		mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve()));
	});
}
