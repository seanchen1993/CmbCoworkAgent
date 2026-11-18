import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import {
  createStreamDataSerializer,
  sanitizeCoordinatorWorkerStreamDataForRenderer
} from "../../../main/ipc/stream-data-serialization"
import { ElectronIPCTransport } from "./electron-transport"
import { enrichWorkerProviderIdentities, useAppStore } from "./store"
import {
  buildWorkerCheckpointHistory,
  checkpointHistoryMessageMatchesSparseLive,
  MAX_WORKER_HISTORY_MESSAGES,
  mergeWorkerCheckpointSparseContent,
  preserveWorkerHistoryMessageIdentities
} from "./worker-checkpoint-history"
import { normalizeAppendedMessageIds } from "../../../shared/message-role-collision"
import {
  createWorkerSignatureMatches,
  resolveWorkerSnapshotContent
} from "./worker-message-content"
import type { Message } from "../types"
import { STREAM_MESSAGE_CONTENT_MODE_KEY } from "../../../shared/stream-message-wire-mode"

const parent = "team-content-test"
const worker = `${parent}__worker__one`
const draft = "Earlier draft moved to the final answer. ".repeat(4)

function wire(content: Message["content"], id?: string, type = "AIMessage") {
  return { id: ["langchain_core", "messages", type], kwargs: { id, content } }
}

function providerWire(
  id: string,
  content: string,
  type = "AIMessage",
  occurrence = 1,
  toolCallId?: string
) {
  const message = wire(content, id, type)
  return {
    ...message,
    kwargs: {
      ...message.kwargs,
      tool_call_id: toolCallId,
      additional_kwargs: {
        cmb_internal_provider_source_id: "provider",
        cmb_internal_provider_occurrence: occurrence
      }
    }
  }
}

function values(transport: ElectronIPCTransport, messages: unknown[], workerTurn = 1) {
  const result = transport.convertFocusedCoordinatorWorkerIPCEvent(
    { type: "stream", mode: "values", data: { messages }, workerTurn },
    parent
  )
  useAppStore.getState().appendWorkerFocusMessages(worker, result, { orderedSnapshot: true })
  return result
}

