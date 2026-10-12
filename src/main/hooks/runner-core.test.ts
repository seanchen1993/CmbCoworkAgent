import { expect, it, vi } from "vitest"
import { build } from "esbuild"
import { runHooksCore } from "./runner-core"
import { withHookRunnerServices, type HookRunnerServices } from "./runner-services"
import type { HookConfig } from "./types"

function hook(): HookConfig {
  return {
    id: "host-adapter",
    event: "PreToolUse",
    enabled: true,
    command: "native-command-must-not-run",
    createdAt: "",
    updatedAt: ""
  }
}
function services(): HookRunnerServices {
  return {
    getHookLoggingConfig: () => ({ enabled: true, diagnostic: false }),
    getUserInfo: () => null,
    getAvailableModelConfigOrDefault: () => null,
    getModelConfigByRef: () => null,
    persistHookResultRecord: vi.fn(),
    trackEvent: vi.fn(),
    forceSynchronous: true,
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  }
}

it.each([
  "src/main/hooks/runner-core.ts",
  "src/main/agent/tool-hooks-core.ts",
  "src/main/hooks/scope-core.ts",
  "src/main/agent/skill-lifecycle/activation-core.ts",
  "src/main/agent/skill-lifecycle/completion-policy.ts"
])("keeps %s free of desktop settings, telemetry and persistent logging imports", async (entry) => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["electron"]
  })
  const dependencies = Object.keys(result.metafile!.inputs)
  expect(
    dependencies.filter((file) =>
      /src\/main\/(?:storage\.ts|models\/registry\.ts|services\/event-reporter\.ts|hooks\/(?:log-record|persistence)\.ts|ipc\/)/.test(
        file
      )
    )
  ).toEqual([])
  expect(
    Object.values(result.metafile!.outputs).flatMap((output) =>
      output.imports.map((item) => item.path)
    )
  ).not.toContain("electron")
})

it("requires a host adapter and preserves blocking decisions from its actual executor output", async () => {
  await expect(runHooksCore([hook()], "PreToolUse", {})).rejects.toThrow("explicit host adapter")
  const port = services()
  port.execute = vi.fn(async ({ payload }) => {
    expect(JSON.parse(payload).tool_name).toBe("project_edit")
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: "Policy denied" }),
      stderr: "",
      blocked: false
    }
  })
  const result = await withHookRunnerServices(port, () =>
    runHooksCore([hook()], "PreToolUse", { toolName: "project_edit" })
  )
  expect(result).toMatchObject({ blocked: true, reason: "Policy denied" })
  expect(port.execute).toHaveBeenCalledTimes(1)
  expect(port.persistHookResultRecord).toHaveBeenCalledTimes(1)
})

it("isolates simultaneous Host service scopes and awaits async-configured hooks when leased", async () => {
  let release!: () => void
  const ready = new Promise<void>((done) => {
    release = done
  })
  const a = services(),
    b = services(),
    records: string[] = []
  a.getHookLoggingConfig = () => ({ enabled: true, diagnostic: true })
  a.execute = async ({ context }) => {
    await ready
    records.push(`a:${context.sessionId}`)
    return {
      exitCode: 0,
      stdout: JSON.stringify({ additionalContext: "A guidance" }),
      stderr: "",
      blocked: false
    }
  }
  b.execute = async ({ context }) => {
    records.push(`b:${context.sessionId}`)
    release()
    return {
      exitCode: 0,
      stdout: JSON.stringify({ additionalContext: "B guidance" }),
      stderr: "",
      blocked: false
    }
  }
  const results = await Promise.all([
    withHookRunnerServices(a, () =>
      runHooksCore([{ ...hook(), async: true }], "PreToolUse", { sessionId: "A" })
    ),
    withHookRunnerServices(b, () =>
      runHooksCore([{ ...hook(), async: true }], "PreToolUse", { sessionId: "B" })
    )
  ])
  expect(records).toEqual(["b:B", "a:A"])
  expect(results.map((result) => result?.additionalContext)).toEqual(["A guidance", "B guidance"])
  expect(vi.mocked(a.persistHookResultRecord).mock.calls[0][2].stdinPayload).toBeDefined()
  expect(vi.mocked(b.persistHookResultRecord).mock.calls[0][2].stdinPayload).toBeUndefined()
  expect(results.every((result) => result?.asyncStatus !== "pending")).toBe(true)
})

