import { afterEach, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotHostLock } from "./host-lock"
import { BotSharedWorkspace } from "./shared-workspace"
import {
  executeBotWorkspaceMaintenance as execute,
  listBotWorkspaceCheckpoints as list
} from "./workspace-maintenance"
import type { BotWorkspaceCheckpoint } from "../../shared/bot-workspace-maintenance"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-workspace-maintenance-")))
  roots.push(root)
  const workspace = await BotSharedWorkspace.open(root),
    value = join(workspace.path, "notes.md")
  await mkdir(join(workspace.path, "empty"))
  await writeFile(value, "work-before")
  await writeFile(join(root, "project.txt"), "external-project-content")
  const store = new BotStore(join(root, "bots.sqlite"), undefined, undefined, workspace.path)
  const bot = store.createBot({ nonce: "create", name: "Workspace maintenance" })
  const run = store.send({ nonce: "send", conversationId: bot.conversationId, text: "queued work" })
    .runIds[0]
  store.close()
  return { root, workspace, value, bot, run }
}
const selection = (value: BotWorkspaceCheckpoint) => ({ id: value.id, sha256: value.sha256 })
async function create(root: string) {
  return (await execute(root, { action: "create", nonce: randomUUID() })).checkpoint!
}

it("restores managed files, retains displaced files, preserves task records and reconciles lost replies", async () => {
  const { root, workspace, value, run } = await fixture()
  const checkpoint = await create(root)
  expect(checkpoint.files).toBe(1)
  await writeFile(value, "work-after")
  const request = {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: selection(checkpoint)
  } as const
  const result = await execute(root, request)
  expect(await readFile(value, "utf8")).toBe("work-before")
  const reopened = await BotSharedWorkspace.open(root)
  expect(reopened.path).toBe(workspace.path)
  expect(reopened.reference.identity).not.toEqual(workspace.reference.identity)
  expect(() => workspace.assertCurrent()).toThrow("替换")
  expect(
    await readFile(
      join(dirname(value), "../", `recovery-${result.recoveryCopy}`, "old/notes.md"),
      "utf8"
    )
  ).toBe("work-after")
  expect(
    await readFile(
      join(
        root,
        "workspace-maintenance/checkpoints",
        result.safetyCheckpoint!.id,
        "files/notes.md"
      ),
      "utf8"
    )
  ).toBe("work-after")
  expect(await readFile(join(root, "project.txt"), "utf8")).toBe("external-project-content")
  const store = new BotStore(join(root, "bots.sqlite"))
  try {
    expect(store.getRun(run).status).toBe("queued")
    expect(
      store.db.exec("SELECT * FROM bot_events WHERE kind='workspace.files_replaced'")[0].values
    ).toHaveLength(1)
  } finally {
    store.close()
  }
  await writeFile(value, "activity-after-restore")
  expect(await execute(root, request)).toEqual(result)
  expect(await readFile(value, "utf8")).toBe("activity-after-restore")
  expect(await list(root)).toHaveLength(2)
  await expect(execute(root, { action: "reset", nonce: request.nonce })).rejects.toThrow("标识")
})

it("holds the Host lock through replacement and can restore a reset's safety checkpoint", async () => {
  const { root, value } = await fixture()
  const result = await execute(root, { action: "reset", nonce: randomUUID() }, () => {
    const competing = BotHostLock.acquire(root)
    competing?.release()
    expect(competing).toBeNull()
  })
  await expect(readFile(value)).rejects.toMatchObject({ code: "ENOENT" })
  expect(result.safetyCheckpoint?.reason).toBe("before-reset")
  await execute(root, {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: selection(result.safetyCheckpoint!)
  })
  expect(await readFile(value, "utf8")).toBe("work-before")
})

