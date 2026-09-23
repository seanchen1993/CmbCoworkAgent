import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { bundledModExamplesRoot } from "./bundled-examples"

it("uses real unpacked files for bundled Function compiler stable file handles", () => {
  const main = resolve("installed/resources/app.asar/out/main")
  expect(bundledModExamplesRoot(main)).toBe(
    resolve("installed/resources/app.asar.unpacked/out/resources/mods")
  )
  const config = JSON.parse(readFileSync(resolve("package.json"), "utf8"))
  expect(config.build.asarUnpack).toContain("out/resources/mods/**")
})

it("keeps development examples in the ordinary build and only replaces an ASAR path segment", () => {
  const main = resolve("development/app.asar-project/out/main")
  expect(bundledModExamplesRoot(main)).toBe(join(main, "../resources/mods"))
})

it("preserves archive-like ancestors when resolving the actual application archive", () => {
  expect(bundledModExamplesRoot(resolve("releases.asar/app.asar/out/main"))).toBe(
    resolve("releases.asar/app.asar.unpacked/out/resources/mods")
  )
  expect(bundledModExamplesRoot(resolve("releases.asar/development/out/main"))).toBe(
    resolve("releases.asar/development/out/resources/mods")
  )
})
