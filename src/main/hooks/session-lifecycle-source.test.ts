import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { collectSnapshotGarbage } from "../harness-board/project-runtime/snapshot-retention"
const mock = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./runner", () => ({ runHooks: mock.run, clearOnceStateForSession: vi.fn() }))
vi.mock("./scope", () => ({ resolveEnabledHooksForRun: vi.fn(() => []) }))
vi.mock("../services/setup-state", () => ({
  hasWorkspaceBeenInitialised: () => true,
  markWorkspaceInitialised: vi.fn()
}))
import { fireSessionStartOnce, fireSessionEnd, fireSessionEndAll } from "./session-lifecycle"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

afterEach(async () => {
  await fireSessionEndAll(50)
  vi.clearAllMocks()
})
it("retains the original fixed source for deferred delete and shutdown SessionEnd", async () => {
  const observed: Array<[string, string | undefined]> = []
  mock.run.mockImplementation(async (_hooks, event) => {
    observed.push([event, currentRuntimePluginSource()?.packageDigest])
    return null
  })
  const token = issueRuntimePluginSourceToken({
    threadId: "thread",
    incarnationKey: "initial",
    projectId: "project",
    operationId: "operation",
    workspace: "workspace",
    packageDigest: "a".repeat(64),
    stageId: "stage",
    plugin: { id: "plugin", path: "fixed" } as PluginMetadata
  })
  await withRuntimePluginSource(token, () => fireSessionStartOnce("thread", "workspace"))
  expect(currentRuntimePluginSource()).toBeUndefined()
  await fireSessionEnd("thread")
  await withRuntimePluginSource(token, () => fireSessionStartOnce("second-thread", "workspace"))
  await fireSessionEndAll(50)
  expect(observed.filter(([event]) => event === "SessionEnd")).toEqual([
    ["SessionEnd", "a".repeat(64)],
    ["SessionEnd", "a".repeat(64)]
  ])
})

it("does not fall back to live source when the retained snapshot fails revalidation", async () => {
  mock.run.mockResolvedValue(null)
  let valid = true
  const token = issueRuntimePluginSourceToken(
    {
      threadId: "changed",
      incarnationKey: "initial",
      projectId: "project",
      operationId: "operation",
      workspace: "workspace",
      packageDigest: "a".repeat(64),
      stageId: "stage",
      plugin: { id: "plugin", path: "fixed" } as PluginMetadata
    },
    () => {
      if (!valid) throw Error("snapshot changed")
    }
  )
  await withRuntimePluginSource(token, () => fireSessionStartOnce("changed", "workspace"))
  valid = false
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await fireSessionEnd("changed")
    expect(mock.run.mock.calls.filter((call) => call[1] === "SessionEnd")).toHaveLength(0)
    expect(warning).toHaveBeenCalled()
  } finally {
    warning.mockRestore()
  }
})

it("keeps retained bytes past SessionEndAll's timeout until the actual Hook settles", async () => {
  const base = mkdtempSync(join(tmpdir(), "session-end-retention-"))
  const installed = join(base, "installed"), root = join(base, "snapshots")
  mkdirSync(installed)
  writeFileSync(join(installed, "source.txt"), "old fixed source")
  const snapshot = new RetainedPackageSnapshots(root).capture(installed)
  const gate = Promise.withResolvers<void>()
  const collect = () => collectSnapshotGarbage(root,
    () => ({ complete: true, digests: new Set<string>(), blockers: [] }))
  mock.run.mockImplementation(async (_hooks, event) => {
    if (event === "SessionEnd") await gate.promise
    return null
  })
  const token = issueRuntimePluginSourceToken({ threadId: "delayed-end", incarnationKey: "inc",
    projectId: "project", operationId: "op", workspace: base, packageDigest: snapshot.digest,
    stageId: "stage", plugin: { id: "p", path: snapshot.root } as PluginMetadata })
  try {
    await withRuntimePluginSource(token, () => fireSessionStartOnce("delayed-end", base))
    expect(collect().protected).toEqual([snapshot.digest])
    await fireSessionEndAll(1)
    expect(collect().protected).toEqual([snapshot.digest])
    gate.resolve()
    await vi.waitFor(() => expect(collect().removed).toEqual([snapshot.digest]))
  } finally {
    gate.resolve()
    await fireSessionEndAll(50)
    rmSync(base, { recursive: true, force: true })
  }
})
