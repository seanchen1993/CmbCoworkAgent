import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  PartnerLocalConfigStore,
  readPartnerPrivateJson,
  parsePartnerLocalConfig,
  type PartnerLocalConfig
} from "../../src/main/services/bot/partner-local-config"
import { descriptor } from "./partner-local-fixture"
import { inputFixture } from "./requirement-execution-fixture"
const key = randomBytes(32)
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString(text: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv)
    return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()])
  },
  decryptString(bytes: Buffer) {
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
    cipher.setAuthTag(bytes.subarray(-16))
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8")
  }
}
test("main-only encrypted config persists exact connection; no plaintext secrets and no automatic execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "devclaw-partner-config-")),
    dir = join(root, "partner")
  try {
    const config: PartnerLocalConfig = {
        descriptor: descriptor(),
        workspacePath: "/explicit-workspace",
        botId: null,
        botVersionId: null,
        groupId: null,
        pending: null,
        lastRunId: null,
        lastTaskNumber: null
      },
      store = new PartnerLocalConfigStore(dir, storage)
    assert.equal(await store.load(), null)
    await store.save(config)
    const raw = await readFile(join(dir, "connection.enc.json"), "utf8")
    for (const token of [
      config.descriptor.ownerToken,
      config.descriptor.businessToken,
      config.descriptor.nodeToken
    ])
      assert.ok(!raw.includes(token))
    assert.deepEqual(await new PartnerLocalConfigStore(dir, storage).load(), config)
    assert.deepEqual(await store.load(), config)
    await assert.rejects(
      new PartnerLocalConfigStore(dir, { ...storage, isEncryptionAvailable: () => false }).load(),
      /STORAGE_UNAVAILABLE/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("memory enable plan is encrypted and bound to the configured expert/team across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "devclaw-partner-memory-config-")),
    dir = join(root, "partner")
  const input = inputFixture()
  const config: PartnerLocalConfig = {
    descriptor: descriptor(),
    workspacePath: "/explicit-workspace",
    botId: input.bot.id,
    botVersionId: input.botVersion.id,
    groupId: input.group.id,
    lastRunId: null,
    lastTaskNumber: null,
    pending: {
      kind: "enableMemory",
      commandId: "enable-memory",
      fingerprint: `sha256:${"a".repeat(64)}`,
      deadline: new Date(Date.now() + 60000).toISOString(),
      plan: {
        botId: input.bot.id,
        groupId: input.group.id,
        botVersion: 1,
        groupVersion: 1,
        config: { ...input.botVersion.config, memoryPolicy: "explicit_only" },
        bots: input.group.bots,
        members: input.group.members
      }
    }
  }
  try {
    const store = new PartnerLocalConfigStore(dir, storage)
    await store.save(config)
    assert.deepEqual(await new PartnerLocalConfigStore(dir, storage).load(), config)
    assert.ok(
      !(await readFile(join(dir, "connection.enc.json"), "utf8")).includes(
        config.pending!.plan!.config.instructions
      )
    )
    for (const change of [
      { ...config, groupId: "different" },
      { ...config, botId: "different" },
      { ...config, pending: { ...config.pending, kind: "other" } },
      {
        ...config,
        pending: {
          ...config.pending,
          plan: {
            ...config.pending!.plan,
            config: { ...config.pending!.plan!.config, memoryPolicy: "disabled" }
          }
        }
      },
      { ...config, pending: { ...config.pending, plan: undefined } }
    ])
      assert.throws(() => parsePartnerLocalConfig(change), /(STORAGE_FAILURE|INVALID_PAYLOAD)/)
    assert.deepEqual(await store.load(), config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("descriptor file refuses world-readable files, symlinks, broad parents and malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devclaw-partner-import-")),
    file = join(dir, "connection.json")
  try {
    await writeFile(file, JSON.stringify(descriptor()), { mode: 0o600 })
    assert.deepEqual(await readPartnerPrivateJson(file), descriptor())
    await chmod(file, 0o644)
    await assert.rejects(readPartnerPrivateJson(file), /STORAGE_FAILURE/)
    await chmod(file, 0o600)
    const link = join(dir, "link.json")
    await symlink(file, link)
    await assert.rejects(readPartnerPrivateJson(link), /STORAGE_FAILURE/)
    await chmod(dir, 0o755)
    await assert.rejects(readPartnerPrivateJson(file), /STORAGE_FAILURE/)
    await chmod(dir, 0o700)
    await writeFile(file, "{broken")
    await assert.rejects(readPartnerPrivateJson(file), /STORAGE_FAILURE/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
