import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { mirrorRequiredDirectorySync } from "../build/directory-mirror"
import { BUNDLED_EXAMPLES, PLATFORM_EXAMPLES, verifyCommunityExample } from "./community-examples"

const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes("stage-debugger-distribution-"))
      throw Error("UNSAFE_DISTRIBUTION_TEST_CLEANUP")
    await rm(directory, { recursive: true, force: true })
  }
})
const pinned: Record<string, string> = {
  "hooks/hooks.json": "1c3cfc433b9383b0f6d714b7599d81bbc585d104ae2dffe321a190d81010ce5b",
  "hooks/register.ts": "a2b64e1c7a5e91eea7f2ddb0230908101695c064f09a8ba5b1738a370e1912c7",
  "plugin.json": "b7cf01b329ff798633cf7c90c09db81ef91c9ea0cfb5f89c2b92fa98902d8a14",
  "README.md": "682390bee8d740d19f8af5ff702fd7fcdcac2b12fd4708d638fed1efbb44ace6"
}
const files = ["README.md", "hooks/hooks.json", "hooks/register.ts", "plugin.json"]
async function tree(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isSymbolicLink()) throw Error("UNEXPECTED_SOURCE_LINK")
    if (entry.isDirectory()) result.push(...await tree(join(root, entry.name), name + "/"))
    else result.push(name)
  }
  return result.sort()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-debugger-distribution-"))
  temporary.push(root)
  const community = join(root, "mods/community-originals")
  const destination = join(root, "mods/platform-examples/stage-debugger")
  await mkdir(community, { recursive: true })
  mirrorRequiredDirectorySync(resolve("examples/sparks-stage-debugger"), destination)
  return { root, community, destination }
}

it("publishes exactly one named local stage-debugger card through the original catalogue", () => {
  const matches = BUNDLED_EXAMPLES.filter(example => example.id === "stage-debugger")
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({ id: "stage-debugger", pluginName: "stage-debugger",
    title: "阶段调试工作台", origin: "devclaw", sourcePath: "examples/sparks-stage-debugger", version: "1.0.0" })
  expect(matches[0]).not.toHaveProperty("upstreamUrl")
  expect(PLATFORM_EXAMPLES).toContain(matches[0])
})

it("mirrors all four canonical files byte-for-byte and verifies every pinned hash before installation", async () => {
  const f = await fixture()
  expect(await tree(resolve("examples/sparks-stage-debugger"))).toEqual(files)
  expect(await tree(f.destination)).toEqual(files)
  for (const file of files) {
    const source = await readFile(resolve("examples/sparks-stage-debugger", file))
    const copied = await readFile(join(f.destination, file))
    expect(copied).toEqual(source)
    expect(createHash("sha256").update(copied).digest("hex")).toBe(pinned[file])
  }
  // verifyCommunityExample compares every file against the original fixed hash map and rejects
  // omissions/extras. Byte equality alone is insufficient if an installed file was customized.
  await expect(verifyCommunityExample(f.community, "stage-debugger")).resolves.toBe(f.destination)
  await expect(verifyCommunityExample(f.community, "stage-debugger", f.destination)).resolves.toBe(f.destination)
  const plugin = JSON.parse(await readFile(join(f.destination, "plugin.json"), "utf8"))
  expect(plugin).toMatchObject({ name: "stage-debugger", version: "1.0.0" })
  const hooks = JSON.parse(await readFile(join(f.destination, "hooks/hooks.json"), "utf8"))
  expect(hooks).toEqual({ modules: ["./register.ts"] })
  const config = await readFile("electron.vite.config.ts", "utf8")
  expect(config).toContain('["sparks-stage-debugger", "stage-debugger"]')
  const pkg = JSON.parse(await readFile("package.json", "utf8"))
  expect(pkg.build.asarUnpack).toContain("out/resources/mods/**")
})

it.each(files)("rejects changed pinned stage-debugger file without installing it: %s", async file => {
  const f = await fixture()
  await writeFile(join(f.destination, file), "changed after packaging")
  await expect(verifyCommunityExample(f.community, "stage-debugger")).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
})

it("rejects a missing original file and an extra executable instead of silently packaging a subset", async () => {
  const missing = await fixture()
  await unlink(join(missing.destination, "README.md"))
  await expect(verifyCommunityExample(missing.community, "stage-debugger")).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
  const extra = await fixture()
  await writeFile(join(extra.destination, "hooks/unreviewed.ts"), "export const surprise = true")
  await expect(verifyCommunityExample(extra.community, "stage-debugger")).rejects.toThrow("MODS_COMMUNITY_INTEGRITY")
})

it("preserves the exact stage-debugger pins through a fresh autocrlf Windows-style checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-debugger-distribution-"))
  temporary.push(root)
  const repository = join(root, "repository")
  const checkout = join(root, "checkout")
  await mkdir(repository)
  await mkdir(checkout)
  const emptyConfig = join(root, "empty-git-config")
  await writeFile(emptyConfig, "")
  // Do not let inherited GIT_DIR, global attributes, filters or template configuration turn
  // the isolated regression into operations on a developer's real repository.
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name]
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: "1"
  })
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "core.attributesFile=" + emptyConfig, ...args
  ], { cwd: repository, env, encoding: "utf8", windowsHide: true, timeout: 10000 })
  git("init", "--quiet", "--template=")
  git("config", "core.autocrlf", "true")
  git("config", "core.safecrlf", "false")
  await writeFile(join(repository, ".gitattributes"), await readFile(".gitattributes"))
  const example = "examples/sparks-stage-debugger"
  for (const file of files) {
    const target = join(repository, example, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(resolve(example, file)))
  }
  // The unruled control must really convert; otherwise this test could pass with autocrlf
  // disabled while failing to protect the package on an actual Windows checkout.
  await writeFile(join(repository, "autocrlf-control.txt"), "control\nsecond line\n")
  git("add", "--", ".gitattributes", "autocrlf-control.txt", example)
  git("checkout-index", "--all", "--prefix=" + checkout.replace(/\\/g, "/") + "/")
  expect(await readFile(join(checkout, "autocrlf-control.txt"), "utf8"))
    .toBe("control\r\nsecond line\r\n")
  const checkedSource = join(checkout, example)
  expect(await tree(checkedSource)).toEqual(files)
  for (const file of files) {
    const bytes = await readFile(join(checkedSource, file))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned[file])
  }
  const community = join(root, "packaged/mods/community-originals")
  const destination = join(root, "packaged/mods/platform-examples/stage-debugger")
  await mkdir(community, { recursive: true })
  mirrorRequiredDirectorySync(checkedSource, destination)
  // Exercise the original verifier and normal packaging layout, not normalized test hashes.
  await expect(verifyCommunityExample(community, "stage-debugger")).resolves.toBe(destination)
  await expect(verifyCommunityExample(community, "stage-debugger", checkedSource))
    .resolves.toBe(checkedSource)
})
