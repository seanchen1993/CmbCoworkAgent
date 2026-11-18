import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import {
  boundedCloneSnapshotValue,
  serializeWorkflowAgentSnapshotMessages,
  WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP,
  WORKFLOW_AGENT_SNAPSHOT_MAX_MESSAGES,
  WORKFLOW_AGENT_SNAPSHOT_TOTAL_CAP
} from "../../../main/agent/workflow/agent-snapshot"
import { agentToolStreamPath, readAgentToolStream } from "../../../main/agent/workflow/run-store"
import type { Message } from "../types"
import { ElectronIPCTransport } from "./electron-transport"
import { createWorkflowAgentMessageProjector } from "./workflow-agent-message-projection"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"

function message(index: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `message-${index}`,
    role: "assistant",
    content: `answer-${index}`,
    created_at: new Date(index),
    ...overrides
  }
}

describe("workflow complete snapshot projection", () => {
  it("distinguishes omitted calls, cleared calls and completed calls on snapshot aliases", () => {
    const call = (id: string) => ({ id, name: "read_file", args: { path: `${id}.txt` } })
    const metadata = (source: string) => ({
      cmb_internal_provider_source_id: source,
      cmb_internal_provider_occurrence: 1
    })
    const assistant = (source: string, tool_calls: ReturnType<typeof call>[]) =>
      new AIMessage({
        id: `${source}-first`,
        content: "Earlier",
        additional_kwargs: metadata(source),
        tool_calls
      })
    const alias = (source: string) =>
      new AIMessage({
        id: `${source}-alias`,
        content: source,
        additional_kwargs: metadata(source)
      })
    const repeatedCall = call("reused-call")
    const completedCall = call("completed-call")
    const pendingCall = call("pending-call")
    const toolResult = (id: string, content: string) =>
      new ToolMessage({ id: `${id}-result`, tool_call_id: id, content })
    const frame = serializeWorkflowAgentSnapshotMessages({
      messages: [
        new HumanMessage({ id: "prompt", content: "Request" }),
        assistant("completed", [completedCall, call("discarded")]),
        alias("completed"),
        toolResult(completedCall.id, "Completed output"),
        assistant("omitted", [pendingCall]),
        {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: "omitted-alias",
            content: "omitted",
            additional_kwargs: metadata("omitted")
          }
        },
        assistant("cleared", [repeatedCall]),
        alias("cleared"),
        new AIMessage({ id: "independent", content: "Independent", tool_calls: [repeatedCall] }),
        toolResult(repeatedCall.id, "Independent output")
      ]
    })

    for (const snapshot of [frame, JSON.parse(JSON.stringify(frame))]) {
      const rows = new ElectronIPCTransport().convertWorkflowAgentValuesSnapshot(snapshot, "run/0")
      const assistants = rows.filter(({ role }) => role === "assistant")
      expect(assistants.map(({ content, tool_calls }) => [content, tool_calls])).toEqual([
        ["completed", [completedCall]],
        ["omitted", [pendingCall]],
        ["cleared", []],
        ["Independent", [repeatedCall]]
      ])
      const results = buildToolResultAssociations(rows)
      expect(results.get(getWorkerToolUiKey(assistants[0].id, completedCall.id, 0))).toMatchObject({
        content: "Completed output"
      })
      expect(results.get(getWorkerToolUiKey(assistants[3].id, repeatedCall.id, 0))).toMatchObject({
        content: "Independent output"
      })
      expect(results.size).toBe(2)
    }
  })

  it("keeps distinct replies and tool rows from a sidecar with legacy truncated identities", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cmb-workflow-legacy-toolstream-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", join(scratch, "home"))
    try {
      const workspacePath = join(scratch, "workspace")
      const threadId = "workflow-thread"
      const runId = "wf_abcdef"
      const toolStreamKey = "probe_c0"
      const path = agentToolStreamPath(workspacePath, threadId, runId, toolStreamKey)
      mkdirSync(dirname(path), { recursive: true })
      // The old serializer saved the equal-length truncations of distinct IDs verbatim.
      const truncatedId = " ".repeat(3) + "x".repeat(23_997) + "\n…[truncated 1 chars]"
      const provider = (id: string) => ({
        cmb_internal_provider_source_id: id,
        cmb_internal_provider_occurrence: 1
      })
      const message = (id: string, content: string, source = truncatedId) =>
        new AIMessage({ id, content, additional_kwargs: provider(source) }).toJSON()
      const tool = (id: string, content: string) =>
        new ToolMessage({
          id,
          tool_call_id: truncatedId,
          content,
          additional_kwargs: provider("tool-provider")
        }).toJSON()
      const ordinarySource = "ordinary\n…[truncated 1 chars]"
      const snapshotMessages = [
        message("wire-one", "first reply"),
        message("wire-two", "second reply"),
        tool("old-tool-one", "first result"),
        tool("old-tool-two", "second result"),
        message("ordinary-first", "ordinary draft", ordinarySource),
        message("ordinary-latest", "ordinary correction", ordinarySource)
      ]
      writeFileSync(path, JSON.stringify({ runId, toolStreamKey, snapshotMessages }))

      const snapshot = await readAgentToolStream(workspacePath, threadId, runId, toolStreamKey)
      expect(snapshot).toHaveLength(6)
      const rows = new ElectronIPCTransport().convertWorkflowAgentValuesSnapshot(snapshot, "run/0")
      expect(rows.map(({ content }) => content)).toEqual([
        "first reply",
        "second reply",
        "first result",
        "second result",
        "ordinary correction"
      ])
      expect(rows.slice(0, 4).map(({ id }) => id)).toEqual([
        "wire-one",
        "wire-two",
        "old-tool-one",
        "old-tool-two"
      ])
    } finally {
      vi.unstubAllEnvs()
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("keeps long provider identities distinct and pairs long tool IDs in live and restored frames", () => {
    const prefix = "x".repeat(WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP) + "\ud840\u0000"
    const first = prefix + "a"
    const second = prefix + "b"
    const tuple = (source: string) => ({
      cmb_internal_provider_source_id: source,
      cmb_internal_provider_occurrence: 1
    })
    const frame = serializeWorkflowAgentSnapshotMessages({
      messages: [
        new AIMessage({ id: "answer-a", content: "draft", additional_kwargs: tuple(first) }),
        new AIMessage({ id: "answer-a-final", content: "first", additional_kwargs: tuple(first) }),
        new AIMessage({ id: "answer-b", content: "second", additional_kwargs: tuple(second) }),
        new AIMessage({
          id: "calls",
          content: "requests",
          tool_calls: [first, second].map((id) => ({ id, name: "read_file", args: {} }))
        }),
        new ToolMessage({
          id: "result-a",
          tool_call_id: first,
          content: "done a",
          additional_kwargs: tuple(first)
        }),
        new ToolMessage({
          id: "result-b",
          tool_call_id: second,
          content: "done b",
          additional_kwargs: tuple(first)
        })
      ]
    })
    expect(frame).toBeDefined()
    expect(JSON.stringify(frame)).not.toContain(prefix.slice(0, 200))
    for (const snapshot of [frame, JSON.parse(JSON.stringify(frame))]) {
      const rows = new ElectronIPCTransport().convertWorkflowAgentValuesSnapshot(snapshot, "run/0")
      expect(rows.map(({ content }) => content)).toEqual([
        "first",
        "second",
        "requests",
        "done a",
        "done b"
      ])
      expect([...buildToolResultAssociations(rows).values()].map(({ content }) => content)).toEqual(
        ["done a", "done b"]
      )
    }
  })

  it("projects explicit aliases with stable IDs through full snapshots and their sidecar form", () => {
    const transport = new ElectronIPCTransport()
    const additional_kwargs = {
      cmb_internal_provider_source_id: "provider",
      cmb_internal_provider_occurrence: 1
    }
    const ai = (id: string, content: string) => new AIMessage({ id, content, additional_kwargs })
    const convert = (messages: BaseMessage[], scope = "parent/run/0") =>
      transport.convertWorkflowAgentValuesSnapshot(
        serializeWorkflowAgentSnapshotMessages({ messages }),
        scope
      )
    const draft = ai("raw-a", "Long earlier text that was corrected")
    const correction = ai("raw-b", "Shorter answer")
    const [earlier] = convert([draft])
    const legacyProviderId = new AIMessage({ id: "provider", content: "Legacy provider ID" })
    for (const messages of [
      [legacyProviderId, correction],
      [correction, legacyProviderId]
    ]) {
      const rows = convert(messages)
      expect(new Set(rows.map((item) => item.id)).size).toBe(2)
      expect(rows.find((item) => item.content === "Shorter answer")?.id).toBe(earlier.id)
      expect(rows.find((item) => item.content === "Legacy provider ID")?.id).toBe("provider")
    }
    const complete = convert([draft, correction])
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ id: earlier.id, content: "Shorter answer" })
    expect(convert([ai("reordered-alias", "Shorter answer"), correction])[0].id).toBe(earlier.id)
    expect(convert([correction], "parent/run/1")[0].id).not.toBe(earlier.id)
    const legacy = new AIMessage({ id: "raw-a", content: "Shorter answer" })
    const differentOccurrence = new AIMessage({
      id: "raw-a",
      content: "Shorter answer",
      additional_kwargs: { ...additional_kwargs, cmb_internal_provider_occurrence: 2 }
    })
    const differentRole = new HumanMessage({ id: "raw-a", content: "prompt", additional_kwargs })
    const tool = (id: string, tool_call_id: string, content: string) =>
      new ToolMessage({ id, content, tool_call_id, additional_kwargs })
    const snapshot = convert([
      differentRole,
      correction,
      legacy,
      differentOccurrence,
      tool("tool-wire-a", "call-a", "before"),
      tool("tool-wire-b", "call-a", "corrected"),
      tool("tool-wire-b", "call-b", "distinct")
    ])
    expect(
      snapshot.map(({ role, content, tool_call_id }) => ({ role, content, tool_call_id }))
    ).toEqual([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "Shorter answer" },
      { role: "assistant", content: "Shorter answer" },
      { role: "assistant", content: "Shorter answer" },
      { role: "tool", content: "corrected", tool_call_id: "call-a" },
      { role: "tool", content: "distinct", tool_call_id: "call-b" }
    ])
    expect(new Set(snapshot.map(({ id }) => id)).size).toBe(snapshot.length)
  })

  it("preserves two replies with the same explicit identity across a structured-output retry turn", () => {
    const transport = new ElectronIPCTransport()
    const prompt = new HumanMessage({ id: "initial-user", content: "Run the workflow" })
    const retry = new HumanMessage({ id: "retry-user", content: "Please submit structured output" })
    const assistant = (id: string, content: string) =>
      new AIMessage({
        id,
        content,
        additional_kwargs: {
          cmb_internal_provider_source_id: "reused-provider-id",
          cmb_internal_provider_occurrence: 1
        }
      })
    const convert = (messages: BaseMessage[]) =>
      transport.convertWorkflowAgentValuesSnapshot(
        serializeWorkflowAgentSnapshotMessages({ messages }),
        "parent/run/0"
      )

    const beforeRetry = convert([prompt, assistant("answer-original", "First reply")])
    const afterRetry = convert([
      prompt,
      assistant("first-alias", "First reply"),
      retry,
      assistant("second-answer", "Second reply")
    ])
    expect(afterRetry.map((message) => message.content)).toEqual([
      "Run the workflow",
      "First reply",
      "Please submit structured output",
      "Second reply"
    ])
    expect(afterRetry[1].id).toBe(beforeRetry[1].id)
    expect(new Set(afterRetry.map((message) => message.id)).size).toBe(4)

    const replay = convert([
      prompt,
      assistant("replayed-first", "First reply"),
      retry,
      assistant("replayed-second", "Corrected second reply")
    ])
    expect(replay.map((message) => message.id)).toEqual(afterRetry.map((message) => message.id))
    expect(replay.at(-1)?.content).toBe("Corrected second reply")
  })

  it("keeps the reply identity when the bounded snapshot drops the retry prompt", () => {
    const transport = new ElectronIPCTransport()
    const scope = "parent/run/0"
    const assistant = (id: string, content: string) =>
      new AIMessage({
        id,
        content,
        additional_kwargs: {
          cmb_internal_provider_source_id: "reused-provider",
          cmb_internal_provider_occurrence: 1
        }
      })
    const firstTurn = [
      new HumanMessage({ id: "initial-user", content: "Run the workflow" }),
      assistant("first-answer", "First reply")
    ]
    const retryPrompt = new HumanMessage({ id: "retry-user", content: "Submit structured output" })
    const reply = assistant("second-answer", "Second reply")
    const retryPromptIndex = firstTurn.length
    // The old sidecar format can infer the retry boundary when its prompt is present.
    const legacyFrame = serializeWorkflowAgentSnapshotMessages({
      messages: [...firstTurn, retryPrompt, reply]
    })
    const [, firstReply, , secondReply] = transport.convertWorkflowAgentValuesSnapshot(
      legacyFrame,
      scope
    )
    expect(firstReply.id).not.toBe(secondReply.id)

    const messages = [
      ...firstTurn,
      retryPrompt,
      reply,
      ...Array.from(
        { length: WORKFLOW_AGENT_SNAPSHOT_MAX_MESSAGES - 2 },
        (_, index) => new AIMessage({ id: `filler-${index}`, content: "tool activity" })
      )
    ]
    const bounded = serializeWorkflowAgentSnapshotMessages({ messages, retryPromptIndex })
    expect(transport.convertWorkflowAgentValuesSnapshot(bounded, scope)[1].id).toBe(secondReply.id)

    const rolled = serializeWorkflowAgentSnapshotMessages({
      messages: [...messages, new AIMessage({ id: "extra", content: "more activity" })],
      retryPromptIndex
    })
    const live = transport.convertWorkflowAgentValuesSnapshot(rolled, scope)
    const restored = new ElectronIPCTransport().convertWorkflowAgentValuesSnapshot(
      JSON.parse(JSON.stringify(rolled)),
      scope
    )
    expect(live[0]).toMatchObject({ id: secondReply.id, content: "Second reply" })
    expect(restored[0].id).toBe(secondReply.id)
  })

  it("omits incomplete retry prompts and aliases at the total budget boundary", () => {
    const transport = new ElectronIPCTransport()
    const scope = "parent/run/0"
    const retryPromptIndex = 1
    const additional_kwargs = {
      cmb_internal_provider_source_id: "source",
      cmb_internal_provider_occurrence: 1
    }
    const prefix = [
      new HumanMessage({ id: "prompt", content: "prompt" }),
      new HumanMessage({ id: "retry", content: "retry" }),
      new AIMessage({ id: "wire-a", content: "alias old", additional_kwargs }),
      new AIMessage({ id: "wire-b", content: "alias new", additional_kwargs })
    ]
    const convert = (snapshot: unknown) =>
      transport.convertWorkflowAgentValuesSnapshot(snapshot, scope)
    const canonical = convert(
      serializeWorkflowAgentSnapshotMessages({ messages: prefix, retryPromptIndex })
    ).at(-1)!
    const result = (id: string, length: number) =>
      new ToolMessage({ id, content: "x".repeat(length), tool_call_id: `call-${id}` })
    const filler = Array.from({ length: 41 }, (_, index) =>
      result(`filler-${index}`, WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP)
    )

    for (const [partialIndex, partialBudget] of [
      [retryPromptIndex, 50], // The serialized class name has not been copied.
      [2, 150] // The content survives, but the provider occurrence does not.
    ]) {
      const budget = { left: WORKFLOW_AGENT_SNAPSHOT_TOTAL_CAP }
      for (const message of [...prefix.slice(partialIndex + 1), ...filler, result("latest", 0)]) {
        boundedCloneSnapshotValue(message, 0, budget)
      }
      const messages = [...prefix, ...filler, result("latest", budget.left - partialBudget)]
      const bounded = serializeWorkflowAgentSnapshotMessages({ messages, retryPromptIndex })
      for (const snapshot of [bounded, JSON.parse(JSON.stringify(bounded))]) {
        const projected = convert(snapshot)
        expect(projected[0].worker_snapshot_index).toBe(partialIndex + 1)
        expect(projected.filter((message) => message.role === "assistant")).toEqual([
          expect.objectContaining({ id: canonical.id, content: "alias new" })
        ])
        expect(projected.at(-1)).toMatchObject({
          id: "latest",
          worker_snapshot_index: messages.length - 1,
          tool_call_id: "call-latest"
        })
      }
    }
  })

  it("applies corrections outside the last 32 messages without duplicating the tail", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 40 }, (_, index) => message(index))
    const initial = project(before, "agent-1")
    const after = before.map((item) => ({ ...item }))
    after[0] = message(0, { content: "corrected" })
    after[39] = message(39, { content: "answer-0" })
    const result = project(after, "agent-1")
    expect(result[0].content).toBe("corrected")
    expect(result.filter((item) => item.content === "answer-0")).toHaveLength(1)
    expect(result).not.toBe(initial)
    expect(result[1]).toBe(initial[1])
    expect(initial[0].content).toBe("answer-0")
  })

  it("handles replacement, reordering, clearing, append and empty snapshots", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 40 }, (_, index) => message(index))
    project(before, "agent")
    const after = before.slice()
    after[0] = message(100)
    after[1] = before[2]
    after[2] = before[1]
    after[3] = message(3, { content: "" })
    expect(project(after, "agent")).toEqual(after)
    expect(project(after.slice(0, 7), "agent")).toEqual(after.slice(0, 7))
    expect(project(after, "agent")).toEqual(after)
    expect(project([], "agent")).toEqual([])
    expect(project(before, "agent")).toEqual(before)
  })

  it("updates reasoning, tool arguments, cleared calls, result identity and errors", () => {
    const updates: Partial<Message>[] = [
      { reasoning: "corrected thinking" },
      { tool_calls: [{ id: "call", name: "read_file", args: { path: "new" } }] },
      { tool_calls: [] },
      { content: [{ type: "text", text: "new block" }] },
      { provider_source_id: "new-source", provider_occurrence: 2 },
      { role: "tool", tool_call_id: "new-call", name: "read_file", status: "error", is_error: true }
    ]
    for (const update of updates) {
      const project = createWorkflowAgentMessageProjector()
      const before = Array.from({ length: 40 }, (_, index) => message(index))
      before[0].tool_calls = [{ id: "call", name: "read_file", args: { path: "old" } }]
      project(before, "agent")
      const after = before.slice()
      after[0] = { ...before[0], ...update }
      expect(project(after, "agent")[0]).toEqual(after[0])
    }
  })

  it("refreshes every tool-result field independently even when prose is unchanged", () => {
    const project = createWorkflowAgentMessageProjector()
    let current = message(0, {
      role: "tool",
      tool_call_id: "call",
      name: "read_file",
      status: "success"
    })
    project([current], "agent")
    for (const update of [
      { tool_call_id: "other" },
      { name: "execute" },
      { status: "error" },
      { is_error: true }
    ]) {
      current = { ...current, ...update }
      expect(project([current], "agent")[0]).toBe(current)
    }
  })

  it("scopes reuse by parent, run and agent rather than provider id or prose", () => {
    const project = createWorkflowAgentMessageProjector()
    const old = project([message(0)], "parent-1/run-1/agent-1")
    for (const scope of [
      "parent-2/run-1/agent-1",
      "parent-2/run-2/agent-1",
      "parent-2/run-2/agent-2"
    ]) {
      const incoming = [message(0)]
      expect(project(incoming, scope)[0]).toBe(incoming[0])
      expect(project(incoming, scope)).not.toBe(old)
    }
  })

  it("keeps repeated authoritative prose and distinct provider occurrences lossless", () => {
    const transport = new ElectronIPCTransport()
    const project = createWorkflowAgentMessageProjector()
    const wire = (content: string) => ({
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { id: "shared", content }
    })
    const convert = () =>
      transport.convertWorkflowAgentValuesSnapshot(
        [wire("same answer"), wire("same answer"), wire("ha ha")],
        "wfagent:run:0"
      )
    const first = project(convert(), "parent/run/0")
    const repeated = project(convert(), "parent/run/0")
    expect(repeated).toBe(first)
    expect(new Set(repeated.map((item) => item.id)).size).toBe(3)
    expect(repeated.map((item) => item.content)).toEqual(["same answer", "same answer", "ha ha"])
  })

  it("reuses unchanged history under maximum-size frames without accumulating snapshots", () => {
    const project = createWorkflowAgentMessageProjector()
    const before = Array.from({ length: 400 }, (_, index) =>
      message(index, {
        content: `${index}:` + "x".repeat(2_200)
      })
    )
    const initial = project(before, "agent")
    for (let frame = 0; frame < 500; frame += 1) {
      const incoming = before.map((item) => ({ ...item, created_at: new Date(frame + 10_000) }))
      incoming[399] = message(399, { content: `frame-${frame}` })
      const result = project(incoming, "agent")
      expect(result).toHaveLength(400)
      expect(result[0]).toBe(initial[0])
      expect(result[367]).toBe(initial[367])
      expect(result[398]).toBe(initial[398])
      expect(result[399].content).toBe(`frame-${frame}`)
      expect(project(incoming, "agent")).toBe(result)
    }
    expect(initial[399].content).toBe(before[399].content)
  })

  it("reuses full-window rows when only provider aliases change", () => {
    const transport = new ElectronIPCTransport()
    const project = createWorkflowAgentMessageProjector()
    const scope = "parent/full/0"
    const frame = (alias: string) =>
      transport.convertWorkflowAgentValuesSnapshot(
        Array.from({ length: 400 }, (_, index) => ({
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: `${alias}-${index}`,
            content: `answer-${index}`,
            additional_kwargs: {
              cmb_internal_provider_source_id: `provider-${index}`,
              cmb_internal_provider_occurrence: 1
            }
          }
        })),
        scope
      )
    const initial = project(frame("first"), scope)
    expect(initial).toHaveLength(400)
    for (let index = 0; index < 20; index += 1) {
      expect(project(frame(`alias-${index}`), scope)).toBe(initial)
    }
  })
})
