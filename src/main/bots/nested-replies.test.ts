import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import type { BotTask } from "../../shared/bots/contracts"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BackgroundCommandLifecycle } from "../agent/background-command-lifecycle"
vi.mock("../storage", () => ({ isMemoryEnabled: () => false }))
import { createBotDeliveryTools, verifyBotDeliveryFiles } from "./tools"

const databases: NativeSqliteAdapter[] = []
const hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  databases.splice(0).forEach((db) => db.close())
})

function fixture(hops = 2, scope: "private" | "work" | "group" = "private", settleParents = true, relayOutputs: string[] = []) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let time = 1000
  const store = new BotStore(db, () => ++time)
  const bots = Array.from({ length: hops + 1 }, (_, i) =>
    store.create({ name: `Peer ${i}`, instructions: "", color: "#123456", modelRef: null })
  )
  const created =
    scope === "work"
      ? store.createWork({
          botId: bots[0].id,
          operationId: "work",
          title: "Analysis",
          goal: "Analyze"
        })
      : undefined
  const group =
    scope === "group"
      ? store.saveGroup({ name: "Analysis", memberIds: bots.map((bot) => bot.id) })
      : undefined
  if (group)
    store.sendGroup({
      groupId: group.id,
      requestId: "group-root",
      text: "Analyze",
      targetBotIds: [bots[0].id]
    })
  const root =
    created?.task ??
    (group
      ? store.recentTasks()[0]
      : store.enqueue({ botId: bots[0].id, requestId: "root", message: "Analyze" }))
  store.transition(root.id, "running")
  const chain = [root]
  for (let i = 1; i <= hops; i++) {
    chain.push(store.delegate(chain[i - 1].id, bots[i].id, `Analyze part ${i}`, `part-${i}`, i === 1 ? relayOutputs : []))
    if (settleParents)
      store.settle(
        chain[i - 1].id,
        "completed",
        null,
        `Waiting for part ${i}`,
        undefined,
        Boolean(group)
      )
    store.transition(chain[i].id, "running")
  }
  // A parent may already have ended its initial wait turn when the leaf finishes.
  store.flushReplies()
  return {
    db,
    store,
    bots,
    chain,
    root,
    work: created?.work,
    group,
    advance: (amount: number) => {
      time += amount
    }
  }
}

function receipt(store: BotStore, source: BotTask): BotTask {
  store.flushReplies()
  const found = store.recentTasks().find((task) => task.requestId === `reply-${source.id}`)
  expect(found, `Missing reply for ${source.id}`).toBeDefined()
  return found!
}

function finish(store: BotStore, task: BotTask, result: string, explicitGroupMessages = false) {
  store.transition(task.id, "running")
  store.settle(task.id, "completed", null, result, undefined, explicitGroupMessages)
}

