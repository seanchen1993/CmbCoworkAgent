import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import type { AddressInfo } from "node:net"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  DashboardEsRequestCancelledError,
  DashboardEsWorkerClient,
  DashboardEsWorkerUnavailableError
} from "./dashboard-es-client"
import {
  DASHBOARD_ES_INPUT_BYTE_LIMIT,
  DASHBOARD_ES_OUTPUT_BYTE_LIMIT,
  DASHBOARD_ES_RESPONSE_TOO_LARGE,
  DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
} from "./dashboard-es-protocol"

const clients: DashboardEsWorkerClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""
let server: Server
let serverUrl = ""

const tickerPayload = `${JSON.stringify({ value: "ticker" })}${" ".repeat(7 * 1024 * 1024)}`
const projectedHomePayload = JSON.stringify({
  aggregations: {
    by_model: {
      buckets: [
        {
          key: "gpt-test",
          doc_count: 4,
          total_input_tokens: { value: 100 },
          total_output_tokens: { value: 40 }
        }
      ]
    },
    by_tier: { buckets: [{ key: "smart", doc_count: 4 }] },
    by_layer: { buckets: [] },
    smart_by_tier: { by_tier: { buckets: [{ key: "smart", doc_count: 4 }] } }
  },
  ignored: "p".repeat(7 * 1024 * 1024)
})
const oversizedOutputPayload = JSON.stringify({
  value: "x".repeat(DASHBOARD_ES_OUTPUT_BYTE_LIMIT + 64 * 1024)
})

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-dashboard-es-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "dashboard-es-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./dashboard-es-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })

  server = createServer((request, response) => {
    const index = request.url?.split("/").filter(Boolean)[0]
    request.resume()
    if (index === "ticker") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(tickerPayload)
      return
    }
    if (index === "projected-home") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(projectedHomePayload)
      return
    }
    if (index === "oversized-input") {
      response.writeHead(200, { "content-type": "application/json" })
      const chunk = `{"value":"${"y".repeat(256 * 1024)}`
      for (let sent = 0; sent <= DASHBOARD_ES_INPUT_BYTE_LIMIT; sent += chunk.length) {
        response.write(chunk)
      }
      response.end('"}')
      return
    }
    if (index === "oversized-output") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(oversizedOutputPayload)
      return
    }
    if (index === "slow") {
      response.writeHead(200, { "content-type": "application/json" })
      setTimeout(() => response.end(JSON.stringify({ value: "slow" })), 200)
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({ index, method: request.method, nested: { finite: 1, invalid: Number.NaN } })
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  serverUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

function createClient(onStart?: () => void): DashboardEsWorkerClient {
  const client = new DashboardEsWorkerClient(async () => {
    onStart?.()
    return new Worker(workerBundlePath, { name: "dashboard-es-test" })
  })
  clients.push(client)
  return client
}

function query(client: DashboardEsWorkerClient, index: string, signal?: AbortSignal) {
  return client.query({
    nodes: [serverUrl],
    method: "POST",
    path: `/${index}/_search`,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ size: 0 }),
    timeoutMs: 5_000,
    signal
  })
}

