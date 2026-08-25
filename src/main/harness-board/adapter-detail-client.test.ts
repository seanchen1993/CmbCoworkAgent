import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import {
  HarnessAdapterDetailClient,
  HarnessAdapterDetailCancelledError,
  HarnessAdapterDetailWorkerResultError,
  HarnessAdapterDetailWorkerUnavailableError,
  parseHarnessAdapterDetailBatchInWorker
} from "./adapter-detail-client"
import type {
  HarnessAdapterDetailProjectInput,
  HarnessAdapterRunProjection
} from "./adapter-detail-protocol"
import {
  HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH
} from "./adapter-detail-protocol"
import { HARNESS_WATCH_REF_MAX_REFS } from "./watch-ref-protocol"

const clients: HarnessAdapterDetailClient[] = []
const testDirectories: string[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-harness-detail-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "adapter-detail-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./adapter-detail-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

function makeProject(projectDir = "project-a"): HarnessProjectMetadata {
  return {
    projectId: projectDir,
    name: projectDir,
    description: "",
    projectCode: projectDir,
    projectFromLean: false,
    projectDir,
    systemId: "system-a",
    systemName: "System A",
    workspacePath: join(tmpdir(), "harness-adapter-detail-workspace"),
    "harness-adapter": {
      id: "adapter-a",
      name: "Adapter A",
      version: "1.0.0",
      type: "plugin"
    },
    lifecycle: {
      status: "active",
      createAt: "2026-08-24T00:00:00.000Z"
    }
  }
}

function makeRunFixture(): { project: HarnessProjectMetadata; logPath: string } {
  const workspacePath = mkdtempSync(join(tmpdir(), "harness-adapter-run-workspace-"))
  testDirectories.push(workspacePath)
  const project = { ...makeProject(), workspacePath }
  const featureDirectory = join(
    workspacePath,
    project.projectDir,
    ".autobizdevops",
    "features",
    "feature-one"
  )
  mkdirSync(featureDirectory, { recursive: true })
  return { project, logPath: join(featureDirectory, "hooks.ndjson") }
}

function makeRunSnapshot(padding = ""): Record<string, unknown> {
  return {
    workflow: {
      display: { mode: "ordered_nodes", groupBy: "group" },
      nodes: [
        {
          id: "plan",
          label: "Plan",
          group: "work",
          artifactDefinitions: [{ id: "spec", artifactType: "markdown", required: true }]
        },
        { id: "implement", label: "Implement", group: "work" }
      ]
    },
    run: {
      featureId: "feature-one",
      featureName: "Feature One",
      currentNodeId: "plan",
      currentNodeStatus: "in_progress",
      nodes: [
        {
          id: "plan",
          nodeStatus: "in_progress",
          artifacts: [{ id: "spec", path: "docs/spec.md", artifactStatus: "generated" }]
        }
      ],
      hookLogRefs: [
        {
          id: "default",
          path: ".autobizdevops/features/feature-one/hooks.ndjson",
          format: "ndjson"
        }
      ]
    },
    ignoredPadding: padding
  }
}

function makeProjectInput(projectDir = "project-a"): HarnessAdapterDetailProjectInput {
  return {
    project: makeProject(projectDir),
    projectDir,
    fallbackWatchRefs: [{ path: ".autobizdevops/STATE.md", purpose: "run-list" }]
  }
}

function makeSnapshot(
  projectDir = "project-a",
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    workflow: {
      display: { mode: "ordered_nodes", groupBy: "group" },
      states: [
        { nodeStatus: "in_progress", nextAction: { slashSkill: " go ", ignored: true } },
        { nodeStatus: "bogus" }
      ],
      nodes: [
        {
          id: "plan",
          label: "Plan",
          group: "work",
          artifactDefinitions: [
            { id: "spec", artifactType: "markdown", required: true },
            { id: "unknown-type", artifactType: "not-supported" }
          ]
        },
        { id: "implement", label: "Implement", group: "work" }
      ]
    },
    projects: {
      [projectDir]: {
        runs: [
          {
            featureId: "feature-one",
            featureName: "Feature One",
            nodeIds: ["plan", "implement", "plan", "missing"],
            currentNodeId: "plan",
            currentNodeStatus: "done"
          },
          {
            featureName: "Archived Feature",
            currentNodeId: "implement",
            currentNodeStatus: "unknown",
            featureStatus: "archived",
            featureStatusLabel: "Archived by plugin"
          },
          { currentNodeStatus: "done" }
        ],
        watchRefs: [
          { path: ".autobizdevops/STATE.md", purpose: "run-list" },
          { path: "../outside", purpose: "invalid" }
        ]
      }
    },
    ...extra
  }
}

function toBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf-8")
}

