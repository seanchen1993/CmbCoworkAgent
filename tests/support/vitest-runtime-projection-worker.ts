import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, extname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build, type Plugin as EsbuildPlugin, type Loader } from "esbuild"
import type { Plugin } from "vite"
import { modsSourceNodeWorkers } from "./mods-source-node-workers"

/** Fixed test-only actor factory. No application test branch or fabricated Worker response. */
export function runtimeProjectionSourceWorkerPlugin(repository: string): Plugin {
  const actor = resolve(repository, "src/main/checkpointer/runtime-projection-worker.ts")
  const client = resolve(repository, "src/main/checkpointer/runtime-projection-client.ts")
  const key = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
  const virtual = "\0current-runtime-projection-worker-factory"
  let compiling: Promise<{ directory: string; factory: string }> | undefined
  let contexts = 0
  const compile = () =>
    (compiling ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "cmb-vitest-projection-source-"))
      try {
        const entry = join(directory, "runtime-projection-worker.cjs")
        const workers = modsSourceNodeWorkers(repository)
        const consumed = new Map<string, { path: string; sha256: string; bytes: number }>()
        const capture: EsbuildPlugin = {
          name: "fixed-actor-consumed-bytes",
          setup(builder) {
            builder.onLoad(
              { filter: /\.[cm]?[jt]sx?$|\.json$/, namespace: "file" },
              async (args) => {
                const bytes = await readFile(args.path),
                  extension = extname(args.path)
                const loader: Loader =
                  extension === ".json"
                    ? "json"
                    : extension === ".tsx"
                      ? "tsx"
                      : extension === ".jsx"
                        ? "jsx"
                        : /\.[cm]?ts$/.test(extension)
                          ? "ts"
                          : "js"
                consumed.set(key(args.path), {
                  path: args.path,
                  bytes: bytes.length,
                  sha256: createHash("sha256").update(bytes).digest("hex")
                })
                return { contents: bytes, loader }
              }
            )
          }
        }
        const output = await build({
          absWorkingDir: repository,
          entryPoints: [actor],
          outfile: entry,
          bundle: true,
          platform: "node",
          target: "node22",
          format: "cjs",
          metafile: true,
          plugins: [workers.plugin, capture],
          logLevel: "silent"
        })
        if (workers.entries.size) throw Error("Unexpected nested Worker in fixed projection actor")
        const inputs = await Promise.all(
          Object.keys(output.metafile!.inputs).map(async (path) => {
            const actual = consumed.get(key(resolve(repository, path)))
            if (
              !actual ||
              actual.sha256 !==
                createHash("sha256")
                  .update(await readFile(actual.path))
                  .digest("hex")
            )
              throw Error("Source changed during actor compilation: " + path)
            return actual
          })
        )
        const factory = join(directory, "factory.cjs")
        await writeFile(
          factory,
          `const {Worker}=require("node:worker_threads");
module.exports=function(options){return new Worker(${JSON.stringify(entry)},options)};
`
        )
        const bytes = await readFile(entry)
        await writeFile(
          join(directory, "source-build-evidence.json"),
          JSON.stringify(
            {
              actor,
              inputs,
              metafile: output.metafile,
              output: {
                path: entry,
                bytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex")
              },
              factory: {
                path: factory,
                sha256: createHash("sha256")
                  .update(await readFile(factory))
                  .digest("hex")
              }
            },
            null,
            2
          ) + "\n"
        )
        return { directory, factory }
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    })())
  return {
    name: "fixed-current-runtime-projection-source-worker",
    enforce: "pre",
    configResolved() {
      contexts++
    },
    // Vite awaits this before module collection: source compilation is not a 5s case operation.
    async buildStart() {
      await compile()
    },
    resolveId(id, importer) {
      if (!id.endsWith("?nodeWorker") || !importer || key(importer.split("?")[0]) !== key(client))
        return
      const target = id.slice(0, -"?nodeWorker".length)
      if (
        key(resolve(dirname(client), target.endsWith(".ts") ? target : target + ".ts")) !==
        key(actor)
      )
        return
      return virtual
    },
    async load(id) {
      if (id !== virtual) return
      const { factory } = await compile()
      // A native require bypasses leaf worker_threads mocks; the real CJS factory retains options.
      return `import {createRequire} from "node:module";
export default createRequire(${JSON.stringify(resolve(repository, "vitest.config.ts"))})(${JSON.stringify(factory)});`
    },
    async closeBundle() {
      if (--contexts > 0 || !compiling) return
      const pending = compiling
      try {
        // buildStart already reports a compile rejection; do not replace it with teardown noise.
        const compiled = await pending.catch(() => undefined)
        if (compiled) await rm(compiled.directory, { recursive: true, force: true })
      } finally {
        if (compiling === pending) compiling = undefined
      }
    }
  }
}
