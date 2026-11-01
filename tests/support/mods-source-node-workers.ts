import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"
import { posix } from "node:path"
import type { Plugin } from "esbuild"

/** Same factory contract as electron-vite, with real separately compiled worker entries. */
export function modsSourceNodeWorkers(
  repository: string,
  historical?: { resolveSource(path: string): string }
) {
  const entries = new Map<string, string>()
  const plugin: Plugin = {
    name: "real-isolated-node-workers",
    setup(builder) {
      builder.onResolve({ filter: /\?nodeWorker$/ }, (args) => {
        const target = args.path.replace(/\?nodeWorker$/, "")
        const source =
          args.namespace === "mods-git-tree"
            ? resolve(
                repository,
                historical!.resolveSource(posix.join(posix.dirname(args.importer), target))
              )
            : resolve(args.resolveDir, target + ".ts")
        if (args.namespace !== "mods-git-tree")
          assert(existsSync(source), `SOURCE_WORKER_MISSING:${source}`)
        const name = `worker-${createHash("sha256")
          .update(relative(repository, source))
          .digest("hex")
          .slice(0, 12)}.js`
        entries.set(source, name)
        return { path: name, namespace: "source-worker-factory" }
      })
      builder.onLoad({ filter: /.*/, namespace: "source-worker-factory" }, (args) => ({
        contents: `import {Worker} from "node:worker_threads";import {join} from "node:path";
export default function(options){return new Worker(join(__dirname,${JSON.stringify(args.path)}),options)}`,
        loader: "js"
      }))
    }
  }
  return { entries, plugin }
}
