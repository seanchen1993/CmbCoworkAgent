import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/system-constraint-read-reporter", () => ({
  recordSystemConstraintRead: vi.fn()
}))

import { recordSystemConstraintRead } from "../services/system-constraint-read-reporter"
import { LocalSandbox, type LocalSandboxOptions } from "./local-sandbox"
import type { TraceContext } from "./trace/types"

const temporaryRoots: string[] = []

async function createSandboxFixture(sandboxOptions: Partial<LocalSandboxOptions> = {}): Promise<{
  sandbox: LocalSandbox
  root: string
  pluginRoot: string
  constraintPath: string
  emptyConstraintPath: string
  outsidePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), "cmb-sandbox-system-constraint-"))
  temporaryRoots.push(root)
  const pluginRoot = join(root, "plugin")
  const sysDir = join(pluginRoot, "sys")
  await mkdir(sysDir, { recursive: true })
  const constraintPath = join(sysDir, "project.md")
  const emptyConstraintPath = join(sysDir, "empty.md")
  const outsidePath = join(pluginRoot, "README.md")
  await Promise.all([
    writeFile(constraintPath, "first constraint\nsecond constraint\n"),
    writeFile(emptyConstraintPath, ""),
    writeFile(outsidePath, "plugin documentation\n")
  ])
  return {
    root,
    pluginRoot,
    sandbox: new LocalSandbox({
      rootDir: root,
      runId: "thread-1",
      agentId: "agent-1",
      pluginRoot,
      pluginId: "plugin-1",
      pluginName: "Plugin One",
      featureId: "feature-1",
      harnessProjectId: "project-1",
      harnessNodeName: "Dev-代码实现",
      harnessNodeStatus: "进行中",
      traceId: "trace-1",
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1",
      ...sandboxOptions
    }),
    constraintPath,
    emptyConstraintPath,
    outsidePath
  }
}

beforeEach(() => {
  vi.mocked(recordSystemConstraintRead).mockClear()
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("LocalSandbox system-constraint telemetry", () => {
  it("records only after read_file actually returns constraint content", async () => {
    const { sandbox, constraintPath, emptyConstraintPath, outsidePath } =
      await createSandboxFixture()

    await expect(sandbox.read(constraintPath, 0, 1)).resolves.toContain("first constraint")
    expect(recordSystemConstraintRead).toHaveBeenCalledTimes(1)
    expect(recordSystemConstraintRead).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessNodeName: "Dev-代码实现",
        constraintFile: "sys/project.md"
      })
    )

    await expect(sandbox.read(emptyConstraintPath)).resolves.toContain("empty contents")
    await expect(sandbox.read(constraintPath, 99, 1)).resolves.toContain("exceeds file length")
    await expect(sandbox.read(outsidePath)).resolves.toContain("plugin documentation")
    expect(recordSystemConstraintRead).toHaveBeenCalledTimes(1)
  })

  it("attributes shared-sandbox task reads to the active child trace", async () => {
    const { sandbox, constraintPath } = await createSandboxFixture()
    const childTraceContext: TraceContext = {
      traceId: "child-trace-1",
      threadId: "thread-1__task_owner-1",
      rootNodeId: "trace:child-trace-1",
      observabilitySchemaVersion: 1,
      traceKind: "subagent",
      executionMode: "normal",
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1",
      parentTraceId: "trace-1",
      parentThreadId: "thread-1",
      linkType: "parent_child",
      subagentKind: "task",
      subagentRunId: "owner-1",
      harnessFeature: {
        projectId: "project-1",
        slug: "feature-1",
        nodeName: "Dev-代码实现",
        nodeStatus: "进行中"
      }
    }

    await expect(
      sandbox.read(constraintPath, 0, 1, { traceContext: childTraceContext })
    ).resolves.toContain("first constraint")

    expect(recordSystemConstraintRead).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "child-trace-1",
        rootTraceId: "root-trace-1",
        rootThreadId: "root-thread-1",
        threadId: "thread-1__task_owner-1",
        agentId: "owner-1",
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessNodeName: "Dev-代码实现",
        constraintFile: "sys/project.md"
      })
    )
  })

  it("keeps concurrent task-subagent read ownership isolated", async () => {
    const { sandbox, constraintPath } = await createSandboxFixture()
    const makeChildContext = (ownerId: string): TraceContext => ({
      traceId: `child-trace-${ownerId}`,
      threadId: `thread-1__task_${ownerId}`,
      rootNodeId: `trace:child-trace-${ownerId}`,
      observabilitySchemaVersion: 1,
      traceKind: "subagent",
      executionMode: "normal",
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1",
      parentTraceId: "trace-1",
      parentThreadId: "thread-1",
      linkType: "parent_child",
      subagentKind: "task",
      subagentRunId: ownerId,
      harnessFeature: { projectId: "project-1", slug: "feature-1" }
    })

    await Promise.all([
      sandbox.read(constraintPath, 0, 1, { traceContext: makeChildContext("owner-a") }),
      sandbox.read(constraintPath, 0, 1, { traceContext: makeChildContext("owner-b") })
    ])

    expect(vi.mocked(recordSystemConstraintRead).mock.calls.map(([record]) => record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ traceId: "child-trace-owner-a", agentId: "owner-a" }),
        expect.objectContaining({ traceId: "child-trace-owner-b", agentId: "owner-b" })
      ])
    )
  })

  it.each([
    ["coordinator worker", "coordinator-trace-1", "coordinator-worker-1"],
    ["workflow agent", "workflow-trace-1", "workflow-agent-1"]
  ])("keeps %s reads on the independent runtime trace", async (_mode, traceId, agentId) => {
    const { sandbox, constraintPath } = await createSandboxFixture({
      runId: `${agentId}-thread`,
      agentId,
      traceId,
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1"
    })

    await sandbox.read(constraintPath, 0, 1)

    expect(recordSystemConstraintRead).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId,
        rootTraceId: "root-trace-1",
        threadId: `${agentId}-thread`,
        agentId
      })
    )
  })

  it("records workflow-worktree reads from the external plugin sys directory", async () => {
    const { root, pluginRoot, constraintPath } = await createSandboxFixture()
    const workflowRoot = join(root, "workflow-worktree")
    await mkdir(workflowRoot, { recursive: true })
    const sandbox = new LocalSandbox({
      rootDir: workflowRoot,
      runId: "workflow-thread-1",
      agentId: "workflow-agent-1",
      pluginRoot,
      featureId: "feature-1",
      harnessProjectId: "project-1",
      traceId: "workflow-trace-1",
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1"
    })

    await expect(sandbox.read(constraintPath, 0, 1)).resolves.toContain("first constraint")
    expect(recordSystemConstraintRead).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "workflow-trace-1",
        agentId: "workflow-agent-1",
        constraintFile: "sys/project.md"
      })
    )
  })
})
