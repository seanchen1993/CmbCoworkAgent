import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ElectronIPCTransport } from "./electron-transport"
import { useAppStore } from "./store"
import {
  mergeWorkerCheckpointSparseContent,
  preserveWorkerHistoryMessageIdentities
} from "./worker-checkpoint-history"
import { normalizeAppendedMessageIds } from "../../../shared/message-role-collision"
import { resolveWorkerSnapshotContent } from "./worker-message-content"
import type { Message } from "../types"
import { STREAM_MESSAGE_CONTENT_MODE_KEY } from "../../../shared/stream-message-wire-mode"

const parent = "team-content-test"
const worker = `${parent}__worker__one`
const draft = "Earlier draft moved to the final answer. ".repeat(4)

function wire(content: Message["content"], id?: string, type = "AIMessage") {
  return { id: ["langchain_core", "messages", type], kwargs: { id, content } }
}

function values(transport: ElectronIPCTransport, messages: unknown[]) {
  const result = transport.convertFocusedCoordinatorWorkerIPCEvent(
    { type: "stream", mode: "values", data: { messages }, workerTurn: 1 },
    parent
  )
  useAppStore.getState().appendWorkerFocusMessages(worker, result, { orderedSnapshot: true })
  return result
}

function chunk(
  transport: ElectronIPCTransport,
  content: string,
  mode: "delta" | "snapshot",
  workerTurn = 1
) {
  const message = wire(content, "answer", "AIMessageChunk")
  const result = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      type: "stream",
      mode: "messages",
      workerTurn,
      data: [message, { [STREAM_MESSAGE_CONTENT_MODE_KEY]: mode }]
    },
    parent
  )
  useAppStore.getState().appendWorkerFocusMessages(worker, result)
  return result
}

beforeEach(() => {
  useAppStore.getState().openWorkerFocusView({
    threadId: parent,
    workerThreadId: worker,
    workerId: "one",
    role: "implementer",
    description: "Team content regression"
  })
})
afterEach(() => useAppStore.getState().closeWorkerFocusView())

