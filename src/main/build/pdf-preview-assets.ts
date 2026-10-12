import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Plugin } from "vite"

/** PDF.js resolves fonts/CMaps/WASM by their original names, including offline.
 * Serve the exact same finite package assets in development and production. */
export function pdfPreviewAssetsPlugin(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))
  const assets = new Map<string, Buffer>()
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      assets.set(
        `pdfjs/${directory}/${entry.name}`,
        readFileSync(join(root, directory, entry.name))
      )
    }
  }
  return {
    name: "pdf-preview-assets",
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source })
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0]?.replace(/^\//, "")
        const data = path ? assets.get(path) : undefined
        if (!data) return next()
        response.setHeader(
          "Content-Type",
          path?.endsWith(".wasm")
            ? "application/wasm"
            : path?.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream"
        )
        response.setHeader("Content-Length", data.length)
        response.end(data)
      })
    }
  }
}
