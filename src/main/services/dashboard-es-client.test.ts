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
  DASHBOARD_ES_MAX_ACTIVE_REQUESTS,
  DASHBOARD_ES_MAX_DISPATCHED_REQUESTS,
  DASHBOARD_ES_MAX_REQUEST_BODY_BYTES,
  DASHBOARD_ES_WORKER_RESOURCE_LIMITS,
  DashboardEsRequestCancelledError,
  DashboardEsWorkerClient,
  DashboardEsWorkerUnavailableError,
  isDashboardEsResponseTooLarge
} from "./dashboard-es-client"
import {
  DASHBOARD_ES_INPUT_BYTE_LIMIT,
  DASHBOARD_ES_OUTPUT_BYTE_LIMIT,
  DASHBOARD_ES_RESPONSE_TOO_LARGE,
  DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
} from "./dashboard-es-protocol"
import { prepareDashboardFieldCapsRequest } from "./dashboard-es-field-caps-request"
import { fetchCompleteProjectDevMetrics } from "../ipc/project-mode-dev-metrics"
import {
  fetchRecentConstraintFiles,
  resolveRecentConstraintFields
} from "../ipc/dashboard-recent-constraint-files"

const clients: DashboardEsWorkerClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""
let server: Server
let serverUrl = ""
let overlapSlowActiveRequests = 0
let overlapSlowPeakRequests = 0

