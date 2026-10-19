/**
 * Loaded with `node --require` (mocha `--require`) before any test: makes `require("vscode")`
 * resolve to the local stand-in so provider code runs outside the editor.
 */
import Module = require("node:module");

const mockPath = require.resolve("./vscodeMock");
type Resolve = (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolve };
const originalResolve = moduleWithResolver._resolveFilename;

moduleWithResolver._resolveFilename = function (request, parent, isMain, options) {
	if (request === "vscode") {
		return mockPath;
	}
	return originalResolve.call(this, request, parent, isMain, options);
};
