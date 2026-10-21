import eslint from "@eslint/js"
import gitignore from "eslint-config-flat-gitignore"
import prettier from "eslint-plugin-prettier/recommended"
import unusedImports from "eslint-plugin-unused-imports"
import { defineConfig } from "eslint/config"
import globals from "globals"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  // `.claude/**` holds agent tooling copied from agent-gateway (skills, hooks).
  // It is not application source and is not part of this project's tsconfig, so
  // the typed parser cannot resolve it — linting it only produces noise.
  // `src/contracts-pkg/**` is the agent-gateway contract package, vendored
  // byte-for-byte by `bun scripts/sync-contracts.ts --into ../copilot-api` and
  // pinned by tests/contracts-pkg-manifest.test.ts — reformatting it would break
  // the manifest digests, so it is never linted/fixed here.
  {
    ignores: ["plugin/**", "desktop/**", ".claude/**", "src/contracts-pkg/**"],
  },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  gitignore(),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: configDir,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "prettier/prettier": [
        "error",
        {
          experimentalOperatorPosition: "start",
          experimentalTernaries: true,
          plugins: ["prettier-plugin-packagejson"],
          semi: false,
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
)
