import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginMetadata, PluginHookMetadata } from "../types"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import {
  registerStageCheckReceiptSink,
  registerStageCheckReceiptObserver,
  prepareStageCheckReceipts
} from "./stage-check-receipts"
import type { HookResult } from "./types"
import { STAGE_CHECK_RECEIPT_PREFIX } from "../../shared/project-runtime/stage-check-receipt"
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { runHooks } from "./runner"
const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)

it("admits only main-registered exact receipt observers and isolates observation failures", async () => {
  const plugin = { id: "plugin", path: "C:/retained" } as PluginMetadata
  const binding = { mode: "legacy" as const, threadId: "thread", incarnationKey: "incarnation",
    projectId: "creator-business-trial:owned", operationId: "trial", workspace: "C:/trial",
    packageDigest: "a".repeat(64), stageId: "review", plugin }
  const hook = { id: "original", event: "PreToolUse", type: "command", enabled: true,
    pluginId: plugin.id, hookSourceRoot: plugin.path } as PluginHookMetadata
  const receipt = { apiVersion: "devclaw.stage-check/v1", nodeId: "review", checkId: "postcheck",
    contractDigest: "b".repeat(64), outcome: "passed", artifacts: [] }
  const result = () => ({ stdout: STAGE_CHECK_RECEIPT_PREFIX +
    Buffer.from(JSON.stringify(receipt)).toString("base64") } as HookResult)
  const context = { sessionId: "thread", workspacePath: "C:/trial" }
  const observe = vi.fn(async () => { throw Error("readback unavailable") })
  const failed = vi.fn()
  const token = issueRuntimePluginSourceToken(binding)
  await withRuntimePluginSource(token, async () => {
    expect(prepareStageCheckReceipts(hook, context, result())).toBeUndefined()
    cleanup.push(registerStageCheckReceiptObserver({
      available: current => current.projectId === binding.projectId &&
        current.packageDigest === binding.packageDigest,
      observe, failed
    }))
    await expect(prepareStageCheckReceipts(hook, context, result())!()).resolves.toBeUndefined()
    expect(observe).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledTimes(1)
    const malformed = { stdout: STAGE_CHECK_RECEIPT_PREFIX + "invalid" } as HookResult
    await expect(prepareStageCheckReceipts(hook, context, malformed)!()).resolves.toBeUndefined()
    expect(failed).toHaveBeenCalledTimes(2)
  })
})

