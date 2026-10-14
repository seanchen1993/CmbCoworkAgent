import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FunctionPeerLedger } from "./peer-ledger"
import { FunctionPeerInbox, type FunctionPeerEndpoint, type FunctionPeerSender } from "./peer-inbox"
import type { FunctionPeerInput } from "../../../shared/mods/v2/peer"

const stores: FunctionPeerLedger[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function setup(receive?: FunctionPeerEndpoint["receive"]) {
  const ledger = new FunctionPeerLedger(":memory:")
  stores.push(ledger)
  const inbox = new FunctionPeerInbox(ledger)
  const controller = new AbortController()
  const scope: FunctionPeerEndpoint = {
    workspace: path.resolve("project"),
    sessionId: "target",
    agentId: "main",
    signal: controller.signal,
    assertLive: vi.fn(),
    receive: receive ?? ((input, commit) => commit(input))
  }
  const consumer = inbox.register(scope)
  const sender: FunctionPeerSender = {
    workspace: scope.workspace,
    sessionId: "source",
    agentId: "worker",
    plugin: "reviewer",
    assertLive: vi.fn(),
    publish: vi.fn(async (text: string) => text)
  }
  return { ledger, inbox, controller, scope, consumer, sender }
}

describe("physical peer inbox", () => {
  it("binds agent aliases to one physical generation and notifies the logical recipient", async () => {
    const { ledger, sender, scope } = setup()
    const changed = vi.fn()
    const inbox = new FunctionPeerInbox(ledger, changed)
    const physical = { ...scope, sessionId: "physical-child", agentId: "worker" }
    const consumer = inbox.register(physical)
    inbox.alias({ workspace: scope.workspace, sessionId: "source", agentId: "worker" }, physical)
    expect(await inbox.send({ to: { agentId: "worker" }, text: "task" }, sender)).toEqual({
      isDelivered: true
    })
    const [record] = consumer.claim()
    consumer.settle([record.id], "delivered")
    expect(record.sessionId).toBe("source")
    expect(changed).toHaveBeenLastCalledWith(scope.workspace, "source")
    consumer.close()
    inbox.register(physical)
    expect(await inbox.send({ to: { agentId: "worker" }, text: "stale" }, sender)).toMatchObject({
      isDelivered: false
    })
  })
  it("claims only messages fitting escaped model context and leaves the rest queued", async () => {
    const { inbox, sender, consumer, scope } = setup()
    for (let index = 0; index < 8; index++) {
      expect(await inbox.send({ to: "target", text: "<".repeat(32768) }, sender)).toEqual({
        isDelivered: true
      })
    }
    const first = consumer.claim()
    expect(first).toHaveLength(1)
    expect(
      inbox.list(scope.workspace, "target").filter((item) => item.status === "queued")
    ).toHaveLength(7)
    consumer.settle([first[0].id], "delivered")
    const second = consumer.claim()
    expect(second).toHaveLength(1)
    expect(second[0].id).not.toBe(first[0].id)
  })

  it("resolves explicit addresses and rejects ambiguous unqualified names", async () => {
    const { inbox, sender, scope } = setup()
    const child = inbox.register({ ...scope, sessionId: "source", agentId: "target" })
    await expect(inbox.send({ to: "target", text: "x" }, sender)).rejects.toThrow(
      "MODS_PEER_AMBIGUOUS_TARGET"
    )
    expect(await inbox.send({ to: "agent:target", text: "x" }, sender)).toEqual({
      isDelivered: true
    })
    expect(child.claim()).toHaveLength(1)
    expect(await inbox.send({ to: "session:target", text: "x" }, sender)).toEqual({
      isDelivered: true
    })
  })
  it("queues a stamped peer without a user message and atomically claims only once", async () => {
    const { inbox, sender, consumer, scope } = setup()
    expect(await inbox.send({ to: "target", text: "review changes" }, sender)).toEqual({
      isDelivered: true
    })
    const claimed = consumer.claim()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({
      plugin: "reviewer",
      fromAgentId: "worker",
      origin: "peer",
      status: "processing"
    })
    expect(consumer.claim()).toEqual([])
    consumer.settle(
      claimed.map((item) => item.id),
      "delivered"
    )
    expect(inbox.list(scope.workspace, "target")[0].status).toBe("delivered")
  })

  it("does not enqueue a receive hook return without next", async () => {
    const { inbox, sender, consumer } = setup(async () => ({ text: "pretend" }))
    expect(await inbox.send({ to: "target", text: "original" }, sender)).toMatchObject({
      isDelivered: false
    })
    expect(consumer.claim()).toEqual([])
  })

  it("checks rewritten text, commits once and reports delivery after post-next failure", async () => {
    const { inbox, sender, consumer } = setup(async (input, commit) => {
      await commit({ ...input, text: "rewritten" })
      await expect(commit(input)).rejects.toThrow("MODS_PEER_DUPLICATE_COMMIT")
      throw new Error("post-next failure")
    })
    expect(await inbox.send({ to: "target", text: "original" }, sender)).toEqual({
      isDelivered: true
    })
    expect(consumer.claim().map((row) => row.text)).toEqual(["rewritten"])
    expect(sender.publish).toHaveBeenLastCalledWith("rewritten", expect.any(AbortSignal))
  })

  it("pins origin and receiver agent id", async () => {
    const { inbox, sender, consumer } = setup(async (input, commit) =>
      commit({ ...input, origin: { kind: "coordinator", plugin: "forged" } })
    )
    await expect(inbox.send({ to: "target", text: "original" }, sender)).rejects.toThrow(
      "MODS_PEER_PINNED_INPUT"
    )
    expect(consumer.claim()).toEqual([])
  })

  it("rejects unknown, idle and another workspace targets without invoking hooks", async () => {
    const receive = vi.fn(async () => undefined)
    const { inbox, sender } = setup(receive)
    expect(await inbox.send({ to: "idle", text: "x" }, sender)).toMatchObject({
      isDelivered: false
    })
    expect(
      await inbox.send({ to: "target", text: "x" }, { ...sender, workspace: "elsewhere" })
    ).toMatchObject({ isDelivered: false })
    expect(receive).not.toHaveBeenCalled()
  })

  it("aborts pending hooks on replacement and never delivers to the next generation", async () => {
    let commit!: (input: FunctionPeerInput) => Promise<{ text: string }>
    let input!: FunctionPeerInput
    const started = Promise.withResolvers<void>()
    const { inbox, sender, scope, consumer } = setup(async (event, next) => {
      commit = next
      input = event
      started.resolve()
      return new Promise(() => {})
    })
    const pending = inbox.send({ to: "target", text: "x" }, sender)
    await started.promise
    const replacement = inbox.register(scope)
    await expect(pending).rejects.toThrow("MODS_PEER_STALE_ENDPOINT")
    await expect(commit(input)).rejects.toThrow()
    expect(replacement.claim()).toEqual([])
    expect(() => consumer.claim()).toThrow()
  })

  it("charges reservations before asynchronous hooks and releases them after cancellation", async () => {
    const { inbox, sender, controller } = setup(async () => new Promise(() => {}))
    const pending = Array.from({ length: 8 }, () => inbox.send({ to: "target", text: "x" }, sender))
    expect(await inbox.send({ to: "target", text: "x" }, sender)).toMatchObject({
      isDelivered: false,
      reason: "Target inbox is full"
    })
    controller.abort(new Error("cancelled"))
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === "rejected")
    ).toBe(true)
  })

  it("refuses unawaited deferred commits after the receive scope ends", async () => {
    let commit!: (input: FunctionPeerInput) => Promise<{ text: string }>
    let input!: FunctionPeerInput
    const { inbox, sender } = setup(async (event, next) => {
      commit = next
      input = event
    })
    expect(await inbox.send({ to: "target", text: "x" }, sender)).toMatchObject({
      isDelivered: false
    })
    await expect(commit(input)).rejects.toThrow("MODS_PEER_DUPLICATE_COMMIT")
  })

  it("bounds text, targets and queued message count", async () => {
    const { inbox, sender, consumer } = setup()
    await expect(inbox.send({ to: "target", text: "a".repeat(32769) }, sender)).rejects.toThrow(
      "MODS_PEER_TEXT_LIMIT"
    )
    await expect(inbox.send({ to: { agentId: "" }, text: "x" }, sender)).rejects.toThrow(
      "MODS_PEER_TARGET"
    )
    for (let index = 0; index < 64; index++) await inbox.send({ to: "target", text: "x" }, sender)
    expect(await inbox.send({ to: "target", text: "x" }, sender)).toMatchObject({
      isDelivered: false
    })
    expect(consumer.claim()).toHaveLength(64)
    expect(await inbox.send({ to: "target", text: "x" }, sender)).toMatchObject({
      isDelivered: false
    })
  })

  it("does not retry model consumption after an acknowledgment failure", async () => {
    const { inbox, sender, consumer, ledger, scope } = setup()
    await inbox.send({ to: "target", text: "x" }, sender)
    const [record] = consumer.claim()
    const transition = ledger.transition.bind(ledger)
    vi.spyOn(ledger, "transition").mockImplementation((ids, from, to) => {
      if (to === "delivered") throw new Error("disk failed")
      transition(ids, from, to)
    })
    expect(() => consumer.settle([record.id], "delivered")).toThrow("disk failed")
    expect(consumer.claim()).toEqual([])
    expect(inbox.list(scope.workspace, "target")[0].status).toBe("uncertain")
  })

  it("invalidates queued records when a physical run ends", async () => {
    const { inbox, sender, consumer, scope } = setup()
    await inbox.send({ to: "target", text: "x" }, sender)
    consumer.close()
    consumer.close()
    expect(inbox.list(scope.workspace, "target")[0].status).toBe("interrupted")
  })

  it("uses same-session coordinator identity for actual child endpoints", async () => {
    const { inbox, sender, scope } = setup()
    const child = inbox.register({ ...scope, sessionId: "source", agentId: "child" })
    await inbox.send({ to: { agentId: "child" }, text: "x" }, { ...sender, agentId: "main" })
    expect(child.claim()[0]).toMatchObject({ origin: "coordinator", agentId: "child" })
  })

  it("persists explicit records across restart but never replays old physical work", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mods-peer-"))
    const file = path.join(directory, "peer.db")
    try {
      const first = new FunctionPeerLedger(file)
      first.insert({
        id: "id",
        workspace: "workspace",
        sessionId: "session",
        agentId: "main",
        runId: "old",
        fromSessionId: "source",
        fromAgentId: "main",
        plugin: "plugin",
        origin: "peer",
        text: "x",
        status: "processing",
        createdAt: 1,
        updatedAt: 1
      })
      first.close()
      const second = new FunctionPeerLedger(file)
      expect(second.list("workspace", "session")[0].status).toBe("interrupted")
      expect(second.list("other", "session")).toEqual([])
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
