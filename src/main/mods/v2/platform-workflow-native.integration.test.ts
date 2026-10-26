import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => "native-provider-test",
    getVersion: () => "0.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))

import { workflowRunManager } from "../../agent/workflow/run-manager"
import { validateWorkflowScript } from "../../agent/workflow/script"
import {
  generateWorkflowRunId,
  loadWorkflowRunAsync,
  sha256Hex
} from "../../agent/workflow/run-store"
import { nativePlatformProviders } from "./platform-native-providers"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionPlugin } from "./dispatcher"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

function cleanTestRoot(root: string): void {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("UNSAFE_TEST_CLEANUP")
  rmSync(root, { recursive: true, force: true })
}

it("observes eight real isolated worktrees through the original engine and native capability API", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-platform-"))
  const repo = join(root, "repo")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  git("init", "--initial-branch=main")
  git("config", "user.name", "Native Provider Test")
  git("config", "user.email", "native@example.test")
  writeFileSync(join(repo, "README.md"), "base\n")
  git("add", "README.md")
  git("commit", "-m", "base")
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "data"))
  vi.stubEnv("CMB_WORKFLOW_MAX_CONCURRENCY", "8")
  const threadId = `native-${Date.now()}`,
    runId = generateWorkflowRunId()
  let release!: () => void,
    allStarted!: () => void,
    started = 0
  const finish = new Promise<void>((done) => {
    release = done
  })
  const ready = new Promise<void>((done) => {
    allStarted = done
  })
  const caller: FunctionPlugin = {
    name: "progress-reader",
    root: "/reader",
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}")
  }
  const session = new FunctionSession([caller], {
    workspace: repo,
    threadId,
    platformNativeProviders: nativePlatformProviders(async () => false),
    assertLive: () => {},
    publish: async (value) => value
  })
  const signal = new AbortController().signal
  const query = {
    ref: { provider: "native.workflow", id: "runs", version: "1.0.0" },
    target: { kind: "current" }
  }
  const call = (method: string, input: unknown) =>
    session.platform.call(
      caller,
      method,
      [input as import("../../../shared/mods/types").ModJson],
      signal
    )
  try {
    const subscription = (await call("platform.subscribe", query)) as {
      subscriptionId: string
      revision: number
    }
    const script = `export const meta={name:"eight-real-worktrees",description:"native observation"}
      return await Promise.all(Array.from({length:8},(_,i)=>agent("task "+i,{label:"task-"+i,isolation:"worktree"})))`
    await workflowRunManager.prepareLaunch(repo, threadId)
    const launch = workflowRunManager.launch({
      threadId,
      workspacePath: repo,
      runId,
      parsed: validateWorkflowScript(script),
      script,
      scriptSha256: sha256Hex(script),
      subagentDeps: {
        parentThreadId: threadId,
        cleanupThread: async () => {},
        isRetryableApiError: () => false,
        createRuntime: async (options) => ({
          stream: async () =>
            (async function* () {
              expect(options.worktreeIsolation).toBeDefined()
              writeFileSync(
                join(options.worktreeIsolation!.workspaceRoot, "actual-change.txt"),
                "done\n"
              )
              if (++started === 8) allStarted()
              await finish
              yield ["values", { messages: [new AIMessage("implemented")] }]
            })()
        })
      }
    })
    expect(await launch.whenInitialPersisted).toBe(true)
    let readyTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        workflowRunManager.waitForRunLifecycle(threadId, runId).then(() => {
          if (started !== 8) throw Error(`Only ${started} worktrees started`)
        }),
        new Promise<never>((_done, reject) => {
          readyTimeout = setTimeout(() => reject(Error("Worktree startup timed out")), 60_000)
        })
      ])
    } finally {
      clearTimeout(readyTimeout)
    }
    const live = (await call("platform.read", query)) as {
      value: {
        activeRunId: string
        run: {
          agents: Array<{ index: number }>
          worktrees: Array<{ agentIndex: number; directory: string }>
        }
      }
    }
    expect(live.value.activeRunId).toBe(runId)
    expect(live.value.run.agents).toHaveLength(8)
    expect(live.value.run.worktrees).toHaveLength(8)
    expect(new Set(live.value.run.worktrees.map((tree) => tree.agentIndex))).toEqual(
      new Set(live.value.run.agents.map((agent) => agent.index))
    )
    expect(
      live.value.run.worktrees.every((tree) =>
        existsSync(join(tree.directory, "actual-change.txt"))
      )
    ).toBe(true)
    expect(JSON.stringify(live)).not.toContain("promptPreview")
    expect(JSON.stringify(live)).not.toContain("journal")
    release()
    await workflowRunManager.waitForRunLifecycle(threadId, runId)
    const original = await loadWorkflowRunAsync(repo, threadId, runId)
    expect(original?.status).toBe("completed")
    expect(original?.worktrees).toHaveLength(8)
    expect(original?.worktrees?.map((tree) => tree.agentIndex).sort()).toEqual(
      original?.agents.map((agent) => agent.index).sort()
    )
    const terminal = await call("platform.read", query)
    expect(terminal).toMatchObject({ value: { activeRunId: null, run: { status: "completed" } } })
    const events = (await call("platform.poll", {
      subscriptionId: subscription.subscriptionId,
      afterRevision: subscription.revision
    })) as { revision: number }
    expect(events.revision).toBeGreaterThan(subscription.revision)
    await call("platform.unsubscribe", { subscriptionId: subscription.subscriptionId })
    expect(session.platform.diagnostics().subscriptions).toBe(0)
  } finally {
    release()
    if (workflowRunManager.isActive(threadId)) {
      workflowRunManager.cancel(threadId, runId)
      await workflowRunManager.waitForRunLifecycle(threadId, runId)
    }
    await session.close(true)
    vi.unstubAllEnvs()
    cleanTestRoot(root)
  }
}, 120_000)

