import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { posix } from "node:path"
import type { Plugin } from "esbuild"

/** Immutable source-only Git view. Missing historical imports never use working-tree files. */
export function modsGitTree(root: string, revision: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
  const commit = git(["rev-parse", "--verify", `${revision}^{commit}`]).trim()
  const files = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", commit]).split("\0").filter(Boolean)
  )
  const cache = new Map<string, string>()
  const loaded = new Set<string>()
  // One batch avoids a git subprocess per source file on Windows. Lengths are bytes, not UTF-16.
  const texts = [...files].filter(
    (file) => file.startsWith("src/") && /\.(?:[cm]?[jt]sx?|json)$/.test(file)
  )
  let batched = false
  const loadBatch = () => {
    if (batched) return
    const batch = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      windowsHide: true,
      input: texts.map((file) => `${commit}:${file}\n`).join(""),
      maxBuffer: 256 * 1024 * 1024
    })
    let offset = 0
    for (const file of texts) {
      const end = batch.indexOf(10, offset)
      const header = batch
        .subarray(offset, end)
        .toString("utf8")
        .match(/^[a-f0-9]+ blob (\d+)$/)
      if (!header) throw Error(`BASELINE_BLOB_INVALID:${file}`)
      const size = Number(header[1])
      cache.set(file, batch.subarray(end + 1, end + 1 + size).toString("utf8"))
      offset = end + size + 2
    }
    batched = true
  }
  const read = (file: string) => {
    if (!files.has(file)) throw Error(`BASELINE_FILE_MISSING:${file}`)
    if (!cache.has(file)) cache.set(file, git(["show", `${commit}:${file}`]))
    loaded.add(file)
    return cache.get(file)!
  }
  const source = (file: string) => file.startsWith("src/")
  const resolveSource = (input: string) => {
    const clean = posix.normalize(input)
    if (clean.startsWith("../") || clean.startsWith("/"))
      throw Error(`BASELINE_IMPORT_OUTSIDE_TREE:${input}`)
    const variants = [
      clean,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map((ext) => clean + ext),
      ...[".ts", ".tsx", ".js", ".json"].map((ext) => `${clean}/index${ext}`)
    ]
    if (/\.m?js$/.test(clean)) variants.push(clean.replace(/\.m?js$/, ".ts"))
    const found = variants.find((file) => files.has(file))
    if (!found) throw Error(`BASELINE_IMPORT_MISSING:${input}`)
    return found
  }
  const plugin: Plugin = {
    name: "immutable-complete-git-source-tree",
    setup(builder) {
      builder.onStart(loadBatch)
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.outsideGitTree) return undefined
        if (args.namespace === "mods-git-tree") {
          if (args.path.startsWith(".")) {
            const file = resolveSource(posix.join(posix.dirname(args.importer), args.path))
            return { path: file, namespace: "mods-git-tree" }
          }
          if (args.path.startsWith("node:")) return { path: args.path, external: true }
          return builder.resolve(args.path, {
            kind: args.kind,
            resolveDir: dirname(resolve(root, args.importer)),
            pluginData: { outsideGitTree: true }
          })
        }
        if (args.namespace !== "file") return undefined
        const absolute = isAbsolute(args.path)
          ? args.path
          : args.path.startsWith(".")
            ? resolve(args.resolveDir, args.path)
            : undefined
        if (!absolute) return undefined
        const file = relative(root, absolute).replaceAll("\\", "/")
        if (!source(file)) return undefined
        return { path: resolveSource(file), namespace: "mods-git-tree" }
      })
      builder.onLoad({ filter: /.*/, namespace: "mods-git-tree" }, (args) => ({
        contents: read(args.path),
        resolveDir: dirname(resolve(root, args.path)),
        loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".tsx") ? "tsx" : "ts"
      }))
    }
  }
  return {
    commit,
    files,
    read,
    resolveSource,
    plugin,
    assertSameDependencies() {
      const expected = createHash("sha256").update(read("package-lock.json")).digest("hex")
      const current = createHash("sha256")
        .update(readFileSync(resolve(root, "package-lock.json")))
        .digest("hex")
      if (expected !== current) throw Error("BASELINE_DEPENDENCY_LOCK_CHANGED")
      return current
    },
    loadedSources() {
      return Object.fromEntries(
        [...cache]
          .filter(([file]) => source(file) && loaded.has(file))
          .sort()
          .map(([file, content]) => [file, createHash("sha256").update(content).digest("hex")])
      )
    }
  }
}
