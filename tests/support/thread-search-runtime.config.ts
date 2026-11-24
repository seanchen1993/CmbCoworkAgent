import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          "decode-named-character-reference", "micromark-util-decode-numeric-character-reference",
          "micromark", "micromark-extension-gfm",
          "remark-gfm", "remark-parse", "remark-rehype", "unified"
        ]
      },
      emptyOutDir: false,
      outDir: process.env.CMB_THREAD_SEARCH_PROBE_BUNDLE,
      lib: {
        entry: { index: "tests/support/thread-search-runtime.ts" },
        formats: ["cjs"]
      }
    }
  }
})
