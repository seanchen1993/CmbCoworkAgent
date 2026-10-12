import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import type { Plugin } from "esbuild"

/** Resolve Vite's ?url imports for isolated esbuild UI fixtures. Embed the real
 * bytes so single-script fixture servers also serve the actual worker asset. */
export function viteUrlAssetsFixture(): Plugin {
  return {
    name: "vite-url-assets",
    setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, async (args) => {
        const result = await builder.resolve(args.path.slice(0, -4), {
          resolveDir: args.resolveDir,
          kind: args.kind
        })
        return result.errors.length ? result : { path: result.path, namespace: "vite-url-asset" }
      })
      builder.onLoad({ filter: /.*/, namespace: "vite-url-asset" }, async ({ path }) => {
        const mime = [".js", ".mjs"].includes(extname(path))
          ? "text/javascript"
          : "application/octet-stream"
        const url = `data:${mime};base64,${(await readFile(path)).toString("base64")}`
        return { loader: "js", contents: `export default ${JSON.stringify(url)}` }
      })
    }
  }
}
