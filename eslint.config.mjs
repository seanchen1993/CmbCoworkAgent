import { defineConfig } from "eslint/config"
import eslint from "@eslint/js"
import tseslint from "@electron-toolkit/eslint-config-ts"
import eslintConfigPrettier from "@electron-toolkit/eslint-config-prettier"
import eslintPluginReact from "eslint-plugin-react"
import eslintPluginReactHooks from "eslint-plugin-react-hooks"
import eslintPluginReactRefresh from "eslint-plugin-react-refresh"

export default defineConfig(
  // `.claude/worktrees` holds throwaway git worktree copies of the repo (full
  // duplicate trees); linting them just floods output with duplicate findings.
  // The playwright-codegen vendor copies are upstream Playwright sources kept
  // verbatim (with @ts-nocheck etc.); only our own adapter files are linted.
  {
    ignores: [
      "**/node_modules",
      "**/.vite",
      "**/dist",
      "**/out",
      // Runtime conversations, generated workflow scripts, caches and traces.
      // They are user data rather than repository source; scanning them makes
      // lint time and output grow with application usage.
      "**/.cmbdevclaw/**",
      "**/.claude/worktrees/**",
      "src/main/browser/record/common/playwright-codegen/codegen/**",
      "src/main/browser/record/common/playwright-codegen/generated/**",
      "src/main/browser/record/common/playwright-codegen/{cssParser,cssTokenizer,locatorGenerators,selectorParser,stringUtils,deviceDescriptors}.ts"
    ]
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat["jsx-runtime"],
  {
    settings: {
      react: {
        version: "detect"
      }
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": eslintPluginReactHooks,
      "react-refresh": eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  },
  {
    // tseslint.configs.recommended above has no `files` filter, so its rules also
    // hit plain .js/.mjs/.cjs — but those can't carry TS return-type annotations,
    // so explicit-function-return-type is UNSATISFIABLE there (e.g. the .mjs test
    // specs). Turn it off for JS, exactly as it's already off for TS above.
    files: ["**/*.{js,mjs,cjs}"],
    rules: { "@typescript-eslint/explicit-function-return-type": "off" }
  },
  {
    // Dynamic-workflow scripts are executable assets run inside the workflow
    // sandbox (engine.ts/sandbox.ts), which injects these globals at runtime.
    files: ["**/*.workflow.js"],
    languageOptions: {
      globals: {
        agent: "readonly",
        parallel: "readonly",
        pipeline: "readonly",
        workflow: "readonly",
        phase: "readonly",
        log: "readonly",
        glob: "readonly",
        readFile: "readonly",
        writeFile: "readonly",
        exists: "readonly",
        args: "readonly",
        budget: "readonly"
      }
    },
    rules: {
      // `catch (_error)` is the scripts' deliberate ignore convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { caughtErrorsIgnorePattern: "^_", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },
  eslintConfigPrettier
)