it.each(["journal", "old", "next", "identity", "database", "receipt", "retained"])(
  "recovers interruption after %s with one event and the displaced directory intact",
  async (step) => {
    const { root, value, workspace } = await fixture()
    const checkpoint = await create(root)
    await writeFile(value, "latest-before-crash")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: selection(checkpoint)
    } as const
    await expect(
      execute(root, request, (at) => {
        if (at === step) throw new Error("power-loss")
      })
    ).rejects.toThrow("power-loss")
    const result = await execute(root, request)
    expect(await readFile(value, "utf8")).toBe("work-before")
    expect(
      await readFile(
        join(dirname(workspace.path), `recovery-${result.recoveryCopy}`, "old/notes.md"),
        "utf8"
      )
    ).toBe("latest-before-crash")
    expect(await list(root)).toHaveLength(2)
    expect(() => workspace.assertCurrent()).toThrow()
    ;(await BotSharedWorkspace.open(root)).assertCurrent()
    const store = new BotStore(join(root, "bots.sqlite"))
    try {
      expect(
        store.db.exec("SELECT * FROM bot_events WHERE kind='workspace.files_replaced'")[0].values
      ).toHaveLength(1)
    } finally {
      store.close()
    }
    await expect(readFile(join(root, "workspace-maintenance/pending.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  }
)

it("allows explicit recovery of a missing workspace, without silently recreating it on startup", async () => {
  const { root, value, workspace } = await fixture()
  const checkpoint = await create(root)
  await rename(workspace.path, join(dirname(workspace.path), "lost"))
  await expect(BotSharedWorkspace.open(root)).rejects.toThrow("丢失")
  const result = await execute(root, {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: selection(checkpoint)
  })
  expect(result.safetyCheckpoint).toBeUndefined()
  expect(result.recoveryCopy).toBeUndefined()
  expect(await readFile(value, "utf8")).toBe("work-before")
  ;(await BotSharedWorkspace.open(root)).assertCurrent()
})

it("rejects corrupt checkpoint bytes and changed selections before changing current files", async () => {
  const { root, value } = await fixture()
  const checkpoint = await create(root)
  const input = { action: "restore", nonce: randomUUID(), checkpoint: selection(checkpoint) }
  await writeFile(value, "current-work")
  await writeFile(
    join(root, "workspace-maintenance/checkpoints", checkpoint.id, "files/notes.md"),
    "corrupt"
  )
  await expect(execute(root, input)).rejects.toThrow("发生变化")
  await expect(
    execute(root, { ...input, checkpoint: { ...input.checkpoint, sha256: "0".repeat(64) } })
  ).rejects.toThrow("已变化")
  expect(await readFile(value, "utf8")).toBe("current-work")
  expect(await list(root)).toHaveLength(1)
})

it("refuses live ownership, path injection and linked work files", async () => {
  const { root, workspace, value } = await fixture()
  const input = { action: "reset", nonce: randomUUID() }
  const lock = BotHostLock.acquire(root)!
  try {
    await expect(execute(root, input)).rejects.toThrow("仍在运行")
  } finally {
    lock.release()
  }
  await expect(execute(root, { ...input, path: root })).rejects.toThrow()
  await expect(
    execute(root, {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: "../outside", sha256: "0".repeat(64) }
    })
  ).rejects.toThrow()
  await symlink(join(root, "project.txt"), join(workspace.path, "linked"))
  await expect(execute(root, input)).rejects.toThrow("链接")
  expect(await readFile(value, "utf8")).toBe("work-before")
  expect(await readFile(join(root, "project.txt"), "utf8")).toBe("external-project-content")
})

it("does not resurrect a deleted checkpoint when a create reply was lost", async () => {
  const { root } = await fixture()
  const request = { action: "create", nonce: randomUUID() } as const
  const first = await execute(root, request)
  expect(await execute(root, request)).toEqual(first)
  const deletion = { action: "delete", checkpoint: selection(first.checkpoint!) } as const
  await execute(root, deletion)
  await execute(root, deletion)
  await expect(execute(root, request)).rejects.toThrow("已删除")
  expect(await list(root)).toEqual([])
})

it("rejects changed staging or owner metadata before moving the current workspace", async () => {
  const { root, value, workspace } = await fixture()
  const checkpoint = await create(root)
  await writeFile(value, "current-work")
  const input = { action: "restore", nonce: randomUUID(), checkpoint: selection(checkpoint) }
  await expect(
    execute(root, input, (step) => {
      if (step === "journal") throw new Error("interrupted")
    })
  ).rejects.toThrow("interrupted")
  const journal = JSON.parse(
    await readFile(join(root, "workspace-maintenance/pending.json"), "utf8")
  )
  const metadata = join(root, "workspace.private.json"),
    originalMetadata = await readFile(metadata)
  const changed = JSON.parse(originalMetadata.toString())
  changed.identity.ino = "0"
  await writeFile(metadata, JSON.stringify(changed))
  await expect(execute(root, input)).rejects.toThrow("恢复日志")
  expect(await readFile(value, "utf8")).toBe("current-work")
  await writeFile(metadata, originalMetadata)
  await writeFile(
    join(dirname(workspace.path), `.restore-${journal.stage}`, "next/notes.md"),
    "corrupt-staging"
  )
  await expect(execute(root, input)).rejects.toThrow("发生变化")
  expect(await readFile(value, "utf8")).toBe("current-work")
})

it("rejects linked databases before replacing work files", async () => {
  const { root, value } = await fixture()
  const source = join(root, "unrelated.sqlite"),
    database = join(root, "bots.sqlite")
  await rename(database, source)
  await link(source, database)
  const original = await readFile(source)
  await expect(execute(root, { action: "reset", nonce: randomUUID() })).rejects.toThrow(
    "数据库不能是链接"
  )
  expect((await readFile(source)).equals(original)).toBe(true)
  expect(await readFile(value, "utf8")).toBe("work-before")
})

it("cleans unpublished copies on startup but never deletes a displaced original without a journal", async () => {
  const { root, workspace } = await fixture()
  const parent = dirname(workspace.path),
    unused = join(parent, `.restore-${randomUUID()}`),
    saved = join(parent, `.restore-${randomUUID()}`)
  await mkdir(join(unused, "next"), { recursive: true })
  await writeFile(join(unused, "next", "partial"), "not-published")
  await mkdir(join(saved, "old"), { recursive: true })
  await writeFile(join(saved, "old", "important"), "keep-me")
  const { recoverBotWorkspaceMaintenance } = await import("./workspace-maintenance")
  await recoverBotWorkspaceMaintenance(root)
  await expect(readFile(join(unused, "next", "partial"))).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(join(saved, "old", "important"), "utf8")).toBe("keep-me")
  workspace.assertCurrent()
})

it("rejects a checkpoint copied from another Host before replacing the current workspace", async () => {
  const { cp } = await import("node:fs/promises")
  const first = await fixture(),
    second = await fixture()
  const checkpoint = await create(first.root)
  await mkdir(join(second.root, "workspace-maintenance/checkpoints"), { recursive: true })
  await cp(
    join(first.root, "workspace-maintenance/checkpoints", checkpoint.id),
    join(second.root, "workspace-maintenance/checkpoints", checkpoint.id),
    { recursive: true }
  )
  await expect(
    execute(second.root, {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: selection(checkpoint)
    })
  ).rejects.toThrow("不属于")
  expect(await readFile(second.value, "utf8")).toBe("work-before")
  second.workspace.assertCurrent()
})
