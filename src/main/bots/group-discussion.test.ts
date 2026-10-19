import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { BOT_GROUP_PASS, isBotGroupPass } from "../../shared/bots/group-discussion"
import type { BotTask } from "../../shared/bots/contracts"
import { buildBotPrompt } from "./prompt"
import { buildGroupDiscussionMessage } from "./group-discussion"

const databases: NativeSqliteAdapter[] = []
const hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  databases.splice(0).forEach((db) => db.close())
})
function fixture(count = 2) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db, () => 1000)
  const members = Array.from({ length: count }, (_, i) =>
    store.create({
      name: i < 2 ? "Same name" : `Member ${i}`,
      instructions: "",
      modelRef: null,
      color: "#ff0000"
    })
  )
  const group = store.saveGroup({ name: "Room", memberIds: members.map((bot) => bot.id) })
  const send = (key = "assignment", targets = [members[0].id]) => {
    store.sendGroup({
      groupId: group.id,
      requestId: key,
      text: `Check ${key}`,
      targetBotIds: targets
    })
    return store
      .recentTasks()
      .filter((task) => task.origin.kind === "group" && task.origin.messageId === key)
  }
  const finish = (task: BotTask, result = BOT_GROUP_PASS) => {
    store.transition(task.id, "running")
    store.settle(task.id, "completed", null, result)
  }
  const reviews = () => store.recentTasks().filter((task) => task.origin.kind === "discussion")
  return { db, store, members, group, send, finish, reviews }
}

