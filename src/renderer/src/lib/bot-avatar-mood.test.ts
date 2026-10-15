import { expect, it } from "vitest"
import { botAvatarMood, botIsSpeaking } from "./bot-avatar-mood"
import type { LiveStreamMessage } from "./live-stream-messages"
const tools = { a: { id: "a", status: "running" as const, updatedAt: new Date(200) } }
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
  expect(botAvatarMood(true, false, {}, 100, true)).toBe("stream")
  expect(botAvatarMood(false, true, {}, 100, true)).toBe("blocked")
  expect(botAvatarMood(true, false, tools, 100, true)).toBe("work")
})
it("uses actual active tools and gives user waits precedence over animation", () => {
  expect(botAvatarMood(false, false, tools, 100)).toBe("idle")
  expect(botAvatarMood(true, true, tools, 100)).toBe("blocked")
  expect(botAvatarMood(true, false, tools, 100)).toBe("work")
  expect(botAvatarMood(true, false, tools, 300)).toBe("think")
  expect(botAvatarMood(true, false, { a: { ...tools.a, status: "completed" } }, 100)).toBe("think")
})

it("maps the newest live runtime activity and ignores completed and previous-turn tools", () => {
  const active = (name: string, at = 200) => ({ ...tools.a, name, updatedAt: new Date(at) })
  expect(botAvatarMood(true, false, { a: active("bot_browser") }, 100)).toBe("search")
  expect(botAvatarMood(true, false, { a: active("bot_delegate") }, 100)).toBe("send")
  expect(botAvatarMood(true, false, { a: active("task") }, 100)).toBe("orbit")
  expect(botAvatarMood(true, false, { a: active("read_file") }, 100)).toBe("read")
  expect(botAvatarMood(true, false, { a: active("write_file") }, 100)).toBe("write")
  expect(botAvatarMood(true, false, { a: active("edit_file") }, 100)).toBe("write")
  expect(botAvatarMood(true, false, { a: active("execute") }, 100)).toBe("run")
  expect(
    botAvatarMood(true, false, { a: active("bot_browser"), b: active("execute", 300) }, 100)
  ).toBe("run")
  expect(
    botAvatarMood(
      true,
      false,
      { a: active("bot_delegate"), b: { ...active("bot_browser", 300), status: "completed" } },
      100
    )
  ).toBe("send")
  expect(botAvatarMood(true, true, { a: active("bot_delegate") }, 100)).toBe("blocked")
})
