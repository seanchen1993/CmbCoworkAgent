import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as io from "./backup-io"
import { executeBotBrowserMaintenance as browser } from "./browser-maintenance"
import { executeBotWorkspaceMaintenance as workspace } from "./workspace-maintenance"
import { BotSharedWorkspace } from "./shared-workspace"
import { BotMaintenanceReceipts } from "./maintenance-receipts"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
for (const kind of ["browser", "workspace"] as const) {
  const execute = kind === "browser" ? browser : workspace
  it(`${kind}: journal publish followed by fsync failure retains its stage and reservation for recovery`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-receipts-publish-")))
    roots.push(root)
    const shared = await BotSharedWorkspace.open(root),
      profile = join(root, "browser-profile", "Default")
    await mkdir(profile, { recursive: true })
    const value = kind === "browser" ? join(profile, "Preferences") : join(shared.path, "notes.md")
    await writeFile(value, "before")
    const original = io.writePrivateJson
    vi.spyOn(io, "writePrivateJson").mockImplementation(async (path, value) => {
      await original(path, value)
      if (path === join(root, `${kind}-maintenance`, "pending.json"))
        throw new Error("fsync after publish")
    })
    const request = { action: "reset" as const, nonce: randomUUID() }
    await expect(execute(root, request)).rejects.toThrow("fsync after publish")
    expect(await readFile(value, "utf8")).toBe("before")
    const ledger = new BotMaintenanceReceipts(root)
    try {
      expect(ledger.getOperation(kind, request.nonce)?.state).toBe("reserved")
    } finally {
      ledger.close()
    }
    vi.restoreAllMocks()
    const result = await execute(root, request)
    await mkdir(kind === "browser" ? profile : shared.path, { recursive: true })
    await writeFile(value, "after recovery")
    expect(await execute(root, request)).toEqual(result)
    expect(await readFile(value, "utf8")).toBe("after recovery")
  })
}
