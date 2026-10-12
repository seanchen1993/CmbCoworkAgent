import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeBotBrowserMaintenance as browser } from "../src/main/bots/browser-maintenance"
import { executeBotWorkspaceMaintenance as workspace } from "../src/main/bots/workspace-maintenance"
import { BotMaintenanceReceipts } from "../src/main/bots/maintenance-receipts"
import { BotSharedWorkspace } from "../src/main/bots/shared-workspace"
import { BotStore } from "../src/main/bots/store"
import { writePrivateJson } from "../src/main/bots/backup-io"
import { executeBotComputerCheckpoint as computer } from "../src/main/bots/computer-checkpoint-service"

test("compiled actual computer create/restore after legacy browser/workspace maintenance preserves exact migrated nonces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-maintenance-continuity-")))
  const options = {
    nativeEntry:
      process.env.CMB_BOT_COMPUTER_NATIVE_ENTRY ??
      join(__dirname, "bot-computer-checkpoint-native.js")
  }
  try {
    const shared = await BotSharedWorkspace.open(root),
      profile = join(root, "browser-profile", "Default")
    await mkdir(profile, { recursive: true })
    const browserValue = join(profile, "Preferences"),
      workspaceValue = join(shared.path, "notes.md")
    await writeFile(browserValue, "original browser")
    await writeFile(workspaceValue, "original workspace")
    const store = new BotStore(join(root, "bots.sqlite"))
    store.createBot({ nonce: "continuity-fixture", name: "Continuous recovery" })
    store.close()
    const browserRequest = { action: "reset" as const, nonce: randomUUID() },
      workspaceRequest = { action: "reset" as const, nonce: randomUUID() }
    let oldBrowserJournal: unknown
    const browserResult = await browser(root, browserRequest, async (step) => {
      if (step === "journal")
        oldBrowserJournal = JSON.parse(
          await readFile(join(root, "browser-maintenance", "pending.json"), "utf8")
        )
    })
    const workspaceResult = await workspace(root, workspaceRequest)
    // Seed the exact receipt bytes emitted by the pre-ledger product. This is
    // an isolated legacy installation fixture, never a production DB rollback.
    await rm(join(root, "maintenance-receipts.sqlite"), { force: true })
    for (const kind of ["browser", "workspace"])
      await mkdir(join(root, `${kind}-maintenance`, "receipts"), { recursive: true })
    if (!oldBrowserJournal) throw new Error("actual pending browser Journal was not captured")
    await writePrivateJson(
      join(root, "browser-maintenance", "receipts", `${browserRequest.nonce}.json`),
      oldBrowserJournal
    )
    await writePrivateJson(
      join(root, "workspace-maintenance", "receipts", `${workspaceRequest.nonce}.json`),
      { request: workspaceRequest, result: workspaceResult }
    )
    await mkdir(profile, { recursive: true })
    await writeFile(browserValue, "later browser")
    await writeFile(workspaceValue, "later workspace")
    const createRequest = { action: "create" as const, nonce: randomUUID() },
      point = await computer(root, createRequest, options)
    assert.equal(point.action, "create")
    if (point.action !== "create") throw new Error("create result required")
    assert.equal(point.checkpoint.data, "established")
    assert.equal(point.checkpoint.shared, "established")
    assert.equal(point.checkpoint.browser, "established")
    assert.deepEqual(await computer(root, createRequest, options), point)
    assert.deepEqual(await browser(root, browserRequest), browserResult)
    assert.deepEqual(await workspace(root, workspaceRequest), workspaceResult)
    assert.equal(await readFile(browserValue, "utf8"), "later browser")
    assert.equal(await readFile(workspaceValue, "utf8"), "later workspace")
    await writeFile(browserValue, "new edits")
    await writeFile(workspaceValue, "new edits")
    const restoreRequest = {
      action: "restore" as const,
      nonce: randomUUID(),
      checkpoint: { id: point.checkpoint.id, sha256: point.checkpoint.sha256 }
    }
    const restored = await computer(root, restoreRequest, options)
    assert.equal(restored.action, "restore")
    assert.equal(await readFile(browserValue, "utf8"), "later browser")
    assert.equal(await readFile(workspaceValue, "utf8"), "later workspace")
    await writeFile(browserValue, "post total restore browser")
    await writeFile(workspaceValue, "post total restore workspace")
    assert.deepEqual(await browser(root, browserRequest), browserResult)
    assert.deepEqual(await workspace(root, workspaceRequest), workspaceResult)
    assert.deepEqual(await computer(root, restoreRequest, options), restored)
    assert.equal(await readFile(browserValue, "utf8"), "post total restore browser")
    assert.equal(await readFile(workspaceValue, "utf8"), "post total restore workspace")
    const ledger = new BotMaintenanceReceipts(root)
    try {
      assert.equal(ledger.getOperation("browser", browserRequest.nonce)?.state, "completed")
      assert.equal(ledger.getOperation("workspace", workspaceRequest.nonce)?.state, "completed")
    } finally {
      ledger.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
