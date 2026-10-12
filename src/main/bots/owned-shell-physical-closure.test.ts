import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writePrivateJson } from "./backup-io"
import { BotHostLock } from "./host-lock"
import {
  ownedShellMaintenanceOwner,
  assertBotOwnedShellMaintenance
} from "./owned-shell-maintenance-fence"
import { inspectDesktopBotShellResources } from "./desktop-owned-shell-maintenance"
import { OwnedShellReceiptSlot, inspectOwnedShellReceipts } from "./owned-shell-receipts"
import { recoverClosedBotShellResources } from "./owned-shell-recovery"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-shell-closure-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, "shell-resources")
  await mkdir(resources, { mode: 0o700 })
  const allocate = () =>
    OwnedShellReceiptSlot.allocate(resources, {
      nonce: randomUUID(),
      hostId: "closure-test",
      dataEpoch: "epoch",
      policySha256: "a".repeat(64),
      runId: randomUUID(),
      helperSha256: "b".repeat(64),
      workerSha256: "c".repeat(64),
      containment: "controlled-inherited-group"
    })
  return { root, resources, allocate }
}

describe("physical closure is independent of group drain and business result", () => {
  it("retains an authorized weak resource even if a caller requests known cleanup", async () => {
    const f = await fixture(),
      slot = await f.allocate()
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await expect(slot.closed()).rejects.toThrow("not physical cleanup authority")
    await slot.settle(true)
    expect(await inspectOwnedShellReceipts(f.resources)).toMatchObject([
      { phase: "closure-unproven", runAuthorized: true }
    ])
    await expect(OwnedShellReceiptSlot.reopenClosed(f.resources, 0)).rejects.toThrow(
      "physical closure"
    )
    expect((await inspectDesktopBotShellResources(f.root)).review).toMatchObject({
      state: "requires_review",
      reason: "physical-closure-unproven"
    })
  })

  it.each([false, true])(
    "never trusts old resource-closed records with weak group proof (hasScope=%s)",
    async (hasScope) => {
      const f = await fixture(),
        slot = await f.allocate()
      await slot.ready(100, 101)
      await slot.authorizeRun()
      const value = JSON.parse(await readFile(join(slot.directory, "owner.json"), "utf8"))
      value.phase = "resource-closed"
      if (!hasScope) delete value.containment
      await writePrivateJson(join(slot.directory, "owner.json"), value)
      const {
        format,
        nonce,
        hostId,
        dataEpoch,
        policySha256,
        runId,
        helperSha256,
        workerSha256,
        directory,
        helperPid,
        workerPid
      } = value
      await writePrivateJson(join(slot.directory, "closure.json"), {
        format,
        nonce,
        hostId,
        dataEpoch,
        policySha256,
        runId,
        helperSha256,
        workerSha256,
        directory,
        helperPid,
        workerPid,
        scope: "controlled-inherited-group"
      })
      expect(await inspectOwnedShellReceipts(f.resources)).toMatchObject([
        { phase: "closure-unproven", runAuthorized: true }
      ])
      const lock = BotHostLock.acquire(f.root)!
      expect(lock).not.toBeNull()
      try {
        const owner = ownedShellMaintenanceOwner(lock)
        await expect(assertBotOwnedShellMaintenance(f.root, owner)).rejects.toMatchObject({
          code: "bot_shell_resource_requires_review"
        })
        await recoverClosedBotShellResources(f.root, owner)
        expect(await readFile(join(slot.directory, "owner.json"), "utf8")).toContain(
          '"resource-closed"'
        )
        await expect(OwnedShellReceiptSlot.reopenClosed(f.resources, 0)).rejects.toThrow(
          "physical closure"
        )
      } finally {
        lock.release()
      }
    }
  )

  it("permits cleanup when no command authorization ever existed", async () => {
    const f = await fixture(),
      slot = await f.allocate()
    await slot.ready(100, 101)
    await slot.closed()
    expect((await inspectDesktopBotShellResources(f.root)).review.state).toBe("ready")
    await slot.settle(true)
    expect(await inspectOwnedShellReceipts(f.resources)).toEqual([])
  })

  it("reconciles an exact weak group proof when the original record was never authorized", async () => {
    const f = await fixture(),
      slot = await f.allocate()
    await slot.ready(100, 101)
    const value = JSON.parse(await readFile(join(slot.directory, "owner.json"), "utf8"))
    expect(value.phase).toBe("worker-ready")
    expect(value.runAuthorized).toBe(false)
    const {
      format,
      nonce,
      hostId,
      dataEpoch,
      policySha256,
      runId,
      helperSha256,
      workerSha256,
      directory,
      helperPid,
      workerPid
    } = value
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format,
      nonce,
      hostId,
      dataEpoch,
      policySha256,
      runId,
      helperSha256,
      workerSha256,
      directory,
      helperPid,
      workerPid,
      scope: "controlled-inherited-group"
    })
    expect(await inspectOwnedShellReceipts(f.resources)).toMatchObject([
      { phase: "resource-closed", runAuthorized: false }
    ])
    const lock = BotHostLock.acquire(f.root)!
    try {
      const owner = ownedShellMaintenanceOwner(lock)
      await assertBotOwnedShellMaintenance(f.root, owner)
      await recoverClosedBotShellResources(f.root, owner)
      expect(await inspectOwnedShellReceipts(f.resources)).toEqual([])
    } finally {
      lock.release()
    }
  })

  it("keeps unresolved records bounded and refuses admission without discarding any of them", async () => {
    const f = await fixture()
    for (let index = 0; index < 64; index++) {
      const slot = await f.allocate()
      await slot.ready(100, 101)
      await slot.authorizeRun()
      await slot.settle(true)
    }
    const before = await inspectOwnedShellReceipts(f.resources)
    expect(before).toHaveLength(64)
    await expect(f.allocate()).rejects.toThrow("64")
    expect(await inspectOwnedShellReceipts(f.resources)).toEqual(before)
  }, 20_000)
})
