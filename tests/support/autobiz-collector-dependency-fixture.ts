import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const assets = [
  [
    "collector-gray-matter.cjs",
    "index.js",
    "a18fe1c53ab582a75ca3818a5eddf4109efa787594e571324ffe41cd899aceb1"
  ],
  [
    "collector-THIRD-PARTY-NOTICES.md",
    "THIRD-PARTY-NOTICES.md",
    "2bd6662b4ecd587835cf373d792834820b352d99cc037aad566f4818972906b7"
  ]
] as const
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Test-only private dependency for unchanged legacy collectors; never installs packages or edits a plugin. */
export function prepareAutobizCollectorFixture(
  collector: string,
  repository = resolve(__dirname, "../..")
): void {
  const directory = join(collector, "node_modules/gray-matter")
  const files: Array<{ target: string; bytes: Buffer }> = assets.map(
    ([asset, target, expected]) => {
      const bytes = readFileSync(join(repository, "resources/mods/autobiz-knowledge", asset))
      if (digest(bytes) !== expected) throw Error("COLLECTOR_FIXTURE_DEPENDENCY_DIGEST_CHANGED")
      return { target, bytes }
    }
  )
  files.push({
    target: "package.json",
    bytes: Buffer.from(
      JSON.stringify({
        name: "gray-matter",
        version: "4.0.3",
        private: true,
        type: "commonjs",
        main: "index.js"
      }) + "\n"
    )
  })
  mkdirSync(directory, { recursive: true })
  for (const { target, bytes } of files) {
    const file = join(directory, target)
    if (existsSync(file)) {
      if (!readFileSync(file).equals(bytes)) throw Error("COLLECTOR_FIXTURE_DEPENDENCY_CHANGED")
    } else writeFileSync(file, bytes, { flag: "wx" })
  }
}
