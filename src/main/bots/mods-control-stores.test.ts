import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { acquireBotModControlStore } from "./mods-control-stores"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-mod-control-owner-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const acquire = (name = "control.sqlite") => {
    const lease = acquireBotModControlStore(join(root, name))
    cleanup.push(lease.release)
    return lease
  }
  return { root, acquire }
}
const identity = {
  workspace: "project",
  threadId: "conversation",
  turnId: "turn",
  agentId: "bot",
  callId: "pending",
  origin: "mod" as const,
  grantEpoch: 0
}

it("does not recover or close another live owner's calls and jobs", () => {
  const f = fixture(),
    first = f.acquire()
  first.store.claim("pending", "read_file", {}, identity)
  first.store.saveJob({
    id: "job",
    threadId: "conversation",
    workspace: "project",
    command: "check",
    state: "running",
    createdAt: Date.now()
  })
  const second = f.acquire()
  expect(second.store.status("pending")).toBe("running")
  expect(second.store.jobs("conversation")[0].state).toBe("running")
  first.release()
  first.release()
  second.store.settle("pending", "succeeded")
  expect(second.store.status("pending")).toBe("succeeded")
  second.release()
  const reopened = f.acquire()
  expect(reopened.store.status("pending")).toBe("succeeded")
  expect(reopened.store.jobs("conversation")[0].state).toBe("unknown")
})

it("keeps Bot stores separate and recovers abandoned calls after the last owner leaves", () => {
  const f = fixture(),
    first = f.acquire(),
    other = f.acquire("other.sqlite")
  first.store.claim("pending", "read_file", {}, identity)
  expect(other.store.status("pending")).toBeUndefined()
  first.release()
  const restarted = f.acquire()
  expect(restarted.store.status("pending")).toBe("unknown")
  // Releasing an old handle again cannot close the new generation.
  first.release()
  restarted.store.functionState.set("plugin", "key", "value")
  expect(restarted.store.functionState.get("plugin", "key")).toBe("value")
})

it.skipIf(process.platform === "win32")(
  "refuses to attach a replacement database to the live owner",
  () => {
    const f = fixture(),
      first = f.acquire()
    renameSync(join(f.root, "control.sqlite"), join(f.root, "moved.sqlite"))
    writeFileSync(join(f.root, "control.sqlite"), "different file")
    expect(() => f.acquire()).toThrow("MODS_CONTROL_RECOVERY_REQUIRED")
    expect(() => first.release()).not.toThrow()
  }
)