function publishWorkerFrames(transport = new ElectronIPCTransport()) {
  const serialize = createStreamDataSerializer()
  return (mode: "messages" | "values", payload: unknown, workerTurn = 1) => {
    const { data, valuesMessageIndexOffset, valuesSnapshotKind } = serialize(mode, payload)
    const rows = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode,
        data: sanitizeCoordinatorWorkerStreamDataForRenderer(mode, data, valuesMessageIndexOffset),
        workerTurn,
        valuesSnapshotKind
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, rows, {
      orderedSnapshot: mode === "values" && valuesSnapshotKind === "full"
    })
    return valuesSnapshotKind
  }
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
  it("keeps a declared tuple independent from an inferred occurrence in the same full frame", () => {
    const legacy = wire("Legacy answer", "provider")
    const explicit = providerWire("named-explicit", "Explicit answer")
    const user = wire("First prompt", "first-user", "HumanMessage")
    for (const snapshot of [
      [legacy, explicit],
      [explicit, legacy]
    ]) {
      useAppStore.setState({ workerFocusMessages: [] })
      values(new ElectronIPCTransport(), [user, ...snapshot])
      const live = useAppStore.getState().workerFocusMessages.slice(1)
      const checkpoint = buildWorkerCheckpointHistory([user, ...snapshot], worker).messages.slice(1)
      for (const rows of [live, checkpoint]) {
        expect(rows.map((message) => message.content)).toEqual(
          snapshot.map((message) => message.kwargs.content)
        )
        expect(new Set(rows.map((message) => message.id)).size).toBe(2)
      }
      const declared = checkpoint.find((message) => message.worker_provider_identity)!
      expect(
        checkpointHistoryMessageMatchesSparseLive({ ...declared, provider_occurrence: 2 }, declared)
      ).toBe(false)
    }
  })

  it.each([false, true])(
    "routes an explicit alias delta to its own row when the worker turn is stale: %s",
    (stale) => {
      const transport = new ElectronIPCTransport()
      const legacy = wire("Legacy answer", "provider")
      const explicit = providerWire("original-alias", "Explicit answer")
      const snapshot = [
        wire("First prompt", "first-user", "HumanMessage"),
        ...(stale ? [legacy, explicit] : [explicit, legacy])
      ]
      if (stale) {
        snapshot.push(
          wire("Second prompt", "second-user", "HumanMessage"),
          wire("Latest answer", "unrelated")
        )
      }
      values(transport, snapshot, stale ? 2 : 1)
      const before = useAppStore.getState().workerFocusMessages
      const explicitRow = before.find((message) => message.worker_provider_identity)!

      const updates = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [
            providerWire("new-alias", " with continuation", "AIMessageChunk"),
            { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "delta" }
          ]
        },
        parent
      )
      expect(updates).toMatchObject([
        { id: explicitRow.id, content: "Explicit answer with continuation" }
      ])
      useAppStore.getState().appendWorkerFocusMessages(worker, updates)
      const after = useAppStore.getState().workerFocusMessages
      expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id))
      expect(after.map(({ content }) => content)).toEqual(
        before.map((message) =>
          message.id === explicitRow.id ? "Explicit answer with continuation" : message.content
        )
      )
    }
  )

  it.each([false, true])(
    "keeps an unobserved explicit occurrence separate from an occupied legacy ID (stale: %s)",
    (stale) => {
      const transport = new ElectronIPCTransport()
      const snapshot = [
        wire("First prompt", "first-user", "HumanMessage"),
        wire("Legacy answer", "provider")
      ]
      if (stale) snapshot.push(wire("Second prompt", "second-user", "HumanMessage"))
      values(transport, snapshot, stale ? 2 : 1)
      const legacy = useAppStore.getState().workerFocusMessages[1]

      const chunk = providerWire("unused", "Independent answer", "AIMessageChunk")
      const newOccurrence = { ...chunk, kwargs: { ...chunk.kwargs, id: undefined } }
      const updates = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [newOccurrence, { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "delta" }]
        },
        parent
      )
      expect(updates[0].content).toBe("Independent answer")
      expect(updates[0].id).not.toBe(legacy.id)
      useAppStore.getState().appendWorkerFocusMessages(worker, updates)
      const answers = useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant")
      expect(answers.map(({ content }) => content)).toEqual(["Legacy answer", "Independent answer"])
      expect(new Set(answers.map(({ id }) => id)).size).toBe(2)
    }
  )

  it("reserves a new provider's accumulator when another provider owns its proposed ID", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [providerWire("other-provider", "Earlier independent reply.")])
    const update = (id: string, body: string) => {
      const message = providerWire(id, body, "AIMessageChunk")
      message.kwargs.additional_kwargs.cmb_internal_provider_source_id = "other-provider"
      const updates = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [message, { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "delta" }]
        },
        parent
      )
      useAppStore.getState().appendWorkerFocusMessages(worker, updates)
      return updates[0]
    }

    const first = update("first-wire-id", "New independent reply")
    const second = update("another-wire-id", " continues.")
    expect(first.content).toBe("New independent reply")
    expect(second).toMatchObject({ id: first.id, content: "New independent reply continues." })
    expect(useAppStore.getState().workerFocusMessages.map(({ content }) => content)).toEqual([
      "Earlier independent reply.",
      "New independent reply continues."
    ])
  })

  it("does not assign an explicit tuple to a legacy exact row if that tuple already has a row", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [
      wire("First prompt", "first-user", "HumanMessage"),
      wire("Legacy answer", "provider"),
      providerWire("original-alias", "Explicit answer")
    ])
    const before = useAppStore.getState().workerFocusMessages
    const legacy = before.find((message) => message.content === "Legacy answer")!
    const explicit = before.find((message) => message.worker_provider_identity)!
    useAppStore.getState().appendWorkerFocusMessages(worker, [
      {
        ...explicit,
        id: legacy.id,
        content: "Explicit correction",
        worker_content_source: "snapshot"
      }
    ])
    const after = useAppStore.getState().workerFocusMessages
    expect(after.map(({ id, content }) => [id, content])).toEqual([
      [before[0].id, "First prompt"],
      [legacy.id, "Legacy answer"],
      [explicit.id, "Explicit correction"]
    ])
  })

  it("adopts an idless legacy snapshot row when a full frame supplies its explicit identity", () => {
    const transport = new ElectronIPCTransport()
    const user = wire("First prompt", "first-user", "HumanMessage")
    values(transport, [user, wire("Same answer")])
    const legacy = useAppStore.getState().workerFocusMessages[1]

    values(transport, [user, providerWire("now-identified", "Same answer")])
    expect(useAppStore.getState().workerFocusMessages.slice(1)).toMatchObject([
      {
        id: legacy.id,
        content: "Same answer",
        provider_occurrence: 1,
        worker_provider_identity: true
      }
    ])
  })

  it("reserves a still-present idless snapshot row for its own slot before upgrading by prose", () => {
    const transport = new ElectronIPCTransport()
    const user = wire("First prompt", "first-user", "HumanMessage")
    const legacy = wire("Same answer")
    const unrelated = wire("Earlier answer", "other")
    values(transport, [user, unrelated, legacy])
    const originalId = useAppStore.getState().workerFocusMessages.at(-1)!.id

    // The independent provider row comes first, but the legacy row is still
    // present at its own exact snapshot position later in the same frame.
    values(transport, [user, providerWire("independent", "Same answer"), legacy])
    const rows = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.content === "Same answer")
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === originalId)?.worker_provider_identity).toBeUndefined()
    expect(rows.find((row) => row.worker_provider_identity)?.id).not.toBe(originalId)
  })

  it("updates an identified live row when a later chunk has the same ID without metadata", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [providerWire("provider", "Original answer")])
    const [original] = useAppStore.getState().workerFocusMessages
    const update = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode: "messages",
        workerTurn: 1,
        data: [
          wire(" with continuation", "provider", "AIMessageChunk"),
          { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "delta" }
        ]
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, update)
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: original.id, content: "Original answer with continuation" }
    ])
  })

  it("continues the identified reply through the production wire when the next delta omits its tuple", () => {
    const publish = publishWorkerFrames()
    const initial = {
      id: "wire-a",
      content: "First reply",
      additional_kwargs: {
        cmb_internal_provider_source_id: "provider-with-different-wire-id",
        cmb_internal_provider_occurrence: 1
      }
    }
    publish("messages", [new AIMessageChunk(initial), {}])
    const [original] = useAppStore.getState().workerFocusMessages
    publish("values", {
      messages: [new HumanMessage("First request"), new AIMessage(initial)]
    })
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: " continues" }), {}])
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: original.id, content: "First reply continues", worker_provider_identity: true }
    ])

    publish("messages", [new AIMessageChunk({ id: "wire-a", content: "Second turn" }), {}], 2)
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: " later" }), {}], 1)
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: original.id, content: "First reply continues later", worker_provider_identity: true },
      { content: "Second turn" }
    ])
  })

  it("remembers earlier aliases across complete frames, completed messages and a late delta", () => {
    const publish = publishWorkerFrames()
    const additional_kwargs = providerWire("wire-a", "draft").kwargs.additional_kwargs
    const ai = (id: string, content: string) => new AIMessage({ id, content, additional_kwargs })
    const user = new HumanMessage({ id: "request", content: "First request" })
    const values = (message: AIMessage) => publish("values", { messages: [user, message] })
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: "draft", additional_kwargs }), {}])
    const [original] = useAppStore.getState().workerFocusMessages
    expect(values(ai("wire-b", "Fixed"))).toBe("full")
    expect(values(ai("wire-c", "Final"))).toBe("full")
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: " answer" }), {}])
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: original.id, content: "Final answer", worker_provider_identity: true }
    ])

    publish("messages", [new AIMessage({ id: "wire-b", content: "Completed" }), {}])
    expect(values(new AIMessage({ id: "wire-c", content: "Corrected" }))).toBe("full")
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: "Second reply" }), {}], 2)
    publish("messages", [new AIMessageChunk({ id: "wire-a", content: " later" }), {}], 1)
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: original.id, content: "Corrected later", worker_provider_identity: true },
      { content: "Second reply" }
    ])
  })

  it("remembers every explicit alias reconciled within a complete frame", () => {
    const publish = publishWorkerFrames()
    const additional_kwargs = providerWire("old", "draft").kwargs.additional_kwargs
    publish("values", {
      messages: [
        new AIMessage({ id: "old", content: "draft", additional_kwargs }),
        new AIMessage({ id: "new", content: "Fixed", additional_kwargs })
      ]
    })
    publish("messages", [new AIMessageChunk({ id: "old", content: " answer" }), {}])
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([{ content: "Fixed answer" }])
  })

  it("keeps an untagged row when its wire ID already belongs to a declared row in the frame", () => {
    const publish = publishWorkerFrames()
    const additional_kwargs = providerWire("reused", "draft").kwargs.additional_kwargs
    const original = new AIMessage({ id: "reused", content: "Original", additional_kwargs })
    publish("values", { messages: [original] })
    publish("values", {
      messages: [
        new AIMessage({ id: "reused", content: "Corrected", additional_kwargs }),
        new AIMessage({ id: "reused", content: "Independent" })
      ]
    })
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { content: "Corrected", worker_provider_identity: true },
      { content: "Independent" }
    ])
    expect(useAppStore.getState().workerFocusMessages[1].worker_provider_identity).toBeUndefined()
  })

  it("keeps independent occurrences when an untagged chunk uses their shared wire ID", () => {
    const publish = publishWorkerFrames()
    const ai = (content: string, occurrence: number) =>
      new AIMessage({
        id: "reused",
        content,
        additional_kwargs: providerWire("reused", content, "AIMessage", occurrence).kwargs
          .additional_kwargs
      })
    publish("values", { messages: [ai("First", 1), ai("Second", 2)] })
    publish("messages", [new AIMessageChunk({ id: "reused", content: "Unattributed" }), {}])
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { content: "First", provider_occurrence: 1 },
      { content: "Second", provider_occurrence: 2 },
      { content: "Unattributed" }
    ])
  })

  it.each([false, true])(
    "does not use a declared render ID as wire evidence (stale: %s)",
    (stale) => {
      const publish = publishWorkerFrames()
      const additional_kwargs = providerWire("observed", "original").kwargs.additional_kwargs
      publish("messages", [
        new AIMessageChunk({ id: "observed", content: "Original", additional_kwargs }),
        {}
      ])
      if (stale) {
        publish("messages", [new AIMessageChunk({ id: "other", content: "New turn" }), {}], 2)
      }
      publish("messages", [new AIMessageChunk({ id: "provider", content: "Independent" }), {}])
      const rows = useAppStore.getState().workerFocusMessages
      expect(rows.find((row) => row.worker_provider_identity)?.content).toBe("Original")
      expect(rows.find((row) => row.content === "Independent")?.worker_provider_identity).toBeFalsy()
      expect(rows).toHaveLength(stale ? 3 : 2)
    }
  )

  it("keeps a reused alias in a new tool cycle separate from the earlier reply", () => {
    const publish = publishWorkerFrames()
    const first = new AIMessage({
      id: "reused",
      content: "First request",
      additional_kwargs: providerWire("reused", "draft").kwargs.additional_kwargs,
      tool_calls: [{ id: "call", name: "read_file", args: {} }]
    })
    const result = new ToolMessage({ id: "result", content: "Tool result", tool_call_id: "call" })
    publish("values", { messages: [first] })
    publish("values", {
      messages: [first, result, new AIMessage({ id: "reused", content: "After tool" })]
    })
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { content: "First request", worker_provider_identity: true },
      { content: "Tool result" },
      { content: "After tool" }
    ])
    expect(useAppStore.getState().workerFocusMessages[2].worker_provider_identity).toBeUndefined()
  })

  it("keeps explicit conflicts out of the legacy signature window without consuming their slots", () => {
    const conflict: Message = {
      id: "worker-snapshot-0",
      role: "assistant",
      content: "Same answer",
      created_at: new Date(),
      provider_source_id: "source-a",
      provider_occurrence: 1,
      worker_provider_identity: true
    }
    const incoming = { ...conflict, id: "wire-b", provider_source_id: "source-b" }
    const legacy = { ...conflict, id: "worker-snapshot-1", worker_provider_identity: false }
    const matches = createWorkerSignatureMatches([conflict, legacy])
    const counts = new Map([["signature", 2]])
    matches.add("signature", 0)
    matches.add("signature", 1)
    expect(matches.take("signature", counts, incoming)).toBe(1)
    expect(matches.take("signature", counts, incoming)).toBeUndefined()
    expect(counts.get("signature")).toBe(1)
    expect(matches.take("signature", counts, legacy)).toBe(0)
  })

  it("does not repeatedly inspect identified rows when an entire signature window has the same prose", () => {
    let inspected = 0
    const history = Array.from(
      { length: 500 },
      (_, index): Message => ({
        id: `worker-snapshot-${index}`,
        role: "assistant",
        content: "Same answer",
        created_at: new Date(),
        provider_source_id: `source-${index}`,
        provider_occurrence: 1,
        get worker_provider_identity() {
          inspected += 1
          return true
        }
      })
    )
    const counts = new Map([["same", history.length]])
    const matches = createWorkerSignatureMatches(history)
    history.forEach((_, index) => matches.add("same", index))
    const incoming = { ...history[0], id: "wire", provider_source_id: "different-source" }
    inspected = 0
    history.forEach(() => expect(matches.take("same", counts, incoming)).toBeUndefined())
    expect(inspected).toBe(0)
  })

  it("updates the same live row when complete snapshots and later chunks change wire IDs", () => {
    const transport = new ElectronIPCTransport()
    const sendChunk = (id: string, content: string, mode: "snapshot" | "delta") => {
      const result = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [
            providerWire(id, content, "AIMessageChunk"),
            { [STREAM_MESSAGE_CONTENT_MODE_KEY]: mode }
          ]
        },
        parent
      )
      useAppStore.getState().appendWorkerFocusMessages(worker, result)
    }
    sendChunk("chunk", "initial live draft", "snapshot")
    const [initial] = useAppStore.getState().workerFocusMessages
    values(transport, [
      providerWire("draft-alias", "long earlier draft"),
      providerWire("answer-alias", "Corrected")
    ])
    sendChunk("new-chunk-alias", " reply", "delta")
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      {
        id: initial.id,
        content: "Corrected reply",
        provider_source_id: `worker-turn-${worker}-1::provider`,
        provider_occurrence: 1
      }
    ])
  })

  it("preserves different turns, occurrences and tool calls in live and restored snapshots", () => {
    const transport = new ElectronIPCTransport()
    const snapshot = [
      wire("First prompt", "user-one", "HumanMessage"),
      providerWire("first-a", "old"),
      providerWire("first-b", "first reply"),
      providerWire("tool-a", "tool result A", "ToolMessage", 1, "call-a"),
      providerWire("tool-a-alias", "corrected tool result A", "ToolMessage", 1, "call-a"),
      providerWire("tool-b", "tool result B", "ToolMessage", 1, "call-b"),
      providerWire("another-occurrence", "first reply", "AIMessage", 2),
      wire("Second prompt", "user-two", "HumanMessage"),
      providerWire("second", "second reply")
    ]
    values(transport, snapshot, 2)
    const live = useAppStore.getState().workerFocusMessages
    const restored = buildWorkerCheckpointHistory(snapshot, worker).messages
    for (const result of [live, restored]) {
      expect(result.map((message) => message.content)).toEqual([
        "First prompt",
        "first reply",
        "corrected tool result A",
        "tool result B",
        "first reply",
        "Second prompt",
        "second reply"
      ])
      expect(new Set(result.map(({ id }) => id)).size).toBe(result.length)
      expect(
        result.filter((message) => message.role === "tool").map((item) => item.tool_call_id)
      ).toEqual(["call-a", "call-b"])
    }
  })

  it("keeps independent explicit identities when consecutive frames reuse a wire ID", () => {
    const transport = new ElectronIPCTransport()
    const one = providerWire("reused", "first")
    const two = providerWire("reused", "second")
    two.kwargs.additional_kwargs.cmb_internal_provider_source_id = "another-provider"
    values(transport, [one])
    values(transport, [two])
    const rows = useAppStore.getState().workerFocusMessages
    expect(rows.map((message) => message.content)).toEqual(["first", "second"])
    expect(new Set(rows.map((message) => message.id)).size).toBe(2)
    expect(rows.every((message) => message.id.startsWith(`worker-turn-${worker}-1::`))).toBe(true)
  })

  it("adopts explicit metadata when a tail snapshot arrives for a known wire ID", () => {
    const transport = new ElectronIPCTransport()
    values(transport, [wire("Legacy draft", "raw")])
    const [initial] = useAppStore.getState().workerFocusMessages
    const tail = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode: "values",
        workerTurn: 1,
        valuesSnapshotKind: "tail",
        data: { messages: [providerWire("raw", "Tail correction")] }
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, tail)
    expect(useAppStore.getState().workerFocusMessages).toMatchObject([
      { id: initial.id, content: "Tail correction", provider_occurrence: 1 }
    ])
  })

  it("reconciles a legacy checkpoint row with explicit metadata adopted by the live row", () => {
    const raw = [wire("First prompt", "user", "HumanMessage"), wire("Previous answer", "raw")]
    const checkpoint = buildWorkerCheckpointHistory(raw, worker).messages
    const live = values(new ElectronIPCTransport(), raw)
      .filter((message) => message.role === "assistant")
      .map((message) => ({
        ...message,
        content: "Latest answer",
        provider_source_id: `worker-turn-${worker}-1::provider`,
        provider_occurrence: 1,
        worker_provider_identity: true
      }))
    const prepared = enrichWorkerProviderIdentities(checkpoint, live)
    expect(normalizeAppendedMessageIds(prepared, live)[0].id).toBe(checkpoint[1].id)
    expect(checkpoint[1].provider_source_id).toBeUndefined()
  })

  it("restores the bounded raw checkpoint window while preserving legacy occurrence history", () => {
    const history = buildWorkerCheckpointHistory(
      [
        wire("First prompt", "user", "HumanMessage"),
        wire("Old reply outside the window", "reused"),
        ...Array.from({ length: MAX_WORKER_HISTORY_MESSAGES - 1 }, (_, index) =>
          wire(`Recent reply ${index}`, `recent-${index}`)
        ),
        wire("Recent reply with a reused ID", "reused")
      ],
      worker
    )
    expect(history.truncatedCount).toBe(2)
    expect(history.messages).toHaveLength(MAX_WORKER_HISTORY_MESSAGES)
    expect(history.messages[0].content).toBe("Recent reply 0")
    expect(history.messages.at(-1)).toMatchObject({
      content: "Recent reply with a reused ID",
      provider_occurrence: 2
    })
  })

  it("uses a newer complete snapshot to seed a subsequent previous-turn delta", () => {
    const transport = new ElectronIPCTransport()
    const full = (previous: string) => [
      wire("First prompt", "user-one", "HumanMessage"),
      providerWire("older-answer", previous),
      wire("Second prompt", "user-two", "HumanMessage"),
      providerWire("current-answer", "Current answer")
    ]
    const staleChunk = (content: string, mode: "snapshot" | "delta") => {
      const result = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          workerTurn: 1,
          data: [
            providerWire("earlier-wire-alias", content, "AIMessageChunk"),
            { [STREAM_MESSAGE_CONTENT_MODE_KEY]: mode }
          ]
        },
        parent
      )
      useAppStore.getState().appendWorkerFocusMessages(worker, result)
    }
    values(transport, full("Original"), 2)
    staleChunk("Cached older correction", "snapshot")
    values(transport, full("Latest complete answer"), 2)
    staleChunk(" with a suffix", "delta")
    const replies = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    expect(replies.map((message) => message.content)).toEqual([
      "Latest complete answer with a suffix",
      "Current answer"
    ])
  })

  it("indexes full-window provider aliases without scanning the history for every row", () => {
    const transport = new ElectronIPCTransport()
    const count = 500
    const frame = (alias: string) =>
      Array.from({ length: count }, (_, index) => {
        const message = providerWire(`${alias}-${index}`, `answer-${index}`)
        message.kwargs.additional_kwargs.cmb_internal_provider_source_id = `provider-${index}`
        return message
      })
    values(transport, frame("before"))
    const existing = useAppStore.getState().workerFocusMessages
    const ids = existing.map((message) => message.id)
    let historyReads = 0
    for (const message of existing) {
      for (const field of ["id", "provider_source_id"] as const) {
        const value = message[field]
        Object.defineProperty(message, field, {
          get: () => {
            historyReads += 1
            return value
          },
          configurable: true
        })
      }
    }
    values(transport, frame("alias"))
    expect(useAppStore.getState().workerFocusMessages.map((message) => message.id)).toEqual(ids)
    expect(historyReads).toBeLessThan(count * 50)
  })

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
