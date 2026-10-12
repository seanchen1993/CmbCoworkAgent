import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { botGlobalInstructions } from "./global-instructions"
import { botProjectContext } from "./project-tools"
import { DEFAULT_AGENTS_MAX_BYTES } from "../agent/agents-md"

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-instructions-"))
  directories.push(root)
  const agentsHome = join(root, "settings")
  await mkdir(agentsHome)
  return { root, agentsHome }
}
function version(prompt: string) {
  const value = /Instruction version: ([a-f0-9]{64})/.exec(prompt)?.[1]
  expect(value).toBeDefined()
  return value!
}

it("requires an explicit Host source and does not inherit its ambient home", async () => {
  const { agentsHome } = await fixture()
  vi.stubEnv("CMB_COWORK_AGENT_HOME", agentsHome)
  await writeFile(join(agentsHome, "AGENTS.md"), "NOT_AN_EXPLICIT_SOURCE")
  expect(await botGlobalInstructions(undefined, () => {})).toBeUndefined()
  await expect(
    botGlobalInstructions({ agentsHome: "relative/settings" }, () => {})
  ).rejects.toThrow("绝对路径")
})

it("reuses global override precedence without exposing or granting the Host path", async () => {
  const source = await fixture()
  await writeFile(join(source.agentsHome, "AGENTS.md"), "NORMAL_RULE")
  await writeFile(join(source.agentsHome, "AGENTS.override.md"), "OVERRIDE_RULE")
  const loaded = (await botGlobalInstructions(source, () => {}))!
  expect(loaded.prompt).toContain("OVERRIDE_RULE")
  expect(loaded.prompt).not.toContain("NORMAL_RULE")
  expect(loaded.prompt).not.toContain(source.root)
  expect(loaded.prompt).toContain("do not grant tool access")
  expect(JSON.parse(await loaded.tool.invoke({ version: version(loaded.prompt) }))).toMatchObject({
    name: "AGENTS.override.md",
    text: "OVERRIDE_RULE",
    nextOffset: null
  })
})

it("treats a missing or empty global instruction document as no additional context", async () => {
  const source = await fixture()
  expect(await botGlobalInstructions(source, () => {})).toBeUndefined()
  await writeFile(join(source.agentsHome, "AGENTS.md"), "  \n")
  expect(await botGlobalInstructions(source, () => {})).toBeUndefined()
})

it.skipIf(process.platform === "win32")(
  "does not follow a global symlink and falls back to the normal file",
  async () => {
    const source = await fixture()
    await writeFile(join(source.root, "secret"), "HOST_SECRET")
    await writeFile(join(source.agentsHome, "AGENTS.md"), "SAFE_RULE")
    await symlink(join(source.root, "secret"), join(source.agentsHome, "AGENTS.override.md"))
    const loaded = (await botGlobalInstructions(source, () => {}))!
    expect(loaded.prompt).toContain("SAFE_RULE")
    expect(loaded.prompt).not.toContain("HOST_SECRET")
  }
)

it("does not inject a hard-linked private file", async () => {
  const source = await fixture()
  await writeFile(join(source.root, "secret"), "HOST_SECRET")
  await link(join(source.root, "secret"), join(source.agentsHome, "AGENTS.md"))
  expect(await botGlobalInstructions(source, () => {})).toBeUndefined()
})

it("pages one bounded version without splitting Unicode or rereading changed disk content", async () => {
  const source = await fixture()
  const text = "a".repeat(2047) + "😀中文尾部".repeat(1000)
  const path = join(source.agentsHome, "AGENTS.md")
  await writeFile(path, text)
  const loaded = (await botGlobalInstructions(source, () => {}))!
  const acceptedVersion = version(loaded.prompt)
  expect(loaded.prompt).toContain("offset 2049")
  expect(loaded.prompt).not.toContain("\uFFFD")
  await writeFile(path, "NEW_RULE")
  const page = JSON.parse(
    await loaded.tool.invoke({ version: acceptedVersion, offset: 2047, limit: 1 })
  )
  expect(page).toMatchObject({
    text: "😀",
    offset: 2047,
    nextOffset: 2049,
    totalCharacters: text.length
  })
  await expect(loaded.tool.invoke({ version: acceptedVersion, offset: 2048 })).rejects.toThrow(
    "读取位置"
  )
  await expect(loaded.tool.invoke({ version: "f".repeat(64), offset: 0 })).rejects.toThrow("版本")
  let offset = 2049
  let tail = ""
  while (offset < text.length) {
    const current = JSON.parse(
      await loaded.tool.invoke({ version: acceptedVersion, offset, limit: 137 })
    )
    tail += current.text
    offset = current.nextOffset ?? text.length
  }
  expect(tail).toBe(text.slice(2049))
  const next = (await botGlobalInstructions(source, () => {}))!
  expect(next.prompt).toContain("NEW_RULE")
  expect(version(next.prompt)).not.toBe(acceptedVersion)
})

it("keeps global and authorized-project instruction prompts inside the common byte budget", async () => {
  const source = await fixture()
  const project = join(source.root, "project")
  await mkdir(project)
  await writeFile(join(source.agentsHome, "AGENTS.md"), "全局规则".repeat(2000))
  await writeFile(join(source.root, "AGENTS.md"), "PARENT_PRIVATE_RULE")
  await writeFile(join(project, "AGENTS.md"), "项目规则".repeat(10000))
  const loaded = (await botGlobalInstructions(source, () => {}))!
  const local = await botProjectContext(
    project,
    [],
    DEFAULT_AGENTS_MAX_BYTES - Buffer.byteLength(loaded.prompt) - 2
  )
  expect(Buffer.byteLength(loaded.prompt + "\n\n" + local)).toBeLessThanOrEqual(
    DEFAULT_AGENTS_MAX_BYTES
  )
  expect(local).toContain("项目规则")
  expect(local).not.toContain("PARENT_PRIVATE_RULE")
})

it("stops before model execution when the full rules exceed the bounded read", async () => {
  const source = await fixture()
  await writeFile(join(source.agentsHome, "AGENTS.md"), "x".repeat(1024 * 1024 + 1))
  await expect(botGlobalInstructions(source, () => {})).rejects.toThrow("超过 1 MiB")
})

it("rechecks execution authority before returning a page", async () => {
  const source = await fixture()
  await writeFile(join(source.agentsHome, "AGENTS.md"), "PRIVATE_RULE")
  const controller = new AbortController()
  const check = () => controller.signal.throwIfAborted()
  const loaded = (await botGlobalInstructions(source, check))!
  controller.abort(new Error("task revoked"))
  await expect(loaded.tool.invoke({ version: version(loaded.prompt) })).rejects.toThrow(
    "task revoked"
  )
})
