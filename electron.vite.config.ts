import { resolve } from "path"
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
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
      if (existsSync(srcSkills)) {
        copyDirRecursive(srcSkills, destSkills)
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
      lib: {
        entry: {
          index: "src/main/index.ts",
          "pty-host": "src/main/pty-host.ts",
          "code-exec-helper": "src/main/code-exec/helper-entry.ts"
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
      proxy: {
      }
    }
  }
})
