import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata, PluginHookMetadata } from "../types"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { modCallContext } from "../mods/context"
import { registerStageCheckReceiptSink } from "./stage-check-receipts"
import { STAGE_CHECK_RECEIPT_PREFIX } from "../../shared/project-runtime/stage-check-receipt"

const held = vi.hoisted(() => ({ preference: vi.fn<() => Promise<void>>() }))
vi.mock("../harness-board/composition-python-cache", async (original) => {
  const actual = await original<typeof import("../harness-board/composition-python-cache")>()
  return {
    suppressCompositionPythonCache: async (root: string) => {
      const value = await actual.suppressCompositionPythonCache(root)
      await held.preference()
      return value
    }
  }
})
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { resetHookOnceStateForTests, runHooks } from "./runner"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  held.preference.mockReset()
  resetHookOnceStateForTests()
})

function fixture(required = false, withRoot = false, stdout = '{"continue":true}', exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "command-source-boundary-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, "source")
  mkdirSync(source)
  writeFileSync(join(source, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(hostProjectFixture(root).manifest)
  )
  writeFileSync(
    join(source, "devclaw.stage-checks.json"),
    JSON.stringify({
      apiVersion: "devclaw.stage-check-adapter/v1",
      adapter: "autobiz-v1"
    })
  )
  writeFileSync(join(source, "rule.txt"), "original required source")
  const snapshots = new HostPackageSnapshots(join(root, "packages")),
    snapshot = snapshots.capture(source)
  const marker = join(root, "process-starts.txt"),
    sessionId = basename(root)
  const script = join(root, "real-hook.cjs")
  writeFileSync(
    script,
    `require("fs").appendFileSync(${JSON.stringify(marker)},"started\\n");` +
      `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exitCode}`
  )
  const plugin: PluginMetadata = {
    id: "installed",
    name: "docs",
    version: "1.0.0",
    enabled: true,
    path: snapshot.root,
    author: "",
    description: "",
    createdAt: "",
    updatedAt: "",
    skillCount: 0,
    hookCount: 1,
    mcpServerCount: 0
  }
  let postCommandObserved = false
  const full = vi.fn(() => {
    snapshots.read(snapshot.digest)
    if (existsSync(marker)) postCommandObserved = true
  })
  const token = issueRuntimePluginSourceToken(
    {
      mode: "legacy",
      threadId: sessionId,
      incarnationKey: "original",
      projectId: "composition-legacy:run:unit",
      operationId: "operation",
      workspace: root,
      packageDigest: snapshot.digest,
      stageId: "gate",
      plugin,
      ...(required ? { requiredHooks: ["gate"] } : {})
    },
    full
  )
  const hook: Omit<PluginHookMetadata, "pluginRoot"> & { pluginRoot?: string } = {
    id: required ? "plugin:installed/gate" : "ordinary",
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginEnabled: true,
    hookPath: "hooks/hooks.json",
    hookSourceType: "plugin",
    hookSourceRoot: snapshot.root,
    pluginRoot: withRoot ? snapshot.root : undefined,
    event: "PreToolUse",
    type: "command",
    command: `"${process.execPath}" "${script}"`,
    once: !required,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }
  const context = { sessionId, workspacePath: root, toolName: "read_file" }
  return {
    root,
    snapshot,
    marker,
    token,
    hook,
    context,
    full,
    postCommandObserved: () => postCommandObserved,
    change: () => writeFileSync(join(snapshot.root, "rule.txt"), "changed source bytes")
  }
}

it.each([false, true])(
  "fences real command spawn and result without an extra metadata-entry full read (root=%s)",
  async (withRoot) => {
    const f = fixture(false, withRoot),
      observed = vi.fn()
    await withRuntimePluginSource(f.token, async () => {
      f.full.mockClear() // The original Legacy source-entry fence remains outside this runner.
      await runHooks([f.hook], "PreToolUse", f.context, observed)
      expect(readFileSync(f.marker, "utf8")).toBe("started\n")
      expect(f.full).toHaveBeenCalledTimes(2) // Actual pre-spawn and post-command publication.
      expect(observed).toHaveBeenCalledOnce()
      await runHooks([f.hook], "PreToolUse", f.context, observed)
      expect(readFileSync(f.marker, "utf8")).toBe("started\n")
      expect(observed).toHaveBeenCalledOnce()
    })
  }
)

it("rejects changed retained bytes after the real preference read/await and before actual spawn", async () => {
  const f = fixture(false, true),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  held.preference.mockImplementation(async () => {
    entered.resolve()
    await release.promise
  })
  await withRuntimePluginSource(f.token, async () => {
    f.full.mockClear()
    const observed = vi.fn(),
      pending = runHooks([f.hook], "PreToolUse", f.context, observed)
    await entered.promise
    expect(f.full).not.toHaveBeenCalled()
    expect(existsSync(f.marker)).toBe(false)
    f.change()
    release.resolve()
    await expect(pending).rejects.toThrow("PACKAGE_CHANGED")
    expect(existsSync(f.marker)).toBe(false)
    expect(observed).not.toHaveBeenCalled()
    writeFileSync(join(f.snapshot.root, "rule.txt"), "original required source")
    held.preference.mockResolvedValue()
    await runHooks([f.hook], "PreToolUse", f.context, observed)
    expect(readFileSync(f.marker, "utf8")).toBe("started\n")
    expect(observed).toHaveBeenCalledOnce() // The failed pre-spawn cannot consume once.
  })
})

it.each([false, true])(
  "rejects already changed command source before a process starts (root=%s)",
  async (withRoot) => {
    const f = fixture(false, withRoot),
      observed = vi.fn()
    await withRuntimePluginSource(f.token, async () => {
      f.change()
      await expect(runHooks([f.hook], "PreToolUse", f.context, observed)).rejects.toThrow(
        "PACKAGE_CHANGED"
      )
      expect(existsSync(f.marker)).toBe(false)
      expect(observed).not.toHaveBeenCalled()
    })
  }
)

it("keeps ordinary nonzero command errors fail-open with fresh pre/post fences", async () => {
  const f = fixture(false, true, "original ordinary failure", 1),
    observed = vi.fn()
  await withRuntimePluginSource(f.token, async () => {
    const result = await runHooks([f.hook], "PreToolUse", f.context, observed)
    expect(result?.blocked).not.toBe(true)
    expect(observed.mock.calls[0][2]).toMatchObject({ exitCode: 1, blocked: false })
    await runHooks([f.hook], "PreToolUse", f.context, observed)
    expect(readFileSync(f.marker, "utf8")).toBe("started\nstarted\n")
  })
})

const receipt =
  STAGE_CHECK_RECEIPT_PREFIX +
  Buffer.from(
    JSON.stringify({
      apiVersion: "devclaw.stage-check/v1",
      nodeId: "gate",
      checkId: "postcheck",
      contractDigest: "a".repeat(64),
      outcome: "passed",
      artifacts: [{ id: "report", path: "report.md", digest: "b".repeat(64) }]
    })
  ).toString("base64") +
  "\n"

it.each(["success", "pre-sink", "in-sink", "cancel", "halt"] as const)(
  "preserves real required command and receipt boundaries without a synchronous duplicate full (%s)",
  async (mode) => {
    const f = fixture(
      true,
      true,
      receipt +
        JSON.stringify(
          mode === "halt" ? { decision: "block", reason: "required halt" } : { decision: "approve" }
        )
    )
    const observed = vi.fn(),
      controller = new AbortController()
    let changed = false
    const sink = vi.fn(async () => {
      if (mode === "in-sink") f.change()
    })
    cleanup.push(registerStageCheckReceiptSink(sink))
    await withRuntimePluginSource(f.token, () =>
      modCallContext.run(
        {
          identity: {
            workspace: f.root,
            threadId: f.context.sessionId,
            turnId: "actual",
            agentId: "main",
            callId: "actual-call",
            origin: "model",
            grantEpoch: 0
          },
          toolId: "read_file",
          signal: controller.signal,
          readOnly: true,
          routeClaimed: false,
          protectedOutput: false,
          assertLive: () => {
            if (changed || !f.postCommandObserved()) return
            if (mode === "pre-sink") {
              changed = true
              f.change()
            }
            if (mode === "cancel") {
              changed = true
              controller.abort(new Error("ACTUAL_CALL_CANCELLED"))
            }
          }
        },
        async () => {
          f.full.mockClear()
          const pending = runHooks(
            [f.hook],
            "PreToolUse",
            { ...f.context, signal: controller.signal },
            observed
          )
          if (mode === "cancel") await expect(pending).rejects.toThrow("ACTUAL_CALL_CANCELLED")
          else {
            const result = await pending
            expect(result?.blocked).toBe(mode !== "success")
          }
          expect(sink).toHaveBeenCalledTimes(mode === "success" || mode === "in-sink" ? 1 : 0)
          expect(readFileSync(f.marker, "utf8")).toBe("started\n")
          if (mode === "success") expect(f.full).toHaveBeenCalledTimes(5)
          if (mode === "halt") expect(f.full).toHaveBeenCalledTimes(2)
          if (mode !== "success")
            expect(observed.mock.calls.some((call) => call[2].decision === "approve")).toBe(false)
        }
      )
    )
  }
)