const tickerPayload = `${JSON.stringify({ value: "ticker" })}${" ".repeat(15 * 1024 * 1024)}`
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
  ignored: "p".repeat(15 * 1024 * 1024)
})
const expandedBudgetValue = "e".repeat(9 * 1024 * 1024)
const expandedBudgetPayload = JSON.stringify({ value: expandedBudgetValue })
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
    if (index === "project-dev-cursor") {
      let text = ""
      request.setEncoding("utf8")
      request.on("data", (chunk) => {
        text += chunk
      })
      request.on("end", () => {
        // Model a null-dropping intermediary on the outbound request as well
        // as the response, not just a direct client -> ES connection.
        const body = JSON.parse(text, (_key, value) => (value === null ? undefined : value))
        const composite = body.aggs.dev_metrics.composite
        const names = composite.sources.map(
          (source: Record<string, unknown>) => Object.keys(source)[0]
        )
        const after = composite.after
        if (after && Object.keys(after).length !== names.length) {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              error: {
                reason: `[after] has ${Object.keys(after).length} value(s) but [sources] has ${names.length}`
              }
            })
          )
          return
        }
        const key = names.includes("feature")
          ? { project: "p", feature: "late", node: "Dev-实现" }
          : { project: "p", node: "Dev-实现" }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            aggregations: {
              dev_metrics: after
                ? { buckets: [] }
                : {
                    buckets: [{ key, doc_count: names.includes("feature") ? 3 : 2 }],
                    after_key: key
                  }
            }
          })
        )
      })
      return
    }
    if (index === "field-caps-native" || index === "field-caps-legacy") {
      const url = new URL(request.url!, serverUrl)
      if (url.pathname.endsWith("/_field_caps")) {
        const fields = url.searchParams.get("fields")
        if (!fields) {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(
            JSON.stringify({ error: { reason: "specified fields can't be null or empty" } })
          )
          return
        }
        const legacy = index.endsWith("legacy")
        const keyword = { keyword: { type: "keyword", searchable: true, aggregatable: true } }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            fields: {
              [legacy ? "properties.constraintFiles.keyword" : "properties.constraintFiles"]:
                keyword,
              ...(legacy
                ? {
                    "properties.constraintFiles": {
                      text: { type: "text", searchable: true, aggregatable: false }
                    }
                  }
                : {}),
              "properties.pluginId": keyword,
              "properties.lastReadAt": legacy
                ? keyword
                : {
                    date: { type: "date", searchable: true, aggregatable: true }
                  }
            }
          })
        )
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          aggregations: {
            files: {
              buckets: [
                { key: { pluginId: "p", file: "sys/project.md" } },
                { key: { pluginId: "p", file: "sys/rules.md" } }
              ]
            },
            truncated_files: { doc_count: 0 }
          }
        })
      )
      return
    }
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
    if (index === "expanded-budget") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(expandedBudgetPayload)
      return
    }
    if (index === "bad-request") {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          error: { type: "search_phase_execution_exception", reason: "all shards failed" }
        })
      )
      return
    }
    if (index === "large-bad-request") {
      const payload = JSON.stringify({
        error: {
          root_cause: [{ type: "too_many_clauses", reason: "maxClauseCount is set to 1024" }]
        },
        failed_query: "x".repeat(20 * 1024)
      })
      response.writeHead(400, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      })
      response.end(payload)
      return
    }
    if (index === "slow") {
      response.writeHead(200, { "content-type": "application/json" })
      setTimeout(() => response.end(JSON.stringify({ value: "slow" })), 200)
      return
    }
    if (index === "overlap-slow") {
      overlapSlowActiveRequests += 1
      overlapSlowPeakRequests = Math.max(overlapSlowPeakRequests, overlapSlowActiveRequests)
      response.writeHead(200, { "content-type": "application/json" })
      setTimeout(() => {
        overlapSlowActiveRequests -= 1
        response.end(JSON.stringify({ value: "overlap-slow" }))
      }, 200)
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
    return new Worker(workerBundlePath, {
      name: "dashboard-es-test",
      resourceLimits: DASHBOARD_ES_WORKER_RESOURCE_LIMITS
    })
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
  it("exports bound and unbound Dev metrics through a null-dropping HTTP intermediary", async () => {
    const client = createClient()
    const execute = (body: Record<string, unknown>) =>
      client.query({
        nodes: [serverUrl],
        method: "POST",
        path: "/project-dev-cursor/_search",
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify(body),
        timeoutMs: 5000
      })
    await expect(
      execute({
        aggs: {
          dev_metrics: {
            composite: {
              sources: [{ project: {} }, { feature: {} }, { node: {} }],
              after: { project: "p", feature: null, node: "Dev-实现" }
            }
          }
        }
      })
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("[after] has 2 value(s) but [sources] has 3") }
    })
    await expect(fetchCompleteProjectDevMetrics(["p"], [], execute)).resolves.toEqual(
      new Map([["p", { conversations: 5, features: 1 }]])
    )
  })

  it.each(["native", "legacy"])(
    "runs field_caps and recent-file aggregation over HTTP with %s mappings",
    async (mapping) => {
      const client = createClient()
      const index = `field-caps-${mapping}`
      const common = {
        nodes: [serverUrl],
        headers: { "content-type": "application/json" },
        timeoutMs: 5_000
      }
      // This is the production bug: a populated JSON body still leaves ES 7.x fields empty.
      await expect(
        client.query({
          ...common,
          method: "POST",
          path: `/${index}/_field_caps`,
          bodyText: JSON.stringify({ fields: ["properties.constraintFiles"] })
        })
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining("specified fields can't be null or empty") }
      })
      const caps = await client.query({
        ...common,
        ...prepareDashboardFieldCapsRequest(index, {
          fields: [
            "properties.constraintFiles",
            "properties.constraintFiles.keyword",
            "properties.pluginId",
            "properties.lastReadAt"
          ]
        })
      })
      const fields = resolveRecentConstraintFields(caps)
      expect(fields.file).toBe(
        `properties.constraintFiles${mapping === "legacy" ? ".keyword" : ""}`
      )
      expect(Boolean(fields.lastReadAt)).toBe(mapping === "native")
      await expect(
        fetchRecentConstraintFiles(fields, [], (body) =>
          client.query({
            ...common,
            method: "POST",
            path: `/${index}/_search`,
            bodyText: JSON.stringify(body)
          })
        )
      ).resolves.toEqual({ fileCount: 2, complete: true })
    }
  )

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

  it("accepts responses above the previous raw and normalized byte limits", async () => {
    const client = createClient()
    const result = await query(client, "expanded-budget")
    expect(result).toEqual({ value: expandedBudgetValue })
    expect(client.getDiagnostics().lastStats).toMatchObject({
      sourceBytes: expandedBudgetPayload.length,
      outputBytes: expect.any(Number)
    })
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

  it("absorbs rapid cancelled replacements without overflowing the worker queue", async () => {
    expect(DASHBOARD_ES_MAX_DISPATCHED_REQUESTS).toBe(4)
    const client = createClient()
    const cancelled: Promise<unknown>[] = []

    for (let round = 0; round < 4; round += 1) {
      const controllers = Array.from({ length: 6 }, () => new AbortController())
      controllers.forEach((controller) => {
        cancelled.push(query(client, "slow", controller.signal).catch((error) => error))
      })
      // Let each dashboard generation reach the worker before a tab/range switch
      // supersedes all six endpoint calls.
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      controllers.forEach((controller) => controller.abort())
    }

    const cancelledResults = await Promise.all(cancelled)
    expect(cancelledResults).toHaveLength(24)
    expect(
      cancelledResults.every((result) => result instanceof DashboardEsRequestCancelledError)
    ).toBe(true)
    await expect(query(client, "after-switch-burst")).resolves.toMatchObject({
      index: "after-switch-burst"
    })
  })

  it("accepts the dashboard's nine-request initial fan-out while dispatch stays bounded", async () => {
    expect(DASHBOARD_ES_MAX_ACTIVE_REQUESTS).toBe(32)
    expect(DASHBOARD_ES_MAX_DISPATCHED_REQUESTS).toBe(4)
    const client = createClient()

    const initialDashboard = Array.from({ length: 9 }, () => query(client, "slow"))
    await expect(Promise.all(initialDashboard)).resolves.toHaveLength(9)
  })

  it("accepts the 9+8 dashboard/project-mode overlap without exceeding four dispatches", async () => {
    expect(DASHBOARD_ES_MAX_ACTIVE_REQUESTS).toBeGreaterThanOrEqual(17)
    expect(DASHBOARD_ES_MAX_DISPATCHED_REQUESTS).toBe(4)
    overlapSlowActiveRequests = 0
    overlapSlowPeakRequests = 0
    const client = createClient()

    const initialDashboard = Array.from({ length: 9 }, () => query(client, "overlap-slow"))
    const projectMode = Array.from({ length: 8 }, () => query(client, "overlap-slow"))
    await expect(Promise.all([...initialDashboard, ...projectMode])).resolves.toHaveLength(17)

    expect(overlapSlowActiveRequests).toBe(0)
    expect(overlapSlowPeakRequests).toBe(DASHBOARD_ES_MAX_DISPATCHED_REQUESTS)
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

  it("treats exit(0) with pending work as failure and starts a replacement", async () => {
    expect(DASHBOARD_ES_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(256)
    let starts = 0
    const client = new DashboardEsWorkerClient(async () => {
      starts += 1
      return starts === 1
        ? new Worker("", { eval: true })
        : new Worker(workerBundlePath, { name: "dashboard-es-clean-exit-replacement" })
    })
    clients.push(client)
    await expect(query(client, "clean-exit")).rejects.toBeInstanceOf(
      DashboardEsWorkerUnavailableError
    )
    await expect(query(client, "replacement")).resolves.toMatchObject({ index: "replacement" })
    expect(starts).toBe(2)
  })

  it("hard-bounds retained requests and rejects oversized input before worker dispatch", async () => {
    let starts = 0
    const client = new DashboardEsWorkerClient(async () => {
      starts += 1
      return new Worker(
        `
          const { parentPort } = require("node:worker_threads")
          parentPort.on("message", () => undefined)
        `,
        { eval: true }
      )
    })
    clients.push(client)
    await expect(
      client.query({
        nodes: [serverUrl],
        method: "POST",
        path: "/oversized/_search",
        headers: {},
        bodyText: "x".repeat(DASHBOARD_ES_MAX_REQUEST_BODY_BYTES + 1),
        timeoutMs: 1_000
      })
    ).rejects.toThrow("hard byte ceiling")
    expect(starts).toBe(0)
    const retained = Array.from({ length: DASHBOARD_ES_MAX_ACTIVE_REQUESTS }, (_, index) =>
      query(client, `retained-${index}`).catch((error) => error)
    )
    await Promise.resolve()
    await expect(query(client, "overflow")).rejects.toMatchObject({
      name: "DASHBOARD_ES_CAPACITY_EXCEEDED"
    })
    expect(starts).toBe(1)
    await client.close()
    await Promise.all(retained)
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

/**
 * 这组用例钉的是一次排查断头：日志打出来是
 * 「All 2 ES nodes failed. Last error: 请检查网络连接后重试」——"原因"栏里躺着的
 * 是面向用户的提示语本身，真实原因不知去向。
 *
 * runDashboardEsQuery 其实把每个节点的失败原因挂在了 cause 上，但 worker 回传时
 * 只 post 了 {code, message, stack}，cause 在结构化克隆边界上整条丢掉，客户端再
 * `new Error(message)` 重建，于是 getErrorDetail 沿 cause 什么也找不到。
 */
describe("失败原因跨 worker 边界", () => {
  it("keeps the ES error reason when its response body exceeds 4 KB", async () => {
    const client = createClient()
    const error = await query(client, "large-bad-request").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const cause = (error as Error).cause as { code?: string; message?: string }
    expect(cause.code).toBe("DASHBOARD_ES_HTTP_ERROR")
    expect(cause.message).toContain("too_many_clauses")
    expect(cause.message).toContain("maxClauseCount is set to 1024")
    expect(cause.message!.length).toBeLessThanOrEqual(1032)
  })

  it("HTTP 失败把 ES 自己的报错带回主进程", async () => {
    const client = createClient()
    const error = await query(client, "bad-request").catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    // 对外仍是那句提示语，它是给用户看的，不该变。
    expect((error as Error).message).toBe("请检查网络连接后重试")
    // 但排查需要的东西必须在 cause 上，而不是只存在于 worker 内部。
    const cause = (error as Error).cause as { code?: string; message?: string } | undefined
    expect(cause?.code).toBe("DASHBOARD_ES_HTTP_ERROR")
    expect(cause?.message).toContain("ES 400")
    expect(cause?.message).toContain("search_phase_execution_exception")
  })

  it("节点不可达时带回 fetch 层的原生原因", async () => {
    const client = createClient()
    // 没有监听者的端口：fetch 直接失败，原因在它自己的 cause 里。
    const error = await client
      .query({
        nodes: ["http://127.0.0.1:1"],
        method: "POST",
        path: "/unreachable/_search",
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ size: 0 }),
        timeoutMs: 5_000
      })
      .catch((e: unknown) => e)

    const cause = (error as Error).cause as
      | { code?: string; message?: string; cause?: { message?: string } }
      | undefined
    expect(cause?.code).toBe("DASHBOARD_ES_NODE_UNAVAILABLE")
    // 「fetch failed」这一层还是泛化的，真正能定位的是它下面那层，所以链要留住。
    expect(cause?.cause?.message).toBeTruthy()
  })

  it("回传的 cause 是可克隆的普通对象，不是 Error", async () => {
    // Error 实例过不了结构化克隆的 cause 语义，所以 worker 侧必须先摊平。
    // 这条同时挡住"直接 post 一个 Error 就完事"的改法。
    const client = createClient()
    const error = (await query(client, "bad-request").catch((e: unknown) => e)) as Error
    expect(error.cause).toBeTruthy()
    expect(error.cause).not.toBeInstanceOf(Error)
    expect(() => structuredClone(error.cause)).not.toThrow()
  })
})

/**
 * 体积超限曾被 makeEsUnavailableError 一律包成「请检查网络连接后重试」，把线上
 * 排查引到了网络方向。这两类失败的处理方式完全不同：换节点、重试对体积超限
 * 毫无意义，只能缩小查询。
 */
describe("response-too-large classification", () => {
  it("recognises the code on the error itself", () => {
    const error = Object.assign(
      new Error("Dashboard normalized response exceeds the 6291456 byte limit"),
      {
        code: DASHBOARD_ES_RESPONSE_TOO_LARGE
      }
    )
    expect(isDashboardEsResponseTooLarge(error)).toBe(true)
  })

  it("follows the cause chain the worker/client/esQuery wrapping creates", () => {
    const worker = Object.assign(new Error("too large"), { code: DASHBOARD_ES_RESPONSE_TOO_LARGE })
    const wrapped = new Error("dashboard query failed", {
      cause: new Error("node failed", { cause: worker })
    })
    expect(isDashboardEsResponseTooLarge(wrapped)).toBe(true)
  })

  it("recognises the message even when the code was dropped in transit", () => {
    expect(
      isDashboardEsResponseTooLarge(new Error("Dashboard response exceeds the 262144 byte limit"))
    ).toBe(true)
  })

  it("does not misclassify a genuine transport failure", () => {
    expect(isDashboardEsResponseTooLarge(new Error("fetch failed"))).toBe(false)
    expect(isDashboardEsResponseTooLarge(new DashboardEsWorkerUnavailableError("no worker"))).toBe(
      false
    )
    expect(isDashboardEsResponseTooLarge(null)).toBe(false)
    expect(isDashboardEsResponseTooLarge("too large")).toBe(false)
  })

  it("terminates on a self-referential cause chain", () => {
    const looping = new Error("loop") as Error & { cause?: unknown }
    looping.cause = looping
    expect(isDashboardEsResponseTooLarge(looping)).toBe(false)
  })
})
