import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const { getMainFileMatchers } = require("app-builder-lib/out/fileMatcher")
const config = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).build
const libraryDirectory = "out/resources/mods-authoring/typescript"
const libraries = readdirSync(path.join(root, libraryDirectory)).filter(
  (name) =>
    name.endsWith(".d.ts") &&
    (name.startsWith("lib.es") ||
      name === "lib.decorators.d.ts" ||
      name === "lib.decorators.legacy.d.ts")
)
assert.equal(libraries.length, 91, "The built ES-only authoring library set must be complete")

const matchers = getMainFileMatchers(
  root,
  path.join(root, "output", "packaged-authoring-file-set-probe"),
  (value) => value,
  {},
  {
    info: {
      projectDir: root,
      buildResourcesDir: "build",
      config,
      debugLogger: { isEnabled: false }
    }
  },
  path.join(root, "dist"),
  false
)
const rootMatcher = matchers.find((matcher) => matcher.from === root)
const authoringMatchers = matchers.filter(
  (matcher) => matcher.from === path.join(root, libraryDirectory)
)
assert(rootMatcher, "Keep the application's ordinary root matcher")
assert.equal(authoringMatchers.length, 1, "Include authoring libraries through one scoped FileSet")
const authoringMatcher = authoringMatchers[0]
assert.equal(
  path.relative(rootMatcher.to, authoringMatcher.to).split(path.sep).join("/"),
  libraryDirectory
)
const file = { isDirectory: () => false }
const admits = (matcher, name) => {
  const relative = path.relative(matcher.from, name)
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    matcher.createFilter()(name, file)
  )
}
for (const library of libraries) {
  const source = path.join(root, libraryDirectory, library)
  assert.equal(admits(rootMatcher, source), false, "Retain builder's default declaration exclusion")
  assert.equal(
    admits(authoringMatcher, source),
    true,
    `Package required authoring library ${library}`
  )
}
for (const other of ["out/resources/unrelated/private.d.ts", "src/shared/private.d.ts"]) {
  const source = path.join(root, other)
  assert.equal(
    matchers.some((matcher) => admits(matcher, source)),
    false,
    `The authoring FileSet cannot include unrelated declarations: ${other}`
  )
}
assert.equal(admits(rootMatcher, path.join(root, "out/main/index.js")), true)
console.log(
  `PASS packaged authoring FileSet: ${libraries.length} ES declarations included; root defaults and path boundary preserved`
)
