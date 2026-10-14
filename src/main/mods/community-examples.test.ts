import { afterEach, expect, it } from "vitest"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  COMMUNITY_EXAMPLES,
  bundledCommunityExamplesRoot,
  communityExampleId,
  verifyCommunityExample
} from "./community-examples"
import { mirrorRequiredDirectorySync } from "../build/directory-mirror"

const root = resolve("resources/mods/community-originals")
const temporary: string[] = []
async function copy() {
  const directory = await mkdtemp(join(tmpdir(), "community-examples-"))
  temporary.push(directory)
  await cp(root, directory, { recursive: true })
  return directory
}
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

it("ships byte-identical pinned originals, provenance and license through the real resource mirror", async () => {
  const destination = await mkdtemp(join(tmpdir(), "community-examples-"))
  temporary.push(destination)
  mirrorRequiredDirectorySync(resolve("resources/mods"), join(destination, "mods"))
  const fixture = resolve("tests/fixtures/mods-upstream")
  const provenance = JSON.parse(await readFile(join(fixture, "provenance.json"), "utf8")) as {
    files: Array<{ fixturePath: string }>
  }
  for (const name of ["provenance.json", ...provenance.files.map((file) => file.fixturePath)])
    expect(await readFile(join(destination, "mods/community-originals", name))).toEqual(
      await readFile(join(fixture, name))
    )
  for (const example of COMMUNITY_EXAMPLES)
    await expect(
      verifyCommunityExample(join(destination, "mods/community-originals"), example.id)
    ).resolves.toBe(join(destination, "mods/community-originals", example.id))
  const config = JSON.parse(await readFile("package.json", "utf8"))
  expect(config.build.asarUnpack).toContain("out/resources/mods/**")
  expect(await readFile(".gitattributes", "utf8")).toContain(
    "resources/mods/community-originals/** -text"
  )
  expect(bundledCommunityExamplesRoot(resolve("installed/app.asar/out/main"))).toBe(
    resolve("installed/app.asar.unpacked/out/resources/mods/community-originals")
  )
})

it.each(["../token-weather", "unknown", "", null, {}, ["token-weather"]])(
  "rejects renderer-selected names or paths: %j",
  (value) => {
    expect(() => communityExampleId(value)).toThrow("MODS_COMMUNITY_EXAMPLE_INVALID")
  }
)

it.each(["provenance.json", "LICENSE", "token-weather/hooks/token-weather.mjs"])(
  "rejects modified bundled evidence or executable bytes: %s",
  async (file) => {
    const directory = await copy()
    await writeFile(join(directory, file), "tampered")
    await expect(verifyCommunityExample(directory, "token-weather")).rejects.toThrow(
      "MODS_COMMUNITY_INTEGRITY"
    )
  }
)

it("rejects unlisted extra executable files in an installed same-name package", async () => {
  const directory = await copy()
  await writeFile(join(directory, "token-weather/hooks/extra.mjs"), "export const x=1")
  await expect(
    verifyCommunityExample(root, "token-weather", join(directory, "token-weather"))
  ).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
})
