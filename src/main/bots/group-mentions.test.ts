import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { bindBotGroupMentions } from "./group-mentions"

it("binds full current names with original UTF-16 offsets, including emoji and Chinese", () => {
  const text = "😀 @Alice Smith，交给@张三。"
  expect(
    bindBotGroupMentions(text, [
      { id: "a", name: "Alice Smith" },
      { id: "b", name: "张三" }
    ])
  ).toEqual([
    { start: 3, end: 15, botId: "a", label: "Alice Smith" },
    { start: 18, end: 21, botId: "b", label: "张三" }
  ])
})

it("does not bind ambiguous names or fall back to shorter Chinese names", () => {
  expect(
    bindBotGroupMentions("@同事 @同 @Outside", [
      { id: "a", name: "同事" },
      { id: "b", name: "同事" },
      { id: "c", name: "同" }
    ])
  ).toEqual([{ start: 4, end: 6, botId: "c", label: "同" }])
})

it("binds explicit everyone handles with exact offsets, but not email or longer handles", () => {
  const text = "😀 @all @EVERYONE @所有人 user@all @alliance @everyone_else"
  expect(bindBotGroupMentions(text, [])).toEqual([
    { start: 3, end: 7, botId: null, label: "all" },
    { start: 8, end: 17, botId: null, label: "EVERYONE" },
    { start: 18, end: 22, botId: null, label: "所有人" }
  ])
})

it("preserves full handle boundaries and never binds an email or a longer unknown handle", () => {
  const text = "user@Ann.test @Annex @Ann-Marie_next @Ann-Marie @Ann"
  expect(
    bindBotGroupMentions(text, [
      { id: "a", name: "Ann" },
      { id: "b", name: "Ann-Marie" }
    ]).map((m) => ({ label: m.label, token: text.slice(m.start, m.end) }))
  ).toEqual([
    { label: "Ann-Marie", token: "@Ann-Marie" },
    { label: "Ann", token: "@Ann" }
  ])
  expect(bindBotGroupMentions("@Ann ".repeat(200), [{ id: "a", name: "Ann" }])).toHaveLength(128)
})

it("persists Bot result identity across reopen/rename without dispatching from display annotations", () => {
  const adapter = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const store = new BotStore(adapter, () => 1000)
    const input = { instructions: "", modelRef: null, color: "#ff0000" }
    const a = store.create({ ...input, name: "Alice" })
    const b = store.create({ ...input, name: "Bob" })
    const other = store.create({ ...input, name: "Outside" })
    const group = store.saveGroup({ name: "Room", memberIds: [a.id, b.id] })
    store.sendGroup({
      groupId: group.id,
      requestId: "user-request",
      text: "@Bob is ordinary pasted text; only Alice is selected",
      targetBotIds: [a.id]
    })
    const task = store.recentTasks()[0]
    store.transition(task.id, "running")
    const result =
      "<think>@Outside is not shared</think>\n@Bob please review; @Outside is not a member."
    store.settle(task.id, "completed", null, result)
    const shown = store.groupMessages(group.id)[1]
    expect(shown.text).toBe("@Bob please review; @Outside is not a member.")
    expect(shown.mentions).toEqual([{ start: 0, end: 4, botId: b.id, label: "Bob" }])
    expect(
      adapter.exec("SELECT targets_json FROM bot_group_messages WHERE id=?", [shown.id])[0]
        .values[0][0]
    ).toBe("[]")
    expect(store.groupMessages(group.id)[0].mentions).toBeUndefined()
    expect(store.recentTasks()).toHaveLength(1)
    store.update({ ...b, name: "Robert", expectedVersion: b.version })
    store.settle(task.id, "completed", null, "@Robert changed after the original result")
    const reopened = new BotStore(adapter, () => 2000)
    expect(reopened.groupMessages(group.id)[1]).toEqual(shown)
    expect(reopened.recentTasks()).toHaveLength(1)
    expect(reopened.getBot(other.id).name).toBe("Outside")
  } finally {
    adapter.close()
  }
})