describe("Team worker authoritative content", () => {
  it.each(["messages", "tail"] as const)(
    "keeps a fresh %s cycle separate when focus opens after a tool",
    (mode) => {
      const transport = new ElectronIPCTransport()
      const base: Message = {
        id: `worker-turn-${worker}-1::user`,
        role: "user",
        content: "request",
        created_at: new Date()
      }
      const history: Message[] = [
        base,
        {
          ...base,
          id: `worker-turn-${worker}-1::answer`,
          role: "assistant",
          content: draft,
          tool_calls: [{ id: "call", name: "read_file", args: {} }]
        },
        {
          ...base,
          id: `worker-turn-${worker}-1::result`,
          role: "tool",
          content: "result",
          tool_call_id: "call"
        }
      ]
      const incoming =
        mode === "messages"
          ? chunk(transport, "Fresh final answer", "snapshot")
          : transport.convertFocusedCoordinatorWorkerIPCEvent(
              {
                type: "stream",
                mode: "values",
                workerTurn: 1,
                valuesSnapshotKind: "tail",
                data: { messages: [wire("Fresh final answer", "answer")] }
              },
              parent
            )
      expect(incoming[0].worker_snapshot_identity).toBeUndefined()
      const normalized = normalizeAppendedMessageIds(
        history,
        preserveWorkerHistoryMessageIdentities(history, incoming),
        { splitAssistantAfterTool: true }
      )
      expect(normalized[0].id).not.toBe(history[1].id)
      expect(normalized[0].content).toBe("Fresh final answer")
    }
  )

  it("keeps a corrected tool cycle in its original slots", () => {
    const base: Message = {
      id: `worker-turn-${worker}-1::user`,
      role: "user",
      worker_snapshot_identity: true,
      content: "request",
      created_at: new Date()
    }
    const history: Message[] = [
      base,
      {
        ...base,
        id: `worker-turn-${worker}-1::call`,
        role: "assistant",
        content: draft,
        tool_calls: [{ id: "call", name: "read_file", args: { path: "file.txt" } }]
      },
      {
        ...base,
        id: `worker-turn-${worker}-1::tool`,
        role: "tool",
        content: "result",
        tool_call_id: "call"
      },
      { ...base, id: `worker-turn-${worker}-1::final`, role: "assistant", content: "final" }
    ]
    const incoming = history.map((message, index) =>
      index === 1 ? { ...message, content: "Fixed" } : message
    )
    const normalized = normalizeAppendedMessageIds(
      history,
      preserveWorkerHistoryMessageIdentities(history, incoming),
      { splitAssistantAfterTool: true }
    )
    expect(normalized.map((message) => message.id)).toEqual(history.map((message) => message.id))
    const unrelatedTool = { ...history[2], tool_call_id: "another-call" }
    expect(preserveWorkerHistoryMessageIdentities(history, [unrelatedTool])[0]).toBe(unrelatedTool)
  })

  it("keeps a replayed turn-scoped user in place after an assistant correction", () => {
    const user: Message = {
      id: `worker-turn-${worker}-1::user`,
      role: "user",
      worker_snapshot_identity: true,
      content: "request",
      created_at: new Date()
    }
    const assistant: Message = {
      ...user,
      id: `worker-turn-${worker}-1::answer`,
      role: "assistant",
      content: draft
    }
    const history = [user, assistant]
    const incoming = [user, { ...assistant, content: "Fixed" }]
    const normalized = normalizeAppendedMessageIds(
      history,
      preserveWorkerHistoryMessageIdentities(history, incoming),
      { splitAssistantAfterTool: true }
    )
    expect(normalized.map((message) => message.id)).toEqual(history.map((message) => message.id))
  })

  it("preserves new user occurrences, other turns, other workers and unscoped IDs", () => {
    const user: Message = {
      id: `worker-turn-${worker}-1::user`,
      role: "user",
      worker_snapshot_identity: true,
      content: "request",
      created_at: new Date()
    }
    const history = [user, { ...user, id: "answer", role: "assistant" as const }]
    for (const incoming of [
      { ...user, id: `worker-turn-${worker}-2::user` },
      { ...user, id: "worker-turn-other-worker-1::user" },
      { ...user, provider_occurrence: 2 },
      { ...user, id: "user" }
    ]) {
      expect(preserveWorkerHistoryMessageIdentities(history, [incoming])[0]).toBe(incoming)
    }
    const bareUser = { ...user, id: "user" }
    const bareHistory = [bareUser, history[1]]
    const normalized = normalizeAppendedMessageIds(
      bareHistory,
      preserveWorkerHistoryMessageIdentities(bareHistory, [bareUser])
    )
    expect(normalized[0].id).not.toBe(bareUser.id)
  })

  it.each([true, false])(
    "applies shorter full-frame corrections before the tail (provider ids: %s)",
    (ids) => {
      const transport = new ElectronIPCTransport()
      const before = Array.from({ length: 40 }, (_, i) =>
        wire(i === 0 ? draft : `row ${i}`, ids ? `row-${i}` : undefined)
      )
      values(transport, before)
      const after = before.map((message) => ({ ...message, kwargs: { ...message.kwargs } }))
      after[0].kwargs.content = "Corrected"
      after[39].kwargs.content = draft
      const converted = values(transport, after)
      expect(converted.filter((message) => message.content === draft)).toHaveLength(1)
      const stored = useAppStore.getState().workerFocusMessages
      expect(stored).toHaveLength(40)
      expect(stored[0].content).toBe("Corrected")
      expect(stored.filter((message) => message.content === draft)).toHaveLength(1)
      expect(stored[0].worker_content_source).toBe("values")
    }
  )

  it("continues deltas from the corrected full body", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire(draft, "answer")])
    values(transport, [wire("Fixed", "answer")])
    chunk(transport, " plus", "delta")
    const stored = useAppStore.getState().workerFocusMessages
    expect(stored).toHaveLength(1)
    expect(stored[0].content).toBe("Fixed plus")
    expect(stored[0].worker_content_source).toBe("values")
  })

  it("preserves lagging values prefixes but accepts explicit truncation", () => {
    const transport = new ElectronIPCTransport()
    chunk(transport, "answer expanded", "delta")
    values(transport, [wire("answer", "answer")])
    expect(useAppStore.getState().workerFocusMessages[0].content).toBe("answer expanded")
    chunk(transport, " again", "delta")
    expect(useAppStore.getState().workerFocusMessages[0].content).toBe("answer expanded again")
    chunk(transport, "answer", "snapshot")
    expect(useAppStore.getState().workerFocusMessages[0].content).toBe("answer")
  })

  it.each(["append", "tail"] as const)("marks %s values bodies for checkpoint merging", (kind) => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire(draft, "answer")])
    const history = useAppStore.getState().workerFocusMessages[0]
    const messages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode: "values",
        data: { messages: [wire("Fixed", "answer")] },
        valuesSnapshotKind: kind,
        workerTurn: 1
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, messages)
    const live = useAppStore.getState().workerFocusMessages[0]
    expect(live.content).toBe("Fixed")
    expect(resolveWorkerSnapshotContent(history, live)).toBe("Fixed")
  })

  it("does not treat an unmarked partial fragment as a complete snapshot", () => {
    const message: Message = {
      id: "answer",
      role: "assistant",
      content: draft,
      created_at: new Date()
    }
    expect(resolveWorkerSnapshotContent(message, { ...message, content: "Fixed" })).toBeUndefined()
    expect(
      resolveWorkerSnapshotContent(message, {
        ...message,
        content: "Fixed",
        worker_content_source: "values"
      })
    ).toBe("Fixed")
  })

  it("preserves a complete body when legacy values omit it or send a sparse empty row", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire(draft, "answer")])
    for (const content of [undefined, ""]) {
      const sparse = values(transport, [
        {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: { id: "answer", content, reasoning_content: "thinking" }
        }
      ])
      expect(sparse[0].worker_content_source).toBeUndefined()
      expect(useAppStore.getState().workerFocusMessages[0].content).toBe(draft)
    }
  })

  it("keeps explicit wire clears through checkpoint enrichment and then continues", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire(draft, "answer")])
    const history = useAppStore.getState().workerFocusMessages[0]
    chunk(transport, "", "snapshot")
    const cleared = useAppStore.getState().workerFocusMessages[0]
    expect(cleared.content).toBe("")
    expect(mergeWorkerCheckpointSparseContent(history, cleared)).toBe("")
    chunk(transport, "New", "delta")
    expect(useAppStore.getState().workerFocusMessages[0].content).toBe("New")
  })

  it("keeps late previous-turn snapshot clears without changing the active turn", () => {
    const transport = new ElectronIPCTransport()
    chunk(transport, draft, "snapshot")
    const history = useAppStore.getState().workerFocusMessages[0]
    chunk(transport, "Turn two", "snapshot", 2)
    chunk(transport, "", "snapshot", 1)
    const messages = useAppStore.getState().workerFocusMessages
    expect(messages.map((message) => message.content)).toEqual(["", "Turn two"])
    expect(resolveWorkerSnapshotContent(history, messages[0])).toBe("")
    expect(mergeWorkerCheckpointSparseContent(history, messages[0])).toBe("")
  })

  it.each([false, true])(
    "keeps late corrections in the original slot across user turns (metadata: %s)",
    (metadata) => {
      const transport = new ElectronIPCTransport()
      const messages = [
        wire("First request", "user", "HumanMessage"),
        wire(draft, "answer"),
        wire("Second request", "user", "HumanMessage"),
        wire("Active answer", "answer")
      ].map((message) => ({
        ...message,
        kwargs: {
          ...message.kwargs,
          ...(metadata && {
            additional_kwargs: {
              cmb_internal_provider_source_id: message.kwargs.id,
              cmb_internal_provider_occurrence: 1
            }
          })
        }
      }))
      values(transport, messages.slice(0, 2))
      const initial = transport.convertFocusedCoordinatorWorkerIPCEvent(
        { type: "stream", mode: "values", workerTurn: 2, data: { messages } },
        parent
      )
      useAppStore.getState().appendWorkerFocusMessages(worker, initial, { orderedSnapshot: true })
      expect(useAppStore.getState().workerFocusMessages.map((message) => message.content)).toEqual([
        "First request",
        draft,
        "Second request",
        "Active answer"
      ])
      const ids = useAppStore.getState().workerFocusMessages.map((message) => message.id)
      chunk(transport, "", "snapshot", 1)
      chunk(transport, "Revised", "delta", 1)
      const stored = useAppStore.getState().workerFocusMessages
      expect(stored.map((message) => message.id)).toEqual(ids)
      expect(stored.map((message) => message.content)).toEqual([
        "First request",
        "Revised",
        "Second request",
        "Active answer"
      ])
    }
  )

  it("keeps checkpoint enrichment for partial fragments and equivalent content blocks", () => {
    const history: Message = {
      id: "history",
      role: "assistant",
      content: [{ type: "text", text: draft }],
      created_at: new Date()
    }
    expect(mergeWorkerCheckpointSparseContent(history, { ...history, content: "" })).toBe(
      history.content
    )
    expect(
      mergeWorkerCheckpointSparseContent(history, {
        ...history,
        content: draft,
        worker_content_source: "values"
      })
    ).toBe(history.content)
  })

  it("routes a late explicit occurrence to its own tool cycle", () => {
    const transport = new ElectronIPCTransport()
    const message = (content: string, occurrence: number, kind = "AIMessage") => ({
      ...wire(content, "answer", kind),
      kwargs: {
        id: "answer",
        content,
        additional_kwargs: {
          cmb_internal_provider_source_id: "answer",
          cmb_internal_provider_occurrence: occurrence
        }
      }
    })
    const initial = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode: "values",
        workerTurn: 2,
        data: {
          messages: [
            wire("First request", "user", "HumanMessage"),
            message("First cycle", 1),
            {
              ...wire("result", "tool", "ToolMessage"),
              kwargs: {
                id: "tool",
                content: "result",
                tool_call_id: "call"
              }
            },
            message("Second cycle", 2),
            wire("Second request", "user", "HumanMessage"),
            message("Active answer", 1)
          ]
        }
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, initial, { orderedSnapshot: true })
    const ids = useAppStore.getState().workerFocusMessages.map((item) => item.id)
    for (const [content, mode] of [
      ["Fixed", "snapshot"],
      [" second", "delta"]
    ]) {
      const update = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [message(content, 2, "AIMessageChunk"), { [STREAM_MESSAGE_CONTENT_MODE_KEY]: mode }]
        },
        parent
      )
      useAppStore.getState().appendWorkerFocusMessages(worker, update)
    }
    const stored = useAppStore.getState().workerFocusMessages
    expect(stored.map((item) => item.id)).toEqual(ids)
    expect(stored.map((item) => item.content)).toEqual([
      "First request",
      "First cycle",
      "result",
      "Fixed second",
      "Second request",
      "Active answer"
    ])
  })

  it("preserves equal prose in separate provider occurrences", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire("Same", "shared"), wire("Same", "shared")])
    values(transport, [wire("Same", "shared"), wire("Same", "shared")])
    const stored = useAppStore.getState().workerFocusMessages
    expect(stored.map((message) => message.content)).toEqual(["Same", "Same"])
    expect(new Set(stored.map((message) => message.id)).size).toBe(2)
  })

  it("updates shorter structured tool results without deleting other messages", () => {
    const transport = new ElectronIPCTransport()
    const tool = (content: Message["content"]) => ({
      ...wire(content, "tool", "ToolMessage"),
      kwargs: { id: "tool", content, name: "read_file", tool_call_id: "call" }
    })
    values(transport, [tool(draft), wire("other", "answer")])
    values(transport, [tool([{ type: "text", text: "Fixed" }]), wire("other", "answer")])
    const stored = useAppStore.getState().workerFocusMessages
    expect(stored).toHaveLength(2)
    expect(stored[0].content).toBe("Fixed")
    expect(stored[0].tool_call_id).toBe("call")
  })
})
