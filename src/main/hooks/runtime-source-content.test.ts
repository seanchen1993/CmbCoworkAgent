import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginMetadata } from "../types"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  currentRuntimePluginSource
} from "../plugins/runtime-source-scope"

const mock = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("./http-runner", () => ({ executeHttpHook: mock.execute }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { runHooks } from "./runner"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})
it("revalidates retained bytes immediately before each original hook while catalog getters stay cheap", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-hook-content-"))
  roots.push(root)
  const source = join(root, "source")
  mkdirSync(source)
  writeFileSync(join(source, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(hostProjectFixture(root).manifest)
  )
  writeFileSync(join(source, "hook.py"), "original hook")
  const snapshots = new HostPackageSnapshots(join(root, "packages"))
  const snapshot = snapshots.capture(source)
  const check = vi.fn(() => snapshots.read(snapshot.digest))
  const token = issueRuntimePluginSourceToken(
    {
      threadId: "thread",
      incarnationKey: "original",
      projectId: "project",
      operationId: "operation",
      workspace: root,
      packageDigest: snapshot.digest,
      stageId: "draft",
      plugin: { id: "plugin", path: snapshot.root } as PluginMetadata
    },
    check
  )
  mock.execute.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  const hook = {
    id: "original",
    event: "PreToolUse" as const,
    type: "http" as const,
    url: "http://fixture.invalid",
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }
  await withRuntimePluginSource(token, async () => {
    for (let index = 0; index < 100; index++) currentRuntimePluginSource()
    expect(check).toHaveBeenCalledTimes(1)
    await runHooks([hook], "PreToolUse", {
      sessionId: "thread",
      workspacePath: root,
      toolName: "read_file"
    })
    expect(mock.execute).toHaveBeenCalledOnce()
    writeFileSync(join(snapshot.root, "hook.py"), "changed while original run is active")
    await expect(
      runHooks([hook], "PreToolUse", {
        sessionId: "thread",
        workspacePath: root,
        toolName: "read_file"
      })
    ).rejects.toThrow("PACKAGE_CHANGED")
    expect(mock.execute).toHaveBeenCalledOnce()
  })
  // Ordinary runs retain their original behavior, even after the opted-in source became invalid.
  await withRuntimePluginSource(undefined, () =>
    runHooks([hook], "PreToolUse", {
      sessionId: "ordinary",
      workspacePath: root,
      toolName: "read_file"
    })
  )
  expect(mock.execute).toHaveBeenCalledTimes(2)
})
