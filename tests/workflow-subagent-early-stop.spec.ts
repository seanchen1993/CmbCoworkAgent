/**
 * A structured subagent stops as soon as it has a schema-valid result. Stopping
 * has to mean the graph stops, not just that we stop reading it.
 *
 * Breaking out of a `for await` calls the iterator's `return()`, which cancels
 * the ReadableStream and nothing else: LangGraph aborts a run only from
 * `IterableReadableStreamWithAbortSignal.cancel()`, and the source it builds has
 * no cancel handler for `reader.cancel()` to reach. So the graph ran on — more
 * model turns, more tool calls, unsupervised and billed — writing tokens into a
 * controller we had already closed, which is what produced the bursts of
 * "Invalid state: Controller is already closed" in the logs.
 *
 * This drives a real StateGraph rather than a stub, because the defect lives
 * entirely in what LangGraph does with a cancelled reader.
 *
 * Run:
 *   npx tsx tests/workflow-subagent-early-stop.spec.ts
 */

import assert from "node:assert/strict"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { consumeValuesStream } from "../src/main/agent/workflow/subagent.ts"

const State = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => []
  })
})

/** Three nodes, so there is still work left to leak after the second one. */
function buildGraph(executed: string[]) {
  const node = (name: string, delayMs: number) => async (): Promise<{ steps: string[] }> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    executed.push(name)
    return { steps: [name] }
  }
  return new StateGraph(State)
    .addNode("a", node("a", 5))
    .addNode("b", node("b", 30))
    .addNode("c", node("c", 30))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", "c")
    .addEdge("c", END)
    .compile()
}

function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testEarlyStopStopsTheGraph(): Promise<void> {
  const executed: string[] = []
  const controller = new AbortController()
  const stream = await buildGraph(executed).stream(
    { steps: [] },
    { streamMode: ["values"], signal: controller.signal }
  )

  // Stands in for "a schema-valid structured_output has been captured".
  let seen = 0
  const result = await consumeValuesStream(stream, controller.signal, () => {
    seen += 1
    return seen >= 2
  })

  assert.ok(result, "the accepted snapshot is still returned")
  await settle()
  assert.ok(
    !executed.includes("c"),
    `the graph must stop when the subagent has its answer, but it ran on: ${JSON.stringify(executed)}`
  )
  assert.equal(
    controller.signal.aborted,
    false,
    "stopping the stream must not abort the caller's signal — raceWithAbort around this call " +
      "would reject and throw away the result we just accepted"
  )
}

async function testAnAbortedRunAlsoStops(): Promise<void> {
  const executed: string[] = []
  const controller = new AbortController()
  const stream = await buildGraph(executed).stream(
    { steps: [] },
    { streamMode: ["values"], signal: controller.signal }
  )

  const consumed = consumeValuesStream(stream, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await consumed.catch(() => undefined)

  await settle()
  assert.ok(
    !executed.includes("c"),
    `an aborted run must not keep executing nodes: ${JSON.stringify(executed)}`
  )
}

async function testAPlainIterableIsStillConsumed(): Promise<void> {
  // consumeValuesStream is typed on AsyncIterable and is called with one in
  // tests and by callers that never produced a LangGraph stream. Asking a plain
  // iterable to cancel must be a no-op, not a crash.
  async function* plain(): AsyncGenerator<unknown> {
    yield ["values", { messages: ["one"] }]
    yield ["values", { messages: ["two"] }]
  }
  const controller = new AbortController()
  let seen = 0
  const result = await consumeValuesStream(plain(), controller.signal, () => {
    seen += 1
    return seen >= 1
  })
  assert.deepEqual(result, { messages: ["one"] }, "the first accepted snapshot is returned")
}

async function main(): Promise<void> {
  await testEarlyStopStopsTheGraph()
  console.log("PASS testEarlyStopStopsTheGraph")
  await testAnAbortedRunAlsoStops()
  console.log("PASS testAnAbortedRunAlsoStops")
  await testAPlainIterableIsStillConsumed()
  console.log("PASS testAPlainIterableIsStillConsumed")
  console.log("workflow-subagent-early-stop.spec.ts passed")
}

void main().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
