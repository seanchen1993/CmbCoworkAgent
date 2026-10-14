import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModsManager } from "./manager"
import { currentFunctionExecution } from "./v2/execution-context"
import { withFunctionAgentExecution } from "./v2/host-call"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "mods-peer-manager-"))
  const manager = new ModsManager(
    path.join(root, "control.db"),
    () => [],
    async () => false,
    () => {}
  )
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const sender = manager.createRuntimeAuthority({
    workspace,
    threadId: "source",
    turnId: "sender-turn"
  })
  const target = manager.createRuntimeAuthority({
    workspace,
    threadId: "target",
    turnId: "target-turn"
  })
  const grant = manager.store.grant(workspace, "function:review", "digest", true)
  cleanups.push(() => {
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  const send = () =>
    withFunctionAgentExecution(
      {
        workspace,
        threadId: "source",
        turnId: "sender-turn",
        agentId: "main",
        runtimeAuthority: sender.authority,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      () =>
        manager.sendFunctionPeer(
          workspace,
          "source",
          grant,
          { to: "session:target", text: "review" },
          new AbortController().signal
        )
    )
  return { manager, workspace, sender, target, grant, send }
}

describe("peer runtime integration", () => {
  it("late cleanup of an old endpoint cannot detach the replacement on the same authority", async () => {
    const f = setup()
    const old = f.manager.bindFunctionPeerEndpoint(f.target.authority)
    const current = f.manager.bindFunctionPeerEndpoint(f.target.authority)
    old.close()
    expect(f.manager.functionPeerEndpoint(f.target.authority)).toBe(current)
    expect(await f.send()).toEqual({ isDelivered: true })
    current.close()
    expect(f.manager.functionPeerEndpoint(f.target.authority)).toBeUndefined()
  })
  it("switches into true receiver identity without lending sender authority or lease", async () => {
    const { manager, target, send, workspace } = setup()
    manager.attachFunctions({
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn(),
      receivePeer: async (_workspace, threadId, input, _signal, commit) => {
        expect(threadId).toBe("target")
        expect(currentFunctionExecution()).toMatchObject({
          runtimeAuthority: target.authority,
          userInitiated: false,
          leased: false,
          immediate: false
        })
        return commit(input)
      }
    })
    const consumer = manager.bindFunctionPeerEndpoint(target.authority)
    expect(await send()).toEqual({ isDelivered: true })
    const [record] = consumer.claim()
    consumer.settle([record.id], "delivered")
    expect((await manager.listFunctionPeerMessages(workspace, "target"))[0].plugin).toBe("review")
  })

  it("closes endpoint and interrupts queued work on project or global invalidation", async () => {
    const { manager, target, send, workspace } = setup()
    const consumer = manager.bindFunctionPeerEndpoint(target.authority)
    await send()
    manager.configure(workspace, false, false)
    expect(() => consumer.claim()).toThrow()
    expect(await manager.listFunctionPeerMessages(workspace, "target")).toEqual([])
    manager.configure(workspace, true, false)
    expect((await manager.listFunctionPeerMessages(workspace, "target"))[0].status).toBe(
      "interrupted"
    )
    manager.configure(workspace, true, false)
    const next = manager.bindFunctionPeerEndpoint(target.authority)
    manager.invalidateAll()
    expect(() => next.claim()).toThrow()
  })

  it("revokes a pending send before commit and publishes no success", async () => {
    const { manager, target, send, workspace, grant } = setup()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    manager.attachFunctions({
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn(),
      receivePeer: async (_workspace, _threadId, input, _signal, commit) => {
        entered.resolve()
        await gate.promise
        return commit(input)
      }
    })
    const consumer = manager.bindFunctionPeerEndpoint(target.authority)
    const pending = send()
    await entered.promise
    manager.store.grant(workspace, grant.modId, grant.digest, false)
    gate.resolve()
    await expect(pending).rejects.toThrow()
    expect(consumer.claim()).toEqual([])
  })

  it("notifies read-only ledger observers and stops after disposal", async () => {
    const { manager, target, send, workspace } = setup()
    const listener = vi.fn()
    const stop = manager.onFunctionPeerMessagesChanged(listener)
    manager.bindFunctionPeerEndpoint(target.authority)
    await send()
    expect(listener).toHaveBeenCalledWith(workspace, "target")
    stop()
    listener.mockClear()
    manager.closeFunctionThread("target")
    expect(listener).not.toHaveBeenCalled()
    expect(await send()).toMatchObject({ isDelivered: false })
  })
})