describe("bounded group discussion on the existing Bot queue", () => {
  it("keeps the full current request and whole newest peer records within the message budget", () => {
    const assignment = "\n".repeat(29_999) + "X"
    const refs = Array.from({ length: 50 }, (_, i) => ({
      source: "Bot b",
      text: `${i}:` + "\0".repeat(1000)
    }))
    const message = buildGroupDiscussionMessage(assignment, refs)
    expect(message).toContain(assignment)
    expect(message.length).toBeLessThan(64_000)
    expect(message).toContain("Earlier references omitted")
    const data = JSON.parse(message.split("identities:\n")[1].split("\n\n")[0])
    expect(data.at(-1)).toEqual(refs.at(-1))
    expect(data.length).toBeGreaterThan(0)
    expect(data.length).toBeLessThan(24)
  })

  it("does not relabel an older room task as newly delivered context for a fresh request", () => {
    const f = fixture()
    f.finish(f.send("older-task")[0], "OLD_RESULT_NOT_CURRENT_PROOF")
    f.finish(f.send("current-task")[0], "NEW_RESULT_CURRENT_PROOF")
    f.store.advanceGroupDiscussions()
    const review = f.reviews()[0]
    expect(review.message).toContain("Check current-task")
    expect(review.message).toContain("NEW_RESULT_CURRENT_PROOF")
    expect(review.message).not.toContain("OLD_RESULT_NOT_CURRENT_PROOF")
    expect(review.message).toContain("an earlier peer reply does not prove")
  })
  it("waits for initial recipients, queues one exact peer, and settles a silent round without bubbles or unread", () => {
    const f = fixture()
    const root = f.send()[0]
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
    f.finish(root, "Original result")
    const activity = f.store.activities().find((item) => item.id === f.group.id)
    f.store.advanceGroupDiscussions()
    const review = f.reviews()[0]
    expect(review).toMatchObject({
      botId: f.members[1].id,
      threadId: `group-${f.group.id}-${f.members[1].id}`,
      origin: { kind: "discussion", messageId: "assignment", round: 1 }
    })
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
    expect(f.store.hasDirectUserRequest(review.id)).toBe(false)
    expect(f.store.groupMessages(f.group.id).map((item) => item.text)).toEqual([
      "Check assignment",
      "Original result"
    ])
    f.finish(review, "<think>No missing work</think>(pass)")
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
    expect(f.store.activities().find((item) => item.id === f.group.id)).toEqual(activity)
    expect(
      f.store.groupMessages(f.group.id).some((item) => /pass|没有可确认/.test(item.text))
    ).toBe(false)
    expect(f.db.exec("SELECT * FROM bot_group_discussions")[0].values).toEqual([])
  })

  it("feeds new shared evidence to the original author and stops after a pass, without private turns", () => {
    const f = fixture()
    f.finish(f.send()[0], "Draft 17+8=24")
    f.store.advanceGroupDiscussions()
    f.finish(f.reviews()[0], "Correction 17+8=25")
    f.store.advanceGroupDiscussions()
    const review = f.reviews().find((task) => task.state === "queued")!
    expect(review.botId).toBe(f.members[0].id)
    expect(review.message).toContain("Correction 17+8=25")
    expect(review.message).toContain(f.members[1].id)
    const prompt = buildBotPrompt(f.members[0], review, "/group")
    expect(prompt).toContain("optional continuation")
    expect(prompt).toContain("not a new user message")
    expect(prompt).toContain("no new permissions")
    expect(prompt).toContain("reply exactly (pass)")
    expect(prompt).not.toContain("direct user request in a group")
    f.finish(review)
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(2)
    expect(
      f.store.recentTasks().every((task) => task.threadId.startsWith(`group-${f.group.id}-`))
    ).toBe(true)
    expect(f.store.groupMessages(f.group.id).map((item) => item.text)).toEqual([
      "Check assignment",
      "Draft 17+8=24",
      "Correction 17+8=25"
    ])
  })

  it("waits for all selected members and actual peer handoff receipts before reviewing", () => {
    const f = fixture(3)
    const roots = f.send(
      "all",
      f.members.map((bot) => bot.id)
    )
    const source = roots.find((task) => task.botId === f.members[0].id)!
    f.store.transition(source.id, "running")
    const peer = f.store.delegate(source.id, f.members[1].id, "Check shared result", "check")
    f.store.settle(source.id, "completed", null, "Asked peer")
    roots
      .filter((task) => task.id !== source.id)
      .forEach((task) => f.finish(task, "Initial result"))
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
    f.finish(peer, "Verified")
    f.store.flushReplies()
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
    const receipt = f.store.recentTasks().find((task) => task.requestId === `reply-${peer.id}`)!
    f.finish(receipt, "Integrated")
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
  })

  it("does not resurrect initial failed/cancelled work or activate historical groups on migration", () => {
    const f = fixture()
    const root = f.send()[0]
    f.store.transition(root.id, "cancelled")
    new BotStore(f.db).advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
    f.db.run("DELETE FROM bot_group_discussions")
    new BotStore(f.db).advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
  })

  it("reuses a queued review across Store restart and never replays an interrupted review", () => {
    const f = fixture()
    f.finish(f.send()[0], "Ready")
    f.store.advanceGroupDiscussions()
    const review = f.reviews()[0]
    const reopened = new BotStore(f.db)
    reopened.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
    f.store.transition(review.id, "running")
    f.store.settle(review.id, "interrupted", "Application exited")
    new BotStore(f.db).advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
    expect(f.db.exec("SELECT * FROM bot_group_discussions")[0].values).toEqual([])
  })

  it("uses stable member IDs despite duplicate names, caps all selected/review calls at ten, and bounds rounds", () => {
    const f = fixture(8)
    f.send(
      "budget",
      f.members.map((bot) => bot.id)
    ).forEach((task) => f.finish(task, `Result from ${task.botId}`))
    for (let i = 0; i < 20; i++) {
      f.store.advanceGroupDiscussions()
      const next = f.reviews().find((task) => task.state === "queued")
      if (!next) break
      f.finish(next, `New evidence ${i}`)
    }
    expect(f.store.recentTasks()).toHaveLength(10)
    expect(f.reviews()).toHaveLength(2)
    expect(
      f.reviews().every((task) => task.origin.kind === "discussion" && task.origin.round < 3)
    ).toBe(true)
    expect(f.db.exec("SELECT * FROM bot_group_discussions")[0].values).toEqual([])
  })

  it("keeps literal pass replies from actual users or delegated work visible", () => {
    const f = fixture()
    f.finish(f.send()[0], BOT_GROUP_PASS)
    expect(f.store.groupMessages(f.group.id).at(-1)?.text).toBe(BOT_GROUP_PASS)
    expect(isBotGroupPass("(pass) plus real content")).toBe(false)
    expect(isBotGroupPass("<think>reason</think>(pass)")).toBe(true)
  })

  it("preserves the original 24-handoff limit and exact retries for explicit group work", () => {
    const f = fixture()
    const root = f.send()[0]
    f.store.transition(root.id, "running")
    const peers = Array.from({ length: 24 }, (_, i) =>
      f.store.delegate(root.id, f.members[1].id, `Check ${i}`, `check-${i}`)
    )
    expect(() => f.store.delegate(root.id, f.members[1].id, "Too much", "extra")).toThrow(
      "协作次数"
    )
    expect(f.store.delegate(root.id, f.members[1].id, "Check 0", "check-0").id).toBe(peers[0].id)
    expect(f.reviews()).toEqual([])
  })

  it("keeps optional discussion in its bounded room turns without starting a second relay chain", () => {
    const f = fixture()
    f.finish(f.send()[0], "Result")
    f.store.advanceGroupDiscussions()
    const review = f.reviews()[0]
    f.store.transition(review.id, "running")
    expect(() => f.store.delegate(review.id, f.members[0].id, "Another chain", "extra")).toThrow(
      "后续讨论请直接在本群回复"
    )
  })

  it("does not consume a review cursor while the ordinary queue is full", () => {
    const f = fixture()
    f.finish(f.send()[0], "Ready")
    for (let i = 0; i < 500; i++)
      f.store.enqueue({ botId: f.members[0].id, requestId: `private-${i}`, message: "Private" })
    const prior = f.db.exec("SELECT payload FROM bot_group_discussions")[0].values
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toEqual([])
    expect(f.db.exec("SELECT payload FROM bot_group_discussions")[0].values).toEqual(prior)
    // Simulate a normal private queue drain, not a separate review executor.
    f.store
      .recentTasks(true)
      .filter((task) => task.origin.kind === "user")
      .forEach((task) => f.store.transition(task.id, "cancelled"))
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
  })

  it("cancels queued reviews on membership change and does not revive them after a new user message", () => {
    const f = fixture()
    f.finish(f.send()[0], "Ready")
    f.store.advanceGroupDiscussions()
    f.store.saveGroup(
      { name: f.group.name, memberIds: [f.members[1].id] },
      { id: f.group.id, version: f.group.version }
    )
    f.store.advanceGroupDiscussions()
    expect(f.reviews()[0].state).toBe("cancelled")
    f.send("new-user", [f.members[1].id])
    f.finish(
      f.store
        .recentTasks()
        .find((task) => task.origin.kind === "group" && task.origin.messageId === "new-user")!,
      "New reply"
    )
    f.store.advanceGroupDiscussions()
    expect(f.reviews()).toHaveLength(1)
  })

  it("aborts an active review on a new group request, preserving cleanup and the new assignment", async () => {
    const f = fixture()
    let signal: AbortSignal | undefined
    const runtime: BotRunPort = {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        execute: async (abort) => {
          if (task.origin.kind !== "discussion") return { state: "completed", result: "Result" }
          signal = abort
          if (!abort.aborted)
            await new Promise<void>((resolve) =>
              abort.addEventListener("abort", () => resolve(), { once: true })
            )
          return { state: "completed", result: "Stale review" }
        },
        release: vi.fn()
      })
    }
    const host = new LocalBotHost(f.store, runtime)
    hosts.push(host)
    host.sendGroup({
      groupId: f.group.id,
      requestId: "first",
      text: "First",
      targetBotIds: [f.members[0].id]
    })
    await vi.waitFor(() => expect(signal).toBeDefined())
    host.sendGroup({
      groupId: f.group.id,
      requestId: "next",
      text: "Next",
      targetBotIds: [f.members[0].id]
    })
    expect(signal!.aborted).toBe(true)
    await vi.waitFor(() =>
      expect(
        f.store
          .recentTasks()
          .find((task) => task.origin.kind === "group" && task.origin.messageId === "next")?.state
      ).toBe("completed")
    )
    expect(f.store.groupMessages(f.group.id).some((item) => item.text === "Stale review")).toBe(
      false
    )
    host.stopConversation(f.members[0].id, f.group.id)
    // Stop every current member's queue through the existing cancellation path.
    host.stopConversation(f.members[1].id, f.group.id)
  })
})