it.each(["mandatory-rejects", "observer-rejects"])(
  "preserves original composition decisions when %s", async mode => {
  const plugin = { id: "plugin", path: "C:/retained" } as PluginMetadata
  const observe = vi.fn(async () => {
    if (mode === "observer-rejects") throw Error("optional readback failed")
  })
  cleanup.push(registerStageCheckReceiptObserver({ available: () => true, observe }))
  cleanup.push(registerStageCheckReceiptSink(async () => {
    if (mode === "mandatory-rejects") throw Error("mandatory rejection")
  }))
  const token = issueRuntimePluginSourceToken({ threadId: "thread", incarnationKey: "incarnation",
    projectId: "composition-legacy:run:unit", operationId: "run", workspace: "C:/trial",
    packageDigest: "a".repeat(64), stageId: "review", plugin })
  await withRuntimePluginSource(token, async () => {
    const hook = { id: "original", type: "command", event: "PreToolUse", pluginId: plugin.id,
      hookSourceRoot: plugin.path } as PluginHookMetadata
    const result = { stdout: STAGE_CHECK_RECEIPT_PREFIX + Buffer.from(JSON.stringify({
      apiVersion: "devclaw.stage-check/v1", nodeId: "review", checkId: "postcheck",
      contractDigest: "b".repeat(64), outcome: "passed", artifacts: []
    })).toString("base64") } as HookResult
    const commit = prepareStageCheckReceipts(hook,
      { sessionId: "thread", workspacePath: "C:/trial" }, result)!
    if (mode === "mandatory-rejects") {
      await expect(commit()).rejects.toThrow("mandatory rejection")
      expect(observe).not.toHaveBeenCalled()
    } else {
      await expect(commit()).resolves.toBeUndefined()
      expect(observe).toHaveBeenCalledTimes(1)
    }
  })
})
it.each(["success", "block", "halt", "exit", "forced", "cancel"])(
  "only commits genuine successful command receipts after original %s decision",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "receipt-hook-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, "plugin"))
    const plugin = { id: "plugin", path: join(root, "plugin") } as PluginMetadata
    const receipt = {
      apiVersion: "devclaw.stage-check/v1",
      nodeId: "review",
      checkId: "postcheck",
      contractDigest: "a".repeat(64),
      outcome: "passed",
      artifacts: [{ id: "report", path: "report.md", digest: "b".repeat(64) }]
    }
    const stdout =
      STAGE_CHECK_RECEIPT_PREFIX +
      Buffer.from(JSON.stringify(receipt)).toString("base64") +
      "\n" +
      JSON.stringify(
        mode === "block"
          ? { decision: "block", reason: "original block" }
          : mode === "halt"
            ? { continue: false, stopReason: "original halt" }
            : { decision: "approve" }
      )
    const script = join(plugin.path, "check.cjs")
    writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${mode === "exit" ? 1 : 0}`
    )
    const sink = vi.fn(async () => undefined)
    cleanup.push(registerStageCheckReceiptSink(sink))
    const token = issueRuntimePluginSourceToken({
      threadId: "thread",
      incarnationKey: "incarnation",
      projectId: "composition-legacy:run:unit",
      operationId: "run",
      workspace: root,
      packageDigest: "c".repeat(64),
      stageId: "review",
      plugin
    })
    const controller = new AbortController()
    if (mode === "cancel") controller.abort()
    const hook = {
      id: "original-check",
      event: "PreToolUse",
      type: "command",
      command: `"${process.execPath}" "${script}"`,
      pluginId: plugin.id,
      hookSourceRoot: plugin.path,
      enabled: true,
      createdAt: "",
      updatedAt: "",
      ...(mode === "forced" ? { forcedOutcome: "always-halt" } : {})
    } as PluginHookMetadata
    const task = withRuntimePluginSource(token, () =>
      runHooks([hook], "PreToolUse", {
        sessionId: "thread",
        workspacePath: root,
        toolName: "read_file",
        signal: controller.signal
      })
    )
    if (mode === "cancel") await expect(task).rejects.toThrow()
    else {
      const result = await task
      if (mode === "block") expect(result?.blocked).toBe(true)
      if (mode === "halt") expect(result?.continue).toBe(false)
    }
    expect(sink).toHaveBeenCalledTimes(mode === "success" ? 1 : 0)
  }
)

it.each([undefined, "legacy", "host"] as const)(
  "original Hook Python environment is scoped to %s runtime",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "retained-hook-env-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const output = join(root, "env.json")
    const script = join(root, "check.cjs")
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({value:process.env.PYTHONDONTWRITEBYTECODE ?? null}))`
    )
    const plugin = { id: "plugin", path: root } as PluginMetadata
    const token =
      mode === undefined
        ? undefined
        : issueRuntimePluginSourceToken({
            mode,
            threadId: "thread",
            incarnationKey: "incarnation",
            projectId: "composition-legacy:run:unit",
            operationId: "run",
            workspace: root,
            packageDigest: "c".repeat(64),
            stageId: "review",
            plugin
          })
    await withRuntimePluginSource(token, () =>
      runHooks(
        [
          {
            id: "original-env",
            event: "PreToolUse",
            type: "command",
            command: `"${process.execPath}" "${script}"`,
            pluginId: "plugin",
            hookSourceRoot: root,
            enabled: true,
            createdAt: "",
            updatedAt: ""
          } as PluginHookMetadata
        ],
        "PreToolUse",
        { sessionId: "thread", workspacePath: root, toolName: "read_file" }
      )
    )
    expect(JSON.parse(readFileSync(output, "utf8")).value).toBe(
      mode === "legacy" ? "1" : (process.env.PYTHONDONTWRITEBYTECODE ?? null)
    )
  }
)