describe("nested private collaboration result return", () => {
  it.each([false, true])("records a live group peer delivery while waiting=%s", async (waiting) => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    const store = new BotStore(db)
    const input = { name: "A", instructions: "", color: "#123456", modelRef: null }
    const a = store.create(input), b = store.create({ ...input, name: "B" })
    const group = store.saveGroup({ name: "Group", memberIds: [a.id, b.id] })
    let childId = ""
    const recorded: BotDeliveredFile[][] = []
    const file = { filePath: "/workspace/report.txt", name: "report.txt", size: 4,
      attachmentPath: "/workspace/.bot-deliveries/sent/report.txt" }
    const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: (_bot, task) => ({
      release() {}, execute: async (_signal, setWaiting) => {
        if (task.origin.kind === "group") childId = host.delegate(task.id, b.id, "Report", "child").id
        if (task.id === childId) {
          if (waiting) setWaiting(true)
          host.publishGroupFiles(task.id, "delivery", [file])
          host.recordPeerDelivery(task.id, [file])
          recorded.push(store.peerHandoff(task.id).files!)
          if (waiting) setWaiting(false)
        }
        return { state: "completed", result: "Done", publicContribution: true }
      }
    }) }, 2)
    hosts.push(host)
    host.sendGroup({ groupId: group.id, requestId: "group-delivery", text: "Report", targetBotIds: [a.id] })
    await vi.waitFor(() => expect(recorded).toEqual([[file]]))
    expect(store.groupMessages(group.id).some((message) => message.files?.length)).toBe(true)
    await vi.waitFor(() => expect(store.getTask(childId).state).toBe("completed"))
    expect(() => host.recordPeerDelivery(childId, [file])).toThrow(/已停止/)
  })
  it("shares the latest explicit revision across sibling result turns of one handoff", () => {
    const f = fixture(2, "private", false, ["report.txt"])
    const relay = f.chain[1], first = f.chain[2]
    const other = f.store.create({ name: "Other reviewer", instructions: "", color: "#123456", modelRef: null })
    const second = f.store.delegate(relay.id, other.id, "Review two", "second-review")
    f.store.transition(second.id, "running")
    const v1 = { filePath: "/workspace/report.txt", name: "report.txt", size: 2,
      attachmentPath: "/workspace/.bot-deliveries/v1/report.txt" }
    const v2 = { ...v1, attachmentPath: "/workspace/.bot-deliveries/v2/report.txt" }
    f.store.recordPeerDelivery(relay.id, [v1])
    f.store.settle(relay.id, "completed", null, "Dispatched", [v1])
    f.store.settle(first.id, "completed", null, "Review one")
    const r1 = receipt(f.store, first)
    f.store.transition(r1.id, "running")
    f.store.recordPeerDelivery(r1.id, [v2])
    f.store.settle(r1.id, "completed", null, "Explicit revision", [v2])
    const reloaded = new BotStore(f.db, () => 2000)
    reloaded.settle(second.id, "completed", null, "Review two")
    const r2 = receipt(reloaded, second)
    expect(reloaded.peerHandoff(r2.id)).toMatchObject({ files: [v2] })
    expect(reloaded.peerHandoff(second.id)).not.toHaveProperty("files")
    reloaded.transition(f.root.id, "cancelled")
    expect(reloaded.peerHandoff(r2.id)).not.toHaveProperty("files")
  })
  it("keeps a relay's delivered snapshot across a new result turn and store reload", () => {
    const f = fixture(2, "private", false, ["report.txt"])
    const relay = f.chain[1], leaf = f.chain[2]
    const sent = { filePath: "/workspace/report.txt", name: "report.txt", size: 4,
      attachmentPath: "/workspace/.bot-deliveries/sent/report.txt" }
    f.store.recordPeerDelivery(relay.id, [sent])
    f.store.settle(relay.id, "completed", null, "Waiting for review", [sent])
    const reloaded = new BotStore(f.db, () => 2000)
    reloaded.settle(leaf.id, "completed", null, "Reviewed")
    const integration = receipt(reloaded, leaf)
    expect(reloaded.peerHandoff(integration.id)).toMatchObject({ files: [sent] })
    expect(reloaded.peerHandoff(leaf.id)).not.toHaveProperty("files")
    expect(reloaded.taskCheckpoint(relay.id)).toBeUndefined()
    expect(reloaded.continuationFiles(relay.id)).toEqual([])
    reloaded.transition(integration.id, "running")
    reloaded.settle(integration.id, "completed", null, "Final", [sent])
    expect(receipt(reloaded, integration).origin).toMatchObject({ replyFiles: [sent] })
  })
  it("keeps active checkpoint files separate from later explicit handoff revisions", () => {
    const f = fixture(2, "private", false, ["report.txt"])
    const relay = f.chain[1], leaf = f.chain[2]
    const old = { filePath: "/workspace/report.txt", name: "report.txt", size: 2,
      attachmentPath: "/workspace/.bot-deliveries/v1/report.txt" }
    const revised = { ...old, attachmentPath: "/workspace/.bot-deliveries/v2/report.txt" }
    f.store.recordPeerDelivery(relay.id, [old])
    f.store.acceptCommand(relay.id, { id: "snapshot-slow", threadId: relay.threadId,
      command: "check", cwd: "/workspace", startedAt: 1, notifyOnComplete: true }, true)
    f.store.deferTask(relay.id, "source-checkpoint", [old])
    f.store.settle(leaf.id, "completed", null, "Reviewed")
    const integration = receipt(f.store, leaf)
    f.store.transition(f.root.id, "completed")
    expect(f.store.nextQueued([])?.id).toBe(integration.id)
    f.store.transition(integration.id, "running")
    f.store.recordPeerDelivery(integration.id, [revised])
    f.store.settle(integration.id, "completed", null, "Revised", [revised])
    expect(f.store.taskCheckpoint(relay.id)).toBe("source-checkpoint")
    expect(f.store.continuationFiles(relay.id)).toEqual([old])
    expect(f.store.peerHandoff(relay.id).files).toEqual([revised])
    f.store.settleCommand({ id: "snapshot-slow", threadId: relay.threadId,
      exitCode: 0, output: "done", cancelled: false, truncated: false })
    f.store.transition(relay.id, "running")
    f.store.settle(relay.id, "completed", null, "Finished", [old])
    // Settlement is not a new delivery and cannot roll the authority back.
    expect(f.store.peerHandoff(relay.id).files).toEqual([revised])
  })
  it.each(["private", "work", "group"] as const)(
    "retains the original %s report requirement until downstream integration",
    (scope) => {
      const f = fixture(2, scope, false, ["reports/final.json"])
      const relay = f.chain[1], leaf = f.chain[2]
      expect(f.store.peerHandoff(relay.id)).toEqual({ owned: true, pending: true, outputFiles: ["reports/final.json"] })
      f.store.settle(relay.id, "completed", null, "Waiting for downstream calculation")
      f.store.settle(leaf.id, "completed", null, "ACTUAL_RESULT")
      const integration = receipt(f.store, leaf)
      expect(integration.origin).not.toHaveProperty("outputFiles")
      expect(f.store.peerHandoff(integration.id)).toEqual({ owned: true, pending: false, outputFiles: ["reports/final.json"] })
      const stopped = fixture(2, scope, false, ["reports/final.json"])
      stopped.store.settle(stopped.chain[2].id, "completed", null, "ACTUAL_RESULT")
      const late = receipt(stopped.store, stopped.chain[2])
      stopped.store.settle(stopped.chain[1].id, "cancelled", "User stopped the original handoff")
      expect(stopped.store.peerHandoff(late.id).outputFiles).toEqual([])
    }
  )

  it.each(["private", "work", "group"] as const)(
    "does not report an intermediate %s handoff complete while its child is still pending",
    (scope) => {
      const f = fixture(2, scope, false)
      const middle = f.chain[1], leaf = f.chain[2]
      f.store.settle(middle.id, "completed", null, "Delegated; waiting for the actual result")
      f.store.flushReplies()
      expect(f.store.recentTasks().some(task => task.requestId === `reply-${middle.id}`)).toBe(false)
      f.store.settle(leaf.id, "completed", null, "VERIFIED_LEAF_RESULT")
      const integration = receipt(f.store, leaf)
      finish(f.store, integration, "VERIFIED_AGGREGATE")
      const final = receipt(f.store, integration)
      expect(final.botId).toBe(f.bots[0].id)
      expect(final.message).toContain("VERIFIED_AGGREGATE")
    }
  )

  it("waits for an already-finished child's undrained result rather than reporting the dispatch complete", () => {
    const f = fixture(2, "private", false)
    f.store.settle(f.chain[2].id, "completed", null, "VERIFIED_RESULT")
    f.store.settle(f.chain[1].id, "completed", null, "Delegated; waiting")
    f.store.flushReplies()
    expect(f.store.recentTasks().some(task => task.requestId === `reply-${f.chain[1].id}`)).toBe(false)
    finish(f.store, receipt(f.store, f.chain[2]), "INTEGRATED_RESULT")
  })

  it("still reports an intermediate failure immediately when its child is pending", () => {
    const f = fixture(2, "private", false)
    f.store.settle(f.chain[1].id, "failed", "ACTUAL_FAILURE")
    expect(receipt(f.store, f.chain[1]).message).toContain("ACTUAL_FAILURE")
  })

  it.each([1, 2, 3, 4])(
    "returns an integrated %i-hop result to its exact original caller without a reply loop",
    (hops) => {
      const f = fixture(hops)
      let current = f.chain.at(-1)!
      f.store.settle(current.id, "completed", null, "ACTUAL_FACT")
      for (let i = hops - 1; i >= 0; i--) {
        const next = receipt(f.store, current)
        expect(next).toMatchObject({
          botId: f.bots[i].id,
          threadId: f.bots[i].threadId,
          origin: {
            kind: "bot",
            fromBotId: current.botId,
            expectsReply: false,
            rootTaskId: f.root.id
          }
        })
        expect(next.message).toContain("ACTUAL_FACT")
        finish(f.store, next, `Integrated ${i}: ACTUAL_FACT`)
        current = next
      }
      f.store.flushReplies()
      expect(f.store.recentTasks().some((task) => task.requestId === `reply-${current.id}`)).toBe(
        false
      )
      expect(f.db.exec("SELECT count(*) FROM bot_reply_outbox")[0].values[0][0]).toBe(0)
    }
  )

  it.each(["failed", "cancelled", "interrupted", "outcome_unknown"] as const)(
    "returns the leaf's actual %s result and a later aggregation failure to the original caller",
    (state) => {
      const f = fixture()
      const leaf = f.chain.at(-1)!
      f.store.settle(leaf.id, state, "ACTUAL_BLOCKER")
      const intermediate = receipt(f.store, leaf)
      expect(intermediate.message).toContain("ACTUAL_BLOCKER")
      expect(intermediate.origin).not.toHaveProperty("replyFiles")
      f.store.transition(intermediate.id, "running")
      f.store.settle(intermediate.id, "failed", "AGGREGATION_BLOCKED")
      expect(receipt(f.store, intermediate)).toMatchObject({
        botId: f.bots[0].id,
        message: expect.stringContaining("AGGREGATION_BLOCKED"),
        origin: { fromBotId: f.bots[1].id, expectsReply: false }
      })
    }
  )

  it("settles and flushes the same integrated result once, including after an outbox drain", () => {
    const f = fixture()
    const leaf = f.chain.at(-1)!
    f.store.settle(leaf.id, "completed", null, "FACT")
    const intermediate = receipt(f.store, leaf)
    finish(f.store, intermediate, "AGGREGATED_FACT")
    f.store.settle(intermediate.id, "completed", null, "IGNORED_DUPLICATE_CALLBACK")
    const first = receipt(f.store, intermediate)
    f.store.settle(intermediate.id, "completed", null, "IGNORED_LATE_CALLBACK")
    f.store.flushReplies()
    f.store.flushReplies()
    expect(f.store.recentTasks().filter((task) => task.requestId === first.requestId)).toEqual([
      first
    ])
    expect(first.message).toContain("AGGREGATED_FACT")
    expect(first.message).not.toContain("IGNORED")
  })

  it.each(["cancelled", "interrupted"] as const)(
    "does not wake a %s root or original intermediate handoff",
    (state) => {
      for (const sourceIndex of [0, 1]) {
        const f = fixture(2, "private", false)
        f.store.settle(f.chain[sourceIndex].id, state, "USER_STOPPED")
        f.store.settle(f.chain[2].id, "completed", null, "LATE_FACT")
        f.store.flushReplies()
        expect(
          f.store.recentTasks().some((task) => task.requestId === `reply-${f.chain[2].id}`)
        ).toBe(false)
        expect(f.store.getTask(f.chain[sourceIndex].id).state).toBe(state)
      }
    }
  )

  it("rechecks an intermediate stop between outbox creation and delivery", () => {
    const f = fixture(2, "private", false)
    f.store.settle(f.chain[2].id, "completed", null, "LATE_FACT")
    f.store.settle(f.chain[1].id, "cancelled", "USER_STOPPED")
    f.store.flushReplies()
    expect(f.store.recentTasks().some((task) => task.requestId === `reply-${f.chain[2].id}`)).toBe(
      false
    )
    expect(
      f.db.exec("SELECT blocked FROM bot_reply_outbox WHERE task_id='" + f.chain[2].id + "'")[0]
        .values
    ).toEqual([[1]])
  })

  it("rechecks an intermediate stop before integrating an already delivered receipt", () => {
    const f = fixture(2, "private", false)
    f.store.settle(f.chain[2].id, "completed", null, "FACT")
    const intermediate = receipt(f.store, f.chain[2])
    f.store.settle(f.chain[1].id, "cancelled", "USER_STOPPED")
    expect(f.store.getTask(intermediate.id).state).toBe("cancelled")
    f.store.flushReplies()
    expect(
      f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
    ).toBe(false)
  })

  it.each(["before integration", "before flush"] as const)(
    "rechecks root cancellation %s on the new upstream route",
    (when) => {
      const f = fixture(2, "private", false)
      f.store.settle(f.chain[1].id, "completed", null, "Waiting")
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const intermediate = receipt(f.store, f.chain[2])
      if (when === "before integration") f.store.settle(f.root.id, "cancelled", "USER_STOPPED")
      finish(f.store, intermediate, "FINAL_FACT")
      if (when === "before flush") f.store.settle(f.root.id, "cancelled", "USER_STOPPED")
      f.store.flushReplies()
      expect(
        f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
      ).toBe(false)
    }
  )

  it("keeps a returned receipt's original upstream when it needs another authorized peer", () => {
    const f = fixture(2)
    f.store.settle(f.chain[2].id, "completed", null, "PARTIAL_FACT")
    const first = receipt(f.store, f.chain[2])
    f.store.transition(first.id, "running")
    const extra = f.store.create({
      name: "Extra",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    const followup = f.store.delegate(first.id, extra.id, "Complete missing detail", "extra")
    f.store.settle(first.id, "completed", null, "Waiting for detail")
    f.store.transition(followup.id, "running")
    f.store.settle(followup.id, "completed", null, "FINAL_DETAIL")
    const second = receipt(f.store, followup)
    finish(f.store, second, "FINAL_AGGREGATION")
    const final = receipt(f.store, second)
    expect(final).toMatchObject({
      botId: f.bots[0].id,
      message: expect.stringContaining("FINAL_AGGREGATION")
    })
    finish(f.store, final, "Delivered")
    f.store.flushReplies()
    expect(f.store.recentTasks().some((task) => task.requestId === `reply-${final.id}`)).toBe(false)
  })

  it("allows an ordinary single-hop receipt to consult another peer without inventing a return to its old sender", () => {
    const f = fixture(1)
    f.store.settle(f.chain[1].id, "completed", null, "FIRST_FACT")
    const first = receipt(f.store, f.chain[1])
    expect(first.origin).not.toHaveProperty("upstreamTaskId")
    f.store.transition(first.id, "running")
    const extra = f.store.create({
      name: "Extra",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    const followup = f.store.delegate(first.id, extra.id, "Verify another fact", "followup")
    f.store.settle(first.id, "completed", null, "Waiting")
    f.store.transition(followup.id, "running")
    f.store.settle(followup.id, "completed", null, "SECOND_FACT")
    const final = receipt(f.store, followup)
    expect(final.botId).toBe(f.bots[0].id)
    finish(f.store, final, "FINAL_FACTS")
    f.store.flushReplies()
    expect(f.store.recentTasks().some((task) => task.requestId === `reply-${final.id}`)).toBe(false)
  })

  it.each(["private", "work", "group"] as const)(
    "cleans an unstarted downstream receipt on restart of the original %s handoff",
    (scope) => {
      const f = fixture(2, scope, false)
      f.store.transition(f.chain[1].id, "waiting_user")
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const pending = receipt(f.store, f.chain[2])
      expect(pending.state).toBe("queued")
      const restarted = new BotStore(f.db)
      restarted.recover()
      expect(restarted.getTask(f.chain[1].id).state).toBe("interrupted")
      expect(restarted.getTask(pending.id).state).toBe("cancelled")
      restarted.recover()
      expect(restarted.getTask(pending.id).state).toBe("cancelled")
      expect(restarted.pendingTasksForThread(pending.threadId)).toEqual([])
    }
  )

  it.each(["private", "work", "group"] as const)(
    "cleans a queued child on restart even when its actual %s source is an ordinary receipt without upstream",
    (scope) => {
      const f = fixture(1, scope)
      f.store.settle(f.chain[1].id, "completed", null, "FACT")
      const first = receipt(f.store, f.chain[1])
      expect(first.origin).not.toHaveProperty("upstreamTaskId")
      f.store.transition(first.id, "running")
      const extra = f.store.create({
        name: "Extra",
        instructions: "",
        color: "#123456",
        modelRef: null
      })
      if (f.group) f.store.saveGroup({
        name: f.group.name, memberIds: [...f.group.memberIds, extra.id]
      }, { id: f.group.id, version: f.group.version })
      const followup = f.store.delegate(first.id, extra.id, "Verify another fact", "followup")
      f.store.transition(first.id, "waiting_user")
      f.store.transition(followup.id, "running")
      f.store.settle(followup.id, "completed", null, "SECOND_FACT")
      const pending = receipt(f.store, followup)
      const restarted = new BotStore(f.db)
      restarted.recover()
      expect(restarted.getTask(first.id).state).toBe("interrupted")
      expect(restarted.getTask(pending.id).state).toBe("cancelled")
      restarted.flushReplies()
      expect(restarted.pendingTasksForThread(pending.threadId)).toEqual([])
    }
  )

  it("reports a recovered intermediate result turn's interruption once and preserves that first fact across retries", () => {
    const f = fixture()
    f.store.settle(f.chain[2].id, "completed", null, "FACT")
    const intermediate = receipt(f.store, f.chain[2])
    f.store.transition(intermediate.id, "running")
    f.store.transition(intermediate.id, "waiting_user")
    const restarted = new BotStore(f.db)
    restarted.recover()
    expect(restarted.getTask(intermediate.id).state).toBe("interrupted")
    const recovered = receipt(restarted, intermediate)
    expect(recovered).toMatchObject({
      botId: f.bots[0].id,
      message: expect.stringContaining("应用已重启"),
      origin: { expectsReply: false, fromBotId: f.bots[1].id }
    })
    expect(recovered.origin).not.toHaveProperty("replyFiles")
    restarted.settle(
      intermediate.id,
      "interrupted",
      "Different late callback must not replace the first fact"
    )
    restarted.recover()
    restarted.flushReplies()
    expect(
      restarted.recentTasks().filter((task) => task.requestId === recovered.requestId)
    ).toEqual([recovered])
  })

  it("returns to the exact independent work, retains its family, and lets that work report to its own main chat", () => {
    const f = fixture(3, "work")
    f.store.createWork({
      botId: f.bots[0].id,
      operationId: "other-work",
      title: "Other",
      goal: "Unrelated"
    })
    let current = f.chain[3]
    f.store.settle(current.id, "completed", null, "WORK_FACT")
    for (let i = 2; i >= 0; i--) {
      const next = receipt(f.store, current)
      expect(next.origin).toMatchObject({ rootWorkId: f.work!.id })
      expect(next.workId).toBe(i === 0 ? f.work!.id : undefined)
      expect(next.threadId).toBe(i === 0 ? f.work!.threadId : f.bots[i].threadId)
      finish(f.store, next, "WORK_INTEGRATION")
      current = next
    }
    f.store.flushReplies()
    const summary = f.store
      .recentTasks()
      .find((task) => task.requestId === `work-result-${current.id}`)!
    expect(summary).toMatchObject({
      botId: f.bots[0].id,
      threadId: f.bots[0].threadId,
      origin: { kind: "work_result", workId: f.work!.id }
    })
    expect(JSON.parse(summary.message).result).toBe("WORK_INTEGRATION")
    expect(f.store.getWork(f.bots[0].id, f.work!.id).state).toBe("active")
  })

  it("does not complete a work while an integrated peer result is still owed", () => {
    const f = fixture(2, "work")
    f.store.settle(f.chain[2].id, "completed", null, "WORK_FACT")
    const intermediate = receipt(f.store, f.chain[2])
    finish(f.store, intermediate, "WORK_INTEGRATION")
    const work = f.store.getWork(f.bots[0].id, f.work!.id)
    expect(() =>
      f.store.changeWork(work.botId, work.id, work.version, "complete", "complete")
    ).toThrow("待办")
  })

  it.each(["private", "work", "group"] as const)(
    "does not reopen an archived %s caller when a final result is pending",
    (scope) => {
      const f = fixture(2, scope)
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const intermediate = receipt(f.store, f.chain[2])
      finish(f.store, intermediate, "FINAL_FACT")
      const owner = f.store.getBot(f.bots[0].id)
      const archived = f.store.update({ ...owner, expectedVersion: owner.version, archived: true })
      f.store.flushReplies()
      expect(
        f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
      ).toBe(false)
      f.store.update({ ...archived, expectedVersion: archived.version, archived: false })
      f.store.flushReplies()
      expect(
        f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
      ).toBe(false)
    }
  )

  it.each(["private", "work", "group"] as const)(
    "returns one cancellation when an archived %s intermediary has queued integration",
    (scope) => {
      const f = fixture(2, scope)
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const integration = receipt(f.store, f.chain[2])
      const middle = f.store.getBot(f.bots[1].id)
      const archived = f.store.update({ ...middle, expectedVersion: middle.version, archived: true })
      expect(f.store.getTask(integration.id).state).toBe("cancelled")
      const upstream = receipt(f.store, integration)
      expect(upstream.botId).toBe(f.bots[0].id)
      expect(upstream.message).toContain("已停止")
      expect(upstream.message).toContain("Bot 已归档，排队任务未执行。")
      expect(upstream.origin).not.toHaveProperty("replyFiles")
      f.store.update({ ...archived, expectedVersion: archived.version, archived: false })
      f.store.flushReplies()
      expect(f.store.recentTasks().filter((task) => task.botId === f.bots[0].id &&
        task.origin.kind === "bot").map((task) => task.id)).toEqual([upstream.id])
      expect(f.store.getTask(integration.id).state).toBe("cancelled")
    }
  )

  it("coalesces queued sibling results into one archive cancellation", () => {
    const f = fixture(2, "private", false)
    const relay = f.chain[1], first = f.chain[2]
    const other = f.store.create({ name: "Other reviewer", instructions: "", color: "#123456", modelRef: null })
    const second = f.store.delegate(relay.id, other.id, "Review two", "archive-second-review")
    f.store.settle(f.root.id, "completed", null, "Waiting")
    f.store.settle(relay.id, "completed", null, "Waiting")
    f.store.settle(first.id, "completed", null, "Review one")
    finish(f.store, second, "Review two")
    const results = [receipt(f.store, first), receipt(f.store, second)]
    const middle = f.store.getBot(f.bots[1].id)
    f.store.update({ ...middle, expectedVersion: middle.version, archived: true })
    f.store.flushReplies()
    const returned = f.store.recentTasks().filter((task) => task.botId === f.bots[0].id && task.origin.kind === "bot")
    expect(returned).toHaveLength(1)
    const upstream = returned[0]
    expect(upstream.message).toContain("已停止")
    expect(upstream.message).toContain("Bot 已归档，排队任务未执行。")
    expect(results.map((task) => f.store.getTask(task.id).state)).toEqual(["cancelled", "cancelled"])
    expect(f.store.recentTasks().filter((task) => task.botId === f.bots[0].id &&
      task.origin.kind === "bot").map((task) => task.id)).toEqual([upstream.id])
  })

  it.each([1, 2])("returns one cancellation when leaving a group with %s queued integration results", (count) => {
    const f = fixture(2, "group", false)
    const relay = f.chain[1], children = [f.chain[2]]
    let group = f.group!
    if (count === 2) {
      const other = f.store.create({ name: "Other reviewer", instructions: "", color: "#123456", modelRef: null })
      group = f.store.saveGroup({ name: group.name, memberIds: [...group.memberIds, other.id] }, group)
      children.push(f.store.delegate(relay.id, other.id, "Review two", "leave-second-review"))
    }
    f.store.settle(f.root.id, "completed", null, "Waiting", undefined, true)
    f.store.settle(relay.id, "completed", null, "Waiting", undefined, true)
    for (const child of children) finish(f.store, child, "Reviewed", true)
    f.store.flushReplies()
    const integrations = f.store.recentTasks().filter(t => t.botId === f.bots[1].id && t.state === "queued")
    const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null })
    hosts.push(host)
    host.saveGroup({ name: group.name, memberIds: group.memberIds.filter(id => id !== f.bots[1].id) }, group)
    f.store.flushReplies()
    const replies = f.store.recentTasks().filter(t => t.botId === f.bots[0].id && t.origin.kind === "bot")
    expect(replies).toHaveLength(1)
    expect(replies[0].message).toContain("协作已取消")
    expect(integrations.every(t => f.store.getTask(t.id).state === "cancelled")).toBe(true)
    expect(f.store.getTask(relay.id).state).toBe("cancelled")
  })

  it.each([false, true])("preserves an already delivered failure when the relay leaves (consumed=%s)", async (consumed) => {
    const f = fixture(2, "group", false)
    const relay = f.chain[1], leaf = f.chain[2], group = f.group!
    f.store.settle(f.root.id, "completed", null, "Waiting", undefined, true)
    f.store.settle(relay.id, "failed", "Provider failed")
    const prior = receipt(f.store, relay)
    if (consumed) finish(f.store, prior, "Failure acknowledged", true)
    f.store.settle(leaf.id, "completed", null, "FACT", undefined, true)
    const integration = receipt(f.store, leaf)
    const errors = vi.fn()
    const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null }, 1, errors)
    hosts.push(host)
    host.saveGroup({ name: group.name, memberIds: group.memberIds.filter(id => id !== relay.botId) }, group)
    expect(() => f.store.flushReplies()).not.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    expect(errors).not.toHaveBeenCalled()
    expect(f.store.getTask(integration.id).state).toBe("cancelled")
    expect(f.store.getTask(relay.id).state).toBe("cancelled")
    const returned = f.store.recentTasks().filter(t => t.botId === f.bots[0].id && t.origin.kind === "bot")
    expect(returned).toHaveLength(1)
    expect(returned[0].id).toBe(prior.id)
    expect(returned[0].message).toContain("Provider failed")
    expect(() => host.send({ botId: leaf.botId, requestId: "after-leave", message: "Unrelated" })).not.toThrow()
  })

  it.each(["private", "work", "group"] as const)("shows nested results and cancellations in the original %s exchange", (scope) => {
    for (const cancelled of [false, true]) {
      const f = fixture(2, scope)
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const integration = receipt(f.store, f.chain[2])
      if (cancelled) {
        const middle = f.store.getBot(f.bots[1].id)
        f.store.update({ ...middle, expectedVersion: middle.version, archived: true })
      } else finish(f.store, integration, "FINAL_INTEGRATION", Boolean(f.group))
      const expected = cancelled ? "Bot 已归档" : "FINAL_INTEGRATION"
      const exchange = () => f.store.exchange(f.bots[0].id, f.chain[1].id, f.group?.id, f.work?.id)
      expect(exchange().reply?.message).toContain(expected)
      expect(exchange().reply?.delivered).toBe(false)
      f.store.flushReplies()
      expect(exchange().reply?.message).toContain(expected)
      expect(exchange().reply?.delivered).toBe(true)
      expect(f.store.exchangeHistory(f.bots[0].id, f.chain[1].id, f.group?.id, undefined, f.work?.id)
        .items.find(item => item.taskId === f.chain[1].id)?.reply?.message).toContain(expected)
    }
  })

  it("does not confuse two handoffs to the same peer under one root in exchange history", () => {
    const f = fixture(2, "private", false)
    const second = f.store.delegate(f.root.id, f.bots[1].id, "Separate request", "separate-request")
    f.store.settle(f.root.id, "completed", null, "Waiting")
    f.store.settle(f.chain[1].id, "completed", null, "Waiting")
    f.store.settle(f.chain[2].id, "completed", null, "FACT")
    const integration = receipt(f.store, f.chain[2])
    finish(f.store, integration, "FIRST_INTEGRATED")
    finish(f.store, second, "SECOND_DIRECT")
    f.store.flushReplies()
    expect(f.store.exchange(f.bots[0].id, f.chain[1].id).reply?.message).toBe("FIRST_INTEGRATED")
    expect(f.store.exchange(f.bots[0].id, second.id).reply?.message).toBe("SECOND_DIRECT")
  })

  it("does not reactivate an archived intermediate after a late child finishes", () => {
    const f = fixture()
    const middle = f.store.getBot(f.bots[1].id)
    expect(() => f.store.update({ ...middle, expectedVersion: middle.version, archived: true }))
      .toThrow("关联协作")
    // Old versions permitted this state. Retain the late-result guard for stored history.
    f.db.run("UPDATE bots SET archived=1 WHERE id=?", [middle.id])
    const archived = f.store.getBot(middle.id)
    f.store.settle(f.chain[2].id, "completed", null, "FACT")
    f.store.flushReplies()
    f.store.update({ ...archived, expectedVersion: archived.version, archived: false })
    f.store.flushReplies()
    expect(f.store.recentTasks().some((task) => task.requestId === `reply-${f.chain[2].id}`)).toBe(
      false
    )
  })

  it("keeps a stale final route closed when its work is completed", () => {
    const f = fixture(2, "work")
    f.store.settle(f.chain[2].id, "completed", null, "FACT")
    const intermediate = receipt(f.store, f.chain[2])
    finish(f.store, intermediate, "FINAL_FACT")
    f.db.run("UPDATE bot_work_items SET state='completed' WHERE id=?", [f.work!.id])
    f.store.flushReplies()
    expect(
      f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
    ).toBe(false)
  })

  it("preserves the existing unlink guard while a nested result is pending", () => {
    const f = fixture(2, "work")
    const ref = {
      kind: "local_thread" as const,
      threadId: f.work!.threadId,
      incarnation: { token: "synthetic-incarnation", legacyCreatedAt: 1000 }
    }
    f.store.conversations.prepareCreated(f.bots[0].id, f.work!.id, ref)
    const work = f.store.conversations.bound(f.bots[0].id, f.work!.id, ref)
    expect(() => f.store.conversations.beginDetach(work.botId, work.id, work.version)).toThrow(
      "协作结果"
    )
    expect(f.store.conversations.record(work.id)?.state).toBe("bound")
  })

  it.each(["bot", "root", "work", "family", "group", "remote"] as const)(
    "refuses a mismatched %s upstream owner",
    (mismatch) => {
      const f = fixture()
      f.store.settle(f.chain[2].id, "completed", null, "FACT")
      const intermediate = receipt(f.store, f.chain[2])
      const original = f.store.getTask(f.chain[1].id)
      if (mismatch === "bot")
        f.db.run("UPDATE bot_tasks SET bot_id=? WHERE id=?", [f.bots[2].id, original.id])
      else if (mismatch === "work")
        f.db.run("UPDATE bot_tasks SET work_id='another-work' WHERE id=?", [original.id])
      else if (mismatch === "remote")
        f.db.run("UPDATE bot_tasks SET mock_source_json=? WHERE id=?", [
          JSON.stringify({
            bindingId: "synthetic-binding",
            grantVersion: 1,
            conversationId: "synthetic-conversation",
            audienceKey: "mock:synthetic-binding",
            eventId: "synthetic-event",
            messageId: "synthetic-message",
            senderId: "synthetic-sender"
          }),
          original.id
        ])
      else
        f.db.run("UPDATE bot_tasks SET origin_json=? WHERE id=?", [
          JSON.stringify({
            ...original.origin,
            ...(mismatch === "root"
              ? { rootTaskId: "another-root" }
              : mismatch === "family"
                ? { rootWorkId: "another-work" }
                : { groupId: "another-group" })
          }),
          original.id
        ])
      finish(f.store, intermediate, "UNRELATED_RESULT")
      f.store.flushReplies()
      expect(
        f.store.recentTasks().some((task) => task.requestId === `reply-${intermediate.id}`)
      ).toBe(false)
    }
  )

  it("returns the group aggregate internally without automatically publishing it again", () => {
    const f = fixture(2, "group")
    const leaf = f.chain[2]
    f.store.publishGroupMessage(leaf.id, "leaf", "PUBLIC_FACT")
    f.store.settle(leaf.id, "completed", null, "PUBLIC_FACT", undefined, true)
    const intermediate = receipt(f.store, leaf)
    finish(f.store, intermediate, "Already public", true)
    f.store.flushReplies()
    expect(
      f.store.groupMessages(f.group!.id).filter((message) => message.text === "PUBLIC_FACT")
    ).toHaveLength(1)
    const final = receipt(f.store, intermediate)
    expect(final.botId).toBe(f.bots[0].id)
    finish(f.store, final, "Already public", true)
    f.store.flushReplies()
    expect(f.store.recentTasks().some((task) => task.requestId === `reply-${final.id}`)).toBe(false)
    expect(f.store.groupMessages(f.group!.id).filter((message) => message.text === "PUBLIC_FACT"))
      .toHaveLength(1)
  })

  it.each(["cancelled", "interrupted"] as const)(
    "returns an intermediate group %s immediately and fences its late child",
    (state) => {
      const f = fixture(2, "group", false)
      const middle = f.chain[1], leaf = f.chain[2]
      f.store.settle(middle.id, state, "STOP_REASON", undefined, undefined, true)
      const notice = receipt(f.store, middle)
      expect(notice.botId).toBe(f.bots[0].id)
      expect(notice.message).toContain("STOP_REASON")
      f.store.settle(leaf.id, "completed", null, "LATE_RESULT", undefined, true)
      f.store.flushReplies()
      expect(f.store.recentTasks().some(task => task.requestId === `reply-${leaf.id}`)).toBe(false)
    }
  )

  it("reports a group relay failure while preserving an already-running child's later result", () => {
    const f = fixture(2, "group", false)
    f.store.settle(f.chain[1].id, "failed", "RELAY_ERROR", undefined, undefined, true)
    expect(receipt(f.store, f.chain[1]).message).toContain("RELAY_ERROR")
    f.store.settle(f.chain[2].id, "completed", null, "ACTUAL_LATE_RESULT", undefined, true)
    const integration = receipt(f.store, f.chain[2])
    finish(f.store, integration, "Recovered using ACTUAL_LATE_RESULT", true)
    expect(receipt(f.store, integration).message).toContain("ACTUAL_LATE_RESULT")
  })

  it("keeps a group relay pending until a queued child receipt has been integrated", () => {
    const f = fixture(2, "group", false)
    f.store.settle(f.chain[2].id, "completed", null, "FACT", undefined, true)
    const integration = receipt(f.store, f.chain[2])
    f.store.settle(f.chain[1].id, "completed", null, "Waiting", undefined, true)
    f.store.flushReplies()
    expect(f.store.recentTasks().some(task => task.requestId === `reply-${f.chain[1].id}`)).toBe(false)
    finish(f.store, integration, "INTEGRATED", true)
    expect(receipt(f.store, integration).message).toContain("INTEGRATED")
  })

  it("returns only this integration's verified files and imports their unchanged bytes through the existing delivery tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmb-nested-reply-"))
    try {
      const f = fixture()
      const [owner, intermediate, leaf] = ["owner", "intermediate", "leaf"].map((name) =>
        join(directory, name)
      )
      await Promise.all([owner, intermediate, leaf].map((path) => mkdir(path)))
      const bytes = Buffer.from("\ufeffid,amount\r\nactual,74.13\r\n", "utf8")
      await writeFile(join(leaf, "result.csv"), bytes)
      const signal = new AbortController().signal
      const leafFiles = await verifyBotDeliveryFiles(leaf, ["result.csv"], signal)
      f.store.settle(f.chain[2].id, "completed", null, "CSV verified", leafFiles)
      const integrated = receipt(f.store, f.chain[2])
      expect(integrated.origin).toMatchObject({ replyFiles: leafFiles })
      let captured: BotDeliveredFile[] | undefined
      const [deliverToIntermediate] = createBotDeliveryTools(
        intermediate,
        signal,
        (files) => {
          captured = files
        },
        {
          workspacePath: leaf,
          files: leafFiles
        }
      )
      await deliverToIntermediate.invoke({ files: [leafFiles[0].filePath] })
      expect(captured).toHaveLength(1)
      expect(await readFile(captured![0].filePath)).toEqual(bytes)
      f.store.transition(integrated.id, "running")
      f.store.settle(integrated.id, "completed", null, "Integrated CSV verified", captured)
      const final = receipt(f.store, integrated)
      expect(final.origin).toMatchObject({ fromBotId: f.bots[1].id, replyFiles: captured })
      expect(final.message).toContain(captured![0].filePath)
      const [deliverToOwner] = createBotDeliveryTools(owner, signal, undefined, {
        workspacePath: intermediate,
        files: captured!
      })
      const output = JSON.parse(
        String(await deliverToOwner.invoke({ files: [captured![0].filePath] }))
      )
      expect(output.kind).toBe("bot-file-delivery")
      expect(await readFile(output.files[0].attachmentPath ?? output.files[0].filePath)).toEqual(
        bytes
      )
      expect(await readFile(join(leaf, "result.csv"))).toEqual(bytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("retains the upstream record while a late child is live and prunes the completed family through the existing policy", () => {
    const f = fixture()
    f.advance(31 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 105; i++) {
      const unrelated = f.store.enqueue({
        botId: f.bots[0].id,
        requestId: `unrelated-${i}`,
        message: "Unrelated"
      })
      finish(f.store, unrelated, "Done")
    }
    f.store.pruneTaskHistory()
    expect(f.store.getTask(f.chain[1].id).id).toBe(f.chain[1].id)
    f.store.settle(f.chain[2].id, "completed", null, "LATE_FACT")
    const intermediate = receipt(f.store, f.chain[2])
    finish(f.store, intermediate, "LATE_INTEGRATION")
    const final = receipt(f.store, intermediate)
    expect(final.message).toContain("LATE_INTEGRATION")
    finish(f.store, final, "Done")
    for (const pending of f.store.recentTasks().filter((task) => task.state === "queued"))
      finish(f.store, pending, "Done")
    f.advance(31 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 105; i++) {
      const unrelated = f.store.enqueue({
        botId: f.bots[0].id,
        requestId: `tail-${i}`,
        message: "Unrelated"
      })
      finish(f.store, unrelated, "Done")
    }
    while (f.store.pruneTaskHistory()) {
      /* Existing bounded batches. */
    }
    expect(() => f.store.getTask(f.chain[1].id)).toThrow("不存在")
    expect(f.store.exchange(f.bots[0].id, f.chain[1].id).sender.id).toBe(f.bots[0].id)
  })

  it("uses the existing Host pump and leases to run a nested result back to its original conversation", async () => {
    const f = fixture(0)
    f.store.settle(f.root.id, "completed", null, "Earlier unrelated history")
    const peers = [
      f.bots[0],
      ...["Middle", "Leaf"].map((name) =>
        f.store.create({ name, instructions: "", color: "#123456", modelRef: null })
      )
    ]
    const executed: BotTask[] = []
    const errors = vi.fn()
    let host: LocalBotHost
    const runtime: BotRunPort = {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        async execute() {
          executed.push(task)
          if (task.origin.kind === "user") {
            host.delegate(task.id, peers[1].id, "Analyze with the leaf", "middle")
            return { state: "completed", result: "Waiting for middle" }
          }
          if (
            task.botId === peers[1].id &&
            task.origin.kind === "bot" &&
            task.origin.expectsReply
          ) {
            host.delegate(task.id, peers[2].id, "Verify a synthetic fact", "leaf")
            return { state: "completed", result: "Waiting for leaf" }
          }
          return {
            state: "completed",
            result:
              task.botId === peers[2].id || task.message.includes("HOST_FACT")
                ? "Integrated HOST_FACT"
                : "Progress recorded"
          }
        }
      })
    }
    host = new LocalBotHost(f.store, runtime, 2, errors)
    hosts.push(host)
    host.send({ botId: peers[0].id, requestId: "host-root", message: "Analyze" })
    await vi.waitFor(() => {
      expect(
        executed.filter((task) => task.botId === peers[0].id && task.message.includes("HOST_FACT"))
      ).toHaveLength(1)
      expect(f.store.recentTasks().every((task) => task.state === "completed")).toBe(true)
    })
    expect(errors).not.toHaveBeenCalled()
    expect(executed.filter((task) => task.botId === peers[2].id)).toHaveLength(1)
    expect(executed.filter((task) => task.botId === peers[1].id)).toHaveLength(2)
  })

  it("cancels an already queued downstream receipt when its still-active intermediate handoff is stopped", async () => {
    const f = fixture(0)
    f.store.settle(f.root.id, "completed", null, "Earlier unrelated history")
    const middle = f.store.create({
      name: "Middle",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    const leaf = f.store.create({
      name: "Leaf",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    const resumed = vi.fn()
    const errors = vi.fn()
    let host: LocalBotHost, original: BotTask | undefined, child: BotTask | undefined
    host = new LocalBotHost(
      f.store,
      {
        onAvailable: () => () => {},
        acquire: (_bot, task) => ({
          release() {},
          async execute(signal, waiting) {
            if (task.origin.kind === "user") {
              original = host.delegate(task.id, middle.id, "Consult leaf", "middle")
              return { state: "completed", result: "Middle is working" }
            }
            if (
              task.botId === middle.id &&
              task.origin.kind === "bot" &&
              task.origin.expectsReply
            ) {
              child = host.delegate(task.id, leaf.id, "Verify", "leaf")
              waiting(true)
              await new Promise<never>((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })
              )
            }
            if (task.botId === middle.id) resumed(task)
            return { state: "completed", result: "FACT" }
          }
        })
      },
      2,
      errors
    )
    hosts.push(host)
    host.send({ botId: f.bots[0].id, requestId: "host-stop-root", message: "Analyze" })
    await vi.waitFor(() => {
      expect(child).toBeDefined()
      expect(
        f.store.recentTasks().find((task) => task.requestId === `reply-${child!.id}`)?.state
      ).toBe("queued")
      expect(f.store.getTask(original!.id).state).toBe("waiting_user")
    })
    const queued = f.store.recentTasks().find((task) => task.requestId === `reply-${child!.id}`)!
    host.cancel(original!.id)
    await vi.waitFor(() => expect(f.store.getTask(original!.id).state).toBe("cancelled"))
    expect(f.store.getTask(queued.id).state).toBe("cancelled")
    expect(resumed).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it.each(["before return", "after return"] as const)(
    "keeps the actual receipt turn stopped when its further peer finishes %s",
    async (when) => {
      const f = fixture(0)
      f.store.settle(f.root.id, "completed", null, "Earlier unrelated history")
      const [middle, leaf, extra] = ["Middle", "Leaf", "Extra"].map((name) =>
        f.store.create({ name, instructions: "", color: "#123456", modelRef: null })
      )
      const resumed = vi.fn(),
        errors = vi.fn()
      let host: LocalBotHost,
        firstChild: BotTask | undefined,
        activeReceipt: BotTask | undefined,
        lastChild: BotTask | undefined
      let releaseExtra!: () => void
      const extraReady = new Promise<void>((resolve) => {
        releaseExtra = resolve
      })
      host = new LocalBotHost(
        f.store,
        {
          onAvailable: () => () => {},
          acquire: (_bot, task) => ({
            release() {},
            async execute(signal, waiting) {
              if (task.origin.kind === "user")
                host.delegate(task.id, middle.id, "Consult leaf", "middle")
              else if (
                task.botId === middle.id &&
                task.origin.kind === "bot" &&
                task.origin.expectsReply
              )
                firstChild = host.delegate(task.id, leaf.id, "Verify", "leaf")
              else if (task.botId === middle.id && task.requestId === `reply-${firstChild!.id}`) {
                activeReceipt = task
                lastChild = host.delegate(task.id, extra.id, "One more detail", "extra")
                waiting(true)
                await new Promise<never>((_resolve, reject) =>
                  signal.addEventListener("abort", () => reject(new Error("Stopped")), {
                    once: true
                  })
                )
              } else if (task.botId === extra.id) await extraReady
              else if (task.botId === middle.id) resumed(task)
              return { state: "completed", result: "FACT" }
            }
          })
        },
        2,
        errors
      )
      hosts.push(host)
      host.send({ botId: f.bots[0].id, requestId: "host-receipt-stop", message: "Analyze" })
      await vi.waitFor(() => {
        expect(lastChild).toBeDefined()
        expect(f.store.getTask(activeReceipt!.id).state).toBe("waiting_user")
      })
      if (when === "after return") {
        releaseExtra()
        await vi.waitFor(() =>
          expect(
            f.store.recentTasks().find((task) => task.requestId === `reply-${lastChild!.id}`)?.state
          ).toBe("queued")
        )
      }
      host.cancel(activeReceipt!.id)
      await vi.waitFor(() => expect(f.store.getTask(activeReceipt!.id).state).toBe("cancelled"))
      releaseExtra()
      await vi.waitFor(() => expect(f.store.getTask(lastChild!.id).state).toBe(when === "after return" ? "completed" : "cancelled"))
      const late = f.store.recentTasks().find((task) => task.requestId === `reply-${lastChild!.id}`)
      expect(late?.state ?? "cancelled").toBe("cancelled")
      expect(resumed).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    }
  )

  it.each(["complete", "cancel"] as const)(
    "cascades Stop while retaining each started result's command owner until its own %s receipt",
    async (outcome) => {
      const f = fixture(0)
      f.store.settle(f.root.id, "completed", null, "Earlier unrelated history")
      const [middle, leaf, extra] = ["Middle", "Leaf", "Extra"].map((name) =>
        f.store.create({ name, instructions: "", color: "#123456", modelRef: null })
      )
      const lifecycles = new Map<string, BackgroundCommandLifecycle>()
      const pendingStops = new Map<string, () => void>()
      const executions: string[] = []
      const errors = vi.fn()
      let host: LocalBotHost,
        firstChild: BotTask | undefined,
        source: BotTask | undefined,
        resumed: BotTask | undefined
      let releaseExtra!: () => void
      const extraReady = new Promise<void>((resolve) => {
        releaseExtra = resolve
      })
      const cancelCommands = vi.fn(async (_threadId: string, ids: readonly string[]) => {
        await new Promise<void>((resolve) => {
          pendingStops.set(ids[0], resolve)
        })
      })
      const command = (task: BotTask, id: string) => ({
        id,
        threadId: task.threadId,
        command: "Synthetic command (never executed)",
        cwd: "/synthetic",
        startedAt: 1000
      })
      const result = (id: string, cancelled: boolean) => ({
        id,
        threadId: middle.threadId,
        output: cancelled ? "ACTUAL_STOPPED" : "ACTUAL_CHILD_RESULT",
        exitCode: cancelled ? 130 : 0,
        truncated: false,
        cancelled
      })
      host = new LocalBotHost(
        f.store,
        {
          onAvailable: () => () => {},
          cancelCommands,
          acquire: (_bot, task) => ({
            release() {},
            async execute() {
              if (task.origin.kind === "user")
                host.delegate(task.id, middle.id, "Consult leaf", "middle")
              else if (
                task.botId === middle.id &&
                task.origin.kind === "bot" &&
                task.origin.expectsReply
              )
                firstChild = host.delegate(task.id, leaf.id, "Verify", "leaf")
              else if (task.botId === middle.id && task.requestId === `reply-${firstChild!.id}`) {
                source = task
                executions.push("source-start")
                host.delegate(task.id, extra.id, "One more detail", "extra")
                const lifecycle = host.commandLifecycle(task.id, true)
                lifecycles.set("source-command", lifecycle)
                lifecycle.accepted(command(task, "source-command"))
                return { state: "deferred", checkpointId: "source-checkpoint" }
              } else if (task.botId === extra.id) await extraReady
              else if (task.botId === middle.id) {
                resumed = task
                const checkpoint = f.store.taskCheckpoint(task.id)
                executions.push(checkpoint ? "child-resume" : "child-start")
                if (!checkpoint) {
                  const lifecycle = host.commandLifecycle(task.id, true)
                  lifecycles.set("child-command", lifecycle)
                  lifecycle.accepted(command(task, "child-command"))
                  return { state: "deferred", checkpointId: "child-checkpoint" }
                }
                expect(checkpoint).toBe("child-checkpoint")
                expect(f.store.continuationCommandResults(task.id)).toEqual([
                  expect.objectContaining({
                    task_id: "child-command",
                    output: "ACTUAL_CHILD_RESULT"
                  })
                ])
                return { state: "completed", result: "ACTUAL_CHILD_RESULT verified" }
              }
              return { state: "completed", result: "FACT" }
            }
          })
        },
        2,
        errors
      )
      hosts.push(host)
      host.send({ botId: f.bots[0].id, requestId: "managed-child-root", message: "Analyze" })
      await vi.waitFor(() => expect(f.store.taskCheckpoint(source!.id)).toBe("source-checkpoint"))
      releaseExtra()
      await vi.waitFor(() => {
        expect(resumed).toBeDefined()
        expect(f.store.taskCheckpoint(resumed!.id)).toBe("child-checkpoint")
      })
      expect(f.store.continuationCommandIds(source!.id)).toEqual(["source-command"])
      expect(f.store.continuationCommandIds(resumed!.id)).toEqual(["child-command"])
      host.cancel(source!.id)
      host.cancel(source!.id)
      await vi.waitFor(() => expect(cancelCommands).toHaveBeenCalledTimes(2))
      expect(cancelCommands.mock.calls).toEqual([
        [middle.threadId, ["source-command"]], [middle.threadId, ["child-command"]]
      ])
      expect(f.store.getTask(source!.id).state).toBe("queued")
      expect(f.store.getTask(resumed!.id).state).toBe("queued")
      lifecycles.get("source-command")!.settled(result("source-command", true))
      pendingStops.get("source-command")!()
      await vi.waitFor(() => expect(f.store.getTask(source!.id).state).toBe("cancelled"))
      expect(f.store.getTask(resumed!.id).state).toBe("queued")
      expect(f.store.taskCheckpoint(resumed!.id)).toBe("child-checkpoint")
      expect(f.store.continuationCommandIds(resumed!.id)).toEqual(["child-command"])
      expect(f.store.nextQueued([])).toBeNull()
      if (outcome === "complete") {
        lifecycles.get("child-command")!.settled(result("child-command", false))
        expect(f.store.getTask(resumed!.id).state).toBe("queued")
        expect(f.store.continuationCommandResults(resumed!.id)).toEqual([
          expect.objectContaining({ task_id: "child-command", exitCode: 0, output: "ACTUAL_CHILD_RESULT", state: "completed" })
        ])
        pendingStops.get("child-command")!()
        await vi.waitFor(() => expect(f.store.getTask(resumed!.id).state).toBe("cancelled"))
        expect(executions).toEqual(["source-start", "child-start"])
        expect(cancelCommands).toHaveBeenCalledTimes(2)
      } else {
        host.cancel(resumed!.id)
        await vi.waitFor(() =>
          expect(cancelCommands).toHaveBeenLastCalledWith(middle.threadId, ["child-command"])
        )
        expect(f.store.getTask(resumed!.id).state).toBe("queued")
        lifecycles.get("child-command")!.settled(result("child-command", true))
        pendingStops.get("child-command")!()
        await vi.waitFor(() => expect(f.store.getTask(resumed!.id).state).toBe("cancelled"))
        expect(executions).toEqual(["source-start", "child-start"])
        expect(cancelCommands).toHaveBeenCalledTimes(2)
      }
      expect(f.store.activeCommandThreads()).toEqual([])
      expect(f.store.pendingTasksForThread(middle.threadId)).toEqual([])
      expect(f.store.recentTasks().some((task) => task.requestId === `reply-${resumed!.id}`)).toBe(
        false
      )
      expect(errors).not.toHaveBeenCalled()
    }
  )
})

// A result turn resumes the whole original handoff, not just its own children.
it.each(["private", "work", "group"] as const)("waits for sibling results before returning the %s aggregate", scope => {
  const { store, bots, chain, root, group } = fixture(1, scope, false, ["report.txt"])
  const parent = chain[1]
  const peers = ["Fast", "Slow", "Follow-up"].map(name => store.create({ name, instructions: "", color: "#123456", modelRef: null }))
  if (group) store.saveGroup({ name: group.name, memberIds: [...group.memberIds, ...peers.map(b => b.id)] }, { id: group.id, version: group.version })
  const fast = store.delegate(parent.id, peers[0].id, "First review", "fast")
  const slow = store.delegate(parent.id, peers[1].id, "Second review", "slow")
  store.settle(root.id, "completed", null, "Dispatched", undefined, Boolean(group))
  store.settle(parent.id, "completed", null, "Waiting", undefined, Boolean(group))
  store.transition(fast.id, "running")
  store.transition(slow.id, "running")
  store.settle(fast.id, "completed", null, "First result", undefined, Boolean(group))
  store.flushReplies()
  const first = store.recentTasks().find(t => t.requestId === `reply-${fast.id}`)!
  store.transition(first.id, "running")
  expect(store.peerHandoff(first.id)).toMatchObject({ owned: true, pending: true, outputFiles: ["report.txt"] })
  // A receipt may also dispatch its own follow-up, which belongs to this handoff.
  const followup = store.delegate(first.id, peers[2].id, "Check extra detail", "followup")
  store.settle(first.id, "completed", null, "Awaiting remaining reviews", undefined, Boolean(group))
  store.flushReplies()
  expect(store.recentTasks().some(t => t.requestId === `reply-${first.id}`)).toBe(false)
  store.settle(slow.id, "completed", null, "Second result", undefined, Boolean(group))
  store.flushReplies()
  const second = store.recentTasks().find(t => t.requestId === `reply-${slow.id}`)!
  store.transition(second.id, "running")
  expect(store.peerHandoff(second.id).pending).toBe(true)
  store.settle(second.id, "completed", null, "Awaiting follow-up", undefined, Boolean(group))
  store.transition(followup.id, "running")
  store.settle(followup.id, "completed", null, "Final detail", undefined, Boolean(group))
  store.flushReplies()
  const final = store.recentTasks().find(t => t.requestId === `reply-${followup.id}`)!
  store.transition(final.id, "running")
  expect(store.peerHandoff(final.id)).toMatchObject({ owned: true, pending: false, outputFiles: ["report.txt"] })
  store.settle(final.id, "completed", null, "Integrated report", undefined, Boolean(group))
  store.flushReplies()
  const deliveries = store.recentTasks().filter(t => t.origin.kind === "bot" && !t.origin.expectsReply && t.botId === bots[0].id)
  expect(deliveries).toHaveLength(1)
  expect(deliveries[0].message).toContain("Integrated report")
})
