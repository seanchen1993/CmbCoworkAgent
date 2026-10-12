import { resolve } from "path"
import { readFileSync, copyFileSync, existsSync, mkdirSync } from "fs"
import { defineConfig, type UserConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { mirrorRequiredDirectorySync } from "./src/main/build/directory-mirror"
import { BOT_PROCESS_ENTRIES, botBuildIdentity } from "./src/main/build/bot-build-inputs"
import { botNativeCompiledSealPlugin } from "./src/main/build/bot-native-compiled"
import { mainGeneratedScriptsPlugin } from "./src/main/build/main-generated-scripts"
import { pdfPreviewAssetsPlugin } from "./src/main/build/pdf-preview-assets"
import {
  prepareBotNativeDistribution,
  mirrorBotNativeDistribution,
  type PreparedBotNativeDistribution
} from "./src/main/build/bot-native-distribution"
// import {app} from "electron"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

// Plugin to copy resources to output
function copyResources(native: PreparedBotNativeDistribution | null): {
  name: string
  closeBundle: () => Promise<void>
} {
  return {
    name: "copy-resources",
    async closeBundle(): Promise<void> {
      const srcIcon = resolve("resources/icon.png")
      const destDir = resolve("out/resources")
      const destIcon = resolve("out/resources/icon.png")

      if (existsSync(srcIcon)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcIcon, destIcon)
      }

      await mirrorBotNativeDistribution(native, destDir)

      // Copy skills directory
      const srcSkills = resolve("skills")
      const destSkills = resolve("out/skills")
      mirrorRequiredDirectorySync(srcSkills, destSkills)
      mirrorRequiredDirectorySync(resolve("resources/mods"), resolve("out/resources/mods"))
      copyFileSync(resolve("resources/mods-policy.json"), resolve("out/resources/mods-policy.json"))
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
      const isMmjFromUtils =
        normalizedSource === "./mmj.js" &&
        normalizedImporter.endsWith("/src/renderer/js/mmjUtils.ts")
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

export default defineConfig(async (): Promise<UserConfig> => {
  const native = await prepareBotNativeDistribution(process.env)
  const buildId = botBuildIdentity(resolve("."), native?.pin)
  return {
    main: {
      define: {
        __BOT_BUILD_ID__: JSON.stringify(buildId),
        __BOT_NATIVE_DISTRIBUTION__: JSON.stringify(native?.pin ?? null)
      },
      // Bundle all dependencies into the main process
      build: {
        // These ESM parser plugins must retain their default exports in the CJS
        // desktop bundle; external require() would pass module namespaces to unified.
        externalizeDeps: {
          exclude: ["unified", "remark-parse", "remark-gfm", "remark-rehype"]
        },
        lib: {
          entry: {
            index: "src/main/bootstrap.ts",
            ...BOT_PROCESS_ENTRIES,
            "browser-native-host": "src/main/browser/chrome/browser-native-host-entry.ts",
            "pty-host": "src/main/pty-host.ts",
            "code-exec-helper": "src/main/code-exec/helper-entry.ts",
            "mods-cli": "src/main/mods/devtools/cli-entry.ts",
            // Test-only exports share the production module instances. Absent in normal builds.
            ...(process.env.CMB_MODS_E2E === "1"
              ? { "mods-e2e": "tests/support/mods-e2e-entry.ts" }
              : {})
          },
          formats: ["cjs"]
        },
        rollupOptions: {
          external: [
            "electron",
            "original-fs",
            "node-pty",
            "quickjs-emscripten",
            "esbuild",
            "@napi-rs/canvas",
            /^pdfjs-dist\//
          ],
          plugins: [
            mainGeneratedScriptsPlugin(),
            botNativeCompiledSealPlugin(native?.pin ?? null, buildId),
            copyResources(native)
          ]
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
      plugins: [optionalMmjModule(), pdfPreviewAssetsPlugin(), react(), tailwindcss()],
      server: {
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
        proxy: {}
      }
    }
  }
})
