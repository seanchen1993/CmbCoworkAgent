import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import {
  botMessageHasEntranceBody,
  projectBotMessageEntrance as project,
  retireBotMessageEntrance as retire
} from "./bot-message-entrance"

describe("Bot message entrances", () => {
  it("skips hydration and older pages, and enters only appended identities", () => {
    let state = project(null, "a", [], false)
    state = project(state, "a", ["old"], true)
    expect([...state.entering]).toEqual([])
    state = project(state, "a", ["earlier", "old", "reply"], true)
    expect([...state.entering]).toEqual(["reply"])
    state = retire(state, "reply")
    expect(project(state, "a", [...state.ids], true)).toBe(state)
    expect(retire(state, "reply")).toBe(state)
    state = project(state, "a", ["earlier", "old", "reply", "next"], true)
    expect([...state.entering]).toEqual(["next"])
  })
  it("starts a loaded empty chat but skips scope changes, disjoint pages and returning to live view", () => {
    let state = project(null, "a", [], true)
    state = project(state, "a", ["first"], true)
    expect([...state.entering]).toEqual(["first"])
    state = project(state, "b", ["first", "other"], true)
    expect([...state.entering]).toEqual([])
    state = project(state, "b", ["old-page"], true)
    expect([...state.entering]).toEqual([])
    state = project(state, "b", ["old-page", "unseen"], false)
    state = project(state, "b", ["old-page", "unseen"], true)
    expect([...state.entering]).toEqual([])
  })
  it("drops retired history IDs and does not grow a permanent seen-message registry", () => {
    let state = project(null, "a", ["old"], true)
    for (let i = 0; i < 100; i++)
      state = project(state, "a", [...state.ids, `m${i}`].slice(-5), true)
    expect(state.ids).toHaveLength(5)
    expect(state.entering.size).toBe(5)
    state = project(state, "a", [], false)
    expect(state.ids).toHaveLength(0)
    expect(state.entering.size).toBe(0)
  })
  it("waits for visible assistant content rather than consuming an empty or reasoning-only shell", () => {
    const message = (content: Message["content"], role: Message["role"] = "assistant") =>
      ({ id: "m", role, content }) as Message
    expect(botMessageHasEntranceBody(message(""))).toBe(false)
    expect(botMessageHasEntranceBody(message("<think>private reasoning</think>"))).toBe(false)
    expect(botMessageHasEntranceBody(message([{ type: "tool_use", name: "read_file" }]))).toBe(
      false
    )
    expect(botMessageHasEntranceBody(message("<think>reason</think>Visible reply"))).toBe(true)
    expect(botMessageHasEntranceBody(message("", "user"))).toBe(true)
    expect(botMessageHasEntranceBody(message("result", "tool"))).toBe(false)
  })
})
