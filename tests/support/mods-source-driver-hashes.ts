import { build } from "esbuild"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { captureModsSourceSnapshot } from "./mods-source-snapshot"

/** Trace the selected driver's static/dynamic imports without running it or writing bundles. */
export async function modsSourceDriverHashes(root: string, entries: readonly string[]) {
  // Capture before asynchronous metadata tracing. Only the selected closure is compared:
  // edits to an unrelated parallel scenario do not invalidate this run.
  const before = captureModsSourceSnapshot(root, ["tests"])
  const graph = await build({
    absWorkingDir: root,
    entryPoints: entries.map((file) => resolve(root, file)),
    outdir: "metadata-only",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
    logLevel: "silent",
    // Source worker bytes are separately pinned by the candidate's complete source snapshot.
    plugins: [
      {
        name: "metadata-only-node-workers",
        setup(builder) {
          builder.onResolve({ filter: /\?nodeWorker$/ }, (args) => ({
            path: args.path,
            external: true
          }))
        }
      }
    ]
  })
  const paths = Object.keys(graph.metafile!.inputs)
    .map((path) => relative(root, resolve(root, path)).replaceAll("\\", "/"))
    .filter((path) => path.startsWith("tests/"))
  // The native launcher is a runtime string path, not an ECMAScript import.
  paths.push("tests/support/electron-launcher.cmd")
  return Object.fromEntries(
    [...new Set(paths)].sort().map((file) => {
      const current = createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex")
      assert.equal(current, before[file], `SOURCE_DRIVER_CHANGED_DURING_TRACE:${file}`)
      return [file, current]
    })
  )
}
