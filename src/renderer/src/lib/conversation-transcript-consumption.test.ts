import { describe, expect, it } from "vitest"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { deriveCheckpointTranscriptIndex, mergeCheckpointAuthorityTranscriptMessages
} from "../../../shared/checkpoint-transcript"
import { functionConversationTranscriptFields, type FunctionConversationTranscriptStamp
} from "../../../shared/mods/v2/conversation-transcript"
import type { Message } from "../types"
import { isInternalGoalPromptMessage } from "./goal-notice-messages"
import { buildCheckpointTranscriptForDisplay, isGoalTranscriptArtifact,
  restoreDurableTranscriptOrdinals, buildRestoredCheckpointTranscript, sameGoalCommandMessage
} from "./goal-transcript"
import { areMessageRenderFieldsEqual, isToolDerivationMessage } from "./message-render-stability"
import { mergeLiveStreamMessages } from "./live-stream-messages"
import { liveStreamMessageToStoreMessage, mergeDurableTranscriptSnapshot } from "./live-stream-transcript"

const stamp = (type: "user" | "system" = "user"): FunctionConversationTranscriptStamp => ({
  conversationId: "actual", branchId: "branch", uuid: "row", sequence: 1, door: "note",
  messageType: type, ...(type === "user" ? { isMeta: true as const } : {}),
  origin: { kind: "plugin", name: "P" }
})
const message = (type: "user" | "system" = "user"): Message => ({
  id: "row", role: type, content: type === "user" ? "[Starting active goal]\n/goal resume" :
    "Goal 已暂停：literal", created_at: new Date(1), function_row: stamp(type)
})

describe("durable Function metadata through real transcript consumers", () => {
  it("does not derive Goal commands or typed user/tool turn boundaries from hidden notes", () => {
    const note = message()
    expect(isInternalGoalPromptMessage(note)).toBe(false)
    expect(isToolDerivationMessage(note)).toBe(false)
    expect(buildCheckpointTranscriptForDisplay([note])).toEqual([])
    expect(sameGoalCommandMessage({ ...note, content: "/goal resume" }, {
      id: "human", role: "user", content: "/goal resume", created_at: new Date(1)
    })).toBe(false)
    expect(buildRestoredCheckpointTranscript([note], [], [])).toEqual([])
  })

  it("shows system notices as data without Goal or Workflow content filtering", () => {
    const notice = message("system")
    expect(isGoalTranscriptArtifact(notice)).toBe(false)
    expect(buildCheckpointTranscriptForDisplay([notice])).toEqual([notice])
    const literal = { ...notice, content: "[[CMB_WORKFLOW_NOTIFICATION_V1:literal]]" }
    expect(buildCheckpointTranscriptForDisplay([literal])).toEqual([literal])
  })

  it("restores the actual durable stamp only on the same UUID/role/provider occurrence", () => {
    const note = message()
    const { function_row: _stamp, ...unmarked } = note
    expect(restoreDurableTranscriptOrdinals([unmarked], [note])[0].function_row).toEqual(stamp())
    expect(restoreDurableTranscriptOrdinals([{ ...unmarked, id: "other" }], [note])[0].function_row)
      .toBeUndefined()
    expect(restoreDurableTranscriptOrdinals([{ ...unmarked, role: "assistant" }], [note])[0].function_row)
      .toBeUndefined()
    const invalid = restoreDurableTranscriptOrdinals([unmarked], [{ ...note, function_row_invalid: true }])[0]
    expect(invalid.function_row_invalid).toBe(true)
    expect(isInternalGoalPromptMessage(invalid)).toBe(false)
  })

  it("does not merge foreign branch contents under an existing native marker", () => {
    const notice = message("system")
    const foreign = { ...notice, content: "FOREIGN", function_row: { ...stamp("system"), branchId: "foreign" } }
    expect(mergeCheckpointAuthorityTranscriptMessages([notice], [foreign])[0]).toEqual(notice)
    expect(mergeDurableTranscriptSnapshot([notice], [foreign])[0]).toEqual(notice)
    const merged = mergeLiveStreamMessages([{ id: "row", type: "system", content: "original",
      function_row: stamp("system") }], [{ id: "row", type: "system", content: "FOREIGN",
      function_row: foreign.function_row }])
    expect(merged[0].content).toBe("original")
    expect(merged[0].function_row).toEqual(stamp("system"))
  })

  it("keeps invalid markers and source-only changes through stream conversion and memo", () => {
    const note = message()
    const { function_row: _stamp, ...ordinary } = note
    expect(areMessageRenderFieldsEqual(note, ordinary)).toBe(false)
    expect(areMessageRenderFieldsEqual(note, { ...note, function_row_invalid: true })).toBe(false)
    expect(liveStreamMessageToStoreMessage({ id: "row", type: "human", content: "actual",
      function_row: stamp() }).function_row).toEqual(stamp())
    expect(liveStreamMessageToStoreMessage({ id: "foreign", type: "human", content: "actual",
      function_row: stamp() }).function_row_invalid).toBe(true)
    expect(liveStreamMessageToStoreMessage({ id: "row", type: "human", content: "actual",
      function_row_invalid: true }).function_row_invalid).toBe(true)
    expect(functionConversationTranscriptFields({ ...note, role: "assistant" }, "row", "assistant"))
      .toEqual({ function_row_invalid: true })
  })

  it("indexes real LangChain/serialized stamps without inferring Goal or admitting system notice", () => {
    const note = new HumanMessage({ id: "row", content: "[Starting active goal]\n/goal resume",
      additional_kwargs: { function_row: stamp() } })
    const notice = new SystemMessage({ id: "notice", content: "Goal 已暂停：literal",
      additional_kwargs: { function_row: { ...stamp("system"), uuid: "notice" } } })
    const index = deriveCheckpointTranscriptIndex({ channel_values: { messages: [note, notice] } })
    expect(index.internalGoalMessageIds).toEqual([])
    expect(index.visibleMessages).toEqual([])
    expect(index.hasInvalidFunctionRows).toBeUndefined()
    expect(deriveCheckpointTranscriptIndex({ channel_values: { messages: [
      new HumanMessage({ id: "wrong", content: "unsafe", additional_kwargs: { function_row: stamp() } })
    ] } }).hasInvalidFunctionRows).toBe(true)
  })

  it("does not treat a legacy generated checkpoint ID as an actual stamped UUID", () => {
    const serialized = { lc: 1, type: "constructor",
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "legacy body" } }
    const old = deriveCheckpointTranscriptIndex({ channel_values: { messages: [serialized] } })
    expect(old.visibleMessages[0]?.id).toBe("msg-0")
    expect(old.hasInvalidFunctionRows).toBeUndefined()
    const native = { ...serialized, kwargs: { ...serialized.kwargs,
      additional_kwargs: { function_row: { ...stamp("system"), uuid: "msg-0",
        door: "response", messageType: "assistant" } } } }
    const corrupted = deriveCheckpointTranscriptIndex({ channel_values: { messages: [native] } })
    expect(corrupted.hasInvalidFunctionRows).toBe(true)
    expect(corrupted.visibleMessages).toEqual([])
    const valid = deriveCheckpointTranscriptIndex({ channel_values: { messages: [
      { ...native, kwargs: { ...native.kwargs, id: "msg-0" } }
    ] } })
    expect(valid.hasInvalidFunctionRows).toBeUndefined()
    expect(valid.visibleMessages[0]?.function_row?.uuid).toBe("msg-0")
  })
})
