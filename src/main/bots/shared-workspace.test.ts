import { randomUUID } from "node:crypto"
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { join, relative } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { BotSharedWorkspace } from "./shared-workspace"
import { BotStore } from "./store"
import { BotProjectFiles } from "./project-files"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "cmb-shared-workspace-")),
    root = join(await realpath(base), "host")
  roots.push(base)
  await mkdir(root)
  return { base, root }
}

it("keeps shared files across Host restarts and assigns the managed default to new and existing unbound Bots", async () => {
  const { base, root } = await fixture(),
    database = join(root, "bots.sqlite")
  const legacy = new BotStore(database)
  const old = legacy.createBot({ nonce: "legacy", name: "Old" }).bot
  legacy.close()
  const workspace = await BotSharedWorkspace.open(root)
  expect(relative(root, workspace.path)).toMatch(/^\.\./)
  const store = new BotStore(database, undefined, undefined, workspace.path)
  try {
    const first = store.createBot({ nonce: "one", name: "One" }).bot
    expect(first.workspacePath).toBe(workspace.path)
    expect(store.getBot(old.id).workspacePath).toBe(workspace.path)
    expect(store.createBot({ nonce: "legacy", name: "Old" }).bot.id).toBe(old.id)
    const customPath = join(base, "project")
    await mkdir(customPath)
    const custom = store.createBot({
      nonce: "custom",
      name: "Custom",
      workspacePath: customPath
    }).bot
    expect(custom.workspacePath).toBe(customPath)
    expect(
      store.updateBot({ id: custom.id, revision: custom.revision, workspacePath: null })
        .workspacePath
    ).toBe(workspace.path)
    expect((await createBotAPI(new BotHost(store)).status()).sharedWorkspace).toBe(workspace.path)
    await writeFile(join(workspace.path, "notes.md"), "persistent shared work")
    expect((await BotSharedWorkspace.open(root)).path).toBe(workspace.path)
    expect(await readFile(join(workspace.path, "notes.md"), "utf8")).toBe("persistent shared work")
    expect(
      store.cloneBot({ nonce: "clone", id: first.id, revision: first.revision }).bot.workspacePath
    ).toBe(workspace.path)
  } finally {
    store.close()
  }
})

it("keeps the original project locking, optimistic conflict and private-file boundaries for two Bots", async () => {
  const { root } = await fixture(),
    workspace = await BotSharedWorkspace.open(root)
  const a = await BotProjectFiles.open(workspace.path, [root]),
    b = await BotProjectFiles.open(workspace.path, [root])
  const create = await a.prepare({ path: "notes.md", expectedHash: null, content: "initial" })
  await a.commit(create, () => workspace.assertCurrent())
  const original = await b.read("notes.md")
  const changes = await Promise.all([
    a.prepare({ path: "notes.md", expectedHash: original.sha256, content: "Bot A" }),
    b.prepare({ path: "notes.md", expectedHash: original.sha256, content: "Bot B" })
  ])
  const results = await Promise.allSettled([
    a.commit(changes[0], () => workspace.assertCurrent()),
    b.commit(changes[1], () => workspace.assertCurrent())
  ])
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
  await writeFile(join(root, "models.private"), "PRIVATE_FIXTURE")
  await symlink(
    root,
    join(workspace.path, "private"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await expect(a.read("private/models.private")).rejects.toThrow()
  await expect(a.read("../../host/models.private")).rejects.toThrow()
})

it.each(["missing", "replacement", "symlink"])(
  "refuses a %s workspace at runtime and on restart without creating an empty replacement",
  async (mode) => {
    const { root, base } = await fixture(),
      workspace = await BotSharedWorkspace.open(root)
    await writeFile(join(workspace.path, "notes.md"), "keep me")
    const retained = join(base, "retained")
    await rename(workspace.path, retained)
    if (mode === "replacement") await mkdir(workspace.path)
    if (mode === "symlink")
      await symlink(retained, workspace.path, process.platform === "win32" ? "junction" : "dir")
    expect(() => workspace.assertCurrent()).toThrow("被替换")
    await expect(BotSharedWorkspace.open(root)).rejects.toThrow("被替换")
    expect(await readFile(join(retained, "notes.md"), "utf8")).toBe("keep me")
  }
)

it.each(["before-mkdir", "after-mkdir", "occupied"])(
  "recovers initial creation at %s without adopting existing user files",
  async (mode) => {
    const { root } = await fixture(),
      id = randomUUID(),
      path = join(`${root}.workspace`, id)
    await writeFile(
      join(root, "workspace.private.json"),
      JSON.stringify({ version: 1, state: "preparing", id })
    )
    if (mode !== "before-mkdir") await mkdir(path, { recursive: true })
    if (mode === "occupied") {
      await writeFile(join(path, "unowned.txt"), "preserve")
      await expect(BotSharedWorkspace.open(root)).rejects.toThrow()
      expect(await readFile(join(path, "unowned.txt"), "utf8")).toBe("preserve")
    } else {
      const workspace = await BotSharedWorkspace.open(root)
      expect(workspace.path).toBe(path)
      expect(JSON.parse(await readFile(join(root, "workspace.private.json"), "utf8")).state).toBe(
        "ready"
      )
    }
  }
)

it.each(["linked-record", "invalid-id", "linked-container"])(
  "rejects %s before granting workspace access",
  async (mode) => {
    const { root, base } = await fixture()
    if (mode === "linked-record") {
      const workspace = await BotSharedWorkspace.open(root)
      await link(join(root, "workspace.private.json"), join(base, "manifest-copy"))
      expect(() => workspace.assertCurrent()).not.toThrow()
    } else if (mode === "invalid-id") {
      await writeFile(
        join(root, "workspace.private.json"),
        JSON.stringify({ version: 1, state: "preparing", id: "../../other" })
      )
    } else {
      const other = join(base, "other")
      await mkdir(other)
      await symlink(other, `${root}.workspace`, process.platform === "win32" ? "junction" : "dir")
    }
    await expect(BotSharedWorkspace.open(root)).rejects.toThrow()
  }
)
