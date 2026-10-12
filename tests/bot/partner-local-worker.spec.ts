import assert from "node:assert/strict"
import test from "node:test"
import { PartnerLocalWorker } from "../../src/main/services/bot/partner-local-worker"
import { runFixture } from "./requirement-execution-fixture"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return
    await sleep(5)
  }
  assert.fail("worker condition timeout")
}

test("serial worker polls and executes once; heartbeat continues while graph runs; stop waits cleanup", async () => {
  const run = runFixture()
  let executing = false,
    models = 0,
    polls = 0,
    heartbeat = 0,
    activeRequests = 0,
    maxRequests = 0,
    release: () => void = () => {},
    cleaned = false
  const worker = new PartnerLocalWorker({
    client: {
      async observe() {
        heartbeat++
      },
      async poll() {
        polls++
        activeRequests++
        maxRequests = Math.max(maxRequests, activeRequests)
        await sleep(5)
        activeRequests--
        return [{ id: run.id, status: "starting" }]
      },
      async claim() {
        return run
      }
    },
    executor: {
      async execute() {
        models++
        executing = true
        await new Promise<void>((resolve) => (release = resolve))
        await sleep(10)
        cleaned = true
        return {
          runId: run.id,
          attemptId: run.attemptId,
          outcome: "failed",
          text: "CANCELLED",
          settledAt: new Date().toISOString()
        }
      },
      cancel() {
        release()
        return true
      }
    },
    onChange: () => {},
    pollMs: 5,
    heartbeatMs: 5
  })
  try {
    await worker.start()
    await until(() => executing)
    await until(() => heartbeat >= 3)
    const stopped = worker.stop()
    assert.equal(cleaned, false)
    await stopped
    assert.equal(cleaned, true)
    assert.equal(models, 1)
    assert.equal(maxRequests, 1)
    const before = { polls, heartbeat }
    await sleep(25)
    assert.deepEqual({ polls, heartbeat }, before)
    assert.equal(worker.activeRunId(), null)
  } finally {
    await worker.stop()
  }
})
test("a late claim after stop cannot start the executor", async () => {
  const run = runFixture()
  let claimed = false,
    models = 0,
    release: () => void = () => {}
  const worker = new PartnerLocalWorker({
    client: {
      async observe() {},
      async poll() {
        return [{ id: run.id, status: "queued" }]
      },
      async claim() {
        claimed = true
        await new Promise<void>((resolve) => (release = resolve))
        return run
      }
    },
    executor: {
      async execute() {
        models++
        throw Error()
      },
      cancel() {
        return false
      }
    },
    onChange: () => {},
    pollMs: 5,
    heartbeatMs: 1000
  })
  await worker.start()
  await until(() => claimed)
  const stopped = worker.stop()
  release()
  await stopped
  assert.equal(models, 0)
  await worker.stop()
})
test("network/auth loss disables node and cancels current attempt; unknown is never replayed", async () => {
  let polls = 0,
    models = 0,
    errors: string[] = []
  const run = runFixture()
  const worker = new PartnerLocalWorker({
    client: {
      async observe() {},
      async poll() {
        polls++
        if (polls > 2) throw Error()
        return [{ id: run.id, status: "running" }]
      },
      async claim() {
        return run
      }
    },
    executor: {
      async execute() {
        models++
        throw new Error("PARTNER_EXECUTION_OUTCOME_UNKNOWN")
      },
      cancel() {
        return false
      }
    },
    onChange: (v) => {
      if (v.error) errors.push(v.error)
    },
    pollMs: 5,
    heartbeatMs: 1000
  })
  try {
    await worker.start()
    await until(() => !worker.isEnabled())
    assert.equal(models, 1)
    assert.ok(errors.includes("OUTCOME_UNKNOWN"))
    assert.ok(errors.includes("DEPENDENCY_UNAVAILABLE"))
  } finally {
    await worker.stop()
  }
})
