import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../../../main/db/native-sqlite-adapter"
import { BotStore } from "../../../main/bots/store"
import type { BotClient, SendBotGroupMessageInput } from "../../../shared/bots/contracts"
import { groupDraftKey, sendGroupDraft, useBotGroupDrafts } from "./bot-group-drafts"
import { insertGroupMention } from "./bot-group-mentions"

const databases: NativeSqliteAdapter[] = []
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    }
  })
  useBotGroupDrafts.setState({ drafts: {} })
})
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.unstubAllGlobals()
})

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let clock = 1000
  const store = new BotStore(db, () => ++clock)
  const create = (name: string) =>
    store.create({ name, instructions: "", modelRef: null, color: "#ff0000" })
  const a = create("A"),
    b = create("B"),
    c = create("C")
  let group = store.saveGroup({ name: "Room", memberIds: [a.id, b.id] })
  const key = groupDraftKey("local", group.id)
  const calls: SendBotGroupMessageInput[] = []
  const sendGroup = vi.fn(async (input: SendBotGroupMessageInput) => {
    calls.push(structuredClone(input))
    store.sendGroup(input)
    if (calls.length === 1) throw new Error("Synthetic lost acknowledgement")
  })
  const client = { hostId: "local", sendGroup } as unknown as BotClient
  return {
    store,
    a,
    b,
    c,
    key,
    calls,
    client,
    sendGroup,
    get group() {
      return group
    },
    members(ids: string[]) {
      group = store.saveGroup({ name: group.name, memberIds: ids }, group)
    },
    restore() {
      useBotGroupDrafts.setState({ drafts: {} })
      useBotGroupDrafts.getState().restore(key)
    }
  }
}

const pendingDraft = (key: string) => useBotGroupDrafts.getState().drafts[key]

