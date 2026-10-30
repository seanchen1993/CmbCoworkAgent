import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

const cache = resolve("node_modules/.cache")
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, "design-session-browser-"))
try {
  const requested = process.argv.slice(2)
  const entries = requested.length
    ? requested
    : [
        "tests/design-background-session-browser.spec.ts",
        "tests/design-validation-feedback-browser.spec.ts"
      ]
  for (const [index, entry] of entries.entries()) {
    const outfile = join(directory, `test-${index}.mjs`)
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile
    })
    await import(pathToFileURL(outfile).href)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
