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
  { ignores: ["**/node_modules", "**/.vite", "**/dist", "**/out", "**/.claude/worktrees/**"] },
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
  eslintConfigPrettier
)
