import { describe, expect, it } from "vitest"

import type { Message, ToolCall } from "../types"
import {
  hasToolReplayCandidates,
  findReplayedToolExchangeAliases
} from "../../../shared/tool-transcript-replay"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import {
  createChatMessageProjector,
  findDisplayedReplayAliases,
  preserveReplayToolBindings,
  resolveChatReplayAliases,
  type ChatLiveMessageProjectionMetadata
} from "./chat-message-projection"

const executeCall: ToolCall = {
  id: "call-execute",
  name: "execute",
  args: { command: "echo cleanup" }
}

function assistant(overrides: Partial<Message> = {}): Message {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "I will run cleanup.",
    created_at: new Date(1),
    ...overrides
  }
}

function liveProjection(
  changedMessages: readonly Message[],
  contentVersion: number
): ChatLiveMessageProjectionMetadata {
  return {
    changedMessages,
    contentVersion,
    structureVersion: 1
  }
}

describe("createChatMessageProjector tool-call reconciliation", () => {
  it("folds the calls and results proved by the projected order, not stale durable order", () => {
    const resultId = "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465"
    const user = assistant({ id: "user", role: "user", content: "Run both checks" })
    const original = assistant({ tool_calls: [executeCall] })
    const result: Message = {
      id: resultId,
      role: "tool",
      tool_call_id: executeCall.id,
      content: "First result",
      created_at: new Date(1)
    }
    const replay = { ...original, id: `${original.id}::cmb-same-role-duplicate:assistant:2` }
    const replayResult = { ...result, id: `${resultId}::cmb-same-role-duplicate:tool:2` }
    const other = assistant({ id: "other", tool_calls: [executeCall] })
    const otherResult = { ...result, id: "another-tool-result", content: "Independent result" }
    const durable = [user, original, result, replay, replayResult, other, otherResult]
    const hints = [user, original, replayResult, other, otherResult, replay, result]
    const display = createChatMessageProjector()(durable, [], hints)
    const aliases = findDisplayedReplayAliases(display.messages)
    expect(aliases.get(result.id)).toBe(replayResult.id)
    const results = buildToolResultAssociations(
      display.messages.filter(({ id }) => !aliases.has(id))
    )
    expect(results.get(getWorkerToolUiKey(other.id, executeCall.id, 0))?.content).toBe(
      "Independent result"
    )
    expect(results.get(getWorkerToolUiKey(original.id, executeCall.id, 0))?.content).toBe(
      "First result"
    )

    const ambiguousOrder = [user, original, replay, other, result, replayResult, otherResult]
    const resolvedHints = [user, original, result, replay, replayResult, other, otherResult]
    expect(hasToolReplayCandidates(ambiguousOrder)).toBe(true)
    expect(findReplayedToolExchangeAliases(ambiguousOrder).size).toBe(0)
    const reordered = createChatMessageProjector()(ambiguousOrder, [], resolvedHints)
    expect(findDisplayedReplayAliases(reordered.messages).get(replay.id)).toBe(original.id)
  })

  it("keeps a late tool result attached to an older pending user turn", () => {
    const user = (id: string) => assistant({ id, role: "user", content: id })
    const call = (id: string) => assistant({ id, tool_calls: [executeCall] })
    const resultId = "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465"
    const done: Message = {
      id: resultId,
      role: "tool",
      tool_call_id: executeCall.id,
      content: "Newest done",
      created_at: new Date(1)
    }
    const replay = { ...done, id: `${resultId}::cmb-same-role-duplicate:tool:2` }
    const oldestDone = { ...done, id: "oldest-result", content: "Oldest done" }
    const rows = [
      user("u1"),
      call("oldest"),
      user("u2"),
      call("previous"),
      user("u3"),
      call("newest"),
      done,
      replay,
      oldestDone
    ]
    expect(findDisplayedReplayAliases(rows).size).toBe(0)
    expect(preserveReplayToolBindings(rows, new Map([[replay.id, done.id]])).size).toBe(0)
  })
  it("keeps a replay row visible when only it has the live reasoning", () => {
    const original = assistant()
    const replay = assistant({ id: "replay" })
    const live = { ...replay, reasoning: "Unique live reasoning" }
    const aliases = new Map([[replay.id, original.id]])
    const display = createChatMessageProjector()([original, replay], [live], undefined)
    expect(resolveChatReplayAliases(aliases, [live], display).size).toBe(0)
    expect(resolveChatReplayAliases(aliases, [], display)).toBe(aliases)
  })
  it("fills missing durable tool calls from the matching live assistant", () => {
    const baseline = assistant()
    const live = assistant({ content: "", tool_calls: [executeCall] })

    const projection = createChatMessageProjector()(
      [baseline],
      [live],
      undefined,
      0,
      liveProjection([live], 1)
    )

    expect(projection.messages[0]).toMatchObject({
      content: baseline.content,
      tool_calls: [executeCall]
    })
  })

  it("preserves durable reasoning while independently filling live tool calls", () => {
    const baseline = assistant({ reasoning: "durable reasoning" })
    const live = assistant({ reasoning: "stale live reasoning", tool_calls: [executeCall] })

    const projection = createChatMessageProjector()([baseline], [live], undefined)

    expect(projection.messages[0]).toMatchObject({
      reasoning: "durable reasoning",
      tool_calls: [executeCall]
    })
  })

  it("keeps durable arrays authoritative, including an explicit empty clear", () => {
    const live = assistant({ tool_calls: [{ ...executeCall, args: {} }] })
    const clearedBaseline = assistant({ tool_calls: [] })
    const completeBaseline = assistant({ tool_calls: [executeCall] })

    const cleared = createChatMessageProjector()([clearedBaseline], [live], undefined)
    const complete = createChatMessageProjector()([completeBaseline], [live], undefined)

    expect(cleared.messages[0].tool_calls).toEqual([])
    expect(complete.messages[0].tool_calls).toEqual([executeCall])
  })

  it("does not synthesize a field from an empty live tool-call array", () => {
    const baseline = assistant()
    const live = assistant({ tool_calls: [] })

    const projection = createChatMessageProjector()([baseline], [live], undefined)

    expect(projection.messages[0]).toBe(baseline)
    expect(projection.messages[0].tool_calls).toBeUndefined()
  })

  it("updates a shared-id row when live tool calls arrive without a structure change", () => {
    const baseline = [assistant()]
    const liveMessages = [assistant({ content: "", tool_calls: [{ ...executeCall, args: {} }] })]
    const project = createChatMessageProjector()
    const before = project(baseline, liveMessages, undefined, 0, liveProjection(liveMessages, 1))
    expect(before.messages[0].tool_calls?.[0].args).toEqual({})

    const liveWithTools = assistant({ content: "", tool_calls: [executeCall] })
    liveMessages[0] = liveWithTools
    const after = project(baseline, liveMessages, undefined, 0, liveProjection([liveWithTools], 2))

    expect(after.messages).toBe(before.messages)
    expect(after.structureVersion).toBe(before.structureVersion)
    expect(after.contentVersion).toBeGreaterThan(before.contentVersion)
    expect(after.changedMessages).toHaveLength(1)
    expect(after.messages[0].tool_calls).toEqual([executeCall])
  })

  it("retains live tool calls through the durable-tail content fast path", () => {
    const baseline = [assistant()]
    const live = assistant({ content: "", tool_calls: [executeCall] })
    const liveState = liveProjection([live], 1)
    const project = createChatMessageProjector()

    project(baseline, [live], undefined, 0, liveState)
    baseline[0] = assistant({ content: "Updated durable content" })
    const after = project(baseline, [live], undefined, 1, liveState)

    expect(after.messages[0]).toMatchObject({
      content: "Updated durable content",
      tool_calls: [executeCall]
    })

    baseline[0] = assistant({ content: "Tool calls cleared", tool_calls: [] })
    const cleared = project(baseline, [live], undefined, 2, liveState)
    expect(cleared.messages[0]).toMatchObject({
      content: "Tool calls cleared",
      tool_calls: []
    })
  })

  it("does not merge live assistant fields into a shared-id message with another role", () => {
    const baseline: Message = {
      ...assistant(),
      role: "user"
    }
    const live = assistant({ reasoning: "live reasoning", tool_calls: [executeCall] })

    const projection = createChatMessageProjector()([baseline], [live], undefined)

    expect(projection.messages[0]).toBe(baseline)
    expect(projection.messages[0].reasoning).toBeUndefined()
    expect(projection.messages[0].tool_calls).toBeUndefined()
  })
})
