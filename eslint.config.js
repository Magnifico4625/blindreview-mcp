// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "benchmark-results/**", "data/**", "coverage/**", "benchmark/repo-cases/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly", AbortController: "readonly", fetch: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["benchmark/**/*.ts", "src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
