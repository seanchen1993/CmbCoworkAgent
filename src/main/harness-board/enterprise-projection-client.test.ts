import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  HarnessEnterpriseProjectionCancelledError,
  HarnessEnterpriseProjectionClient,
  HarnessEnterpriseProjectionResultError,
  HarnessEnterpriseProjectionWorkerUnavailableError
} from "./enterprise-projection-client"
import { projectEnterpriseProjectReviews } from "./enterprise-projection-normalizer"
import {
  HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
  HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES,
  HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS,
  HARNESS_ENTERPRISE_REVIEW_MAX_TYPE_NODES
} from "./enterprise-projection-protocol"

const clients: HarnessEnterpriseProjectionClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-enterprise-projection-worker-"))
  workerBundlePath = join(workerBuildDirectory, "enterprise-projection-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./enterprise-projection-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

function makeClient(onStart?: () => void): HarnessEnterpriseProjectionClient {
  const client = new HarnessEnterpriseProjectionClient(async () => {
    onStart?.()
    return new Worker(workerBundlePath, { name: "harness-enterprise-projection-test" })
  })
  clients.push(client)
  return client
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8")
}

function makeDetail(index: number): Record<string, unknown> {
  return {
    prjCode: `PROJECT-${index}`,
    prjName: `Project ${index}`,
    pm: `pm-${index}`,
    mainProduct: `ABC12.3 System ${index}`,
    status: "active",
    phaseStatus: "implementation",
    baselineEndDate: "2026-08-24",
    ignoredPayload: { deeply: { nested: "must not cross the worker boundary" } }
  }
}

function detailResponse(count = 1, padding = ""): Buffer {
  return jsonBuffer({
    returnCode: "SUC0000",
    body: Array.from({ length: count }, (_, index) => makeDetail(index)),
    ignoredPadding: padding
  })
}

function reviewSummary(count = 1): Buffer {
  return jsonBuffer({
    reviewSummaries: Array.from({ length: count }, (_, index) => ({
      title: `Review ${index}`,
      type: "design",
      startTime: "2026-08-24 10:00:00",
      endTime: "2026-08-24 11:00:00",
      creator: `creator-${index}`,
      creatorName: `Creator ${index}`,
      reviewMembers: [{ name: "Alice" }, { name: "Bob" }],
      ignoredPayload: "not returned"
    }))
  })
}

function reviewTypes(): Buffer {
  return jsonBuffer({
    data: [
      {
        type: "parent",
        description: "Technical review",
        subTypes: [{ type: "design", description: "Design review" }]
      }
    ]
  })
}

describe("Harness enterprise projection worker", () => {
  it("projects only the required detail and review fields with hard item caps", async () => {
    const client = makeClient()
    const details = await client.projectDetails(
      detailResponse(HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS + 100),
      "renderer:details"
    )
    expect(details.projects).toHaveLength(HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS)
    expect(details.projects[0]).toEqual({
      projectCode: "PROJECT-0",
      projectName: "Project 0",
      pm: "pm-0",
      systemId: "ABC12.3",
      systemName: "System 0",
      status: "active",
      phaseStatus: "implementation",
      baselineEndDate: "2026-08-24"
    })

    const reviews = await client.projectReviews(
      reviewSummary(HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS + 100),
      reviewTypes(),
      "renderer:reviews"
    )
    expect(reviews.tokenConfigured).toBe(true)
    expect(reviews.reviews).toHaveLength(HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS)
    expect(reviews.reviews[0]).toEqual({
      title: "Review 0",
      type: "Technical review - Design review",
      start_time: "2026-08-24 10:00:00",
      end_time: "2026-08-24 11:00:00",
      creator: "creator-0 (Creator 0)",
      members: "Alice, Bob"
    })
    expect(client.getDiagnostics().lastStats?.outputBytes).toBeLessThanOrEqual(
      HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES
    )
  }, 30_000)

  it("keeps a main-thread ticker moving while parsing a near-limit response", async () => {
    const client = makeClient()
    await client.projectDetails(detailResponse(), "renderer:warmup")
    const largeResponses = Array.from({ length: 8 }, () =>
      detailResponse(
        HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
        "x".repeat(HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES - 128 * 1024)
      )
    )
    expect(largeResponses[0]?.byteLength).toBeLessThan(
      HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES
    )
    expect(largeResponses[0]?.byteLength).toBeGreaterThan(1024 * 1024)

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const results = await Promise.all(
        largeResponses.map((large, index) =>
          client.projectDetails(large, `renderer:large-details:${index}`)
        )
      )
      expect(results).toHaveLength(8)
      expect(results[0]?.projects).toHaveLength(HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  }, 30_000)

  it("cancels a superseded same-scope projection and keeps the latest result", async () => {
    const client = makeClient()
    await client.projectDetails(detailResponse(), "renderer:warmup")
    const first = client.projectDetails(
      detailResponse(
        HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
        "x".repeat(HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES - 128 * 1024)
      ),
      "renderer:selected-project"
    )
    const second = client.projectDetails(
      detailResponse(1),
      "renderer:selected-project"
    )
    await expect(first).rejects.toBeInstanceOf(HarnessEnterpriseProjectionCancelledError)
    await expect(second).resolves.toMatchObject({
      projects: [{ projectCode: "PROJECT-0" }]
    })
  }, 30_000)

  it("restarts after a worker crash and bounds parse errors", async () => {
    let starts = 0
    const client = new HarnessEnterpriseProjectionClient(async () => {
      starts += 1
      if (starts === 1) {
        return new Worker("throw new Error('intentional enterprise projection crash')", {
          eval: true
        })
      }
      return new Worker(workerBundlePath, { name: "harness-enterprise-projection-replacement" })
    })
    clients.push(client)

    await expect(
      client.projectDetails(detailResponse(), "renderer:crash")
    ).rejects.toBeInstanceOf(HarnessEnterpriseProjectionWorkerUnavailableError)
    await expect(
      client.projectDetails(detailResponse(), "renderer:replacement")
    ).resolves.toMatchObject({ projects: [{ projectCode: "PROJECT-0" }] })
    expect(starts).toBe(2)
    expect(client.getDiagnostics().workerRestarts).toBe(1)

    const invalid = client.projectDetails(
      Buffer.from(`{"returnCode":"SUC0000","body":${"x".repeat(20_000)}`),
      "renderer:invalid"
    )
    await expect(invalid).rejects.toBeInstanceOf(HarnessEnterpriseProjectionResultError)
    await expect(invalid).rejects.toMatchObject({
      code: "HARNESS_ENTERPRISE_INVALID_JSON",
      preview: expect.any(String)
    })
    await invalid.catch((error: HarnessEnterpriseProjectionResultError) => {
      expect(error.preview?.length).toBeLessThanOrEqual(1024)
    })
  }, 30_000)

  it("rejects pending projection on a clean unexpected exit and restarts", async () => {
    let starts = 0
    const client = new HarnessEnterpriseProjectionClient(async () => {
      starts += 1
      if (starts === 1) {
        return new Worker(
          `
            const { parentPort } = require("node:worker_threads")
            parentPort.on("message", () => process.exit(0))
          `,
          { eval: true }
        )
      }
      return new Worker(workerBundlePath, { name: "harness-enterprise-clean-restart" })
    })
    clients.push(client)

    await expect(
      client.projectDetails(detailResponse(), "renderer:clean-exit")
    ).rejects.toBeInstanceOf(HarnessEnterpriseProjectionWorkerUnavailableError)
    await expect(
      client.projectDetails(detailResponse(), "renderer:clean-exit")
    ).resolves.toMatchObject({ projects: [{ projectCode: "PROJECT-0" }] })
    expect(starts).toBe(2)
  }, 30_000)

  it("rejects normalized output before it can exceed the IPC budget", () => {
    expect(() =>
      projectEnterpriseProjectReviews(reviewSummary(2), reviewTypes(), {
        maxReviews: HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS,
        maxTypeNodes: HARNESS_ENTERPRISE_REVIEW_MAX_TYPE_NODES,
        maxOutputBytes: 64,
        cancelFlag: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
      })
    ).toThrow("normalized result exceeded IPC limit")
  })

  it("keeps details and reviews free of main-process response.json parsing", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./enterprise-projects.ts", import.meta.url)),
      "utf8"
    )
    const detailsStart = source.indexOf("export async function getEnterpriseProjectDetails")
    const reviewsStart = source.indexOf("export async function getProjectReviews")
    const detailsSource = source.slice(detailsStart, reviewsStart)
    const reviewsSource = source.slice(reviewsStart)
    expect(detailsSource).not.toContain("response.json")
    expect(reviewsSource).not.toContain("response.json")
    expect(detailsSource).toContain("readBoundedResponseBody")
    expect(reviewsSource).toContain("readBoundedResponseBody")
    expect(reviewsSource).not.toContain('size: "999"')
    expect(reviewsSource).toContain("HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE")
  })
})
