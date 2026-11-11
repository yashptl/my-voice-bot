import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Import direction, per folder. `regex` matches a relative import that leaves the folder
 * for somewhere it may not go. Folders are flat, so `../` always means "another folder".
 * Test files are exempt: they may import fakes from anywhere.
 */
function layer(folder, regex, message) {
  return {
    files: [`${folder}/**/*.{ts,tsx,js}`],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex, message: `Import direction: ${message}` }] },
      ],
    },
  };
}

export default defineConfig([
  globalIgnores(["dist/", "**/.wrangler/", "node_modules/", "probes/results/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The capture worklet runs in AudioWorkletGlobalScope, not the window.
    files: ["src/client/**/*.js"],
    languageOptions: { globals: globals.audioWorklet },
  },
  layer("src/protocol", String.raw`^\.\./`, "src/protocol imports nothing from src/ (zod only)."),
  layer("src/ports", String.raw`^\.\./(?!protocol(/|$))`, "src/ports may import only src/protocol."),
  layer(
    "src/core",
    String.raw`^\.\./(?!(protocol|ports)(/|$)|knowledge/types(\.js)?$)`,
    "src/core may import only src/protocol, src/ports and src/knowledge/types.",
  ),
  layer(
    "src/adapters",
    String.raw`^\.\./(?!(protocol|ports)(/|$))`,
    "src/adapters may import only src/protocol and src/ports.",
  ),
  layer("src/knowledge", String.raw`^\.\./(?!protocol(/|$))`, "src/knowledge may import only src/protocol."),
  layer(
    "src/client",
    String.raw`^\.\./(?!protocol(/|$))`,
    "src/client may import only src/protocol and src/client.",
  ),
  layer(
    "playground",
    String.raw`^\.\./(?!src/(protocol|client)(/|$))`,
    "playground may import only src/protocol and src/client.",
  ),
  layer(
    "src/worker",
    String.raw`^(\.\./)+(src/)?client(/|$)`,
    "src/worker may import anything except src/client.",
  ),
]);
