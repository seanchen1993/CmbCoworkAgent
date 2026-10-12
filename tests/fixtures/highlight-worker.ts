import { join } from "node:path"
import { build, type Plugin } from "esbuild"
import { viteUrlAssetsFixture } from "./vite-url-assets"

/** Use the actual highlight worker with the same transform as Vite's ?worker import. */
export async function highlightWorkerFixture(renderer: string): Promise<Plugin> {
  const bundle = await build({
    entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
    outfile: "highlight-worker-fixture.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!script) throw new Error("Missing highlight worker fixture bundle")
  return {
    name: "original-highlight-worker",
    setup(builder) {
      viteUrlAssetsFixture().setup(builder)
      builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
        path: "highlight",
        namespace: "worker"
      }))
      builder.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
        loader: "js",
        contents: `export default class extends Worker {constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(script.text)}],{type:"text/javascript"}));try{super(url,options)}finally{URL.revokeObjectURL(url)}}}`
      }))
    }
  }
}
