import { afterEach, expect, it } from "vitest"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { bundledBusinessModExamples, readBundledBusinessModExample } from "./business-mod-examples"
import { compileFunctionPlugin } from "../mods/v2/loader"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it("reads shipped knowledge SDK source from the real unpacked ASAR layout and compiles its native extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-bundled-example-"))
  roots.push(root)
  const main = join(root, "resources/app.asar/out/main")
  const unpacked = join(root, "resources/app.asar.unpacked/out/resources/mods")
  await mkdir(unpacked, { recursive: true })
  await cp(resolve("resources/mods/autobiz-knowledge"), join(unpacked, "autobiz-knowledge"), {
    recursive: true
  })
  await cp(
    resolve("resources/mods/autobiz-context-provider.py"),
    join(unpacked, "autobiz-context-provider.py")
  )
  const example = await readBundledBusinessModExample("autobiz-knowledge", main)
  expect(example).toMatchObject({
    exampleId: "autobiz-knowledge",
    installed: false,
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" }
  })
  expect(example.draft.files).toHaveLength(4)
  expect(example.draft.files.find((file) => file.path.endsWith("/provider.py"))?.text).toBe(
    await readFile(resolve("resources/mods/autobiz-context-provider.py"), "utf8")
  )
  const extension = example.draft.extensions![0]
  expect(extension.skills).toEqual([
    "mods/business/autobiz.knowledge/skills/knowledge-sync/SKILL.md"
  ])
  const config = JSON.parse(await readFile(resolve("package.json"), "utf8"))
  expect(config.build.asarUnpack).toContain("out/resources/mods/**")
  const plugin = join(root, "plugin")
  for (const file of example.draft.files) {
    await mkdir(dirname(join(plugin, file.path)), { recursive: true })
    await writeFile(join(plugin, file.path), file.text)
  }
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "knowledge-sdk-compiled", version: "1.0.0", mods: "mods/manifest.json" })
  )
  await writeFile(
    join(plugin, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "knowledge-sdk-compiled",
      claw: {
        componentsVersion: 1,
        actions: [],
        components: [
          {
            id: extension.id,
            name: extension.title,
            kind: "module",
            entry: extension.entry.slice(5),
            dependsOn: [],
            actionIds: [],
            usage: "project"
          }
        ]
      }
    })
  )
  expect(
    (await compileFunctionPlugin(plugin)).components?.map((component) => component.id)
  ).toEqual(["autobiz.knowledge"])
  expect(bundledBusinessModExamples.map((example) => example.exampleId)).toEqual([
    "autobiz-knowledge"
  ])
  await expect(readBundledBusinessModExample("../../private", main)).rejects.toThrow(
    "BUSINESS_CREATOR_EXAMPLE_UNAVAILABLE"
  )
})
