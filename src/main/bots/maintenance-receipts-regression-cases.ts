import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeBotBrowserMaintenance as browser } from "./browser-maintenance"
import { executeBotWorkspaceMaintenance as workspace } from "./workspace-maintenance"
import { migrateBotMaintenanceJsonReceipts as migrate } from "./maintenance-receipts-migration"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { BotSharedWorkspace } from "./shared-workspace"
import { writePrivateJson } from "./backup-io"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-receipts-regression-")))
  const shared = await BotSharedWorkspace.open(root)
  const profile = join(root, "browser-profile", "Default")
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "Preferences"), "before")
  await writeFile(join(shared.path, "notes.md"), "before")
  return {
    root,
    shared,
    profile,
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
      await rm(`${root}.workspace`, { recursive: true, force: true })
    }
  }
}

export function registerMaintenanceReceiptRegressions(
  test: (name: string, run: () => Promise<void>) => unknown
): void {
  test("actual legacy browser Journal migrates to exact completed result before JSON cleanup", async () => {
    const f = await fixture()
    try {
      const request = { action: "reset" as const, nonce: randomUUID() },
        result = await browser(f.root, request)
      const receiptPath = join(f.root, "browser-maintenance", "receipts", `${request.nonce}.json`)
      // Legacy production writes this schema. Future direct-ledger code creates an explicit real-format fixture.
      const journal = {
        format: 1,
        request,
        stage: randomUUID(),
        hadOriginal: true,
        safetyCheckpoint: result.safetyCheckpoint
      }
      await mkdir(join(f.root, "browser-maintenance", "receipts"), { recursive: true })
      await rm(join(f.root, "maintenance-receipts.sqlite"), { force: true })
      await writePrivateJson(receiptPath, journal)
      await migrate(f.root, () => {})
      const ledger = new BotMaintenanceReceipts(f.root)
      try {
        assert.deepEqual(ledger.getOperation("browser", request.nonce)?.result, result)
      } finally {
        ledger.close()
      }
      await assert.rejects(readFile(receiptPath), { code: "ENOENT" })
    } finally {
      await f.dispose()
    }
  })

  test("migrated workspace reset nonce returns original receipt and never replaces later user files", async () => {
    const f = await fixture()
    try {
      const request = { action: "reset" as const, nonce: randomUUID() },
        result = await workspace(f.root, request)
      await migrate(f.root, () => {})
      await writeFile(join(f.shared.path, "notes.md"), "after reset")
      assert.deepEqual(await workspace(f.root, request), result)
      assert.equal(await readFile(join(f.shared.path, "notes.md"), "utf8"), "after reset")
    } finally {
      await f.dispose()
    }
  })

  test("migrated browser normalized reset nonce returns original receipt and never replaces later profile", async () => {
    const f = await fixture()
    try {
      const request = { action: "reset" as const, nonce: randomUUID() },
        result = await browser(f.root, request)
      await mkdir(join(f.root, "browser-maintenance", "receipts"), { recursive: true })
      await rm(join(f.root, "browser-maintenance", "receipts", `${request.nonce}.json`), {
        force: true
      })
      await rm(join(f.root, "maintenance-receipts.sqlite"), { force: true })
      await writePrivateJson(
        join(f.root, "browser-maintenance", "receipts", `${request.nonce}.json`),
        { request, result }
      )
      await migrate(f.root, () => {})
      await mkdir(f.profile, { recursive: true })
      await writeFile(join(f.profile, "Preferences"), "after reset")
      assert.deepEqual(await browser(f.root, request), result)
      assert.equal(await readFile(join(f.profile, "Preferences"), "utf8"), "after reset")
    } finally {
      await f.dispose()
    }
  })

  test("migrated workspace delete tombstone cannot recreate original successful create nonce", async () => {
    const f = await fixture()
    try {
      const request = { action: "create" as const, nonce: randomUUID() },
        result = await workspace(f.root, request)
      const selected = { id: result.checkpoint!.id, sha256: result.checkpoint!.sha256 }
      await workspace(f.root, { action: "delete", checkpoint: selected })
      await migrate(f.root, () => {})
      await writeFile(join(f.shared.path, "notes.md"), "new state")
      await assert.rejects(workspace(f.root, request), /已删除/)
      assert.equal(
        (await readdir(join(f.root, "workspace-maintenance", "checkpoints"))).includes(
          request.nonce
        ),
        false
      )
    } finally {
      await f.dispose()
    }
  })

  test("migrated browser replacement nonce cannot later become a create nonce", async () => {
    const f = await fixture()
    try {
      const request = { action: "reset" as const, nonce: randomUUID() },
        result = await browser(f.root, request)
      await mkdir(join(f.root, "browser-maintenance", "receipts"), { recursive: true })
      await rm(join(f.root, "browser-maintenance", "receipts", `${request.nonce}.json`), {
        force: true
      })
      await rm(join(f.root, "maintenance-receipts.sqlite"), { force: true })
      await writePrivateJson(
        join(f.root, "browser-maintenance", "receipts", `${request.nonce}.json`),
        { request, result }
      )
      await migrate(f.root, () => {})
      await assert.rejects(browser(f.root, { action: "create", nonce: request.nonce }), /标识/)
    } finally {
      await f.dispose()
    }
  })

  for (const kind of ["browser", "workspace"] as const) {
    const execute = kind === "browser" ? browser : workspace
    test(`${kind}: completed pending cleanup after lost receipt ACK never replays later edits`, async () => {
      const f = await fixture()
      try {
        const request = { action: "reset" as const, nonce: randomUUID() }
        await assert.rejects(
          execute(f.root, request, (step) => {
            if (step === "receipt") throw new Error("lost receipt ACK")
          }),
          /lost receipt ACK/
        )
        const ledger = new BotMaintenanceReceipts(f.root)
        const original = ledger.getOperation(kind, request.nonce)!.result
        assert.equal(ledger.getOperation(kind, request.nonce)!.state, "completed")
        ledger.close()
        const path =
          kind === "browser" ? join(f.profile, "Preferences") : join(f.shared.path, "notes.md")
        await mkdir(kind === "browser" ? f.profile : f.shared.path, { recursive: true })
        await writeFile(path, "post failure edits")
        assert.deepEqual(await execute(f.root, request), original)
        assert.equal(await readFile(path, "utf8"), "post failure edits")
        await assert.rejects(readFile(join(f.root, `${kind}-maintenance`, "pending.json")), {
          code: "ENOENT"
        })
      } finally {
        await f.dispose()
      }
    })
    test(`${kind}: deleting restore source does not replay or change exact completed result`, async () => {
      const f = await fixture()
      try {
        const saved = (await execute(f.root, { action: "create", nonce: randomUUID() })).checkpoint!
        const request = {
          action: "restore" as const,
          nonce: randomUUID(),
          checkpoint: { id: saved.id, sha256: saved.sha256 }
        }
        const result = await execute(f.root, request)
        await execute(f.root, { action: "delete", checkpoint: request.checkpoint })
        const path =
          kind === "browser" ? join(f.profile, "Preferences") : join(f.shared.path, "notes.md")
        await writeFile(path, "post restore edits")
        assert.deepEqual(await execute(f.root, request), result)
        assert.equal(await readFile(path, "utf8"), "post restore edits")
        await assert.rejects(
          execute(f.root, {
            ...request,
            checkpoint: { ...request.checkpoint, sha256: "b".repeat(64) }
          }),
          /标识/
        )
        await assert.rejects(execute(f.root, { action: "reset", nonce: saved.id }), /标识/)
      } finally {
        await f.dispose()
      }
    })
    test(`${kind}: pending journal tampering after seal refuses cleanup/effects and preserves current files`, async () => {
      const f = await fixture()
      try {
        const request = { action: "reset" as const, nonce: randomUUID() }
        await assert.rejects(
          execute(f.root, request, (step) => {
            if (step === "receipt") throw new Error("lost receipt ACK")
          }),
          /lost receipt ACK/
        )
        const path =
          kind === "browser" ? join(f.profile, "Preferences") : join(f.shared.path, "notes.md")
        await mkdir(kind === "browser" ? f.profile : f.shared.path, { recursive: true })
        await writeFile(path, "later edit")
        const journalPath = join(f.root, `${kind}-maintenance`, "pending.json")
        const journal = JSON.parse(await readFile(journalPath, "utf8"))
        journal.stage = randomUUID()
        await writePrivateJson(journalPath, journal)
        await assert.rejects(execute(f.root, request), /变化/)
        assert.equal(await readFile(path, "utf8"), "later edit")
        assert.equal(JSON.parse(await readFile(journalPath, "utf8")).stage, journal.stage)
      } finally {
        await f.dispose()
      }
    })
    test(`${kind}: capacity reservation failure happens before replacement and keeps request retryable`, async () => {
      const f = await fixture(),
        original = BotMaintenanceReceipts.prototype.reserveOperation
      try {
        BotMaintenanceReceipts.prototype.reserveOperation = function (
          ...args: Parameters<typeof original>
        ) {
          if (args[0] === kind) throw new Error("ledger capacity")
          return original.apply(this, args)
        }
        const request = { action: "reset" as const, nonce: randomUUID() }
        await assert.rejects(execute(f.root, request), /ledger capacity/)
        const path =
          kind === "browser" ? join(f.profile, "Preferences") : join(f.shared.path, "notes.md")
        assert.equal(await readFile(path, "utf8"), "before")
        BotMaintenanceReceipts.prototype.reserveOperation = original
        const result = await execute(f.root, request)
        assert.deepEqual(await execute(f.root, request), result)
      } finally {
        BotMaintenanceReceipts.prototype.reserveOperation = original
        await f.dispose()
      }
    })
  }

  test("migration preserves existing completed pin plus exact legacy source SHA across interrupted JSON cleanup", async () => {
    const f = await fixture()
    try {
      const requests = [
        { action: "reset" as const, nonce: randomUUID() },
        { action: "reset" as const, nonce: randomUUID() }
      ]
      const results: Awaited<ReturnType<typeof browser>>[] = []
      for (const request of requests) results.push(await browser(f.root, request))
      const ledger = new BotMaintenanceReceipts(f.root),
        pins = requests.map(
          (request) => ledger.getOperation("browser", request.nonce)!.journalSha256
        )
      ledger.close()
      const receiptRoot = join(f.root, "browser-maintenance", "receipts")
      await mkdir(receiptRoot, { recursive: true })
      for (let index = 0; index < 2; index++)
        await writePrivateJson(join(receiptRoot, `${requests[index].nonce}.json`), {
          request: requests[index],
          result: results[index]
        })
      await assert.rejects(
        migrate(f.root, async () => {
          if ((await readdir(receiptRoot)).filter((name) => name.endsWith(".json")).length === 1)
            throw new Error("cleanup interruption")
        }),
        /cleanup interruption/
      )
      const journal = JSON.parse(
        await readFile(join(f.root, "maintenance-receipts-migration.json"), "utf8")
      )
      assert.equal(journal.items.length, 2)
      assert.ok(
        journal.items.every(
          (item: { sha256: string; operationJournalSha256: string }) =>
            item.sha256 !== item.operationJournalSha256
        )
      )
      await migrate(f.root, () => {})
      assert.deepEqual(await readdir(receiptRoot), [])
      const reopened = new BotMaintenanceReceipts(f.root)
      try {
        assert.deepEqual(
          requests.map((request) => reopened.getOperation("browser", request.nonce)!.journalSha256),
          pins
        )
      } finally {
        reopened.close()
      }
    } finally {
      await f.dispose()
    }
  })

  test("workspace tombstone precedes partial deletion and hides/removes a directory with missing manifest on retry", async () => {
    const f = await fixture(),
      original = BotMaintenanceReceipts.prototype.retire
    try {
      const request = { action: "create" as const, nonce: randomUUID() },
        saved = (await workspace(f.root, request)).checkpoint!
      let once = true
      BotMaintenanceReceipts.prototype.retire = function (...args: Parameters<typeof original>) {
        original.apply(this, args)
        if (args[0] === "workspace" && once) {
          once = false
          throw new Error("delete interrupted")
        }
      }
      await assert.rejects(
        workspace(f.root, { action: "delete", checkpoint: { id: saved.id, sha256: saved.sha256 } }),
        /delete interrupted/
      )
      BotMaintenanceReceipts.prototype.retire = original
      const path = join(f.root, "workspace-maintenance", "checkpoints", saved.id)
      await rm(join(path, "manifest.json"))
      assert.deepEqual(
        await workspace(f.root, {
          action: "delete",
          checkpoint: { id: saved.id, sha256: saved.sha256 }
        }),
        { action: "delete" }
      )
      await assert.rejects(readFile(join(path, "files", "notes.md")), { code: "ENOENT" })
      await assert.rejects(workspace(f.root, request), /已删除/)
    } finally {
      BotMaintenanceReceipts.prototype.retire = original
      await f.dispose()
    }
  })
}
