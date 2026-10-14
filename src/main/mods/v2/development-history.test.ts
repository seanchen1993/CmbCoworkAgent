import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { DevelopmentHistory } from "./development-history"
import type { DevelopmentScope, DevelopmentStatus } from "./development-session"

it("retains an interrupted activation across SQLite reopen without reviving authority", () => {
  const root = mkdtempSync(join(tmpdir(), "mods-development-history-"))
  const path = join(root, "control.sqlite")
  const scope: DevelopmentScope = {
    workspace: root,
    threadId: "thread",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const status: DevelopmentStatus = {
    componentId: "test",
    draftId: "test",
    revision: 1,
    bundleDigest: "a".repeat(64),
    compiledDigest: "b".repeat(64),
    turnId: "turn",
    capabilities: ["ui.resolve"],
    phase: "retiring"
  }
  let store = new ModControlStore(path)
  try {
    new DevelopmentHistory(store).write(scope, status)
    store.close()
    store = new ModControlStore(path)
    const history = new DevelopmentHistory(store)
    expect(history.read(scope)).toMatchObject({
      phase: "unknown",
      error: "MODS_DEVELOPMENT_RESTART_UNCONFIRMED"
    })
    expect(
      history.read({ ...scope, incarnation: { token: "recreated", legacyCreatedAt: 1 } })
    ).toBeUndefined()
    history.write(scope, { ...status, phase: "queued" })
    expect(history.read(scope)).toMatchObject({
      phase: "stopped",
      error: "MODS_DEVELOPMENT_RESTART_APPROVAL_REQUIRED"
    })
  } finally {
    store.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-development-history-/)
    rmSync(root, { recursive: true, force: true })
  }
})
