import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it, vi } from "vitest"
import ts from "typescript"
import {
  configureAgentToolStrategy,
  getAgentToolStrategy,
  isAgentToolStrategy
} from "./agent-runtime-limits"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const sourceBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe("agent runtime settings integration", () => {
  const mainProcess = readRepositoryFile("src/main/index.ts")
  const storage = readRepositoryFile("src/main/storage.ts")
  const preload = readRepositoryFile("src/preload/index.ts")
  const preloadTypes = readRepositoryFile("src/preload/index.d.ts")
  const generalPanel = readRepositoryFile("src/renderer/src/components/customize/GeneralPanel.tsx")
  const customizeView = readRepositoryFile(
    "src/renderer/src/components/customize/CustomizeView.tsx"
  )

  it.each([
    ["Warning", "CMB_AGENT_FAILURE_FUSE_WARN"],
    ["ModelFeedback", "CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK"],
    ["Debug", "CMB_AGENT_FAIL_FAST"]
  ])(
    "waits for failure %s publication and permits retry after a failed acknowledgement",
    async (suffix, variable) => {
      const sandbox = readRepositoryFile("src/main/ipc/sandbox.ts")
      const registration = sourceBetween(
        sandbox,
        'ipcMain.handle("sandbox:setFailureFuseWarning"',
        'ipcMain.handle("sandbox:getPendingApprovals"'
      )
      const handlers = new Map<string, (event: unknown, input: unknown) => Promise<void>>()
      const env: Record<string, string> = {}
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const publish = vi.fn(() => blocked)
      const notify = vi.fn()
      new Function(
        "ipcMain",
        "process",
        "publishExecutionSettings",
        "notifyChanged",
        ts.transpile(registration, { target: ts.ScriptTarget.ES2022 })
      )(
        {
          handle: (name: string, handler: (event: unknown, input: unknown) => Promise<void>) =>
            handlers.set(name, handler)
        },
        { env },
        publish,
        notify
      )
      const handler = handlers.get(`sandbox:setFailureFuse${suffix}`)!
      await expect(handler({}, "true")).rejects.toThrow("Invalid")
      expect(env).toEqual({})
      expect(publish).not.toHaveBeenCalled()
      let acknowledged = false
      const pending = handler({}, true).then(() => {
        acknowledged = true
      })
      await Promise.resolve()
      expect(env[variable]).toBe("1")
      expect(publish).toHaveBeenCalledOnce()
      expect(acknowledged).toBe(false)
      expect(notify).not.toHaveBeenCalled()
      release()
      await pending
      expect(notify).toHaveBeenCalledOnce()
      publish.mockRejectedValueOnce(new Error("publication failed"))
      await expect(handler({}, false)).rejects.toThrow("publication failed")
      expect(env[variable]).toBe(suffix === "Warning" ? "0" : undefined)
      expect(notify).toHaveBeenCalledOnce()
      await handler({}, false)
      expect(publish).toHaveBeenCalledTimes(3)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(mainProcess).toContain(
        "registerSandboxHandlers(ipcMain, syncActiveBotExecutionSettings)"
      )
    }
  )

  it("acknowledges a runtime limit only after Bot publication and rejects an unauthorized window", async () => {
    const registration = sourceBetween(
      mainProcess,
      "ipcMain.handle(\n      AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL,",
      "ipcMain.handle(\n      WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL,"
    )
    let handler!: (
      event: { sender: { id: number } },
      value: unknown
    ) => Promise<{ recursionLimit: number }>
    let current = 2000,
      saved = 2000,
      publications = 0
    let publicationFailure = false
    let publish!: () => void
    const pending = new Promise<void>((done) => {
      publish = done
    })
    new Function(
      "ipcMain",
      "AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL",
      "mainWindow",
      "isAgentGraphRecursionLimit",
      "setStoredAgentGraphRecursionLimit",
      "configureAgentGraphRecursionLimit",
      "getAgentGraphRecursionLimit",
      "getAgentToolStrategy",
      "getWorkflowWorktreeTimeoutMinutes",
      "getWorkflowWorktreeRemoveTimeoutMinutes",
      "syncActiveBotExecutionSettings",
      ts.transpile(registration, { target: ts.ScriptTarget.ES2022 })
    )(
      {
        handle: (_channel: string, fn: typeof handler) => {
          handler = fn
        }
      },
      "set-limit",
      { isDestroyed: () => false, webContents: { id: 7 } },
      (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 25 && value <= 100000,
      (value: number) => {
        saved = value
        return value
      },
      (value: number) => {
        current = value
        return value
      },
      () => current,
      () => "standard",
      () => 3,
      () => 1,
      () => {
        publications++
        if (publicationFailure) throw new Error("publication failed")
        return pending
      }
    )
    await expect(handler({ sender: { id: 8 } }, 25)).rejects.toThrow("main window")
    await expect(handler({ sender: { id: 7 } }, -1)).rejects.toThrow("integer")
    expect(saved).toBe(2000)
    expect(publications).toBe(0)
    let acknowledged = false
    const result = handler({ sender: { id: 7 } }, 25).then((settings) => {
      acknowledged = true
      return settings
    })
    await Promise.resolve()
    expect(saved).toBe(25)
    expect(current).toBe(25)
    expect(publications).toBe(1)
    expect(acknowledged).toBe(false)
    publish()
    expect((await result).recursionLimit).toBe(25)
    publicationFailure = true
    await expect(handler({ sender: { id: 7 } }, 50)).rejects.toThrow("publication failed")
    // The local setting may be durable even when detached publication failed.
    // Repeating the same requested value must retry publication before success.
    expect(saved).toBe(50)
    expect(current).toBe(50)
    publicationFailure = false
    expect((await handler({ sender: { id: 7 } }, 50)).recursionLimit).toBe(50)
    expect(publications).toBe(3)
  })

  it("validates the tool-strategy IPC handler and waits for Bot publication", async () => {
    const registration = sourceBetween(
      mainProcess,
      "ipcMain.handle(\n      AGENT_TOOL_STRATEGY_SET_CHANNEL,",
      "ipcMain.on(CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL"
    )
    let handler: (event: { sender: { id: number } }, value: unknown) => Promise<unknown>
    let persisted: unknown
    let publish!: () => void
    let publications = 0
    const publication = new Promise<void>((done) => {
      publish = done
    })
    const compiled = ts.transpile(registration, { target: ts.ScriptTarget.ES2022 })
    new Function(
      "ipcMain",
      "AGENT_TOOL_STRATEGY_SET_CHANNEL",
      "mainWindow",
      "isAgentToolStrategy",
      "setStoredAgentToolStrategy",
      "configureAgentToolStrategy",
      "getAgentToolStrategy",
      "getAgentGraphRecursionLimit",
      "getWorkflowWorktreeTimeoutMinutes",
      "getWorkflowWorktreeRemoveTimeoutMinutes",
      "syncActiveBotExecutionSettings",
      compiled
    )(
      {
        handle: (_channel: string, fn: typeof handler) => {
          handler = fn
        }
      },
      "app:set-agent-tool-strategy",
      { isDestroyed: () => false, webContents: { id: 7 } },
      isAgentToolStrategy,
      (value: unknown) => {
        persisted = value
        return value
      },
      configureAgentToolStrategy,
      getAgentToolStrategy,
      () => 2000,
      () => 3,
      () => 1,
      () => {
        publications++
        return publication
      }
    )
    try {
      await expect(handler!({ sender: { id: 8 } }, "shell-first")).rejects.toThrow("main window")
      await expect(handler!({ sender: { id: 7 } }, "bogus")).rejects.toThrow("Invalid")
      expect(persisted).toBeUndefined()
      expect(getAgentToolStrategy()).toBe("standard")
      expect(publications).toBe(0)
      let acknowledged = false
      const pending = handler!({ sender: { id: 7 } }, "shell-first").then((value) => {
        acknowledged = true
        return value
      })
      await Promise.resolve()
      expect(publications).toBe(1)
      expect(acknowledged).toBe(false)
      publish()
      expect(await pending).toEqual({
        toolStrategy: "shell-first",
        recursionLimit: 2000,
        workflowWorktreeTimeoutMinutes: 3,
        workflowWorktreeRemoveTimeoutMinutes: 1
      })
      expect(persisted).toBe("shell-first")
      expect(getAgentToolStrategy()).toBe("shell-first")
    } finally {
      configureAgentToolStrategy("standard")
    }
    const runtimeHandlers = sourceBetween(
      mainProcess,
      "ipcMain.handle(AGENT_RUNTIME_SETTINGS_GET_CHANNEL",
      "ipcMain.on(CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL"
    )
    expect(runtimeHandlers.match(/toolStrategy: getAgentToolStrategy\(\)/g)).toHaveLength(5)
    expect(preload).toContain("setAgentToolStrategy: (value: AgentToolStrategy)")
    expect(preloadTypes).toContain("setAgentToolStrategy: (value: AgentToolStrategy)")
    expect(generalPanel).toContain("下次运行生效，当前任务不受影响")
    expect(generalPanel.indexOf("await window.electron.setAgentToolStrategy(value)")).toBeLessThan(
      generalPanel.indexOf("setToolStrategy(settings.toolStrategy)")
    )
  })

  it.each([
    {
      channel: "WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL",
      next: "WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL",
      suffix: "WorkflowWorktreeTimeoutMinutes",
      field: "workflowWorktreeTimeoutMinutes",
      initial: 3,
      value: 17,
      max: 120
    },
    {
      channel: "WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL",
      next: "AGENT_TOOL_STRATEGY_SET_CHANNEL",
      suffix: "WorkflowWorktreeRemoveTimeoutMinutes",
      field: "workflowWorktreeRemoveTimeoutMinutes",
      initial: 1,
      value: 4,
      max: 10
    }
  ])(
    "publishes $field before acknowledging the settings save",
    async ({ channel, next, suffix, field, initial, value, max }) => {
      const registration = sourceBetween(
        mainProcess,
        `ipcMain.handle(\n      ${channel},`,
        `ipcMain.handle(\n      ${next},`
      )
      let handler!: (
        event: { sender: { id: number } },
        value: unknown
      ) => Promise<Record<string, unknown>>
      let current = initial,
        publications = 0
      let release!: () => void
      const publishing = new Promise<void>((done) => {
        release = done
      })
      const deps: Record<string, unknown> = {
        ipcMain: {
          handle: (_channel: string, fn: typeof handler) => {
            handler = fn
          }
        },
        [channel]: channel,
        mainWindow: { isDestroyed: () => false, webContents: { id: 7 } },
        [`is${suffix}`]: (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max,
        [`setStored${suffix}`]: (value: number) => value,
        [`configure${suffix}`]: (value: number) => {
          current = value
          return value
        },
        getAgentGraphRecursionLimit: () => 2000,
        getAgentToolStrategy: () => "standard",
        getWorkflowWorktreeTimeoutMinutes: () => 3,
        getWorkflowWorktreeRemoveTimeoutMinutes: () => 1,
        [`get${suffix}`]: () => current,
        syncActiveBotExecutionSettings: () => {
          publications++
          return publishing
        }
      }
      new Function(
        ...Object.keys(deps),
        ts.transpile(registration, { target: ts.ScriptTarget.ES2022 })
      )(...Object.values(deps))
      await expect(handler({ sender: { id: 8 } }, value)).rejects.toThrow("main window")
      await expect(handler({ sender: { id: 7 } }, max + 1)).rejects.toThrow("integer")
      expect(current).toBe(initial)
      expect(publications).toBe(0)
      let acknowledged = false
      const pending = handler({ sender: { id: 7 } }, value).then((result) => {
        acknowledged = true
        return result
      })
      await Promise.resolve()
      expect(acknowledged).toBe(false)
      expect(current).toBe(value)
      expect(publications).toBe(1)
      release()
      expect((await pending)[field]).toBe(value)
    }
  )

  it("validates unknown renderer input before persisting or applying it", () => {
    expect(mainProcess).toContain("async (event, value: unknown): Promise<AgentRuntimeSettings>")
    expect(mainProcess).toContain("if (!isAgentGraphRecursionLimit(value))")
    expect(mainProcess).toContain("if (!isWorkflowWorktreeTimeoutMinutes(value))")
    expect(mainProcess).toContain("if (!isWorkflowWorktreeRemoveTimeoutMinutes(value))")
    expect(mainProcess.indexOf("if (!isAgentGraphRecursionLimit(value))")).toBeLessThan(
      mainProcess.indexOf("setStoredAgentGraphRecursionLimit(value)")
    )
    expect(storage).toContain("if (!isAgentGraphRecursionLimit(value))")
    expect(storage).toContain("if (!isWorkflowWorktreeTimeoutMinutes(value))")
    expect(storage).toContain("if (!isWorkflowWorktreeRemoveTimeoutMinutes(value))")
  })

  it("keeps the renderer bridge narrow and typed", () => {
    expect(preload).toContain("getAgentRuntimeSettings")
    expect(preload).toContain("setAgentRuntimeRecursionLimit")
    expect(preload).toContain("setWorkflowWorktreeTimeoutMinutes")
    expect(preload).toContain("setWorkflowWorktreeRemoveTimeoutMinutes")
    expect(preloadTypes).toContain("getAgentRuntimeSettings: () => Promise<AgentRuntimeSettings>")
    expect(preloadTypes).toContain(
      "setAgentRuntimeRecursionLimit: (value: number) => Promise<AgentRuntimeSettings>"
    )
    expect(preloadTypes).toContain(
      "setWorkflowWorktreeTimeoutMinutes: (value: number) => Promise<AgentRuntimeSettings>"
    )
    expect(preloadTypes).toContain(
      "setWorkflowWorktreeRemoveTimeoutMinutes: (value: number) => Promise<AgentRuntimeSettings>"
    )
  })

  it("exposes the bounded graph-step setting in General settings", () => {
    expect(generalPanel).toContain("单次任务运行上限")
    expect(generalPanel).toContain("isAgentGraphRecursionLimit(value)")
    expect(generalPanel).toContain("任务异常时也可能运行更久")
    expect(generalPanel).toContain("setAgentRuntimeRecursionLimit(value)")
    expect(generalPanel).toContain("Git 操作等待时间")
    expect(generalPanel).toContain("不限制 Agent")
    expect(generalPanel).toContain("setWorkflowWorktreeTimeoutMinutes(value)")
    expect(generalPanel).toContain(">Worktree</h2>")
    expect(generalPanel).toContain("删除等待时间")
    expect(generalPanel).toContain("setWorkflowWorktreeRemoveTimeoutMinutes(value)")
  })

  it("routes scale-sensitive worktree create, merge, and save operations through the configured timeout", () => {
    const worktreeService = readRepositoryFile("src/main/services/git-worktree.ts")
    expect(worktreeService).toContain("getWorkflowWorktreeTimeoutMs()")
    expect(worktreeService).toContain("getWorkflowWorktreeRemoveTimeoutMs()")
    expect(worktreeService).not.toContain("GIT_CREATE_TIMEOUT_MS")
    expect(worktreeService).not.toContain("GIT_REMOVE_TIMEOUT_MS")
    expect(worktreeService).not.toContain("180_000")

    const scaleSensitiveHelpers = [
      [
        "async function assertWorkflowWorktreeDeliverablePathsInScope(",
        "function assertGitPathsInScope("
      ],
      ["async function listChangedGitPaths(", "async function assertNoGitlinkChanges("],
      ["async function assertNoGitlinkChanges(", "function gitPathBatches("],
      ["async function assertNoIgnoredSourceCollisions(", "// ── Per-repository serialization"],
      ["async function inspectWorkspaceStatus(", "interface SourceWorkspaceSnapshot"],
      ["async function inspectSourceWorkspaceForProvisioning(", "/** Resolve a path"],
      ["export async function inspectWorkflowWorktree(", "interface WorkflowWorktreeDiff"]
    ] as const
    for (const [start, end] of scaleSensitiveHelpers) {
      const helper = sourceBetween(worktreeService, start, end)
      expect(helper).toContain("timeoutMs = GIT_QUERY_TIMEOUT_MS")
      expect(helper).toContain("signal?: AbortSignal")
      expect(helper.match(/\btimeoutMs\b/g)?.length ?? 0).toBeGreaterThan(1)
    }

    const provisioning = sourceBetween(
      worktreeService,
      "export async function prepareWorkflowWorktreeSource(",
      "export async function createWorkflowWorktree("
    )
    expect(provisioning).toContain("getWorkflowWorktreeTimeoutMs()")
    expect(provisioning).toContain("signal?: AbortSignal")

    const mergeFinalization = sourceBetween(
      worktreeService,
      "async function finishMergedWorkflowWorktree(",
      "export async function diffWorkflowWorktree("
    )
    expect(mergeFinalization).toContain("operationTimeoutMs: number")
    expect(mergeFinalization).toContain("signal?: AbortSignal")
    expect(mergeFinalization).toMatch(/operationTimeoutMs,\r?\n\s+signal/)

    const merge = sourceBetween(
      worktreeService,
      "export async function mergeWorkflowWorktree(",
      "interface WorktreeListEntry"
    )
    expect(merge).toContain("const operationTimeoutMs = getWorkflowWorktreeTimeoutMs()")
    expect(merge.match(/\boperationTimeoutMs\b/g)?.length ?? 0).toBeGreaterThan(10)
    expect(merge).not.toMatch(/git\(record\.sourceRoot, \["write-tree"\]\)/)
    expect(merge).toMatch(/operationTimeoutMs,\r?\n\s+input\.signal/)

    const runtime = readRepositoryFile("src/main/agent/runtime.ts")
    expect(runtime).toMatch(
      /timeout:\s*managedExecution\s*\?\s*MANAGED_EXECUTE_TIMEOUT_MS\s*:\s*options\.worktreeIsolation\s*\?\s*getWorkflowWorktreeTimeoutMs\(\)\s*:\s*60_000/
    )
  })

  it("opens General by default while preserving explicit deep links", () => {
    expect(customizeView).toContain('(customizeInitialTab as CustomizeTab) || "general"')
    expect(customizeView).toContain('customizeInitialTab === "commitPolicy"')
  })

  it("routes every explicit main, background, workflow, and subagent stream through one getter", () => {
    const runtimeOwners = [
      "src/main/agent/runtime.ts",
      "src/main/agent/workflow/subagent.ts",
      "src/main/ipc/agent.ts",
      "src/main/services/im/remote-runner.ts",
      "src/main/services/heartbeat.ts",
      "src/main/services/scheduler.ts"
    ]

    for (const path of runtimeOwners) {
      const sites = (readRepositoryFile(path).match(/recursionLimit:[^\r\n]*/g) ?? []).map((site) =>
        site.trim().replace(/,$/, "")
      )
      expect(sites.length, `${path}: 找不到 recursionLimit 调用点`).toBeGreaterThan(0)
      // 逐个调用点断言，而不是「文件里存在一处 getter」。agent.ts 有 invoke /
      // resume / interrupt 三处，40faca27 合并时前两处被带回硬编码 1000、第三处
      // 仍是 getter，旧写法的 toContain 照样通过；只禁 2000 字面量也拦不住 1000。
      for (const site of sites) {
        expect(site, path).toBe("recursionLimit: getAgentGraphRecursionLimit()")
      }
    }
  })
})
