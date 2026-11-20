import assert from "node:assert/strict"
import { StreamConverter } from "../src/main/agent/stream-converter"
import {
  createStreamDataSerializer,
  serializeStreamData
} from "../src/main/ipc/stream-data-serialization"

function serializedMessage(className: string, id: string | undefined, content: string): unknown {
  return {
    id: ["langchain_core", "messages", className],
    kwargs: {
      ...(id ? { id } : {}),
      content,
      additional_kwargs: {}
    }
  }
}

const poisonedPrefix = Array.from({ length: 10_000 }, (_, index) => ({
  toJSON(): never {
    throw new Error(`historical message ${index} must not be serialized`)
  }
}))
const values = {
  messages: [
    ...poisonedPrefix,
    serializedMessage("HumanMessage", "turn-user", "current prompt"),
    serializedMessage("AIMessage", undefined, "current answer")
  ],
  todos: []
}

const projected = serializeStreamData("values", values)
assert.equal(projected.valuesMessageIndexOffset, 10_000)

const converter = new StreamConverter("background-projection", "turn-user")
const events = converter.processChunk("values", projected.data, {
  valuesMessageIndexOffset: projected.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn"
})
const turnEvent = events.find((event) => event.type === "turn-messages")
assert.ok(turnEvent)
assert.equal(turnEvent.messages.length, 2)
assert.equal(turnEvent.messages[0].id, "turn-user")
assert.equal(turnEvent.messages[1].id, "msg-10001")
assert.equal(events.some((event) => event.type === "full-messages"), false)

const serializeForRun = createStreamDataSerializer()
const user = serializedMessage("HumanMessage", "delta-user", "prompt")
const assistant = serializedMessage("AIMessage", "delta-assistant", "a")
const initialDeltaState = serializeForRun("values", { messages: [user, assistant] })
assert.equal(initialDeltaState.valuesSnapshotKind, "full")
const deltaConverter = new StreamConverter("background-delta", "delta-user")
deltaConverter.processChunk("values", initialDeltaState.data, {
  valuesMessageIndexOffset: initialDeltaState.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn",
  valuesSnapshotKind: initialDeltaState.valuesSnapshotKind
})

const grownAssistant = serializedMessage("AIMessage", "delta-assistant", "answer complete")
const tailDelta = serializeForRun("values", { messages: [user, grownAssistant] })
assert.equal(tailDelta.valuesSnapshotKind, "tail")
const tailEvents = deltaConverter.processChunk("values", tailDelta.data, {
  valuesMessageIndexOffset: tailDelta.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn",
  valuesSnapshotKind: tailDelta.valuesSnapshotKind
})
const tailTurnEvent = tailEvents.find((event) => event.type === "turn-messages")
assert.ok(tailTurnEvent)
assert.deepEqual(tailTurnEvent.messages.map((message) => message.id), ["delta-assistant"])
assert.equal(tailTurnEvent.messages[0].content, "answer complete")

const appendedAssistant = serializedMessage("AIMessage", "delta-next", "next")
const appendDelta = serializeForRun("values", {
  messages: [user, grownAssistant, appendedAssistant]
})
assert.equal(appendDelta.valuesSnapshotKind, "append")
const appendEvents = deltaConverter.processChunk("values", appendDelta.data, {
  valuesMessageIndexOffset: appendDelta.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn",
  valuesSnapshotKind: appendDelta.valuesSnapshotKind
})
const appendTurnEvent = appendEvents.find((event) => event.type === "turn-messages")
assert.ok(appendTurnEvent)
assert.deepEqual(appendTurnEvent.messages.map((message) => message.id), ["delta-next"])

const taskCall = {
  id: ["langchain_core", "messages", "AIMessage"],
  kwargs: {
    id: "delta-task-parent",
    content: "",
    additional_kwargs: {},
    tool_calls: [
      {
        id: "delta-task",
        name: "task",
        args: { subagent_type: "general-purpose", prompt: "inspect incrementally" }
      }
    ]
  }
}
const taskDelta = serializeForRun("values", {
  messages: [user, grownAssistant, appendedAssistant, taskCall]
})
assert.equal(taskDelta.valuesSnapshotKind, "append")
const taskEvents = deltaConverter.processChunk("values", taskDelta.data, {
  valuesMessageIndexOffset: taskDelta.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn",
  valuesSnapshotKind: taskDelta.valuesSnapshotKind
})
assert.ok(
  taskEvents.some(
    (event) =>
      event.type === "custom" &&
      event.data.type === "subagents" &&
      Array.isArray(event.data.subagents) &&
      event.data.subagents.some(
        (subagent) =>
          subagent &&
          typeof subagent === "object" &&
          (subagent as { toolCallId?: string }).toolCallId === "delta-task"
      )
  )
)

const taskResult = {
  id: ["langchain_core", "messages", "ToolMessage"],
  kwargs: {
    id: "delta-task-result",
    type: "tool",
    name: "task",
    tool_call_id: "delta-task",
    content: "incremental result"
  }
}
const taskResultDelta = serializeForRun("values", {
  messages: [user, grownAssistant, appendedAssistant, taskCall, taskResult]
})
assert.equal(taskResultDelta.valuesSnapshotKind, "append")
const taskResultEvents = deltaConverter.processChunk("values", taskResultDelta.data, {
  valuesMessageIndexOffset: taskResultDelta.valuesMessageIndexOffset,
  valuesSnapshotScope: "turn",
  valuesSnapshotKind: taskResultDelta.valuesSnapshotKind
})
assert.ok(
  taskResultEvents.some(
    (event) =>
      event.type === "custom" &&
      event.data.type === "subagent_transcript_message" &&
      (event.data.subagentMessage as { content?: string } | undefined)?.content ===
        "incremental result"
  )
)

console.log("background stream projection tests passed")
