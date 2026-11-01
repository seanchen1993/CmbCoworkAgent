import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { PluginMetadata } from "../types"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { readProjectSourceSet } from "../mods/devtools/project-source-set"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { compileNativeComposition } from "./native-composition"
import { derivationContentIdentity, snapshotDerivationSource } from "./derivation-source"

/** Prepare every package before catalog mutation. Compilation grants no execution permission. */
export async function prepareProjectSourceSetInstall(
  root: string,
  staging: string,
  installed: readonly PluginMetadata[]
) {
  const source = await readProjectSourceSet(root, () => {})
  const catalog: ClawActionDescriptor[] = []
  const plan: Array<{
    name: string
    id: string
    root: string
    existing: boolean
    verify(directory: string): Promise<void>
  }> = []
  async function stage(name: string, files: Array<{ path: string; bytes: Buffer }>) {
    const directory = join(staging, name)
    await mkdir(directory, { recursive: true })
    for (const file of files) {
      const target = join(directory, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.bytes, { flag: "wx" })
    }
    const expectedFiles = (await snapshotDerivationSource(directory)).files
    const expected = derivationContentIdentity(expectedFiles)
    const matches = installed.filter((item) => item.name.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw Error(`项目包名称不唯一：${name}`)
    const verify = async (target: string) => {
      const actual = (await snapshotDerivationSource(target)).files
      if (derivationContentIdentity(actual) !== expected) {
        const changed = expectedFiles
          .filter(
            (file) =>
              !actual.some((other) => other.path === file.path && other.digest === file.digest)
          )
          .map((file) => file.path)
        throw Error(
          `项目包内容冲突或已变化：${name}（${changed.join("、")}）。请使用独立插件标识，避免覆盖已有项目版本。`
        )
      }
    }
    if (matches[0]) await verify(matches[0].path)
    const item = {
      name,
      id: matches[0]?.id ?? randomUUID(),
      root: directory,
      existing: !!matches[0],
      verify
    }
    plan.push(item)
    return item
  }
  for (const dependency of source.dependencies) {
    const item = await stage(dependency.name, dependency.snapshot.files)
    const compiled = await compileFunctionPlugin(
      installed.find((plugin) => plugin.id === item.id)?.path ?? item.root
    )
    for (const { id, ...action } of compiled.actions ?? [])
      catalog.push({
        ...action,
        actionId: id,
        pluginId: item.id,
        plugin: compiled.name,
        digest: compiled.digest
      })
  }
  if (source.dependencies.some((item) => item.name === source.composition.plugin.id))
    throw Error("项目名称不能与依赖名称重复")
  const compiled = compileNativeComposition(source.composition, {
    files: source.project.bundle.files.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.text)
    })),
    actionCatalog: catalog
  })
  await stage(source.composition.plugin.id, compiled.files)
  return plan
}
