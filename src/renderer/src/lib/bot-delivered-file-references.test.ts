import { expect, it } from "vitest"
import type { Message } from "@/types"
import { botDeliveredFileReferences } from "./bot-delivered-file-references"

const message = (id: string, role: Message["role"], content = ""): Message => ({
  id,
  role,
  content,
  created_at: new Date(0)
})
const delivery = (id: string, path = "/workspace/result.txt", failed = false): Message[] => [
  {
    ...message(id, "assistant"),
    tool_calls: [{ id: "reused-call", name: "bot_deliver_files", args: {} }]
  },
  {
    ...message(
      `${id}-result`,
      "tool",
      JSON.stringify({
        kind: "bot-file-delivery",
        files: [{ filePath: path, name: "result.txt", size: 3 }]
      })
    ),
    tool_call_id: "reused-call",
    is_error: failed
  }
]

it("uses verified deliveries in the same turn and preserves earlier replies and unrelated turns", () => {
  const view = botDeliveredFileReferences([
    message("user", "user"),
    message("before", "assistant"),
    ...delivery("first"),
    message("after", "assistant"),
    ...delivery("second", "/workspace/other/result.txt"),
    message("both", "assistant"),
    message("next", "user"),
    message("new-reply", "assistant")
  ])
  expect(view.has("before")).toBe(false)
  expect([...view.get("after")!]).toEqual(["/workspace/result.txt"])
  expect([...view.get("both")!]).toEqual(["/workspace/result.txt", "/workspace/other/result.txt"])
  expect(view.has("new-reply")).toBe(false)
})

it("never treats a failed, pending or merely quoted file as a successful delivery", () => {
  const pending = delivery("pending")[0]
  const view = botDeliveredFileReferences([
    ...delivery("failed", "/workspace/result.txt", true),
    pending,
    message("prose", "assistant", "[result](/workspace/result.txt)"),
    message("answer", "assistant")
  ])
  expect(view.size).toBe(0)
})
