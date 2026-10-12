import { afterEach, expect, it, vi } from "vitest"
import { avatarImage } from "./image-fixtures"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BotStore } from "./store"
import { BotDocumentReader } from "./document-reader"
import { prepareBotAvatar } from "./avatar-image"
import { BOT_SCHEMA_VERSION } from "./schema"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
const signal = () => new AbortController().signal
const reader = { avatar: async (base64: string) => prepareBotAvatar(base64) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-avatar-"))
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const owner = store.createBot({
    nonce: "owner",
    name: "Owner",
    avatarShape: "cloud",
    avatarColor: "violet"
  })
  return { root, path, store, owner }
}
it("normalizes pictures, keeps bytes out of workspace snapshots, clones independently and replays a lost save without undoing later changes", async () => {
  const { store, owner } = fixture()
  const input = {
    nonce: "picture",
    botId: owner.bot.id,
    revision: 1,
    pngBase64: await avatarImage()
  }
  const changed = await store.avatars.change(input, signal(), reader)
  expect(changed).toMatchObject({ revision: 2, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(store.getBot(owner.bot.id).avatarHash).toBe(changed.hash)
  const address = { botId: owner.bot.id, hash: changed.hash! }
  expect(await prepareBotAvatar(store.avatars.read(address))).toBe(store.avatars.read(address))
  expect(JSON.stringify(store.snapshot())).not.toContain(input.pngBase64)
  expect(JSON.stringify(store.events(0))).not.toContain(input.pngBase64)
  expect(JSON.stringify(store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    input.pngBase64
  )
  const clone = store.cloneBot({ nonce: "clone", id: owner.bot.id, revision: 2 })
  expect(clone.bot.avatarHash).toBe(changed.hash)
  expect(store.avatars.read({ botId: clone.bot.id, hash: changed.hash! })).toBe(
    store.avatars.read(address)
  )
  const cleared = await store.avatars.change(
    { ...input, nonce: "clear", revision: 2, pngBase64: null },
    signal(),
    reader
  )
  expect(cleared).toMatchObject({ revision: 3, hash: null })
  const unused = {
    avatar: vi.fn(() => {
      throw new Error("decoder offline")
    })
  }
  expect(await store.avatars.change(input, signal(), unused)).toEqual(changed)
  expect(unused.avatar).not.toHaveBeenCalled()
  expect(store.getBot(owner.bot.id)).toMatchObject({
    avatarHash: null,
    avatarShape: "cloud",
    avatarColor: "violet",
    revision: 3
  })
  expect(store.avatars.read(address)).toBeNull()
  expect(store.avatars.read({ ...address, botId: clone.bot.id })).toBeTruthy()
  await expect(
    store.avatars.change({ ...input, botId: clone.bot.id }, signal(), reader)
  ).rejects.toMatchObject({ code: "nonce_conflict" })
})
it("rejects invalid pictures, stale concurrent edits, foreign fields, deleted Bots and canceled decoding without changing profile state", async () => {
  const { store, owner } = fixture()
  const input = {
    nonce: "picture",
    botId: owner.bot.id,
    revision: 1,
    pngBase64: await avatarImage()
  }
  await expect(
    store.avatars.change({ ...input, filePath: "/private/picture" }, signal(), reader)
  ).rejects.toMatchObject({ code: "invalid_input" })
  await expect(
    store.avatars.change({ ...input, pngBase64: await avatarImage("red", 512) }, signal(), reader)
  ).rejects.toMatchObject({ code: "avatar_invalid" })
  await expect(
    store.avatars.change(
      { ...input, pngBase64: Buffer.from("<svg/>").toString("base64") },
      signal(),
      reader
    )
  ).rejects.toMatchObject({ code: "avatar_invalid" })
  await expect(
    store.avatars.change({ ...input, pngBase64: input.pngBase64.slice(0, 48) }, signal(), reader)
  ).rejects.toMatchObject({ code: "avatar_invalid" })
  const canceled = new AbortController()
  await expect(
    store.avatars.change(input, canceled.signal, {
      avatar: async () => {
        canceled.abort(new Error("closed"))
        return input.pngBase64
      }
    })
  ).rejects.toThrow("closed")
  await expect(
    store.avatars.change(input, signal(), {
      avatar: async () => {
        store.updateBot({ id: owner.bot.id, revision: 1, name: "Changed while decoding" })
        return input.pngBase64
      }
    })
  ).rejects.toMatchObject({ code: "revision_conflict" })
  expect(store.getBot(owner.bot.id)).toMatchObject({ revision: 2, avatarHash: null })
  expect(store.db.exec("SELECT * FROM bot_avatar_images")[0].values).toEqual([])
  store.deleteBot(owner.bot.id, 2)
  expect(() => store.avatars.read({ botId: owner.bot.id, hash: "a".repeat(64) })).toThrow(
    /不存在|删除/
  )
})
it("preserves image identity and receipts across reopening and upgrades a v27 database with a backup", async () => {
  const { store, owner, path, root } = fixture()
  const input = {
    nonce: "picture",
    botId: owner.bot.id,
    revision: 1,
    pngBase64: await avatarImage()
  }
  const saved = await store.avatars.change(input, signal(), reader)
  store.close()
  const next = new BotStore(path)
  expect(next.avatars.read({ botId: owner.bot.id, hash: saved.hash! })).toBeTruthy()
  expect(await next.avatars.change(input, signal(), reader)).toEqual(saved)
  next.db.run("DROP TABLE bot_avatar_images")
  next.db.run("UPDATE bot_schema SET version=27")
  next.close()
  const upgraded = new BotStore(path)
  try {
    expect(upgraded.getBot(owner.bot.id)).toMatchObject({ name: "Owner", avatarHash: null })
    expect(upgraded.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
      BOT_SCHEMA_VERSION
    )
    expect(upgraded.db.exec("PRAGMA foreign_key_check")[0].values).toEqual([])
    expect(readdirSync(join(root, "backups")).some((name) => name.startsWith("bots-v27-"))).toBe(
      true
    )
  } finally {
    upgraded.close()
  }
})
it("uses the isolated media worker for real decoding and rejects malformed data", async () => {
  const worker = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const png = await avatarImage()
  expect(await worker.avatar(png, signal())).toBe(await prepareBotAvatar(png))
  await expect(worker.avatar(png.slice(0, 48), signal())).rejects.toThrow()
}, 15_000)
