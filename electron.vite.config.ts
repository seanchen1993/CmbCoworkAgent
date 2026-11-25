import { resolve } from "path"
import { createRequire } from "node:module"
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { mirrorRequiredDirectorySync } from "./src/main/build/directory-mirror"
import { collectMarkdownHighlightGrammars } from "./src/renderer/src/lib/markdown-highlight"
import { virtuosoResizeAnchor } from "./scripts/vite-virtuoso-resize-anchor"
// import {app} from "electron"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))
const requireDependency = createRequire(import.meta.url)

// Plugin to copy resources to output
function copyResources(): { name: string; closeBundle: () => void } {
  return {
    name: "copy-resources",
    closeBundle(): void {
      const srcIcon = resolve("resources/icon.png")
      const destDir = resolve("out/resources")
      const destIcon = resolve("out/resources/icon.png")

      if (existsSync(srcIcon)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcIcon, destIcon)
      }

      // Copy skills directory
      const srcSkills = resolve("skills")
      const destSkills = resolve("out/skills")
      mirrorRequiredDirectorySync(srcSkills, destSkills)

      // Preserve the original notices for adapted Bot code in packaged builds.
      const botNotices = resolve("out/resources/notices")
      mkdirSync(botNotices, { recursive: true })
      for (const [source, name] of [
        ["src/renderer/src/components/bots/animation/LICENSE.hermes", "hermes-bots-animation.txt"],
        ["src/renderer/src/components/bots/animation/vendor/README.md", "grok-avatar-source.md"],
        ["src/renderer/src/components/bots/EDITOR-SOURCES.md", "grok-group-editor-source.md"]
      ])
        copyFileSync(resolve(source), resolve(botNotices, name))

      // Playwright vendored 录制器生成文件在主进程 bundle 中仍通过
      // require("./generated/*.js") 加载，因此这里把源码副本同步到
      // out/main/generated，保证开发和构建产物都能命中相对路径。
      const srcPlaywrightGenerated = resolve(
        "src/main/browser/record/common/playwright-codegen/generated"
      )
      const destPlaywrightGenerated = resolve("out/main/generated")
      if (existsSync(srcPlaywrightGenerated)) {
        copyDirRecursive(srcPlaywrightGenerated, destPlaywrightGenerated)
      }
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry)
    const destPath = resolve(dest, entry)
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

function optionalMmjModule() {
  const virtualId = "\0virtual:mmj-empty"
  const mmjPath = resolve("src/renderer/js/mmj.js")

  return {
    name: "optional-mmj-module",
    resolveId(source: string, importer?: string) {
      const normalizedSource = source.replace(/\\/g, "/")
      const normalizedImporter = (importer || "").replace(/\\/g, "/")
      const isMmjFromUtils = normalizedSource === "./mmj.js" && normalizedImporter.endsWith("/src/renderer/js/mmjUtils.ts")
      const isDirectMmjPath = normalizedSource.endsWith("/src/renderer/js/mmj.js")
      if ((isMmjFromUtils || isDirectMmjPath) && !existsSync(mmjPath)) {
        return virtualId
      }
      return null
    },
    load(id: string) {
      if (id === virtualId) {
        return "export {}"
      }
      return null
    }
  }
}

export default defineConfig({
  main: {
    // Bundle all dependencies into the main process
    build: {
      externalizeDeps: {
        exclude: [
          "decode-named-character-reference", "micromark-util-decode-numeric-character-reference",
          "micromark", "micromark-extension-gfm",
          "remark-gfm", "remark-parse", "remark-rehype", "unified"
        ]
      },
      lib: {
        entry: {
          index: "src/main/bootstrap.ts",
          application: "src/main/index.ts",
          "bot-browser-host": "src/main/bots/browser-host-entry.ts",
          "bot-browser-toolbar-preload": "src/main/bots/browser-toolbar-preload.ts",
          "browser-native-host": "src/main/browser/chrome/browser-native-host-entry.ts",
          "pty-host": "src/main/pty-host.ts",
          "code-exec-helper": "src/main/code-exec/helper-entry.ts",
          ...(process.env.CMB_BOTS_E2E === "1" ? { "bots-browser-e2e": "tests/support/bots-browser-e2e-entry.ts" } : {}),
          ...(process.env.CMB_BOT_APP_E2E === "1" ? { "bots-app-e2e": "tests/support/bots-app-e2e-entry.ts" } : {})
        },
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["electron", "node-pty"],
        plugins: [copyResources()]
      }
    }
  },
  preload: {},
  renderer: {
    cacheDir: resolve("node_modules/.vite/renderer"),
    // Run the same Virtuoso transform in dev instead of pre-bundling past it.
    optimizeDeps: { exclude: ["react-virtuoso"] },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __CHAT_HIGHLIGHT_GRAMMARS__: JSON.stringify(collectMarkdownHighlightGrammars())
      // __APP_VERSION__: app.getVersion(),
    },
    resolve: {
      alias: {
        // Both dev and built Web Workers need the decoder without DOM dependencies.
        "decode-named-character-reference": requireDependency.resolve("decode-named-character-reference"),
        "@": resolve("src/renderer/src"),
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [optionalMmjModule(), virtuosoResizeAnchor(), react(), tailwindcss()],
    server: {
      fs: {
        // Worktrees may share node_modules through a symlink; allow its static assets too.
        allow: [resolve("."), realpathSync(resolve("node_modules"))]
      },
      watch: {
        ignored: [
          "**/dist/**",
          "**/out/**",
          "**/build/**",
          "**/tmp/**",
          "**/temp/**",
          "**/resources/bin/**",
          "**/src/renderer/.vite/**"
        ]
      },
      proxy: {
      }
    }
  }
})
