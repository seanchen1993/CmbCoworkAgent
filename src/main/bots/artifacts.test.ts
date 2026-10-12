import { afterEach, expect, it } from "vitest"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-bot-files-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const { conversationId } = store.createBot({ nonce: "create", name: "文件助手" })
  return { directory, store, files: new BotArtifacts(directory, store), conversationId }
}

it("reclaims only unreferenced regular objects and preserves concurrent publication and unrelated paths", async () => {
  const f = await fixture()
  const other = f.store.createBot({ nonce: "other", name: "Other Bot" })
  const shared = Buffer.from("shared published content")
  for (const [id, conversationId] of [
    ["first", f.conversationId],
    ["second", other.conversationId]
  ])
    await f.files.publish(
      { id, conversationId, runId: null, name: "shared.txt", mime: "text/plain" },
      shared
    )
  await f.files.close()
  const orphan = Buffer.from("uncommitted content"),
    orphanHash = createHash("sha256").update(orphan).digest("hex"),
    published = Buffer.from("reissued publication"),
    publishedHash = createHash("sha256").update(published).digest("hex")
  await writeFile(join(f.directory, orphanHash), orphan)
  await writeFile(join(f.directory, publishedHash), published)
  await writeFile(join(f.directory, "keep.txt"), "unmanaged file")
  await mkdir(join(f.directory, "0".repeat(64)))
  await writeFile(join(f.directory, "0".repeat(64), "keep.txt"), "nested file")
  if (process.platform !== "win32")
    await symlink(join(f.directory, "keep.txt"), join(f.directory, "1".repeat(64)))

  const reopened = new BotArtifacts(f.directory, f.store)
  cleanup.push(() => reopened.close())
  const [, artifact] = await Promise.all([
    reopened.recover(),
    reopened.publish(
      {
        id: "new",
        conversationId: f.conversationId,
        runId: null,
        name: "new.txt",
        mime: "text/plain"
      },
      published
    )
  ])
  await reopened.collectDeleted()
  await expect(access(join(f.directory, orphanHash))).rejects.toMatchObject({ code: "ENOENT" })
  expect((await reopened.read(artifact.id)).bytes).toEqual(published)
  expect((await reopened.read("first")).bytes).toEqual(shared)
  expect((await reopened.read("second")).bytes).toEqual(shared)
  expect(await readFile(join(f.directory, "keep.txt"), "utf8")).toBe("unmanaged file")
  expect(await readFile(join(f.directory, "0".repeat(64), "keep.txt"), "utf8")).toBe("nested file")
  if (process.platform !== "win32")
    expect(await readFile(join(f.directory, "1".repeat(64)), "utf8")).toBe("unmanaged file")
})
it("publishes verified bytes once and binds attachments to the accepted message", async () => {
  const f = await fixture(),
    input = {
      nonce: "file-1",
      conversationId: f.conversationId,
      name: "说明.md",
      mime: "text/markdown",
      base64: Buffer.from("# 中文结果").toString("base64")
    }
  const artifact = await f.files.upload(input)
  expect(await f.files.upload(input)).toEqual(artifact)
  expect((await f.files.read(artifact.id)).bytes.toString()).toBe("# 中文结果")
  f.store.send({
    nonce: "send",
    conversationId: f.conversationId,
    text: "阅读附件",
    attachments: [artifact.id]
  })
  expect(f.store.messages(f.conversationId)[0].attachments).toEqual([artifact.id])
  const other = f.store.createBot({ nonce: "other", name: "其他" })
  expect(() =>
    f.store.send({
      nonce: "invalid",
      conversationId: other.conversationId,
      text: "test",
      attachments: [artifact.id]
    })
  ).toThrow("不属于当前对话")
  await expect(
    f.files.upload({ ...input, base64: Buffer.from("changed").toString("base64") })
  ).rejects.toThrow("不同内容")
})
it("rejects unsafe names, invalid encoding, oversized bytes and corrupted objects", async () => {
  const f = await fixture(),
    input = {
      nonce: "file",
      conversationId: f.conversationId,
      name: "note.txt",
      mime: "text/plain",
      base64: "dGVzdA=="
    }
  for (const name of ["../secret", "C:\\secret", "con.txt", "note:stream", ".env"])
    await expect(f.files.upload({ ...input, name })).rejects.toThrow("文件名")
  await expect(f.files.upload({ ...input, base64: "????" })).rejects.toThrow("编码")
  await expect(
    f.files.publish(
      {
        id: "big",
        conversationId: f.conversationId,
        runId: null,
        name: "big.txt",
        mime: "text/plain"
      },
      Buffer.alloc(25 * 1024 * 1024 + 1)
    )
  ).rejects.toThrow("25 MiB")
  const artifact = await f.files.upload(input)
  await writeFile(join(f.directory, artifact.sha256), "oops")
  await expect(f.files.read(artifact.id)).rejects.toThrow("完整性")
})

