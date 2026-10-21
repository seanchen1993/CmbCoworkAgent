import { afterEach, expect, it, vi } from "vitest"
import * as fsPromises from "node:fs/promises"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  COMMUNITY_EXAMPLES,
  PLATFORM_EXAMPLES,
  BUNDLED_EXAMPLES,
  bundledCommunityExamplesRoot,
  communityExampleId,
  verifyCommunityExample,
  withMaterializedCommunityExample
} from "./community-examples"
import { mirrorRequiredDirectorySync } from "../build/directory-mirror"

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original, rm: vi.fn(original.rm) }
})

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
    resolve("installed/app.asar/out/resources/bundled-mods/community-originals")
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

async function platformResources() {
  const destination = await mkdtemp(join(tmpdir(), "platform-examples-"))
  temporary.push(destination)
  await mkdir(join(destination, "community-originals"))
  for (const example of PLATFORM_EXAMPLES) {
    if (example.origin !== "devclaw") throw Error("wrong provenance")
    mirrorRequiredDirectorySync(
      resolve(example.sourcePath),
      join(destination, "platform-examples", example.id)
    )
  }
  return { root: join(destination, "community-originals"), destination }
}

it("ships every named local package including the independent stage debugger with exact canonical bytes", async () => {
  const { root: bundledRoot, destination } = await platformResources()
  expect(PLATFORM_EXAMPLES.map((example) => example.id)).toEqual([
    "task-workbench-provider",
    "task-workbench-consumer",
    "task-behavior-prefix",
    "task-behavior-compact",
    "edit-reminder",
    "stage-debugger"
  ])
  expect(new Set(BUNDLED_EXAMPLES.map((example) => example.id)).size).toBe(9)
  expect(PLATFORM_EXAMPLES.find((example) => example.id === "stage-debugger")).toMatchObject({
    pluginName: "stage-debugger",
    title: "阶段调试工作台",
    origin: "devclaw",
    sourcePath: "examples/sparks-stage-debugger",
    version: "1.0.0"
  })
  for (const example of PLATFORM_EXAMPLES) {
    expect(communityExampleId(example.id)).toBe(example.id)
    const directory = join(destination, "platform-examples", example.id)
    await expect(verifyCommunityExample(bundledRoot, example.id)).resolves.toBe(directory)
    expect(JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"))).toMatchObject({
      name: example.pluginName,
      version: "1.0.0"
    })
    expect(example).not.toHaveProperty("upstreamUrl")
    expect(example).not.toHaveProperty("commit")
    expect(example.origin).toBe("devclaw")
  }
})

it.each(["plugin.json", "hooks/hooks.json", "hooks/register.ts"])(
  "rejects tampered local executable packages before installation: %s",
  async (file) => {
    const { root: bundledRoot, destination } = await platformResources()
    await writeFile(
      join(destination, "platform-examples/task-workbench-consumer", file),
      "tampered"
    )
    await expect(verifyCommunityExample(bundledRoot, "task-workbench-consumer")).rejects.toThrow(
      "MODS_COMMUNITY_INTEGRITY"
    )
  }
)

it("rejects an installed local package with extra code and directory links", async () => {
  const { root: bundledRoot, destination } = await platformResources()
  const original = join(destination, "platform-examples/task-workbench-provider")
  const installed = join(destination, "installed")
  await cp(original, installed, { recursive: true })
  await writeFile(join(installed, "hooks/extra.ts"), "export const extra = true")
  await expect(
    verifyCommunityExample(bundledRoot, "task-workbench-provider", installed)
  ).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
  const linked = join(destination, "linked")
  await symlink(original, linked, process.platform === "win32" ? "junction" : "dir")
  await expect(
    verifyCommunityExample(bundledRoot, "task-workbench-provider", linked)
  ).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
})

it("reports only the pinned relative file when an integrity check fails", async () => {
  const { root: bundledRoot, destination } = await platformResources()
  await writeFile(
    join(destination, "platform-examples/task-workbench-consumer/hooks/register.ts"),
    "tampered"
  )
  await expect(verifyCommunityExample(bundledRoot, "task-workbench-consumer")).rejects.toThrow(
    "MODS_COMMUNITY_INTEGRITY: task-workbench-consumer · hooks/register.ts 的内容与内置版本不一致"
  )
  await expect(
    verifyCommunityExample(join(destination, "missing-private-path"), "token-weather")
  ).rejects.toThrow(
    "MODS_COMMUNITY_INTEGRITY: token-weather · 文件缺失、不可读取或目录类型不受支持"
  )
})

it("describes context weather separately from cumulative input/output usage", () => {
  const weather = COMMUNITY_EXAMPLES.find((example) => example.id === "token-weather")!
  expect(weather.description).toContain("上下文占用")
  expect(weather.usage).toContain("不是累计输入/输出 Token")
  expect(weather.usage).toContain("尚无上下文读数")
})

it("stages only verified same-archive bytes into physical files and always cleans up", async () => {
  const { root: bundledRoot } = await platformResources()
  let staged = ""
  await expect(
    withMaterializedCommunityExample(bundledRoot, "task-workbench-consumer", async (directory) => {
      staged = directory
      await expect(
        verifyCommunityExample(bundledRoot, "task-workbench-consumer", directory)
      ).resolves.toBe(directory)
      throw Error("installer rejected")
    })
  ).rejects.toThrow("installer rejected")
  await expect(readFile(join(staged, "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" })
})

it.each([false, true])(
  "does not replace an install outcome with a staging cleanup error: %s",
  async (failed) => {
    const { root: bundledRoot } = await platformResources()
    const remove = vi
      .mocked(fsPromises.rm)
      .mockRejectedValueOnce(
        Object.assign(Error("staging directory held by scanner"), { code: "EPERM" })
      )
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    let staged = ""
    try {
      const result = withMaterializedCommunityExample(
        bundledRoot,
        "task-workbench-consumer",
        async (directory) => {
          staged = directory
          if (failed) throw Error("original install failure")
          return { pluginId: "installed", requiresApproval: true }
        }
      )
      if (failed) await expect(result).rejects.toThrow("original install failure")
      else await expect(result).resolves.toEqual({ pluginId: "installed", requiresApproval: true })
      expect(remove).toHaveBeenCalledWith(dirname(staged), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      })
      expect(warning).toHaveBeenCalledOnce()
    } finally {
      remove.mockRestore()
      warning.mockRestore()
      expect(dirname(staged)).toContain("cmb-builtin-example-")
      await rm(dirname(staged), { recursive: true, force: true })
    }
  }
)
