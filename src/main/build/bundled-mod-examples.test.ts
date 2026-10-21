import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  BUNDLED_EXAMPLES,
  PLATFORM_EXAMPLES,
  bundledCommunityExamplesRoot,
  verifyCommunityExample
} from "../mods/community-examples"
import { mirrorBundledModExamples } from "./bundled-mod-examples"

const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !directory.includes("bundled-mod-build-")
    )
      throw Error("UNSAFE_BUILD_TEST_CLEANUP")
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundled-mod-build-"))
  temporary.push(root)
  const project = join(root, "source")
  await mkdir(join(project, "resources/mods"), { recursive: true })
  await cp(
    resolve("resources/mods/community-originals"),
    join(project, "resources/mods/community-originals"),
    { recursive: true }
  )
  for (const example of PLATFORM_EXAMPLES) {
    if (example.origin !== "devclaw") throw Error("wrong provenance")
    await cp(resolve(example.sourcePath), join(project, example.sourcePath), { recursive: true })
  }
  return { root, project, output: join(root, "output/mods") }
}

it("uses the install catalogue to copy and verify all nine examples after an autocrlf checkout", async () => {
  const f = await fixture()
  const config = join(f.root, "empty-git-config")
  await writeFile(config, "")
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name]
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_ATTR_NOSYSTEM: "1"
  })
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.attributesFile=" + config, ...args], {
      cwd: f.project,
      env,
      windowsHide: true,
      timeout: 10000
    })
  git("init", "--quiet", "--template=")
  git("config", "core.autocrlf", "true")
  git("config", "core.safecrlf", "false")
  await writeFile(join(f.project, ".gitattributes"), await readFile(".gitattributes"))
  await writeFile(join(f.project, "control.txt"), "control\nsecond line\n")
  git("add", "--", ".")
  const checkout = join(f.root, "checkout")
  await mkdir(checkout)
  git("checkout-index", "--all", "--prefix=" + checkout.replace(/\\/g, "/") + "/")
  expect(await readFile(join(checkout, "control.txt"), "utf8")).toBe("control\r\nsecond line\r\n")
  await mirrorBundledModExamples(checkout, f.output)
  for (const example of BUNDLED_EXAMPLES) {
    await expect(
      verifyCommunityExample(join(f.output, "community-originals"), example.id)
    ).resolves.toEqual(expect.any(String))
  }
})

it.each(["line endings", "changed source", "extra executable"])(
  "fails packaging before a bad built-in can ship: %s",
  async (change) => {
    const f = await fixture()
    const file = join(f.project, "examples/sparks-task-workbench/provider/hooks/register.ts")
    const source = await readFile(file, "utf8")
    if (change === "extra executable")
      await writeFile(join(dirname(file), "unexpected.ts"), "export const unexpected = true\n")
    else
      await writeFile(
        file,
        change === "line endings"
          ? source.replace(/\r?\n/g, "\r\n")
          : source + "\n// changed after review\n"
      )
    await expect(mirrorBundledModExamples(f.project, f.output)).rejects.toThrow(
      "Bundled example failed packaging verification: task-workbench-provider"
    )
  }
)

it("keeps original bytes in app.asar when older unpacked resources remain beside it", async () => {
  const f = await fixture()
  const app = join(f.root, "app")
  const bundled = join(app, "out/resources/bundled-mods")
  await mirrorBundledModExamples(f.project, bundled)
  const { createPackageWithOptions, extractAll, extractFile, statFile } = createRequire(import.meta.url)(
    "@electron/asar"
  ) as typeof import("@electron/asar")
  const archive = join(f.root, "app.asar")
  const config = JSON.parse(await readFile("package.json", "utf8"))
  expect(config.build.asarUnpack).not.toContain("out/resources/bundled-mods/**")
  await createPackageWithOptions(app, archive, { unpack: "out/resources/mods/**" })
  const old = join(
    f.root,
    "app.asar.unpacked/out/resources/mods/platform-examples/task-workbench-provider/hooks"
  )
  await mkdir(old, { recursive: true })
  await writeFile(join(old, "register.ts"), "old installed version")
  const main = join(archive, "out/main")
  expect(bundledCommunityExamplesRoot(main)).toBe(
    join(archive, "out/resources/bundled-mods/community-originals")
  )
  const name = join(
    "out/resources/bundled-mods/platform-examples/task-workbench-provider/hooks/register.ts"
  )
  expect(statFile(archive, name)).not.toHaveProperty("unpacked", true)
  const bytes = extractFile(archive, name)
  expect(bytes).toEqual(
    await readFile(join(bundled, "platform-examples/task-workbench-provider/hooks/register.ts"))
  )
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "e5e8f877bde33aef2d41029dac9b0ff7b677a7e85c39deb114649c1fc2f89e0a"
  )
  const extracted = join(f.root, "archive-extracted")
  extractAll(archive, extracted)
  for (const example of BUNDLED_EXAMPLES) {
    await expect(
      verifyCommunityExample(
        join(extracted, "out/resources/bundled-mods/community-originals"), example.id
      )
    ).resolves.toEqual(expect.any(String))
  }
})
