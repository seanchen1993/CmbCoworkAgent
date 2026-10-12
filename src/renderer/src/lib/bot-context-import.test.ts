import { afterEach, expect, it, vi } from "vitest"
import type { Message } from "../../../main/types"
import {
  acknowledgeContextImport,
  readPendingContextImport,
  rememberContextImport,
  selectableBotContextMessages
} from "./bot-context-import"

afterEach(() => vi.unstubAllGlobals())

it("uses only complete visible text and never includes tool payloads, reasoning or image data", () => {
  const messages: Message[] = [
    {
      id: "user",
      role: "user",
      created_at: new Date(1000),
      ordinal: 7,
      content: [
        { type: "text", text: "selected text" },
        { type: "image", content: "private-image-data" }
      ],
      reasoning: "private-reasoning",
      tool_calls: [{ id: "command", name: "shell", args: { command: "private-command" } }]
    },
    {
      id: "assistant",
      role: "assistant",
      created_at: new Date(2000),
      ordinal: 8,
      content: "selected answer"
    },
    { id: "tool", role: "tool", created_at: new Date(3000), content: "secret-response" },
    { id: "system", role: "system", created_at: new Date(4000), content: "internal-instructions" },
    { id: "truncated", role: "assistant", created_at: new Date(5000), content: "partial preview" },
    { id: "large", role: "assistant", created_at: new Date(6000), content: "x".repeat(24_001) },
    {
      id: "internal-goal",
      role: "user",
      created_at: new Date(7000),
      content:
        "[Starting active goal]\n<untrusted_objective>INTERNAL_GOAL_PROMPT</untrusted_objective>"
    }
  ]
  expect(selectableBotContextMessages(messages, ["truncated"])).toEqual([
    { id: "user", role: "user", text: "selected text", createdAt: 1000, ordinal: 7 },
    { id: "assistant", role: "assistant", text: "selected answer", createdAt: 2000, ordinal: 8 }
  ])
})

it("retains the exact selection for a lost response without mixing Bots or restored data", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    nonce: "import",
    botId: "bot",
    draft: {
      source: { threadId: "thread", title: "Old task" },
      messages: [{ id: "selected", role: "user" as const, text: "exact reviewed content" }]
    }
  }
  rememberContextImport(input, "epoch")
  expect(readPendingContextImport("bot", "epoch")).toEqual(input)
  expect(readPendingContextImport("other", "epoch")).toBeNull()
  expect(readPendingContextImport("bot", "restored")).toBeNull()
  rememberContextImport({ ...input, nonce: "newer" }, "epoch")
  acknowledgeContextImport(input, "epoch")
  expect(readPendingContextImport("bot", "epoch")?.nonce).toBe("newer")
  acknowledgeContextImport({ ...input, nonce: "newer" }, "epoch")
  expect(items.size).toBe(0)
  vi.stubGlobal("localStorage", {
    setItem() {
      throw new Error("QuotaExceededError")
    }
  })
  expect(() => rememberContextImport(input, "epoch")).toThrow("尚未提交")
})
