import assert from "node:assert/strict"
import {
  replaceTrustedMessageTailInPlace,
  type TrustedMessageTailLocation
} from "../src/renderer/src/lib/trusted-message-tail"
import type { Message } from "../src/renderer/src/types"

const createdAt = new Date("2026-08-21T00:00:00.000Z")
const history = Array.from({ length: 10_000 }, (_, index): Message => ({
  id: `history-${index}`,
  role: "user",
  content: `history ${index}`,
  created_at: createdAt
}))
const tail: Message = {
  id: "scheduler-live",
  role: "assistant",
  content: "one",
  created_at: createdAt
}
const messages = [...history, tail]
const location: TrustedMessageTailLocation = {
  messages,
  index: messages.length - 1,
  tail
}
const stableValues = messages.slice(0, history.length)
for (let index = 0; index < history.length; index += 1) {
  Object.defineProperty(messages, index, {
    configurable: true,
    get(): never {
      throw new Error(`scheduler token read stable history index ${index}`)
    },
    set(value: Message): void {
      stableValues[index] = value
    }
  })
}

assert.equal(
  replaceTrustedMessageTailInPlace(location, messages, {
    id: "scheduler-live",
    role: "assistant",
    content: "one two",
    created_at: new Date("2026-08-21T00:00:01.000Z")
  }),
  true
)
assert.equal(messages.at(-1)?.content, "one two")
assert.equal(messages.at(-1)?.created_at, createdAt)

assert.equal(
  replaceTrustedMessageTailInPlace(location, messages, {
    id: "scheduler-live",
    role: "assistant",
    content: "one two three",
    tool_calls: [{ id: "new-tool", name: "read_file", args: {} }],
    created_at: createdAt
  }),
  false,
  "a tool-structure boundary must fall back to canonical normalization"
)

console.log("scheduler message tail performance contract passed")
