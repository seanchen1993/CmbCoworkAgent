import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

const cache = resolve("node_modules/.cache")
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, "design-session-browser-"))
try {
  const outfile = join(directory, "test.mjs")
  await build({
    entryPoints: ["tests/design-background-session-browser.spec.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile
  })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
