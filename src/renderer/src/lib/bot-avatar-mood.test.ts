import { expect, it } from "vitest"
import { botActiveTaskCreatedAt, botAvatarMood, botIsSpeaking } from "./bot-avatar-mood"
import type { LiveStreamMessage } from "./live-stream-messages"
import type { Message } from "@/types"
const call = (name: string, id = name, at = 200): Message => ({
  id: `message-${id}`,
  role: "assistant",
  content: "",
  created_at: new Date(at),
  tool_calls: [{ id, name, args: {} }]
})
const result = (id: string): Message => ({
  id: `result-${id}`,
  role: "tool",
  content: "done",
  created_at: new Date(250),
  tool_call_id: id
})
it("distinguishes live visible output from reasoning, old replies and tool calls", () => {
  const reply: LiveStreamMessage = { type: "ai", start_at: new Date(200), content: "开始处理" }
  expect(botIsSpeaking(true, [reply], 100)).toBe(true)
  expect(botIsSpeaking(false, [reply], 100)).toBe(false)
  expect(botIsSpeaking(true, [reply], 300)).toBe(false)
  expect(botIsSpeaking(true, [reply], null)).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, start_at: undefined }], 100)).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, end_at: new Date(300) }], 100)).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, content: "", reasoning: "检查中" }], 100)).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, content: "<think>检查中" }], 100)).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, content: "<think>检查中</think>回复" }], 100)).toBe(true)
  expect(
    botIsSpeaking(
      true,
      [{ ...reply, tool_calls: [{ id: "call", name: "read_file", args: {} }] }],
      100
    )
  ).toBe(false)
  expect(botIsSpeaking(true, [reply, { type: "tool", content: "read result" }], 100)).toBe(false)
  expect(
    botIsSpeaking(true, [{ ...reply, content: [{ type: "reasoning", text: "检查中" }] }], 100)
  ).toBe(false)
  expect(botIsSpeaking(true, [{ ...reply, content: [{ type: "text", text: "回复" }] }], 100)).toBe(
    true
  )
  expect(botAvatarMood(true, false, [reply], 100)).toBe("stream")
  expect(botAvatarMood(false, true, [reply], 100)).toBe("blocked")
})
it("projects scheduler canonical requests without trusting approval UUID running states", () => {
  const state = { scheduledTaskLoading: true, messages: [call("read_file")] }
  Object.defineProperty(state, "toolCallStates", {
    get: () => {
      throw new Error("orphan UUID state read")
    }
  })
  expect(botAvatarMood(state.scheduledTaskLoading, false, state.messages, 100)).toBe("read")
  expect(botAvatarMood(false, false, state.messages, 100)).toBe("idle")
  expect(botAvatarMood(true, true, state.messages, 100)).toBe("blocked")
  expect(botAvatarMood(true, false, [], 100)).toBe("work")
  expect(botAvatarMood(true, false, state.messages, null)).toBe("work")
  expect(botAvatarMood(true, false, state.messages, 300)).toBe("work")
})

it("maps pending request activity and exits when the exact result arrives", () => {
  for (const [name, mood] of Object.entries({
    bot_browser: "search",
    bot_delegate: "send",
    task: "orbit",
    read_file: "read",
    write_file: "write",
    edit_file: "write",
    execute: "run",
    unknown: "work"
  })) {
    expect(botAvatarMood(true, false, [call(name)], 100)).toBe(mood)
    expect(botAvatarMood(true, false, [call(name), result(name)], 100)).toBe("think")
  }
  expect(botAvatarMood(true, false, [call("read_file"), result("approval-uuid")], 100)).toBe("read")
})

it("follows canonical parallel call order and never revives a returned call", () => {
  const batch = {
    ...call("read_file"),
    tool_calls: [...call("read_file").tool_calls!, ...call("write_file").tool_calls!]
  }
  expect(botAvatarMood(true, false, [batch], 100)).toBe("read")
  expect(botAvatarMood(true, false, [batch, result("read_file")], 100)).toBe("write")
  expect(botAvatarMood(true, false, [batch, result("write_file")], 100)).toBe("read")
  expect(botAvatarMood(true, false, [batch, result("write_file"), result("read_file")], 100)).toBe(
    "think"
  )
})

it("stops at the current ordinary assistant/user instead of scanning or reviving history", () => {
  const reply: Message = {
    id: "reply",
    role: "assistant",
    content: "结果",
    created_at: new Date(300)
  }
  const messages = new Proxy([call("execute"), reply], {
    get: (items, key, receiver) => {
      if (key === "0") throw new Error("old transcript scanned")
      return Reflect.get(items, key, receiver)
    }
  })
  expect(botAvatarMood(true, false, messages, 100)).toBe("stream")
  expect(botAvatarMood(true, false, [{ ...reply, content: "<think>检查中" }], 100)).toBe("think")
  expect(botAvatarMood(true, false, [{ ...reply, role: "user" }], 100)).toBe("think")
  expect(botAvatarMood(true, false, [reply], 400)).toBe("work")
})

it("keeps the active thread fence when newer work is queued or another thread is running", () => {
  const tasks = [
    { threadId: "current", state: "running" as const, createdAt: 100 },
    { threadId: "current", state: "queued" as const, createdAt: 300 },
    { threadId: "other", state: "running" as const, createdAt: 400 }
  ]
  const start = botActiveTaskCreatedAt(tasks, "current")
  expect(start).toBe(100)
  expect(botAvatarMood(true, false, [call("read_file")], start!)).toBe("read")
  expect(botActiveTaskCreatedAt([{ ...tasks[0], state: "waiting_user" }], "current")).toBe(100)
  expect(botActiveTaskCreatedAt(tasks.slice(1), "current")).toBeUndefined()
})
