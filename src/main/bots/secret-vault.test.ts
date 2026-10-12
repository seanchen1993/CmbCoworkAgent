import { afterEach, expect, it } from "vitest"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotSecretVault, botSecretOrigin, type BotSecretProtection } from "./secret-vault"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bot-secrets-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const { bot } = store.createBot({ nonce: "secret-bot", name: "凭据测试" })
  const key = randomBytes(32)
  // Real authenticated encryption exercises persistence independently of Windows-only DPAPI.
  const protection: BotSecretProtection = {
    async protect(bytes) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce)
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    },
    async unprotect(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()])
    }
  }
  const path = join(directory, "secrets.private")
  const open = (provider: BotSecretProtection | null = protection) => {
    const vault = new BotSecretVault(provider ? path : undefined, store, provider ?? undefined)
    cleanup.push(() => vault.close())
    return vault
  }
  const input = {
    botId: bot.id,
    name: "研发平台",
    description: "登录",
    origin: "https://dev.example.com",
    value: "PRIVATE_VAULT_VALUE_874901"
  }
  return { directory, store, bot, protection, path, open, input }
}

it("persists encrypted credentials, reopens them and returns metadata only", async () => {
  const f = await fixture(),
    vault = f.open(),
    record = await vault.save(f.input)
  expect(JSON.stringify(record)).not.toContain(f.input.value)
  expect(await vault.list(f.bot.id)).toEqual({
    persistent: true,
    protection: "external",
    items: [record]
  })
  expect((await readFile(f.path)).includes(Buffer.from(f.input.value))).toBe(false)
  await vault.close()
  const reopened = f.open()
  expect(await reopened.list(f.bot.id)).toEqual({
    persistent: true,
    protection: "external",
    items: [record]
  })
  expect(
    await reopened.use({ ...record }, async (value, check) => {
      check()
      return value === f.input.value
    })
  ).toBe(true)
  expect((await readdir(f.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  expect(JSON.stringify(f.store.snapshot())).not.toContain(f.input.value)
})

it("uses memory only when secure persistence is unavailable and discards values on close", async () => {
  const f = await fixture(),
    vault = f.open(null)
  await vault.save(f.input)
  expect((await vault.list(f.bot.id)).persistent).toBe(false)
  expect((await readdir(f.directory)).includes("secrets.private")).toBe(false)
  await vault.close()
  await expect(vault.list(f.bot.id)).rejects.toThrow("关闭")
  expect((await f.open(null).list(f.bot.id)).items).toEqual([])
})

it("fences stale replacement, delete and in-flight use after revocation", async () => {
  const f = await fixture(),
    vault = f.open(),
    initial = await vault.save(f.input)
  let checkCurrent!: () => void
  await vault.use(initial, async (_value, check) => {
    checkCurrent = check
  })
  const current = await vault.save({
    ...f.input,
    id: initial.id,
    revision: initial.revision,
    value: "REPLACED"
  })
  expect(current.revision).toBe(2)
  expect(() => checkCurrent()).toThrow("已替换")
  await expect(
    vault.save({ ...f.input, id: initial.id, revision: initial.revision })
  ).rejects.toThrow("已替换")
  await expect(vault.remove(initial)).rejects.toThrow("已替换")
  await expect(vault.use(initial, async () => "unexpected")).rejects.toThrow("已替换")
  await vault.use(current, async (_value, check) => {
    checkCurrent = check
  })
  await vault.remove(current)
  expect(() => checkCurrent()).toThrow("已替换")
  expect((await f.open().list(f.bot.id)).items).toEqual([])
})

it("isolates Bots and exact website origins, including clones", async () => {
  const f = await fixture(),
    vault = f.open(),
    record = await vault.save(f.input)
  const { bot: other } = f.store.createBot({ nonce: "other", name: "其他" })
  await expect(vault.use({ ...record, botId: other.id }, async () => "unexpected")).rejects.toThrow(
    "不属于"
  )
  await expect(vault.remove({ ...record, botId: other.id })).rejects.toThrow("不属于")
  for (const origin of [
    "https://sub.dev.example.com",
    "http://dev.example.com",
    "https://dev.example.com:444"
  ])
    await expect(vault.use({ ...record, origin }, async () => "unexpected")).rejects.toThrow(
      "此网站"
    )
  const clone = f.store.cloneBot({ id: f.bot.id, revision: f.bot.revision, nonce: "clone-secret" })
  expect((await vault.list(clone.bot.id)).items).toEqual([])
})

it("keeps previous credentials on encryption failure and suppresses provider errors", async () => {
  const f = await fixture()
  let fail = false
  const vault = f.open({
    ...f.protection,
    async protect(bytes) {
      if (fail) throw new Error(bytes.toString("utf8"))
      return f.protection.protect(bytes)
    }
  })
  const record = await vault.save(f.input),
    previous = await readFile(f.path)
  fail = true
  await expect(
    vault.save({ ...f.input, id: record.id, revision: record.revision, value: "NEW_PRIVATE_VALUE" })
  ).rejects.toThrow("凭据加密失败，原有记录未修改")
  expect(await readFile(f.path)).toEqual(previous)
  expect((await vault.list(f.bot.id)).items).toEqual([record])
})

it("rejects a corrupted vault without overwriting it", async () => {
  const f = await fixture(),
    vault = f.open()
  await vault.save(f.input)
  await vault.close()
  const bytes = await readFile(f.path)
  bytes[40] ^= 0xff
  await writeFile(f.path, bytes)
  const reopened = f.open()
  await expect(reopened.list(f.bot.id)).rejects.toThrow("无法解密或已损坏")
  await expect(reopened.save(f.input)).rejects.toThrow("无法解密或已损坏")
  expect(await readFile(f.path)).toEqual(bytes)
})

it("removes deleted Bot credentials on restart if deletion cleanup was interrupted", async () => {
  const f = await fixture(),
    vault = f.open(),
    record = await vault.save(f.input)
  f.store.deleteBot(f.bot.id, f.bot.revision)
  await expect(vault.use(record, async () => "unexpected")).rejects.toThrow()
  await vault.close()
  const { bot: other } = f.store.createBot({ nonce: "new-bot", name: "新 Bot" })
  expect((await f.open().list(other.id)).items).toEqual([])
  expect(
    JSON.parse((await f.protection.unprotect(await readFile(f.path))).toString()).items
  ).toEqual([])
})

it("serializes concurrent versions and refuses invalid origins or values", async () => {
  const f = await fixture(),
    vault = f.open(),
    record = await vault.save(f.input)
  const attempts = await Promise.allSettled(
    ["one", "two"].map((value) =>
      vault.save({ ...f.input, id: record.id, revision: record.revision, value })
    )
  )
  expect(attempts.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"])
  for (const origin of [
    "https://user:pass@example.com",
    "http://example.com",
    "file:///secret",
    "https://example.com/login",
    "https://example.com/?token=abc",
    "https://example.com/#abc"
  ])
    expect(() => botSecretOrigin(origin)).toThrow()
  expect(botSecretOrigin("https://DEV.example.com:443/")).toBe("https://dev.example.com")
  for (const value of ["", "a".repeat(16001), 123])
    expect(() => vault.save({ ...f.input, value: value as string })).toThrow()
})

it("retries a temporarily locked provider without losing or overwriting persisted credentials", async () => {
  const f = await fixture(),
    initial = f.open()
  const record = await initial.save(f.input)
  await initial.close()
  const before = await readFile(f.path)
  let locked = true
  const reopened = f.open({
    ...f.protection,
    kind: "macos-keychain",
    async unprotect(bytes) {
      if (locked) throw new Error("KEYCHAIN_PRIVATE_ERROR")
      return f.protection.unprotect(bytes)
    }
  })
  await expect(reopened.list(f.bot.id)).rejects.toThrow("无法解密或已损坏")
  await expect(reopened.save({ ...f.input, value: "REPLACEMENT" })).rejects.toThrow(
    "无法解密或已损坏"
  )
  expect(await readFile(f.path)).toEqual(before)
  locked = false
  expect(await reopened.list(f.bot.id)).toEqual({
    persistent: true,
    protection: "macos-keychain",
    items: [record]
  })
  await reopened.use(record, async (value) => {
    expect(value).toBe(f.input.value)
  })
  expect(await readFile(f.path)).toEqual(before)
})

it("closes a blocked provider before waiting for queued vault mutations", async () => {
  const f = await fixture()
  let cancel!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const vault = f.open({
    ...f.protection,
    protect: () =>
      new Promise<Buffer>((_resolve, reject) => {
        cancel = () => reject(new Error("closed"))
        started()
      }),
    close: () => cancel?.()
  })
  const pending = expect(vault.save(f.input)).rejects.toThrow("凭据加密失败")
  await ready
  await vault.close()
  await pending
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" })
})