it("rejects a late hook result after the Host lease changes", async () => {
  const port = services()
  let checks = 0
  port.assertCurrent = () => {
    if (++checks === 2) throw new Error("lease expired")
  }
  await expect(
    withHookRunnerServices(port, () => runHooksCore([hook()], "PreToolUse", {}))
  ).rejects.toThrow("lease expired")
  expect(port.persistHookResultRecord).not.toHaveBeenCalled()
  expect(port.trackEvent).not.toHaveBeenCalled()
})

it("returns leased failure feedback and stops before dispatching later Hooks", async () => {
  const port = services()
  port.execute = vi.fn(async ({ hook }) => ({
    exitCode: 0,
    stderr: "",
    blocked: false,
    stdout: JSON.stringify(
      hook.id === "feedback"
        ? { additionalContext: "KEEP_THE_FAILURE_EVIDENCE" }
        : { continue: false, stopReason: "STOP_AFTER_FAILURE" }
    )
  }))
  const hooks = ["feedback", "halt", "must-not-execute"].map((id) => ({
    ...hook(),
    id,
    event: "PostToolUseFailure" as const
  }))
  const result = await withHookRunnerServices(port, () =>
    runHooksCore(hooks, "PostToolUseFailure", { toolName: "execute" })
  )
  expect(result).toMatchObject({
    continue: false,
    stopReason: "STOP_AFTER_FAILURE",
    additionalContext: "KEEP_THE_FAILURE_EVIDENCE"
  })
  expect(port.execute).toHaveBeenCalledTimes(2)
})

it.each(["SessionStart", "SessionEnd", "Notification", "Setup"] as const)(
  "awaits every %s handler in a leased Host and propagates cancellation",
  async (event) => {
    const port = services(),
      order: string[] = []
    port.execute = async ({ hook, payload }) => {
      if (event === "Notification")
        expect(JSON.parse(payload)).toMatchObject({ notification_type: "permission_prompt" })
      order.push(`start:${hook.id}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${hook.id}`)
      return { exitCode: 0, stdout: "", stderr: "", blocked: false }
    }
    const hooks = ["a", "b"].map((id) => ({ ...hook(), id, event, async: true }))
    await withHookRunnerServices(port, () =>
      runHooksCore(
        hooks,
        event,
        event === "Notification" ? { notificationType: "permission_prompt" } : {}
      )
    )
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"])
    port.execute = async () => {
      throw new Error("Host cancelled")
    }
    await expect(
      withHookRunnerServices(port, () => runHooksCore(hooks, event, {}))
    ).rejects.toThrow("Host cancelled")
  }
)

it.each(
  [true, false].flatMap((synchronous) =>
    ["stop", "block"].map((decision) => ({ synchronous, decision }))
  )
)(
  "preserves explicit Setup vetoes even when the command exits zero ($synchronous, $decision)",
  async ({ synchronous, decision }) => {
    const port = services()
    port.forceSynchronous = synchronous
    port.execute = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        decision === "stop"
          ? { continue: false, stopReason: "INIT_STOPPED" }
          : { decision: "block", reason: "INIT_BLOCKED" }
      ),
      stderr: "",
      blocked: false
    })
    const result = await withHookRunnerServices(port, () =>
      runHooksCore([{ ...hook(), event: "Setup" }], "Setup", { setupTrigger: "init" })
    )
    expect(result?.blocked).toBe(true)
  }
)
