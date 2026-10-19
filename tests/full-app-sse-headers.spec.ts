/** Real HTTP transport only; no model/Workflow/native execution facts are synthesized. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { endFullAppModelError, flushFullAppSseHeaders } from "./support/full-app-sse-headers"
import { waitForOriginalWorkflowTerminal } from "./support/full-app-workflow-wait"

async function main() {
  const fixtureCleanup = new AbortController()
  const gates = new Map<string, { value?: { transportFixture: string }; aborted: boolean;
    completed: boolean; done: Promise<void>; finish: () => void }>()
  for (const path of ["/held", "/cancel", "/cleanup", "/failed", "/unflushed-error"]) {
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    gates.set(path, { aborted: false, completed: false, done, finish })
  }
  let requests = 0
  const errors: unknown[] = []
  const server = createServer(async (request, response) => {
    requests++
    const gate = gates.get(request.url!)!
    const disconnect = new AbortController()
    response.once("close", () => disconnect.abort())
    const signal = AbortSignal.any([fixtureCleanup.signal, disconnect.signal])
    try {
      if (request.url === "/unflushed-error") throw Error("expected unflushed model-fixture error")
      flushFullAppSseHeaders(response)
      flushFullAppSseHeaders(response) // Idempotent; never sends an early data packet.
      if (request.url === "/failed") {
        await delay(20)
        throw Error("expected held SSE model-fixture error")
      }
      const actual = await waitForOriginalWorkflowTerminal({ readTerminal: () => gate.value,
        deadline: Date.now() + 5000, signal, observe: () => {} })
      assert(actual)
      assert.equal(actual, gate.value)
      response.end(`data: ${JSON.stringify(actual)}\n\ndata: [DONE]\n\n`)
      gate.completed = true
    } catch (error) {
      if (signal.aborted) gate.aborted = true
      else { errors.push(error); endFullAppModelError(response) }
      if (signal.aborted) response.destroy()
    } finally { gate.finish() }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  try {
    const response = await fetch(`${url}/held`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/event-stream")
    assert.equal(gates.get("/held")!.value, undefined,
      "Actual headers must reach fetch before the terminal is supplied")
    let bodyDelivered = false
    const body = response.text().then(text => { bodyDelivered = true; return text })
    await delay(120)
    assert.equal(bodyDelivered, false, "No invented completion/body while waiting")
    assert.equal(requests, 1, "Flushing headers needs no retry/second business request")
    gates.get("/held")!.value = { transportFixture: "observed-terminal" }
    assert.equal(await body, 'data: {"transportFixture":"observed-terminal"}\n\ndata: [DONE]\n\n')
    await gates.get("/held")!.done

    const client = new AbortController()
    const cancelled = await fetch(`${url}/cancel`, { signal: client.signal })
    const cancelledBody = cancelled.text()
    client.abort()
    await assert.rejects(cancelledBody, /abort/i)
    await gates.get("/cancel")!.done
    assert.equal(gates.get("/cancel")!.aborted, true)
    assert.equal(gates.get("/cancel")!.completed, false)

    const failing = await fetch(`${url}/failed`, { signal: AbortSignal.timeout(5000) })
    assert.equal(failing.status, 200)
    await assert.rejects(failing.text())
    await gates.get("/failed")!.done
    assert.equal(gates.get("/failed")!.completed, false)
    assert.equal(gates.get("/failed")!.value, undefined)
    const unflushed = await fetch(`${url}/unflushed-error`, { signal: AbortSignal.timeout(5000) })
    assert.equal(unflushed.status, 500)
    assert.equal(await unflushed.text(), "Full App model fixture rejected unexpected facts")
    await gates.get("/unflushed-error")!.done

    const cleaning = await fetch(`${url}/cleanup`, { signal: AbortSignal.timeout(5000) })
    const cleaningBody = cleaning.text()
    fixtureCleanup.abort(new Error("fixture finally cleanup"))
    await assert.rejects(cleaningBody)
    await gates.get("/cleanup")!.done
    assert.equal(gates.get("/cleanup")!.aborted, true)
    assert.equal(gates.get("/cleanup")!.completed, false)
    assert.equal(gates.get("/cleanup")!.value, undefined)
    assert.equal(requests, 5)
    assert.deepEqual(errors.map(String), ["Error: expected held SSE model-fixture error",
      "Error: expected unflushed model-fixture error"])
    console.log("PASS real HTTP SSE: headers before terminal, body held/no retries, observed result only, client/finally cancellation and error termination without synthetic completion")
  } finally {
    fixtureCleanup.abort()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