it("deletes only the selected reference, retains shared bytes, and rejects replay resurrection", async () => {
  const f = await fixture()
  const other = f.store.createBot({ nonce: "shared-owner", name: "其他 Bot" })
  const bytes = Buffer.from("shared immutable contents")
  const first = await f.files.publish(
    {
      id: "first",
      conversationId: f.conversationId,
      runId: null,
      name: "one.txt",
      mime: "text/plain",
      origin: "browser"
    },
    bytes
  )
  const second = await f.files.publish(
    {
      id: "second",
      conversationId: other.conversationId,
      runId: null,
      name: "two.txt",
      mime: "text/plain",
      origin: "project"
    },
    bytes
  )
  expect(first.origin).toBe("browser")
  const deletion = {
    nonce: "delete-first",
    conversationId: f.conversationId,
    id: first.id,
    sha256: first.sha256
  }
  const receipt = await f.files.remove(deletion)
  expect(await f.files.remove(deletion)).toEqual(receipt)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  await expect(f.files.read(first.id)).rejects.toThrow("已删除")
  await expect(
    f.files.transfers.begin({
      nonce: first.id,
      conversationId: f.conversationId,
      name: first.name,
      mime: first.mime,
      sha256: first.sha256,
      size: first.size
    })
  ).rejects.toThrow("已删除")
  expect((await f.files.read(second.id)).bytes).toEqual(bytes)
  await expect(f.files.publish({ ...first }, bytes)).rejects.toThrow("已删除")
  await f.files.remove({
    nonce: "delete-second",
    conversationId: other.conversationId,
    id: second.id,
    sha256: second.sha256
  })
  expect(f.store.artifactGarbage()).toEqual([])
  const { access } = await import("node:fs/promises")
  await expect(access(join(f.directory, first.sha256))).rejects.toMatchObject({ code: "ENOENT" })
  // A genuinely new upload may reuse identical bytes; the deleted IDs stay tombstoned.
  const replacement = await f.files.publish(
    {
      id: "replacement",
      conversationId: other.conversationId,
      runId: null,
      name: "again.txt",
      mime: "text/plain"
    },
    bytes
  )
  await f.files.collectDeleted()
  expect((await f.files.read(replacement.id)).bytes).toEqual(bytes)
  await expect(f.files.read(first.id)).rejects.toThrow("已删除")
})

it("rejects wrong scopes, forged content identities and unfinished task deletion without changing the file", async () => {
  const f = await fixture()
  const artifact = await f.files.upload({
    nonce: "file",
    conversationId: f.conversationId,
    name: "task.txt",
    mime: "text/plain",
    base64: Buffer.from("evidence").toString("base64")
  })
  const other = f.store.createBot({ nonce: "other", name: "other" })
  const input = {
    nonce: "delete",
    conversationId: f.conversationId,
    id: artifact.id,
    sha256: artifact.sha256
  }
  await expect(f.files.remove({ ...input, conversationId: other.conversationId })).rejects.toThrow(
    "不属于"
  )
  await expect(f.files.remove({ ...input, sha256: "0".repeat(64) })).rejects.toThrow("身份")
  await expect(f.files.remove({ ...input, path: "../other" })).rejects.toThrow()
  const task = f.store.send({
    nonce: "task",
    conversationId: f.conversationId,
    text: "read",
    attachments: [artifact.id]
  })
  await expect(f.files.remove(input)).rejects.toThrow("未结束")
  const { lease } = f.store.claim("host")!
  f.store.fenceOwner(lease.owner, "interrupted")
  await expect(f.files.remove(input)).rejects.toThrow("待核对")
  const run = f.store.getRun(task.runIds[0])
  f.store.recover({
    id: run.id,
    revision: run.revision,
    decision: "cancel",
    note: "没有外部操作",
    effects: []
  })
  await f.files.remove(input)
  expect(f.store.messages(f.conversationId)[0].attachments).toEqual([artifact.id])
  expect(() =>
    f.store.send({
      nonce: "reuse",
      conversationId: f.conversationId,
      text: "read deleted",
      attachments: [artifact.id]
    })
  ).toThrow("已删除")
})

it("reclaims a tombstoned object after reopening and preserves a simultaneous new reference", async () => {
  const f = await fixture()
  const bytes = Buffer.from("same hash in a different upload")
  const old = await f.files.publish(
    {
      id: "old",
      conversationId: f.conversationId,
      runId: null,
      name: "old.txt",
      mime: "text/plain"
    },
    bytes
  )
  f.store.deleteArtifact({
    nonce: "interrupted-delete",
    conversationId: f.conversationId,
    id: old.id,
    sha256: old.sha256
  })
  const reopened = new BotArtifacts(f.directory, f.store)
  cleanup.push(() => reopened.close())
  await reopened.recover()
  const { access } = await import("node:fs/promises")
  await expect(access(join(f.directory, old.sha256))).rejects.toMatchObject({ code: "ENOENT" })
  const current = await reopened.publish(
    {
      id: "new",
      conversationId: f.conversationId,
      runId: null,
      name: "new.txt",
      mime: "text/plain"
    },
    bytes
  )
  const [replacement] = await Promise.all([
    reopened.publish(
      {
        id: "concurrent",
        conversationId: f.conversationId,
        runId: null,
        name: "concurrent.txt",
        mime: "text/plain"
      },
      bytes
    ),
    reopened.remove({
      nonce: "concurrent-delete",
      conversationId: f.conversationId,
      id: current.id,
      sha256: current.sha256
    })
  ])
  expect((await reopened.read(replacement.id)).bytes).toEqual(bytes)
  await expect(reopened.read(current.id)).rejects.toThrow("已删除")
})
