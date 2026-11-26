import { describe, expect, it } from "vitest"

import type { Message, ToolCall } from "../types"
import {
  hasToolReplayCandidates,
  findReplayedToolExchangeAliases
} from "../../../shared/tool-transcript-replay"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { createLiveDisplayMessageProjector } from "./live-display-message-projection"
import { createIncrementalToolDerivationProjector } from "./message-render-stability"
import {
  createChatMessageProjector,
  createChatReplayAliasProjector,
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
  it("keeps proven history off unrelated tool-bearing token frames and rechecks changed evidence", () => {
    const original = assistant({ id: "settled", tool_calls: [executeCall] })
    const tool = assistant({
      id: "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465",
      role: "tool",
      content: "Settled output",
      tool_call_id: executeCall.id
    })
    const copy = { ...original, id: `${original.id}::cmb-same-role-duplicate:assistant:2` }
    const toolCopy = { ...tool, id: `${tool.id}::cmb-same-role-duplicate:tool:2` }
    const tail = assistant({
      id: "unrelated-tail",
      tool_calls: [{ ...executeCall, id: "unrelated-call" }]
    })
    const repeatedText = assistant({ id: `${original.id}::cmb-same-role-duplicate:assistant:3` })
    const repeatedPendingCall = {
      ...tail,
      id: `${original.id}::cmb-same-role-duplicate:assistant:4`
    }
    const history = [
      original,
      tool,
      copy,
      toolCopy,
      ...Array.from({ length: 10000 }, (_, index) => assistant({ id: `unrelated-${index}` })),
      tail,
      repeatedText,
      repeatedPendingCall
    ]
    let forbidHistoryReads = false
    const rows = new Proxy(history, {
      get(target, property, receiver) {
        if (forbidHistoryReads) throw new Error("the display traversed unchanged history")
        return Reflect.get(target, property, receiver)
      }
    })
    const project = createChatReplayAliasProjector()
    const deriveTools = createIncrementalToolDerivationProjector()
    const indexById = new Map(history.map((message, index) => [message.id, index]))
    const display = { messages: rows, indexById, structureVersion: 1 }
    const { aliases } = project({ ...display, contentVersion: 1, changedMessages: rows })
    expect(aliases.get(copy.id)).toBe(original.id)
    expect(aliases.get(toolCopy.id)).toBe(tool.id)
    deriveTools(rows, rows, 1, aliases)
    forbidHistoryReads = true
    for (let frame = 0; frame < 300; frame++) {
      const changedMessages = [tail, repeatedText, repeatedPendingCall].map((message) => ({
        ...message,
        content: `Streaming ${frame}`
      }))
      for (const changed of changedMessages) history[indexById.get(changed.id)!] = changed
      expect(project({ ...display, contentVersion: frame + 2, changedMessages }).aliases).toBe(
        aliases
      )
      const toolRows = deriveTools(rows, changedMessages, 1, aliases).messages
      expect(toolRows.map(({ id }) => id)).toEqual([
        original.id,
        tool.id,
        tail.id,
        repeatedPendingCall.id
      ])
    }
    forbidHistoryReads = false
    const distinct = { ...copy, reasoning: "Keep this distinct reasoning" }
    history[2] = distinct
    const { aliases: nextAliases } = project({
      ...display,
      contentVersion: 302,
      changedMessages: [distinct]
    })
    expect(nextAliases.size).toBe(0)
    expect(deriveTools(rows, [distinct], 1, nextAliases).messages.map(({ id }) => id)).toEqual([
      original.id,
      tool.id,
      copy.id,
      toolCopy.id,
      tail.id,
      repeatedPendingCall.id
    ])
  })

  it("rebuilds tool ownership when history is replaced at the same local revision", () => {
    const derive = createIncrementalToolDerivationProjector()
    const first = assistant({ id: "first", tool_calls: [executeCall] })
    const second = assistant({ id: "second", tool_calls: [executeCall] })
    const result = assistant({
      id: "result",
      role: "tool",
      content: "Result for first",
      tool_call_id: executeCall.id
    })
    const aliases = new Map([["hidden", "retained"]])
    const oldOrder = [second, first, result]
    const hydrated = [first, result, second]
    derive(oldOrder, oldOrder, 1, aliases)
    const { messages } = derive(hydrated, hydrated, 1, aliases)
    const associations = buildToolResultAssociations(messages)
    expect(associations.get(getWorkerToolUiKey(first.id, executeCall.id, 0))?.content).toBe(
      "Result for first"
    )
    expect(associations.has(getWorkerToolUiKey(second.id, executeCall.id, 0))).toBe(false)
  })

  it("updates the visible replay text without changing its tool owner or alias", () => {
    const original = assistant({
      id: "reply",
      content: "Checking",
      tool_calls: [
        executeCall,
        {
          id: "directory-call",
          name: "ls",
          args: {}
        }
      ]
    })
    const check = assistant({
      id: "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465",
      role: "tool",
      name: executeCall.name,
      tool_call_id: executeCall.id
    })
    const directory = assistant({
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      role: "tool",
      name: "ls",
      tool_call_id: "directory-call"
    })
    const copy = {
      ...original,
      id: "reply::cmb-same-role-duplicate:assistant:2",
      content: "Checking again"
    }
    const checkCopy = { ...check, id: `${check.id}::cmb-same-role-duplicate:tool:2` }
    const messages = [original, check, directory, copy, checkCopy]
    const display = {
      messages,
      structureVersion: 1,
      indexById: new Map(messages.map(({ id }, index) => [id, index]))
    }
    const project = createChatReplayAliasProjector()
    const first = project({ ...display, contentVersion: 1, changedMessages: messages })
    expect(first.aliases.get(copy.id)).toBe(original.id)
    expect(first.assistantContent.get(original.id)).toBe(copy.content)
    const revised = { ...copy, content: "Checking again before reporting" }
    messages[3] = revised
    const second = project({ ...display, contentVersion: 2, changedMessages: [revised] })
    expect(second.aliases).toBe(first.aliases)
    expect(second.assistantContent.get(original.id)).toBe(revised.content)
    expect(original.content).toBe("Checking")
  })

  it.each([
    {
      callName: "read_file",
      resultId: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      resultName: "execute",
      before: true
    },
    {
      callName: "bot_work_create",
      resultId: "bot-attempt-38607a85-e47b-4fcb-a144-abcca82a9991-1",
      resultName: "bot_work_create",
      before: false
    }
  ])(
    "rechecks late result names for $callName without an order change",
    ({ callName, resultId, resultName, before }) => {
      const toolCall = { ...executeCall, name: callName }
      const original = assistant({ id: "original", tool_calls: [toolCall] })
      const active = assistant({ id: "active", tool_calls: [toolCall] })
      const firstResult = assistant({
        id: "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465",
        role: "tool",
        tool_call_id: toolCall.id,
        name: callName
      })
      const copy = { ...firstResult, id: `${firstResult.id}::cmb-same-role-duplicate:tool:2` }
      const unlabeled = { ...firstResult, id: resultId, name: undefined, content: "New procedure" }
      const messages = [original, firstResult, active, copy, unlabeled]
      const display = {
        messages,
        structureVersion: 1,
        indexById: new Map(messages.map(({ id }, index) => [id, index]))
      }
      const project = createChatReplayAliasProjector()
      expect(
        project({ ...display, contentVersion: 1, changedMessages: messages }).aliases.has(copy.id)
      ).toBe(before)
      const labeled = { ...unlabeled, name: resultName }
      messages[messages.length - 1] = labeled
      const { aliases } = project({ ...display, contentVersion: 2, changedMessages: [labeled] })
      expect(aliases.has(copy.id)).toBe(!before)
      expect(aliases).toEqual(findDisplayedReplayAliases(messages))
    }
  )

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
    expect(findReplayedToolExchangeAliases(ambiguousOrder).get(replay.id)).toBe(original.id)
    const project = createChatMessageProjector()
    const before = project(ambiguousOrder, [], ambiguousOrder, 0, undefined, 1)
    const reordered = project(ambiguousOrder, [], resolvedHints, 0, undefined, 2)
    expect(reordered.structureVersion).toBeGreaterThan(before.structureVersion)
    expect(reordered.messages.map(({ id }) => id)).toEqual(resolvedHints.map(({ id }) => id))
    expect(findDisplayedReplayAliases(reordered.messages).get(replay.id)).toBe(original.id)

    const durableOnly = [user, original, result]
    const liveReplay = [replay, replayResult]
    expect(hasToolReplayCandidates(durableOnly)).toBe(false)
    expect(hasToolReplayCandidates(liveReplay)).toBe(false)
    const mixed = createChatMessageProjector()(durableOnly, liveReplay, [
      ...durableOnly,
      ...liveReplay
    ])
    expect(hasToolReplayCandidates(mixed.messages)).toBe(true)
    expect(findDisplayedReplayAliases(mixed.messages)).toEqual(
      new Map([
        [replay.id, original.id],
        [replayResult.id, result.id]
      ])
    )
  })

  it("keeps status and identity on a failed result replay during streaming", () => {
    const original = assistant({ tool_calls: [executeCall] })
    const result: Message = {
      id: "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465",
      role: "tool",
      content: "Failed",
      tool_call_id: executeCall.id,
      status: "error",
      is_error: true,
      created_at: new Date(1)
    }
    const baseline = [original, result]
    const originalAlias = `${original.id}::cmb-same-role-duplicate:assistant:2`
    const resultAlias = `${result.id}::cmb-same-role-duplicate:tool:2`
    const live = createLiveDisplayMessageProjector()(baseline, [
      {
        id: originalAlias,
        type: "ai",
        content: original.content,
        tool_calls: [executeCall],
        provider_source_id: original.id,
        provider_occurrence: 2
      },
      {
        id: resultAlias,
        type: "tool",
        content: "Failed",
        tool_call_id: executeCall.id,
        status: "error",
        is_error: true,
        provider_source_id: result.id,
        provider_occurrence: 2
      }
    ])
    const display = createChatMessageProjector()(baseline, live.messages, undefined, 0, live)
    expect(findDisplayedReplayAliases(display.messages)).toEqual(
      new Map([
        [originalAlias, original.id],
        [resultAlias, result.id]
      ])
    )
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

  it("lets a new call receive its own result after an old exact replay claimed its slot", () => {
    const resultId = "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465"
    const oldCall = assistant({ id: "older-call", tool_calls: [executeCall] })
    const current = assistant({
      id: "next-call",
      tool_calls: [{ ...executeCall, args: { command: "echo another fixture" } }]
    })
    const oldResult: Message = {
      id: resultId,
      role: "tool",
      tool_call_id: executeCall.id,
      content: "Old output",
      created_at: new Date(1)
    }
    const replay = { ...oldResult, id: `${resultId}::cmb-same-role-duplicate:tool:2` }
    const currentResult = {
      ...oldResult,
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      content: "Current output"
    }
    const rows = [
      assistant({ id: "u1", role: "user" }),
      oldCall,
      oldResult,
      assistant({ id: "u2", role: "user" }),
      current,
      replay,
      currentResult
    ]
    expect(findDisplayedReplayAliases(rows.slice(0, -1)).size).toBe(0)
    expect(
      findDisplayedReplayAliases([...rows.slice(0, -1), { ...currentResult, name: "another-tool" }])
        .size
    ).toBe(0)
    const aliases = findDisplayedReplayAliases(rows)
    expect(aliases).toEqual(new Map([[replay.id, oldResult.id]]))
    const trailing = { ...replay, id: `${resultId}::cmb-same-role-duplicate:tool:3` }
    const withTrailing = [...rows, trailing]
    const allAliases = findDisplayedReplayAliases(withTrailing)
    expect(allAliases).toEqual(
      new Map([
        [replay.id, oldResult.id],
        [trailing.id, oldResult.id]
      ])
    )
    const results = buildToolResultAssociations(
      withTrailing.filter(({ id }) => !allAliases.has(id))
    )
    expect(results.get(getWorkerToolUiKey(oldCall.id, executeCall.id, 0))?.content).toBe(
      "Old output"
    )
    expect(results.get(getWorkerToolUiKey(current.id, executeCall.id, 0))?.content).toBe(
      "Current output"
    )

    const currentReplay = {
      ...currentResult,
      id: `${currentResult.id}::cmb-same-role-duplicate:tool:2`
    }
    expect(findDisplayedReplayAliases([...withTrailing, currentReplay])).toEqual(
      new Map([
        [replay.id, oldResult.id],
        [trailing.id, oldResult.id],
        [currentReplay.id, currentResult.id]
      ])
    )

    const priorPreview = { ...currentResult, content: "Earlier result preview" }
    const priorFull = {
      ...currentResult,
      id: `${currentResult.id}::cmb-same-role-duplicate:tool:2`
    }
    const noCurrentResult = [
      assistant({ id: "u0", role: "user" }),
      assistant({ id: "unrelated-older-call", tool_calls: [executeCall] }),
      priorPreview,
      ...rows.slice(0, -1),
      priorFull
    ]
    expect(findDisplayedReplayAliases(noCurrentResult).size).toBe(0)

    const waiting = assistant({
      id: "waiting-call",
      tool_calls: [{ ...executeCall, args: { command: "echo still waiting" } }]
    })
    const waitingReplay = { ...replay, id: `${resultId}::cmb-same-role-duplicate:tool:4` }
    const withWaiting = [...rows, assistant({ id: "u3", role: "user" }), waiting, waitingReplay]
    expect(findDisplayedReplayAliases(withWaiting)).toEqual(aliases)

    const independentCall = { ...executeCall, id: "different-raw-id" }
    const independentAssistant = (id: string) =>
      assistant({ id, tool_calls: [{ ...independentCall, args: { command: id } }] })
    const independentResult = (id: string, content: string) => ({
      ...oldResult,
      id,
      tool_call_id: independentCall.id,
      content
    })
    const otherOld = independentResult(
      "2a336f5a-c3d6-406d-bcf8-5fda5e53c111",
      "Other previous output"
    )
    const otherReplay = { ...otherOld, id: `${otherOld.id}::cmb-same-role-duplicate:tool:2` }
    const ambiguousBucket = [
      assistant({ id: "u-d1", role: "user" }),
      independentAssistant("d1"),
      otherOld,
      assistant({ id: "u-d2", role: "user" }),
      independentAssistant("d2"),
      otherReplay,
      independentAssistant("d3"),
      independentResult("89668b32-971a-43fa-81aa-ce014c243774", "D2 or D3"),
      independentResult("0e02e6a6-9b77-44cc-9bc1-04f4303e6d0e", "Unclear owner")
    ]
    expect(findDisplayedReplayAliases([...rows, ...ambiguousBucket])).toEqual(aliases)
    const sameCallBucket = ambiguousBucket.map((row) => ({
      ...row,
      ...(row.tool_calls
        ? { tool_calls: row.tool_calls.map((tool) => ({ ...tool, id: executeCall.id })) }
        : {}),
      ...(row.tool_call_id ? { tool_call_id: executeCall.id } : {})
    }))
    expect(findDisplayedReplayAliases([...rows, ...sameCallBucket])).toEqual(aliases)
  })
  it.each([true, false])("keeps live reasoning when the replay target is resident (%s)", (resident) => {
    const original = assistant()
    const replay = assistant({ id: "replay" })
    const live = { ...replay, reasoning: "Unique live reasoning" }
    const aliases = new Map([[replay.id, original.id]])
    const display = createChatMessageProjector()(resident ? [original, replay] : [replay], [live], undefined)
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
