import { resolve } from "path"
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { mirrorRequiredDirectorySync } from "./src/main/build/directory-mirror"
// import {app} from "electron"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

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
      mirrorRequiredDirectorySync(resolve("resources/mods"), resolve("out/resources/mods"))
      copyFileSync(resolve("resources/mods-policy.json"), resolve("out/resources/mods-policy.json"))

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
    // Preserve existing main env mapping, including VITE_LEANSTAR_REVIEW_GATEWAY_URL.
    // The requirement gateway prefers runtime LEANSTAR_REVIEW_GATEWAY_URL.
    envPrefix: ["MAIN_VITE_", "VITE_"],
    // Bundle all dependencies into the main process
    build: {
      lib: {
        entry: {
          index: "src/main/bootstrap.ts",
          application: "src/main/index.ts",
          "bot-browser-host": "src/main/bots/browser-host-entry.ts",
          "browser-native-host": "src/main/browser/chrome/browser-native-host-entry.ts",
          "pty-host": "src/main/pty-host.ts",
          "code-exec-helper": "src/main/code-exec/helper-entry.ts",
          "mod-host": "src/main/mods/host-entry.ts",
          "function-mod-host": "src/main/mods/v2/host-entry.ts",
          "mods-cli": "src/main/mods/devtools/cli-entry.ts",
          ...(process.env.CMB_BOTS_E2E === "1" ? { "bots-browser-e2e": "tests/support/bots-browser-e2e-entry.ts" } : {}),
          // Test-only exports share the production module instances. Absent in normal builds.
          ...(process.env.CMB_MODS_E2E === "1" ? { "mods-e2e": "tests/support/mods-e2e-entry.ts" } : {})
        },
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["electron", "node-pty", "quickjs-emscripten", "esbuild"],
        plugins: [copyResources()]
      }
    }
  },
  preload: {},
  renderer: {
    cacheDir: resolve("node_modules/.vite/renderer"),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
      // __APP_VERSION__: app.getVersion(),
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [optionalMmjModule(), react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
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
