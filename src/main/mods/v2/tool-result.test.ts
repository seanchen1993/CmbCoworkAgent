import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import { expect, it } from "vitest"
import { FunctionToolResults, functionToolContexts } from "./tool-result"

it("keeps referenced host messages verbatim and holds reminders outside visible content", () => {
  const results = new FunctionToolResults<ToolMessage>("read_file", "call")
  const original = new ToolMessage({
    content: "real",
    tool_call_id: "call",
    artifact: { ok: true }
  })
  const first = results.add(original)
  expect(results.resolve({ ...first, result: "forged", text: "forged" })).toBe(original)
  const answer = results.resolve({ ...first, context: ["private reminder"] })
  expect(answer.content).toBe("real")
  expect(answer.artifact).toEqual({ ok: true })
  expect(functionToolContexts([answer])).toEqual(["private reminder"])
})

it("preserves graph routing, unrelated messages and actual errors when a hook replaces a result", () => {
  const other = new ToolMessage({ content: "other", tool_call_id: "other" })
  const command = new Command({
    update: {
      flag: 1,
      messages: [
        other,
        new ToolMessage({
          content: "host failure",
          tool_call_id: "call",
          id: "host-id",
          status: "error"
        })
      ]
    },
    graph: Command.PARENT,
    goto: "next",
    resume: { accepted: true }
  })
  const results = new FunctionToolResults<Command>("task", "call")
  expect(results.add(command)).toMatchObject({ isError: true })
  const answer = results.resolve({ result: "replacement", context: ["reminder"] }) as Command
  expect(isCommand(answer)).toBe(true)
  expect(answer.graph).toBe(command.graph)
  expect(answer.goto).toEqual(command.goto)
  expect(answer.resume).toEqual(command.resume)
  const update = answer.update as { flag: number; messages: ToolMessage[] }
  expect(update.flag).toBe(1)
  expect(update.messages[0]).toBe(other)
  expect(update.messages[1]).toMatchObject({
    content: "replacement",
    id: "host-id",
    status: "error"
  })
})

it("supports denies and short circuits without a core call, and cannot erase a completed control update", () => {
  const results = new FunctionToolResults<Command>("task", "call")
  expect(results.resolve({ deny: "refused" })).toMatchObject({
    content: "refused",
    status: "error"
  })
  expect(results.resolve({ result: { text: "local" } })).toMatchObject({ content: "local" })
  results.add(
    new Command({
      update: {
        started: true,
        messages: [
          new ToolMessage({
            content: "started",
            tool_call_id: "call"
          })
        ]
      },
      goto: "worker"
    })
  )
  const denied = results.resolve({ deny: "blocked after execution" }) as Command
  expect(denied.goto).toEqual(["worker"])
  expect(denied.update).toMatchObject({
    started: true,
    messages: [{ content: "blocked after execution", status: "error" }]
  })
})

it("keeps refs local to an invocation and can select a previous explicit next", () => {
  const results = new FunctionToolResults<string>("read_file", "call")
  const first = results.add("first")
  results.add("second")
  expect(results.resolve(first)).toBe("first")
  expect(() => results.resolve({ result: "fake", ref: 99 })).toThrow("MODS_TOOL_RESULT_REF")
  expect(() => new FunctionToolResults("read_file", "next").resolve(first)).toThrow(
    "MODS_TOOL_RESULT_REF"
  )
  expect(() => results.resolve({ result: null, ref: -1 })).toThrow("MODS_TOOL_RESULT")
})

it("only injects the most recent tool round and bounds aggregate reminders", () => {
  const result = new FunctionToolResults<ToolMessage>("read_file", "call").resolve({
    result: "visible",
    context: ["hidden"]
  })
  expect(functionToolContexts([new AIMessage("tool round"), result, result])).toEqual([
    "hidden",
    "hidden"
  ])
  expect(functionToolContexts([result, new HumanMessage("next question")])).toEqual([])
  expect(functionToolContexts([result, new AIMessage("answer")])).toEqual([])
  const large = new FunctionToolResults<ToolMessage>("read_file", "call").resolve({
    result: "visible",
    context: ["x".repeat(32000)]
  })
  expect(() => functionToolContexts([large, large, large, large, large])).toThrow(
    "MODS_TOOL_CONTEXT_LIMIT"
  )
})
