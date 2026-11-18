import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { mergeWorkerHistoryWithLiveMessages } from "../components/chat/WorkerStreamPanel"
import { ElectronIPCTransport } from "./electron-transport"
import { useAppStore } from "./store"
import { buildWorkerCheckpointHistory } from "./worker-checkpoint-history"
import { buildToolResultAssociations } from "./worker-tool-result-key"

const parent = "team-panel-merge-test"
const worker = `${parent}__worker__one`

function declaredAnswer(id: string, content: string) {
  return new AIMessage({
    id,
    content,
    additional_kwargs: {
      cmb_internal_provider_source_id: "provider",
      cmb_internal_provider_occurrence: 1
    }
  })
}

function checkpointHistory(...answers: AIMessage[]) {
  const messages = [new HumanMessage({ id: "prompt", content: "Prompt" }), ...answers]
  return buildWorkerCheckpointHistory(messages, worker).messages
}

function appendLiveAnswer(id: string, content: string, declared = false) {
  const transport = new ElectronIPCTransport()
  const additional_kwargs = declared ? declaredAnswer(id, content).additional_kwargs : undefined
  const rows = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      type: "stream",
      mode: "messages",
      workerTurn: 1,
      data: [new AIMessageChunk({ id, content, additional_kwargs }).toJSON(), {}]
    },
    parent
  )
  useAppStore.getState().appendWorkerFocusMessages(worker, rows)
  return useAppStore.getState().workerFocusMessages
}

describe("Team panel history and live messages", () => {
  beforeEach(() => {
    useAppStore.getState().openWorkerFocusView({
      threadId: parent,
      workerThreadId: worker,
      workerId: "one",
      role: "implementer",
      description: "Team checkpoint merge"
    })
  })

  afterEach(() => useAppStore.getState().closeWorkerFocusView())

  it.each(["Independent answer", "Saved answer"])(
    "keeps an untagged reply separate when only the declared source ID matches (%s)",
    (content) => {
      const history = checkpointHistory(declaredAnswer("first-wire-id", "Saved answer"))
      const live = appendLiveAnswer("provider", content)
      const merged = mergeWorkerHistoryWithLiveMessages(history, live)

      expect(merged.map(({ id, content }) => [id, content])).toEqual([
        [history[0].id, "Prompt"],
        [history[1].id, "Saved answer"],
        [live[0].id, content]
      ])
      expect(merged[1].worker_provider_identity).toBe(true)
      expect(merged[2].worker_provider_identity).toBeUndefined()
    }
  )

  it("updates the declared reply when its observed wire ID matches", () => {
    const history = checkpointHistory(declaredAnswer("first-wire-id", "Saved answer"))
    const live = appendLiveAnswer("first-wire-id", "Updated answer")
    const merged = mergeWorkerHistoryWithLiveMessages(history, live)

    expect(merged.map(({ id, content }) => [id, content])).toEqual([
      [history[0].id, "Prompt"],
      [history[1].id, "Updated answer"]
    ])
    expect(merged[1].worker_provider_identity).toBe(true)
  })

  it("updates a declared reply through another wire ID recorded in the checkpoint", () => {
    const history = checkpointHistory(
      declaredAnswer("first-wire-id", "Draft"),
      declaredAnswer("later-wire-id", "Saved answer")
    )
    const live = appendLiveAnswer("later-wire-id", "Updated answer")
    const merged = mergeWorkerHistoryWithLiveMessages(history, live)

    expect(merged.map(({ id, content }) => [id, content])).toEqual([
      [history[0].id, "Prompt"],
      [history[1].id, "Updated answer"]
    ])
    expect(merged[1].worker_provider_identity).toBe(true)
  })

  it.each([false, true])(
    "applies an alias tool clear while retaining completed checkpoint calls (result: %s)",
    (hasCheckpointResult) => {
      const call = { id: "call", name: "read_file", args: { path: "old.txt" } }
      const callMessage = new AIMessage({
        id: "first-wire-id",
        content: "Draft",
        tool_calls: [call],
        additional_kwargs: declaredAnswer("first-wire-id", "Draft").additional_kwargs
      })
      const prompt = new HumanMessage({ id: "prompt", content: "Prompt" })
      const result = new ToolMessage({
        id: "result",
        tool_call_id: call.id,
        content: "Checkpoint output"
      })
      const history = buildWorkerCheckpointHistory(
        hasCheckpointResult ? [prompt, callMessage, result] : [prompt, callMessage],
        worker
      ).messages
      const live = new ElectronIPCTransport().convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "values",
          workerTurn: 1,
          data: {
            messages: [
              prompt.toJSON(),
              callMessage.toJSON(),
              declaredAnswer("latest-wire-id", "Updated answer").toJSON()
            ]
          }
        },
        parent
      )

      const merged = mergeWorkerHistoryWithLiveMessages(history, live)
      expect(merged.filter(({ role }) => role === "assistant")).toMatchObject([
        { content: "Updated answer", tool_calls: hasCheckpointResult ? [call] : [] }
      ])
      expect([...buildToolResultAssociations(merged).values()].map(({ content }) => content)).toEqual(
        hasCheckpointResult ? ["Checkpoint output"] : []
      )
    }
  )

  it("adopts live provider metadata for an earlier reply with the same wire ID", () => {
    const history = checkpointHistory(new AIMessage({ id: "first-wire-id", content: "Draft" }))
    const live = appendLiveAnswer("first-wire-id", "Updated answer", true)
    const merged = mergeWorkerHistoryWithLiveMessages(history, live)

    expect(merged.map(({ id, content }) => [id, content])).toEqual([
      [history[0].id, "Prompt"],
      [history[1].id, "Updated answer"]
    ])
    expect(merged[1]).toMatchObject({
      worker_provider_identity: true,
      provider_occurrence: 1,
      worker_provider_wire_ids: ["first-wire-id"]
    })
  })

  it("keeps independent replies in order when a full live snapshot includes the same prompt", () => {
    const history = checkpointHistory(declaredAnswer("first-wire-id", "Saved answer"))
    const transport = new ElectronIPCTransport()
    const rows = transport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        type: "stream",
        mode: "values",
        workerTurn: 1,
        valuesSnapshotKind: "full",
        data: {
          messages: [
            new HumanMessage({ id: "prompt", content: "Prompt" }).toJSON(),
            new AIMessage({ id: "provider", content: "Saved answer" }).toJSON()
          ]
        }
      },
      parent
    )
    useAppStore.getState().appendWorkerFocusMessages(worker, rows, { orderedSnapshot: true })
    const live = useAppStore.getState().workerFocusMessages
    const merged = mergeWorkerHistoryWithLiveMessages(history, live)

    expect(merged.map(({ id, content }) => [id, content])).toEqual([
      [history[0].id, "Prompt"],
      [history[1].id, "Saved answer"],
      [live[1].id, "Saved answer"]
    ])
  })
})