it("notifies a native subscriber after a user-cancelled run actually leaves its lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-cancel-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "data"))
  const threadId = `cancel-${Date.now()}`,
    runId = generateWorkflowRunId()
  const provider = nativePlatformProviders(async () => true).find(
    candidate => candidate.provider === "native.workflow" && candidate.descriptor.id === "runs"
  )
  if (!provider?.watch) throw Error("NATIVE_WORKFLOW_WATCH_REQUIRED")
  let ready!: () => void, observed!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const settledEvent = new Promise<void>((resolve) => {
    observed = resolve
  })
  const controller = new AbortController()
  const context: NativePlatformCallContext = {
    workspace: root,
    threadId,
    incarnation: "test",
    generation: "test",
    caller: { provider: "reader", name: "reader", digest: "reader", generation: "test" },
    signal: controller.signal,
    assertCurrent() {
      /* This fixture exercises the original native lifecycle. */
    },
    publish(value) {
      if (value && typeof value === "object" && !Array.isArray(value) &&
        value.activeRunId === null && value.run) observed()
    },
    invoke: async () => {
      throw Error("not used")
    }
  }
  const stop = provider.watch(context)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await workflowRunManager.prepareLaunch(root, threadId)
    const script =
      'export const meta={name:"cancel-observer",description:"actual cancel"}; return await agent("wait")'
    const launch = workflowRunManager.launch({
      workspacePath: root,
      threadId,
      runId,
      script,
      parsed: validateWorkflowScript(script),
      scriptSha256: sha256Hex(script),
      subagentDeps: {
        parentThreadId: threadId,
        cleanupThread: async () => {},
        isRetryableApiError: () => false,
        createRuntime: async (options) => ({
          stream: async () =>
            (async function* () {
              ready()
              yield ["values", { messages: [] }]
              await new Promise<void>((resolve) => {
                if (options.abortSignal?.aborted) resolve()
                else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
              })
              throw Error("aborted")
            })()
        })
      }
    })
    expect(await launch.whenInitialPersisted).toBe(true)
    await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error("Cancellation startup timed out")), 15000)
      })
    ])
    clearTimeout(timeout)
    expect(await provider.act(context, "cancel", { runId })).toMatchObject({
      requested: true,
      cleanupSettled: true
    })
    await Promise.race([
      settledEvent,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error("Missing final lifecycle observation")), 5000)
      })
    ])
    expect(workflowRunManager.isActive(threadId)).toBe(false)
  } finally {
    clearTimeout(timeout)
    stop()
    controller.abort()
    if (workflowRunManager.isActive(threadId)) {
      workflowRunManager.cancel(threadId, runId)
      await workflowRunManager.waitForRunLifecycle(threadId, runId)
    }
    vi.unstubAllEnvs()
    cleanTestRoot(root)
  }
}, 30000)
