import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { InMemoryCache } from "@langchain/langgraph-checkpoint"
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"

const require = createRequire(import.meta.url)

it("preserves ordinary graph output when all node writes come from cache", async () => {
  let calls = 0
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("answer", () => {
      calls++
      return { messages: [new AIMessage("cached answer")] }
    }, { cachePolicy: { keyFunc: () => "same input" } })
    .addEdge(START, "answer")
    .addEdge("answer", END)
    .compile({ cache: new InMemoryCache() })
  for (let run = 0; run < 2; run++) {
    const controller = new AbortController()
    const result = await graph.invoke({ messages: [new HumanMessage("question")] },
      { signal: controller.signal })
    expect(result.messages.map(message => message.content)).toEqual(["question", "cached answer"])
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(calls).toBe(1)
})

it.each(["js", "cjs"])("keeps empty and nonempty Runner cancellation correct in %s", extension => {
  const path = resolve(dirname(require.resolve("@langchain/langgraph")), `pregel/runner.${extension}`)
  const source = `
    import assert from "node:assert/strict"
    import { getEventListeners } from "node:events"
    const { PregelRunner } = await import(${JSON.stringify(pathToFileURL(path).href)})
    const runner = new PregelRunner({ loop: {} })
    const controller = new AbortController()
    const signals = { externalAbortSignal: controller.signal, composedAbortSignal: controller.signal }
    const empty = runner._executeTasksWithRetry([], { signals })
    assert.deepEqual(await empty.next(), { value: undefined, done: true })
    assert.equal(getEventListeners(controller.signal, "abort").length, 0)
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
    await assert.rejects(runner._executeTasksWithRetry([], { signals }).next(), /Abort/)

    const active = new AbortController()
    let started, release
    const starting = new Promise(resolve => { started = resolve })
    const held = new Promise(resolve => { release = resolve })
    const task = { id: "active", config: {}, writes: [], input: null,
      proc: { async invoke() { started(); await held; return "finished" } } }
    const stream = runner._executeTasksWithRetry([task], { signals: {
      externalAbortSignal: active.signal, composedAbortSignal: active.signal
    } })
    const rejected = assert.rejects(stream.next(), /Abort/)
    await starting
    active.abort()
    release()
    await rejected
    await new Promise(resolve => setTimeout(resolve, 0))
    console.log("empty completion, late abort, already aborted, active cancellation passed")
  `
  // Use Node's strict rejection handling, without adding a global rejection listener.
  const child = spawnSync(process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 4500, windowsHide: true })
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  expect(child.stdout).toContain("active cancellation passed")
})