describe("group retry identity through durable drafts and the real Store", () => {
  it.each([false, true])(
    "does not repeat an accepted task or expand recipients after a member joins (restored=%s)",
    async (restored) => {
      const f = fixture()
      useBotGroupDrafts.getState().edit(f.key, { text: "Do authorized work once" })
      await sendGroupDraft(f.client, f.group)
      const originalTasks = f.store.recentTasks()
      const task = originalTasks.find((task) => task.botId === f.a.id)!
      f.store.transition(task.id, "running")
      f.store.settle(task.id, "completed", null, "Done")
      f.members([f.a.id, f.b.id, f.c.id])
      if (restored) f.restore()
      await sendGroupDraft(f.client, f.group)
      expect(f.calls[1]).toEqual(f.calls[0])
      expect(f.store.recentTasks()).toHaveLength(originalTasks.length)
      expect(f.store.recentTasks().some((task) => task.botId === f.c.id)).toBe(false)
      expect(pendingDraft(f.key)).toMatchObject({ text: "", request: null, error: null })
    }
  )

  it.each(["default", "mention", "all", "reply"] as const)(
    "acknowledges the accepted %s payload after an original member leaves",
    async (mode) => {
      const f = fixture()
      let text = "Do authorized work once"
      const patch: Parameters<ReturnType<typeof useBotGroupDrafts.getState>["edit"]>[1] = {}
      if (mode === "mention" || mode === "all") {
        const mention = insertGroupMention(
          "@",
          { start: 0, end: 1 },
          [],
          mode === "all" ? null : f.a.id,
          mode === "all" ? "所有人" : "A"
        )
        text = mention.text + text
        patch.mentions = mention.mentions
      }
      if (mode === "reply") {
        f.store.sendGroup({
          groupId: f.group.id,
          requestId: "quote",
          text: "Reference",
          targetBotIds: [f.a.id]
        })
        const source = f.store.recentTasks().find((task) => task.botId === f.a.id)!
        f.store.transition(source.id, "running")
        f.store.settle(source.id, "completed", null, "Original answer")
        const answer = f.store
          .groupMessages(f.group.id)
          .find((message) => message.authorBotId === f.a.id)!
        patch.replyTo = {
          id: answer.id,
          ordinal: answer.ordinal,
          text: answer.text,
          authorBotId: f.a.id
        }
      }
      useBotGroupDrafts.getState().edit(f.key, { ...patch, text })
      await sendGroupDraft(f.client, f.group)
      const count = f.store.recentTasks().length
      f.members([f.b.id])
      f.restore()
      await sendGroupDraft(f.client, f.group)
      expect(f.calls[1]).toEqual(f.calls[0])
      expect(f.store.recentTasks()).toHaveLength(count)
      expect(pendingDraft(f.key).error).toBeNull()
    }
  )

  it("keeps an accepted @all recipient snapshot when a member joins", async () => {
    const f = fixture()
    const mention = insertGroupMention("@", { start: 0, end: 1 }, [], null, "所有人")
    useBotGroupDrafts
      .getState()
      .edit(f.key, { text: mention.text + "Check", mentions: mention.mentions })
    await sendGroupDraft(f.client, f.group)
    f.members([f.a.id, f.b.id, f.c.id])
    f.restore()
    await sendGroupDraft(f.client, f.group)
    expect(f.calls[1]).toEqual(f.calls[0])
    expect(f.store.recentTasks()).toHaveLength(2)
    expect(pendingDraft(f.key).error).toBeNull()
  })

  it.each(["removed", "all-expanded"] as const)(
    "rejects a never-accepted stale %s payload without reinterpreting its audience",
    async (mode) => {
      const f = fixture()
      f.sendGroup.mockImplementationOnce(async (input) => {
        f.calls.push(structuredClone(input))
        throw new Error("Never reached Host")
      })
      const mention = insertGroupMention(
        "@",
        { start: 0, end: 1 },
        [],
        mode === "removed" ? f.a.id : null,
        mode === "removed" ? "A" : "所有人"
      )
      useBotGroupDrafts
        .getState()
        .edit(f.key, { text: mention.text + "Check", mentions: mention.mentions })
      await sendGroupDraft(f.client, f.group)
      f.members(mode === "removed" ? [f.b.id] : [f.a.id, f.b.id, f.c.id])
      f.restore()
      await sendGroupDraft(f.client, f.group)
      expect(f.calls[1]).toEqual(f.calls[0])
      expect(f.store.recentTasks()).toHaveLength(0)
      expect(pendingDraft(f.key).error).not.toBeNull()
      expect(pendingDraft(f.key).request?.id).toBe(f.calls[0].requestId)
    }
  )

  it("treats an explicit edit as a new request with the current audience", async () => {
    const f = fixture()
    useBotGroupDrafts.getState().edit(f.key, { text: "Do work once" })
    await sendGroupDraft(f.client, f.group)
    f.members([f.a.id, f.b.id, f.c.id])
    useBotGroupDrafts.getState().edit(f.key, { text: "Do new work" })
    await sendGroupDraft(f.client, f.group)
    expect(f.calls[1].requestId).not.toBe(f.calls[0].requestId)
    expect(f.calls[1].targetBotIds).toEqual([f.a.id, f.b.id, f.c.id].sort())
    expect(f.store.recentTasks()).toHaveLength(5)
  })

  it("keeps a user's explicit replacement distinct even when it returns to identical text", async () => {
    const f = fixture()
    useBotGroupDrafts.getState().edit(f.key, { text: "Do work once" })
    await sendGroupDraft(f.client, f.group)
    f.members([f.a.id, f.b.id, f.c.id])
    useBotGroupDrafts.getState().edit(f.key, { text: "" })
    useBotGroupDrafts.getState().edit(f.key, { text: "Do work once" })
    await sendGroupDraft(f.client, f.group)
    expect(f.calls[1].text).toBe(f.calls[0].text)
    expect(f.calls[1].requestId).not.toBe(f.calls[0].requestId)
    expect(f.calls[1].targetBotIds).toEqual([f.a.id, f.b.id, f.c.id].sort())
    expect(f.store.recentTasks()).toHaveLength(5)
  })

  it("rejects same-ID payload mutations even after membership changes, and rejects a deleting group", async () => {
    const f = fixture()
    useBotGroupDrafts.getState().edit(f.key, { text: "@A Do work once" })
    await sendGroupDraft(f.client, f.group)
    f.members([f.b.id, f.c.id])
    const original = f.calls[0]
    for (const patch of [
      { text: "Changed" },
      { targetBotIds: [f.b.id] },
      { replyToId: "missing" },
      { mentions: [{ start: 0, end: 2, botId: null, label: "A" }] }
    ]) {
      expect(() => f.store.sendGroup({ ...original, ...patch })).toThrow("消息标识已被使用")
    }
    expect(f.store.sendGroup(original)).toBe(false)
    expect(() => f.store.sendGroup({ ...original, requestId: "new" })).toThrow("请选择群内")
    const other = f.store.saveGroup({ name: "Other room", memberIds: [f.b.id] })
    expect(() => f.store.sendGroup({ ...original, groupId: other.id })).toThrow("消息标识已被使用")
    f.store.beginGroupDeletion(f.group.id, f.group.version)
    expect(() => f.store.sendGroup(original)).toThrow("群聊正在删除")
    f.store.finishGroupDeletion(f.group.id)
    expect(() => f.store.sendGroup(original)).toThrow("群聊不存在")
  })
})
