import assert from "node:assert/strict"
import { createChatMessageProjector } from "../src/renderer/src/lib/chat-message-projection"
import {
  createDynamicLiveVisibilityProjector,
  createLiveDisplayMessageProjector
} from "../src/renderer/src/lib/live-display-message-projection"
import type { LiveStreamMessage } from "../src/renderer/src/lib/live-stream-messages"
import { createIncrementalToolDerivationProjector } from "../src/renderer/src/lib/message-render-stability"
import type { Message } from "../src/renderer/src/types"

let stableFieldsReadable = true
let stableFieldReads = 0
function guardedLiveMessage(index: number): LiveStreamMessage {
  const target: LiveStreamMessage = {
    id: `live-${index}`,
    type: index % 2 === 0 ? "ai" : "tool",
    content: `content-${index}`,
    ...(index % 2 === 1
      ? { tool_call_id: `call-${index}`, name: "read_file" }
      : {})
  }
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string") {
        stableFieldReads += 1
        if (!stableFieldsReadable) {
          throw new Error(`content-only frame read stable live field ${index}.${property}`)
        }
      }
      return Reflect.get(object, property, receiver)
    }
  })
}

const durableTarget: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `durable-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `durable-${index}`,
  created_at: new Date(index)
}))
let durablePrefixReadable = true
const durable = new Proxy(durableTarget, {
  get(target, property, receiver) {
    if (
      typeof property === "string" &&
      /^\d+$/.test(property) &&
      !durablePrefixReadable
    ) {
      throw new Error(`content-only frame read durable index ${property}`)
    }
    return Reflect.get(target, property, receiver)
  }
})

const stableLive = Array.from({ length: 1_999 }, (_, index) => guardedLiveMessage(index))
const firstFrame: LiveStreamMessage[] = [
  ...stableLive,
  { id: "live-tail", type: "ai", content: "a" }
]
const projectLive = createLiveDisplayMessageProjector()
const firstLiveProjection = projectLive(durable, firstFrame)
assert.equal(firstLiveProjection.messages.length, 2_000)
assert.equal(firstLiveProjection.lastUserMessageId, null)

const projectChat = createChatMessageProjector()
const firstChatProjection = projectChat(
  durable,
  firstLiveProjection.messages,
  undefined,
  0,
  firstLiveProjection
)
const stableDisplayPrefix = firstLiveProjection.messages.slice(0, -1)
stableFieldsReadable = false
durablePrefixReadable = false
stableFieldReads = 0

for (let token = 0; token < 100; token += 1) {
  const nextFrame: LiveStreamMessage[] = [
    ...stableLive,
    { id: "live-tail", type: "ai", content: `token-${token}` }
  ]
  const liveProjection = projectLive(durable, nextFrame)
  assert.equal(liveProjection.messages, firstLiveProjection.messages)
  assert.equal(liveProjection.changedMessages.length, 1)
  assert.equal(liveProjection.structureVersion, firstLiveProjection.structureVersion)
  assert.equal(liveProjection.messages.at(-1)?.content, `token-${token}`)
  assert.deepEqual(liveProjection.messages.slice(0, -1), stableDisplayPrefix)

  const chatProjection = projectChat(
    durable,
    liveProjection.messages,
    undefined,
    0,
    liveProjection
  )
  assert.equal(chatProjection.messages, firstChatProjection.messages)
  assert.equal(chatProjection.changedMessages.length, 1)
}
assert.equal(stableFieldReads, 0, "tail frames must not read stable current-turn fields")

stableFieldsReadable = true
durablePrefixReadable = true
const newToolMessage: LiveStreamMessage = {
  id: "new-tool",
  type: "tool",
  tool_call_id: "call-new",
  content: "result"
}
const latestLiveProjection = projectLive(durable, [
  ...stableLive,
  { id: "live-tail", type: "ai", content: "final" },
  newToolMessage
])
assert.equal(latestLiveProjection.messages.length, 2_001)
assert.ok(latestLiveProjection.structureVersion > firstLiveProjection.structureVersion)

const projectVisibility = createDynamicLiveVisibilityProjector()
let visibilityChecks = 0
const hasHookLogChip = (): boolean => {
  visibilityChecks += 1
  return false
}
const latestChatProjection = projectChat(
  durable,
  latestLiveProjection.messages,
  undefined,
  0,
  latestLiveProjection
)
const initialVisibilityProjection = projectVisibility({
  live: latestLiveProjection,
  displayMessages: latestChatProjection.messages,
  displayIndexById: latestChatProjection.indexById,
  displayContentVersion: latestChatProjection.contentVersion,
  displayStructureVersion: latestChatProjection.structureVersion,
  hasHookLogChip
})
assert.equal(visibilityChecks, 2_001)
assert.equal(initialVisibilityProjection.orderedVisibleIndexes.length, 1_001)

stableFieldsReadable = false
durablePrefixReadable = false
const finalLiveProjection = projectLive(durable, [
  ...stableLive,
  { id: "live-tail", type: "ai", content: "final-tail" },
  newToolMessage
])
const finalChatProjection = projectChat(
  durable,
  finalLiveProjection.messages,
  undefined,
  0,
  finalLiveProjection
)
visibilityChecks = 0
const contentVisibilityProjection = projectVisibility({
  live: finalLiveProjection,
  displayMessages: finalChatProjection.messages,
  displayIndexById: finalChatProjection.indexById,
  displayContentVersion: finalChatProjection.contentVersion,
  displayStructureVersion: finalChatProjection.structureVersion,
  hasHookLogChip
})
assert.equal(visibilityChecks, 1, "content-only visibility must inspect only changed rows")
assert.equal(
  contentVisibilityProjection.orderedVisibleIndexes,
  initialVisibilityProjection.orderedVisibleIndexes
)

const toolProjectionMessages: Message[] = Array.from({ length: 2_000 }, (_, index) => ({
  id: `tool-projection-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: "stable",
  created_at: new Date(index)
}))
let toolProjectionPrefixReadable = true
const guardedToolProjectionMessages = new Proxy(toolProjectionMessages, {
  get(target, property, receiver) {
    if (
      typeof property === "string" &&
      /^\d+$/.test(property) &&
      !toolProjectionPrefixReadable
    ) {
      throw new Error(`tool projector read stable index ${property}`)
    }
    return Reflect.get(target, property, receiver)
  }
})
const projectToolMessages = createIncrementalToolDerivationProjector()
const initialToolProjection = projectToolMessages(guardedToolProjectionMessages, [], 1)
toolProjectionPrefixReadable = false
const changedAssistant: Message = {
  ...toolProjectionMessages.at(-1)!,
  content: "content-only-tail"
}
toolProjectionMessages[toolProjectionMessages.length - 1] = changedAssistant
const contentToolProjection = projectToolMessages(
  guardedToolProjectionMessages,
  [changedAssistant],
  1
)
assert.equal(contentToolProjection.messages, initialToolProjection.messages)
assert.equal(contentToolProjection.version, initialToolProjection.version)

console.log("live display message projection tests passed")
