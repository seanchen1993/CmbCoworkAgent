import { randomUUID } from "node:crypto"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from
  "@langchain/langgraph"
import { createAgent, FakeToolCallingModel } from "langchain"
import { describe, expect, it, vi } from "vitest"

function messages(value: unknown): BaseMessage[] {
  if (!value || typeof value !== "object") throw Error("ACTUAL_SDK_STATE_REQUIRED")
  const values = Object.getOwnPropertyDescriptor(value, "messages")?.value as unknown
  if (!Array.isArray(values) || !values.every(BaseMessage.isInstance))
    throw Error("ACTUAL_SDK_MESSAGES_REQUIRED")
  return values
}
function codec(message: BaseMessage): string { return JSON.stringify(message.toDict()) }

describe("original SDK completed child history on parent resume", () => {
  it.each(["ordinary-replay", "new-command-update"] as const)(
    "keeps actual %s semantics without native wrappers", async mode => {
      const controller = new AbortController(), saver = new MemorySaver()
      const model = new FakeToolCallingModel({ toolCalls: [[], []] })
      const provider = vi.spyOn(FakeToolCallingModel.prototype, "_generate")
      const agent = createAgent({ model, tools: [], checkpointer: saver })
      const runs: Promise<unknown>[] = [], childOutputs: BaseMessage[][] = []
      const tasks: string[] = [], namespaces: string[] = []
      const firstInput = new HumanMessage("original completed child input")
      const nextInput = new HumanMessage("original new command input")
      let restarted = 0
      const retain = <T>(run: Promise<T>): Promise<T> => {
        runs[runs.length] = run
        void run.catch(() => undefined)
        return run
      }
      const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
        reducer: (_old, incoming) => incoming, default: () => [] }) })
      const graph = new StateGraph(state).addNode("original-history-parent", (_state, config) => {
        const actual = (async () => {
          restarted++
          const taskId = config.configurable?.__pregel_task_id
          const namespace = config.configurable?.checkpoint_ns
          if (typeof taskId !== "string" || typeof namespace !== "string")
            throw Error("ACTUAL_SDK_PARENT_TASK_REQUIRED")
          tasks[tasks.length] = taskId
          namespaces[namespaces.length] = namespace
          const input = restarted === 2 && mode === "new-command-update"
            ? new Command({ update: { messages: [nextInput] }, goto: "model_request" })
            : { messages: [firstInput] }
          const output: unknown = await retain(agent.invoke(input, config))
          const native = messages(output)
          childOutputs[childOutputs.length] = native
          const accepted: unknown = interrupt("original completed child boundary")
          if (accepted !== "resume original child") throw Error("ACTUAL_SDK_RESUME_REQUIRED")
          return { messages: native }
        })()
        return retain(actual)
      }).addEdge(START, "original-history-parent").addEdge("original-history-parent", END)
        .compile({ checkpointer: saver })
      const config: RunnableConfig = { configurable: { thread_id: randomUUID() },
        signal: controller.signal }
      try {
        await retain(graph.invoke({ messages: [new HumanMessage("original parent input")] }, config))
        expect(restarted).toBe(1)
        expect(provider).toHaveBeenCalledTimes(1)
        expect(childOutputs).toHaveLength(1)
        expect(childOutputs[0]).toHaveLength(2)
        expect(childOutputs[0][0]).toBeInstanceOf(HumanMessage)
        expect(childOutputs[0][1]).toBeInstanceOf(AIMessage)
        const firstCodec = childOutputs[0].map(codec)
        const resumed: unknown = await retain(graph.invoke(new Command({ resume: "resume original child" }),
          config))
        expect(restarted).toBe(2)
        expect(tasks[1]).toBe(tasks[0])
        expect(namespaces[1]).toBe(namespaces[0])
        expect(childOutputs).toHaveLength(2)
        const output = messages(resumed)
        expect(output.map(codec)).toEqual(childOutputs[1].map(codec))
        expect(output.slice(0, 2).map(codec)).toEqual(firstCodec)
        expect(provider).toHaveBeenCalledTimes(mode === "ordinary-replay" ? 1 : 2)
        expect(output).toHaveLength(mode === "ordinary-replay" ? 2 : 4)
        if (mode === "new-command-update") {
          expect(output[2]).toBeInstanceOf(HumanMessage)
          expect(output[2].content).toBe(nextInput.content)
          expect(output[3]).toBeInstanceOf(AIMessage)
          expect(output.filter(message => message instanceof AIMessage)).toHaveLength(2)
          expect(output.filter(message => message instanceof HumanMessage)).toHaveLength(2)
        }
        expect(output.every(message => typeof message.id === "string" && message.id.length > 0))
          .toBe(true)
        expect(output.filter(message => message instanceof AIMessage)
          .every(message => (message as AIMessage).tool_calls?.length === 0)).toBe(true)
      } finally {
        controller.abort(Error("ACTUAL_SDK_REFERENCE_FINISHED"))
        await Promise.allSettled(runs)
        provider.mockRestore()
      }
    })
})