describe("Dashboard ES worker", () => {
  it("keeps the main ticker moving while parsing and normalizing a near-limit response", async () => {
    const client = createClient()
    await query(client, "warmup")
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await expect(query(client, "ticker")).resolves.toMatchObject({ value: "ticker" })
    } finally {
      clearInterval(ticker)
    }

    expect(ticks).toBeGreaterThan(0)
    expect(client.getDiagnostics().lastStats).toMatchObject({
      sourceBytes: tickerPayload.length,
      outputBytes: expect.any(Number),
      durationMs: expect.any(Number)
    })
  }, 30_000)

  it("projects a near-limit home response before it crosses into main", async () => {
    const client = createClient()
    await query(client, "warmup")
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const result = await client.queryWithStats({
        nodes: [serverUrl],
        method: "POST",
        path: "/projected-home/_search",
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ size: 0 }),
        projection: { kind: "model-stats" },
        timeoutMs: 5_000,
        outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
      })

      expect(result.value).toEqual({
        byModel: [{ model: "gpt-test", count: 4, inputTokens: 100, outputTokens: 40 }],
        byTier: [{ tier: "smart", count: 4 }],
        byLayer: [],
        smartByTier: [{ tier: "smart", count: 4 }]
      })
      expect(result.value).not.toHaveProperty("ignored")
      expect(result.stats.sourceBytes).toBe(projectedHomePayload.length)
      expect(result.stats.outputBytes).toBeLessThan(1024)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  }, 30_000)

  it("enforces hard limits before raw or normalized payloads cross into main", async () => {
    const client = createClient()
    await expect(query(client, "oversized-input")).rejects.toMatchObject({
      code: DASHBOARD_ES_RESPONSE_TOO_LARGE
    })
    await expect(query(client, "oversized-output")).rejects.toMatchObject({
      code: DASHBOARD_ES_RESPONSE_TOO_LARGE
    })
  }, 30_000)

  it("reuses one worker and isolates concurrent response identities", async () => {
    let starts = 0
    const client = createClient(() => {
      starts += 1
    })
    const [first, second] = await Promise.all([query(client, "first"), query(client, "second")])

    expect(first).toMatchObject({ index: "first", nested: { finite: 1, invalid: null } })
    expect(second).toMatchObject({ index: "second", nested: { finite: 1, invalid: null } })
    expect(starts).toBe(1)
    expect(client.getDiagnostics().completedRequests).toBe(2)
  })

  it("supports bounded GET responses and reports the serving node for audited queries", async () => {
    const client = createClient()
    const result = await client.queryWithStats({
      nodes: [serverUrl],
      method: "GET",
      path: "/mapping/_mapping",
      headers: { "content-type": "application/json" },
      timeoutMs: 5_000
    })

    expect(result.value).toMatchObject({ index: "mapping", method: "GET" })
    expect(result.stats.node).toBe(serverUrl)
  })

  it("cancels in-flight work without poisoning the reusable worker", async () => {
    const client = createClient()
    const controller = new AbortController()
    const pending = query(client, "slow", controller.signal)
    setTimeout(() => controller.abort(), 10)

    await expect(pending).rejects.toBeInstanceOf(DashboardEsRequestCancelledError)
    await expect(query(client, "after-cancel")).resolves.toMatchObject({
      index: "after-cancel"
    })
  })

  it("restarts after a worker crash and keeps request failures bounded", async () => {
    let starts = 0
    const client = new DashboardEsWorkerClient(async () => {
      starts += 1
      if (starts === 1) {
        return new Worker(
          `
            const { parentPort } = require("node:worker_threads")
            parentPort.on("message", () => { throw new Error("intentional dashboard crash") })
          `,
          { eval: true }
        )
      }
      return new Worker(workerBundlePath, { name: "dashboard-es-replacement" })
    })
    clients.push(client)

    await expect(query(client, "crash")).rejects.toBeInstanceOf(DashboardEsWorkerUnavailableError)
    await expect(query(client, "replacement")).resolves.toMatchObject({
      index: "replacement"
    })
    expect(starts).toBe(2)
  })

  it("rejects pending work and acknowledges bounded shutdown", async () => {
    const client = new DashboardEsWorkerClient(
      async () =>
        new Worker(
          `
            const { parentPort } = require("node:worker_threads")
            parentPort.on("message", (message) => {
              if (message.type === "shutdown") {
                parentPort.postMessage({ type: "shutdown-complete" })
              }
            })
          `,
          { eval: true }
        )
    )
    clients.push(client)
    const pending = query(client, "pending").catch((error) => error)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await client.close()

    await expect(pending).resolves.toBeInstanceOf(DashboardEsRequestCancelledError)
  })
})
