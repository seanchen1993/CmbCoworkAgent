import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { canonicalBotMessageInput } from "../../shared/bots/message-mentions"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import type { BotMessageMention } from "../../shared/bots/contracts"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const raw = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(raw)
  let now = 1000
  const reply = { id: "quoted", ordinal: 3, role: "assistant" as const, text: "Original" }
  const store = new BotStore(
    raw,
    () => now,
    undefined,
    () => reply
  )
  const create = (name: string) =>
    store.create({ name, instructions: "private instructions", color: "#ea2845", modelRef: null })
  return {
    raw,
    store,
    bot: create("Owner"),
    peer: create("A"),
    other: create("A"),
    reply,
    tick: () => {
      now++
    },
    advance: () => {
      now += 31 * 86400000
    }
  }
}
const selected = (botId: string): BotMessageMention[] => [{ start: 0, end: 2, botId, label: "A" }]
const check = (requestId: string, message: string, mentions?: BotMessageMention[]) => ({
  requestId,
  messageHash: createHash("sha256")
    .update(canonicalBotMessageInput(message, mentions))
    .digest("hex")
})

describe("private Bot selected mention persistence", () => {
  it("persists private group references by exact identity without posting or dispatching group members", () => {
    const f = fixture()
    const group = f.store.saveGroup({ name: "A", memberIds: [f.bot.id, f.peer.id] })
    const sameName = f.store.saveGroup({ name: "A", memberIds: [f.bot.id, f.other.id] })
    const mentions: BotMessageMention[] = [
      { start: 0, end: 2, kind: "group", groupId: group.id, label: "A" }
    ]
    const input = { botId: f.bot.id, requestId: "group-ref", message: "@A check", mentions }
    const task = f.store.enqueue(input)
    const renamed = f.store.saveGroup({ ...group, name: "Renamed" }, group)
    expect(f.store.enqueue(input).id).toBe(task.id)
    expect(() =>
      f.store.enqueue({
        ...input,
        mentions: [{ start: 0, end: 2, kind: "group", groupId: sameName.id, label: "A" }]
      })
    ).toThrow("请求标识")
    const restored = new BotStore(f.raw)
    expect(restored.messageOrigins(f.bot.id, [input.requestId])[0].origin).toEqual({
      kind: "user",
      mentions
    })
    expect(restored.recentTasks().map((entry) => entry.botId)).toEqual([f.bot.id])
    expect(restored.groupMessages(group.id)).toEqual([])
    expect(
      restored.requestReceipts(f.bot.id, [check(input.requestId, input.message, mentions)])[0].state
    ).toBe("accepted")
    f.store.saveGroup({ ...renamed, memberIds: [f.peer.id] }, renamed)
    expect(f.store.enqueue(input).id).toBe(task.id)
    expect(() => f.store.enqueue({ ...input, requestId: "group-left" })).toThrow("不可用")
  })
  it.each(["missing", "foreign-host", "deleting", "mismatched-id"])(
    "rejects unavailable private group references: %s",
    (state) => {
      const f = fixture()
      const group = f.store.saveGroup({ name: "A", memberIds: [f.bot.id, f.peer.id] })
      if (state !== "missing") {
        f.raw.run("UPDATE bot_groups SET payload=? WHERE id=?", [
          JSON.stringify({
            ...group,
            ...(state === "foreign-host"
              ? { hostId: "other" }
              : state === "mismatched-id"
                ? { id: "different-group" }
                : { deleting: true })
          }),
          group.id
        ])
      }
      expect(() =>
        f.store.enqueue({
          botId: f.bot.id,
          requestId: "unavailable",
          message: "@A",
          mentions: [
            {
              start: 0,
              end: 2,
              kind: "group",
              groupId: state === "missing" ? "missing" : group.id,
              label: "A"
            }
          ]
        })
      ).toThrow()
      expect(f.store.recentTasks()).toEqual([])
    }
  )
  it("retains exact IDs through rename/reopen and refuses same-nonce identity changes without dispatching peers", () => {
    const f = fixture(),
      mentions = selected(f.peer.id)
    const input = { botId: f.bot.id, requestId: "r", message: "@A check", mentions }
    const task = f.store.enqueue(input)
    expect(task.origin).toEqual({ kind: "user", mentions })
    f.store.update({ ...f.peer, name: "Renamed", expectedVersion: f.peer.version })
    expect(f.store.enqueue(input).id).toBe(task.id)
    expect(() => f.store.enqueue({ ...input, mentions: selected(f.other.id) })).toThrow("请求标识")
    const restored = new BotStore(f.raw)
    expect(restored.messageOrigins(f.bot.id, ["r"])[0].origin).toEqual(task.origin)
    expect(restored.messageOrigins(f.other.id, ["r"])).toEqual([])
    expect(restored.recentTasks().map((entry) => entry.botId)).toEqual([f.bot.id])
    expect(restored.requestReceipts(f.bot.id, [check("r", input.message, mentions)])[0].state).toBe(
      "accepted"
    )
    expect(
      restored.requestReceipts(f.bot.id, [check("r", input.message, selected(f.other.id))])[0].state
    ).toBe("conflict")
  })
  it("keeps selected references and digest receipts after original task pruning", () => {
    const f = fixture(),
      mentions = selected(f.peer.id)
    const task = f.store.enqueue({ botId: f.bot.id, requestId: "old", message: "@A", mentions })
    f.store.transition(task.id, "cancelled")
    f.tick()
    for (let i = 0; i < 100; i++) {
      const tail = f.store.enqueue({ botId: f.bot.id, requestId: `tail-${i}`, message: "Tail" })
      f.store.transition(tail.id, "cancelled")
    }
    f.advance()
    expect(f.store.pruneTaskHistory()).toBe(1)
    expect(f.store.messageOrigins(f.bot.id, ["old"])[0].origin).toEqual({ kind: "user", mentions })
    expect(f.store.requestReceipts(f.bot.id, [check("old", "@A", mentions)])[0].state).toBe(
      "accepted"
    )
    expect(f.store.requestReceipts(f.bot.id, [check("old", "@A")])[0].state).toBe("conflict")
  })
  it("keeps work/reply references together and rejects unavailable or non-user targets", () => {
    const f = fixture()
    const { work } = f.store.createWork({
      botId: f.bot.id,
      operationId: "work",
      title: "Work",
      goal: "Check"
    })
    const message = formatBotMessageReply("@A", f.reply),
      start = message.length - 2
    const mentions = [{ start, end: start + 2, botId: f.peer.id, label: "A" }]
    const task = f.store.enqueue({
      botId: f.bot.id,
      workId: work.id,
      requestId: "work-r",
      message,
      mentions,
      replyToId: f.reply.id
    })
    expect(task.origin).toMatchObject({ kind: "user", mentions, replyTo: { id: f.reply.id } })
    expect(f.store.messageOrigins(f.bot.id, ["work-r"])).toEqual([])
    expect(f.store.messageOrigins(f.bot.id, ["work-r"], undefined, work.id)[0].origin).toEqual(
      task.origin
    )
    expect(() =>
      f.store.enqueue({
        botId: f.bot.id,
        requestId: "self",
        message: "@A",
        mentions: selected(f.bot.id)
      })
    ).toThrow("不可用")
    expect(() =>
      f.store.enqueue({
        botId: f.bot.id,
        requestId: "unknown",
        message: "@A",
        mentions: selected("other-host-id")
      })
    ).toThrow("不存在")
    expect(() =>
      f.store.enqueue(
        { botId: f.bot.id, requestId: "routine", message: "@A", mentions: selected(f.peer.id) },
        { kind: "schedule", scheduleId: "s" }
      )
    ).toThrow("本机用户")
    expect(() =>
      f.store.enqueue(
        { botId: f.bot.id, requestId: "source", message: "@A", mentions: selected(f.peer.id) },
        { kind: "user" },
        {
          personal: true,
          transport: "im",
          bindingId: "binding",
          grantVersion: 1,
          conversationId: "dm",
          audienceKey: "audience",
          eventId: "event",
          messageId: "message",
          senderId: "sender"
        }
      )
    ).toThrow("本机用户")
    f.store.update({ ...f.peer, archived: true, expectedVersion: f.peer.version })
    expect(() =>
      f.store.enqueue({
        botId: f.bot.id,
        requestId: "archived",
        message: "@A",
        mentions: selected(f.peer.id)
      })
    ).toThrow("不可用")
    f.raw.run("UPDATE bots SET deleting=1 WHERE id=?", [f.other.id])
    expect(() =>
      f.store.enqueue({
        botId: f.bot.id,
        requestId: "deleted",
        message: "@A",
        mentions: selected(f.other.id)
      })
    ).toThrow("不可用")
  })
})
