import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { createTestLocalProjectAccess } from "./test-local-project-permission"
import type { BotLocalToolAction } from "../../shared/bot-local-tool-permission"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-test-local-project-")),
    workspace = join(root, "project")
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(workspace)
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  store.localTools.bind({
    target: { id: "a".repeat(64), label: "本机测试电脑", platform: "darwin" },
    assertCurrent() {
      // This fixture owns its synthetic physical target until Store cleanup.
    }
  })
  const created = store.createBot({ nonce: "bot", name: "Test", workspacePath: workspace })
  store.send({ nonce: "task", conversationId: created.conversationId, text: "Inspect" })
  const { run, lease } = store.claim("host")!
  const { realpath } = await import("node:fs/promises")
  const canonical = await realpath(workspace)
  const action: BotLocalToolAction = {
    kind: "read-file",
    workspace: canonical,
    target: "本项目的说明、配置和文件（含目录检索）",
    description: "Read this project once",
    fingerprint: "b".repeat(64)
  }
  const port = {
    snapshot: vi.fn(async () => store.snapshot()),
    resolve: vi.fn(async (input: unknown) => store.localTools.resolve(input))
  }
  const access = (commands: readonly string[] = []) =>
    createTestLocalProjectAccess({ workspace, runId: run.id, readProject: true, commands })
  return { root, workspace, canonical, store, lease, run, action, port, access }
}
it("resolves actual SQLite Host cards once and preserves independent original approval", async () => {
  const f = await fixture()
  const other = f.store.createBot({ nonce: "other-bot", name: "Other" })
  f.store.send({ nonce: "other-task", conversationId: other.conversationId, text: "Other task" })
  const otherLease = f.store.claim("other-host")!.lease
  const approval = f.store.requestInteraction(otherLease, {
    kind: "approval",
    prompt: JSON.stringify({ shell: { command: "node running.cjs" } }),
    action: { command: "node running.cjs" }
  })
  const permit = f.store.localTools.request(f.lease, "project-read", f.action)
  const access = await f.access()
  const snapshot = await access.snapshot(f.port)
  expect(f.store.getInteraction(permit.interactionId!).answer).toBe("approve")
  expect(snapshot.interactions.some((i) => i.id === permit.interactionId)).toBe(false)
  expect(f.store.getInteraction(approval.id).status).toBe("pending")
  expect(f.store.localTools.read().choice).toBe("ask")
  expect(f.port.resolve.mock.calls[0][0]).toMatchObject({ resolution: "allow-once" })
  await access.snapshot(f.port)
  expect(f.port.resolve).toHaveBeenCalledTimes(1)
  f.store.localTools.assertGranted(f.lease, permit.id)
})
it("only admits exact allowlisted commands and leaves an unknown command pending", async () => {
  const f = await fixture(),
    access = await f.access(["node running.cjs"])
  const allowed = f.store.localTools.request(f.lease, "shell-one", {
    ...f.action,
    kind: "run-command",
    target: "node running.cjs"
  })
  await access.snapshot(f.port)
  f.store.localTools.assertGranted(f.lease, allowed.id)
  const denied = f.store.localTools.request(f.lease, "shell-two", {
    ...f.action,
    kind: "run-command",
    target: "node running.cjs && node extra.cjs"
  })
  await expect(access.snapshot(f.port)).rejects.toThrow("no explicit admission")
  expect(f.store.getInteraction(denied.interactionId!).status).toBe("pending")
  expect(f.port.resolve).toHaveBeenCalledTimes(1)
})
it.each(["workspace", "epoch"])(
  "refuses Host metadata for a different %s before answering",
  async (kind) => {
    const f = await fixture(),
      access = await f.access()
    const permit = f.store.localTools.request(f.lease, "read", {
      ...f.action,
      ...(kind === "workspace" ? { workspace: f.root } : {})
    })
    if (kind === "epoch") {
      f.port.snapshot.mockImplementation(async () => ({
        ...f.store.snapshot(),
        dataEpoch: "other"
      }))
    }
    await expect(access.snapshot(f.port)).rejects.toThrow("scope does not match")
    expect(f.store.getInteraction(permit.interactionId!).status).toBe("pending")
    expect(f.port.resolve).not.toHaveBeenCalled()
  }
)
it("does not interpret model prompt JSON as a trusted card or answer questions/other runs", async () => {
  const f = await fixture(),
    access = await f.access()
  const permit = f.store.localTools.request(f.lease, "read", f.action)
  const card = f.store.getInteraction(permit.interactionId!).localProjectAccess
  const other = f.store.createBot({ nonce: "other-bot", name: "Other" })
  f.store.send({ nonce: "other-task", conversationId: other.conversationId, text: "Other task" })
  const otherLease = f.store.claim("other-host")!.lease
  const spoof = f.store.requestInteraction(otherLease, {
    kind: "question",
    prompt: JSON.stringify({ localProjectAccess: card })
  })
  const snapshot = f.store.snapshot()
  f.port.snapshot.mockImplementation(async () => ({
    ...snapshot,
    interactions: snapshot.interactions.map((item) =>
      item.id === permit.interactionId ? { ...item, runId: "another-run" } : item
    )
  }))
  await access.snapshot(f.port)
  expect(f.port.resolve).not.toHaveBeenCalled()
  expect(f.store.getInteraction(spoof.id).status).toBe("pending")
  expect(f.store.getInteraction(permit.interactionId!).status).toBe("pending")
})
it("refuses a replaced project inode instead of applying its old admission", async () => {
  const f = await fixture(),
    access = await f.access()
  const permit = f.store.localTools.request(f.lease, "read", f.action)
  await rename(f.workspace, join(f.root, "old-project"))
  await mkdir(f.workspace)
  await expect(access.snapshot(f.port)).rejects.toThrow("identity changed")
  expect(f.store.getInteraction(permit.interactionId!).status).toBe("pending")
  expect(f.port.snapshot).not.toHaveBeenCalled()
  expect(f.port.resolve).not.toHaveBeenCalled()
})