function makeWorkerClient(onStart?: () => void): HarnessAdapterDetailClient {
  const client = new HarnessAdapterDetailClient(async () => {
    onStart?.()
    return new Worker(workerBundlePath, { name: "harness-adapter-detail-test" })
  })
  clients.push(client)
  return client
}

describe("Harness adapter detail worker", () => {
  it("parses and normalizes project details without returning the raw adapter tree", async () => {
    const client = makeWorkerClient()
    const result = await client.parse(toBuffer(makeSnapshot()), [makeProjectInput()])

    expect(result.workflow.nodes.map((node) => node.id)).toEqual(["plan", "implement"])
    expect(result.workflow.states).toEqual([
      { nodeStatus: "in_progress", nextAction: { slashSkill: "go" } }
    ])
    expect(result.workflow.nodes[0]?.artifactDefinitions).toEqual([
      { id: "spec", artifactType: "markdown", required: true },
      { id: "unknown-type", artifactType: "unknown", required: false }
    ])
    expect(result.projects["project-a"]?.runs).toMatchObject([
      {
        id: "feature-one",
        nodeIds: ["plan", "implement", "missing"],
        currentNodeStatus: "done",
        featureStatus: "in_progress",
        overallStatus: { label: "进行中", uiKind: "active" }
      },
      {
        id: "Archived Feature",
        featureStatus: "archived",
        location: "archived",
        overallStatus: { label: "Archived by plugin", uiKind: "archived" }
      }
    ])
    expect(result.projects["project-a"]?.watchRefs).toEqual([
      { path: ".autobizdevops/STATE.md", purpose: "run-list" }
    ])
    expect(Object.keys(result.projects["project-a"] ?? {})).toEqual(["runs", "watchRefs"])
  }, 30_000)

  it("hard-caps project and run watch refs before main installs filesystem watchers", async () => {
    const client = makeWorkerClient()
    const watchRefs = Array.from({ length: 1_000 }, (_, index) => ({
      path: `watch/path-${index}`,
      purpose: "artifacts"
    }))
    const projectSnapshot = makeSnapshot()
    const projects = projectSnapshot.projects as Record<string, Record<string, unknown>>
    projects["project-a"].watchRefs = watchRefs

    const projectResult = await client.parse(toBuffer(projectSnapshot), [makeProjectInput()])
    expect(projectResult.projects["project-a"]?.watchRefs).toHaveLength(
      HARNESS_WATCH_REF_MAX_REFS
    )

    const { project } = makeRunFixture()
    const runSnapshot = makeRunSnapshot()
    const run = runSnapshot.run as Record<string, unknown>
    run.watchRefs = watchRefs
    const runResult = await client.parseRun(
      toBuffer(runSnapshot),
      project,
      "feature-one",
      "renderer:watch-ref-budget"
    )
    expect(runResult.run.watchRefs).toHaveLength(HARNESS_WATCH_REF_MAX_REFS)
  }, 30_000)

  it("keeps the main event-loop moving while parsing a near-limit adapter payload", async () => {
    const client = makeWorkerClient()
    await client.parse(toBuffer(makeSnapshot()), [makeProjectInput()])

    const large = toBuffer(
      makeSnapshot("project-a", {
        ignoredPadding: "x".repeat(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES - 512 * 1024)
      })
    )
    expect(large.byteLength).toBeLessThan(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES)
    expect(large.byteLength).toBeGreaterThan(8 * 1024 * 1024)

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const result = await client.parse(large, [makeProjectInput()])
      expect(result.projects["project-a"]?.runs).toHaveLength(2)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
    expect(client.getDiagnostics().lastStats).toMatchObject({
      inputBytes: expect.any(Number),
      projectCount: 1
    })
  }, 30_000)

  it("projects run details and only reads a bounded recent tail from a 100MB hook log", async () => {
    const client = makeWorkerClient()
    const { project, logPath } = makeRunFixture()
    const descriptor = openSync(logPath, "w+")
    try {
      ftruncateSync(descriptor, 100 * 1024 * 1024)
      const recentLines = Array.from({ length: 700 }, (_, index) =>
        JSON.stringify({
          ts: `2026-08-24 12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
          source: "test",
          sessionId: "session",
          pluginId: "plugin",
          featureId: "feature-one",
          eventId: `event-${index}`,
          eventStatus: "success",
          message: `message-${index}`,
          nodeId: index % 2 === 0 ? "plan" : "missing"
        })
      ).join("\n")
      const tail = Buffer.from(`\n${recentLines}\n`, "utf8")
      writeSync(descriptor, tail, 0, tail.length, 100 * 1024 * 1024 - tail.length)
    } finally {
      closeSync(descriptor)
    }

    const nearLimit = toBuffer(
      makeRunSnapshot("x".repeat(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES - 512 * 1024))
    )
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const startedAt = performance.now()
    let result: HarnessAdapterRunProjection
    try {
      result = await client.parseRun(nearLimit, project, "feature-one", "renderer:run")
    } finally {
      clearInterval(ticker)
    }

    expect(ticks).toBeGreaterThan(0)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    expect(result.run.nodes.map((node) => node.id)).toEqual(["plan", "implement"])
    expect(result.run.nodes[0]?.artifacts[0]).toMatchObject({
      id: "spec",
      artifactType: "markdown",
      artifactStatus: "generated"
    })
    const externalHooks =
      result.run.nodes.reduce((sum, node) => sum + node.hooks.length, 0) +
      result.run.unmatchedHooks.length
    expect(externalHooks).toBeLessThanOrEqual(512)
    expect(result.run.nodes[0]?.hooks[0]?.eventId).toBe("event-698")
    expect(result.run.unmatchedHooks[0]?.eventId).toBe("event-699")
    expect(client.getDiagnostics().lastStats?.outputBytes).toBeLessThanOrEqual(
      HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES
    )
  }, 30_000)

  it("cancels superseded run projections and keeps the replacement usable", async () => {
    const client = makeWorkerClient()
    const { project } = makeRunFixture()
    const large = toBuffer(
      makeRunSnapshot("x".repeat(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES - 512 * 1024))
    )
    const first = client.parseRun(large, project, "old", "renderer:run")
    const second = client.parseRun(toBuffer(makeRunSnapshot()), project, "new", "renderer:run")
    await expect(first).rejects.toBeInstanceOf(HarnessAdapterDetailCancelledError)
    await expect(second).resolves.toMatchObject({ run: { id: "feature-one" } })
  }, 30_000)

  it("cancels superseded project projections and keeps the replacement usable", async () => {
    const client = makeWorkerClient()
    const large = toBuffer(
      makeSnapshot("project-a", {
        ignoredPadding: "x".repeat(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES - 512 * 1024)
      })
    )
    const first = client.parse(large, [makeProjectInput()], "renderer:project")
    const second = client.parse(
      toBuffer(makeSnapshot()),
      [makeProjectInput()],
      "renderer:project"
    )

    await expect(first).rejects.toBeInstanceOf(HarnessAdapterDetailCancelledError)
    await expect(second).resolves.toMatchObject({
      projects: { "project-a": { runs: expect.any(Array) } }
    })
  }, 30_000)

  it("rejects a run projection before an oversized normalized tree crosses IPC", async () => {
    const client = makeWorkerClient()
    const { project } = makeRunFixture()
    const snapshot = makeRunSnapshot()
    const run = snapshot.run as Record<string, unknown>
    const nodes = run.nodes as Array<Record<string, unknown>>
    nodes[0].hooks = Array.from({ length: 512 }, (_, index) => ({
      ts: "2026-08-24 12:00:00",
      source: "test",
      sessionId: "session",
      pluginId: "plugin",
      featureId: "feature-one",
      eventId: `event-${index}`,
      eventStatus: "success",
      message: "x".repeat(8_000),
      nodeId: "plan"
    }))
    const buffer = toBuffer(snapshot)
    expect(buffer.byteLength).toBeLessThan(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES)

    await expect(
      client.parseRun(buffer, project, "feature-one", "renderer:oversized-run")
    ).rejects.toMatchObject({ code: "HARNESS_ADAPTER_DETAIL_RESULT_TOO_LARGE" })
  }, 30_000)

  it("reuses one worker and keeps concurrent response identities isolated", async () => {
    let starts = 0
    const client = makeWorkerClient(() => {
      starts += 1
    })
    const [first, second] = await Promise.all([
      client.parse(toBuffer(makeSnapshot("project-a")), [makeProjectInput("project-a")]),
      client.parse(toBuffer(makeSnapshot("project-b")), [makeProjectInput("project-b")])
    ])

    expect(first.projects["project-a"]?.runs[0]?.id).toBe("feature-one")
    expect(second.projects["project-b"]?.runs[0]?.id).toBe("feature-one")
    expect(first.projects["project-b"]).toBeUndefined()
    expect(second.projects["project-a"]).toBeUndefined()
    expect(starts).toBe(1)
    expect(client.getDiagnostics().completedRequests).toBe(2)
  }, 30_000)

  it("enforces the eight-project production batch boundary in the worker", async () => {
    const client = makeWorkerClient()
    const inputs = Array.from(
      { length: HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH + 1 },
      (_, index) => makeProjectInput(`project-${index}`)
    )
    await expect(client.parse(toBuffer(makeSnapshot()), inputs)).rejects.toMatchObject({
      code: "HARNESS_ADAPTER_DETAIL_BATCH_TOO_LARGE"
    })
  })

  it("bounds normalized data before it can cross back into the main process", async () => {
    const client = makeWorkerClient()
    const oversizedRuns = Array.from({ length: 12_000 }, (_, index) => ({
      featureId: `feature-${index}-${"x".repeat(80)}`,
      featureName: `Feature ${index} ${"y".repeat(80)}`,
      currentNodeId: "plan",
      currentNodeStatus: "in_progress"
    }))
    const snapshot = makeSnapshot()
    const projects = snapshot.projects as Record<string, Record<string, unknown>>
    if (projects["project-a"]) projects["project-a"].runs = oversizedRuns
    const buffer = toBuffer(snapshot)
    expect(buffer.byteLength).toBeLessThan(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES)

    const outcome = client.parse(buffer, [makeProjectInput()])
    await expect(outcome).rejects.toMatchObject({
      code: "HARNESS_ADAPTER_DETAIL_RESULT_TOO_LARGE"
    })
    await expect(outcome).rejects.toThrow(
      `normalized result exceeded IPC limit (${HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES} bytes)`
    )
  }, 30_000)

  it("uses only the bounded fallback when worker startup is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const client = new HarnessAdapterDetailClient(async () => {
      throw new Error("worker bundle unavailable")
    })
    clients.push(client)
    try {
      await expect(
        parseHarnessAdapterDetailBatchInWorker(
          toBuffer(makeSnapshot()),
          [makeProjectInput()],
          client
        )
      ).resolves.toMatchObject({
        projects: { "project-a": { runs: expect.any(Array) } }
      })
      expect(client.getDiagnostics().fallbackRequests).toBe(1)

      const large = toBuffer(makeSnapshot("project-a", { ignoredPadding: "x".repeat(300_000) }))
      await expect(
        parseHarnessAdapterDetailBatchInWorker(large, [makeProjectInput()], client)
      ).rejects.toBeInstanceOf(HarnessAdapterDetailWorkerUnavailableError)
      expect(client.getDiagnostics().fallbackRequests).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("restarts after a crash and reports parse failures without returning unbounded output", async () => {
    let starts = 0
    const client = new HarnessAdapterDetailClient(async () => {
      starts += 1
      if (starts === 1) {
        return new Worker("throw new Error('intentional adapter detail crash')", { eval: true })
      }
      return new Worker(workerBundlePath, { name: "harness-adapter-detail-replacement" })
    })
    clients.push(client)

    await expect(
      client.parse(toBuffer(makeSnapshot()), [makeProjectInput()])
    ).rejects.toBeInstanceOf(HarnessAdapterDetailWorkerUnavailableError)
    await expect(
      client.parse(toBuffer(makeSnapshot()), [makeProjectInput()])
    ).resolves.toMatchObject({
      projects: { "project-a": { runs: expect.any(Array) } }
    })
    expect(starts).toBe(2)
    expect(client.getDiagnostics().workerRestarts).toBe(1)

    await expect(
      client.parseRun(toBuffer(makeRunSnapshot()), makeProject(), "feature-one", "renderer:run")
    ).resolves.toMatchObject({ run: { id: "feature-one" } })
    expect(starts).toBe(2)

    const invalid = client.parse(Buffer.from(`{"projects": ${"x".repeat(20_000)}`), [
      makeProjectInput()
    ])
    await expect(invalid).rejects.toBeInstanceOf(HarnessAdapterDetailWorkerResultError)
    await expect(invalid).rejects.toMatchObject({
      code: "HARNESS_ADAPTER_DETAIL_INVALID_JSON",
      preview: expect.any(String)
    })
    await invalid.catch((error: HarnessAdapterDetailWorkerResultError) => {
      expect(error.preview?.length).toBeLessThanOrEqual(4_097)
    })
  }, 30_000)

  it("rejects pending work and acknowledges shutdown", async () => {
    const client = new HarnessAdapterDetailClient(
      async () =>
        new Worker(
          `
      const { parentPort } = require("node:worker_threads")
      parentPort.on("message", (message) => {
        if (message.type === "shutdown") {
          parentPort.postMessage({ type: "shutdown-complete" })
          return
        }
        setTimeout(() => {}, 1_000)
      })
    `,
          { eval: true }
        )
    )
    clients.push(client)

    const pending = client.parse(toBuffer(makeSnapshot()), [makeProjectInput()]).then(
      () => null,
      (error: unknown) => error
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await client.close()
    await expect(pending).resolves.toBeInstanceOf(HarnessAdapterDetailWorkerUnavailableError)
  })
})
