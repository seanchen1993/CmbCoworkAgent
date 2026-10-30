import type { SDK } from "devclaw-mods"
export function productionModules(tracked: string[]) {
  return tracked.filter(
    (path) =>
      /\.(?:cjs|mjs|js)$/.test(path) &&
      !/(?:^|\/)(?:tests?|__tests__)\//.test(path) &&
      !/\.(?:test|spec)\./.test(path)
  )
}

export function assertNodeProductionPaths(paths: string[]) {
  const resources =
    /\.(?:json|jsonc|md|mdx|txt|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|lock|png|jpe?g|gif|svg|ico|webp|pdf|woff2?|ttf|otf)$/i
  for (const path of paths) {
    if (/(?:^|\/)(?:tests?|__tests__)\//.test(path) || /\.(?:test|spec)\./.test(path)) continue
    if (/\.(?:js|cjs|mjs)$/.test(path) || resources.test(path)) continue
    const name = path.split("/").at(-1)!
    if (
      /^\.(?:gitignore|gitattributes|editorconfig|npmrc|nvmrc)$/.test(name) ||
      /^(?:LICENSE|NOTICE|CHANGELOG|README)(?:\..*)?$/i.test(name)
    )
      continue
    // An unknown production extension or extensionless executable needs an explicit compiler adapter.
    throw Error("LEAN_NODE_UNSUPPORTED_PRODUCTION_SOURCE:replace-execution-adapter")
  }
}

/** Node parses every production module. An entry-point check cannot hide another invalid module. */
export async function compileNodeModules($: Pick<SDK, "process">, files: string[]) {
  const results: Array<{ path: string; exitCode: number }> = []
  const logs: string[] = []
  const errors: string[] = []
  for (const path of files) {
    const result = await $.process.run(["node", "--check", path], { timeoutMs: 30000 })
    results.push({ path, exitCode: result.exitCode })
    logs.push(result.stdout)
    errors.push(result.stderr)
  }
  const failed = results.find((result) => result.exitCode !== 0)
  return {
    exitCode: failed?.exitCode ?? 0,
    stdout: logs.join("\n"),
    stderr: errors.join("\n"),
    compilation: {
      protocol: "autobiz.production-compile/v1",
      mode: "node-syntax",
      passed: !failed,
      files,
      results
    }
  }
}
