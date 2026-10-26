import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "", skills: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getCustomSkillsDir: () => paths.skills,
  getPlugins: () => [],
  getOpenworkDir: () => tmpdir(),
  getWindowsSandboxMode: () => "none",
  getBuiltinRobotSettings: () => ({ enabled: false }),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../harness-board/service", () => ({
  getHarnessCapabilityWorkspaces: () => [],
  getHarnessCapabilityFeatureWorkspace: () => undefined
}))
vi.mock("../services/adoption-tracker", () => ({
  isCodeFile: () => false, recordGen: vi.fn(), recordShellEdit: vi.fn(),
  recordShellFileOps: vi.fn(), setAdoptionContext: vi.fn()
}))
// This suite uses the real unrestricted shell; unrelated Electron elevated-ACL UI is not loaded.
vi.mock("../ipc/sandbox", () => ({
  areElevatedRootsPreparedAsync: async () => false, isElevatedSetupComplete: () => false,
  markElevatedRootsPrepared: vi.fn(), runElevatedSetupForPaths: vi.fn(),
  normalizeDirKey: (value: string) => value,
  getElevatedSystemSensitivePathError: () => undefined, validateElevatedWorkspaceRoot: vi.fn()
}))
import * as db from "../db"
import { LocalSandbox } from "./local-sandbox"
import { ModsManager, setModsManager } from "../mods/manager"
import { modCallContext } from "../mods/context"
import { withModToolCall } from "../mods/adapters"
import { withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"
import { actualAgentCancelHandler } from "../../../tests/support/agent-cancel-handler"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"

let root = "", manager: ModsManager | undefined, globallyEnabled = true
const threads = new Set<string>()
beforeEach(async () => {
  if (process.platform === "win32") vi.stubEnv("SHELL", "C:/Program Files/Git/bin/bash.exe")
  root = mkdtempSync(join(tmpdir(), "native-background-"))
  paths.database = join(root, "actual.sqlite")
  paths.skills = join(root, "skills")
  mkdirSync(paths.skills)
  await db.initializeDatabase()
  globallyEnabled = true
  manager = new ModsManager(join(root, "mods.sqlite"), () => [], async () => true, () => {},
    undefined, undefined, () => globallyEnabled)
  setModsManager(manager)
})
afterEach(async () => {
  for (const thread of threads) await LocalSandbox.cancelBackgroundTasksAndWait(thread)
  threads.clear()
  manager?.close()
  setModsManager(undefined)
  await db.closeDatabase()
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function fixture(agentId = "main") {
  const workspace = join(root, randomUUID())
  mkdirSync(workspace)
  const threadId = randomUUID()
  threads.add(threadId)
  if (agentId === "main") db.createThread(threadId, { workspacePath: workspace })
  const scope = { workspace: manager!.workspaceKey(workspace), threadId, agentId }
  const signal = new AbortController()
  const create = (turnId: string) => {
    const instance = manager!.createRuntimeAuthority({ ...scope, turnId, signal: signal.signal })
    const sandbox = new LocalSandbox({ rootDir: workspace, runId: threadId, agentId,
      modWorkspace: scope.workspace, modRuntimeAuthority: instance.authority,
      abortSignal: signal.signal, hookTurnId: turnId, windowsSandbox: "none" })
    return { instance, sandbox, binding: { ...scope, turnId, runtimeAuthority: instance.authority,
      signal: signal.signal } }
  }
  manager!.configure(workspace, true, false)
  const ready = join(workspace, "ready.json"), release = join(workspace, "release")
  const script = join(workspace, "business.mjs")
  writeFileSync(script, `import fs from 'node:fs';
const [ready,release]=process.argv.slice(2);
fs.writeFileSync(ready,JSON.stringify({pid:process.pid}));
const timer=setInterval(()=>{if(fs.existsSync(release)){
 clearInterval(timer);process.stdout.write('native-business-complete');
}},40);
`)
  const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
  const command = `${quote(process.execPath)} ${quote(script)} ${quote(ready)} ${quote(release)}`
  const first = create("first")
  const mint = vi.spyOn(manager!, "registerNativeBackground")
  const start = async () => {
    const priorMints = mint.mock.calls.length
    // Deliberately omit cwd: the ordinary tool's final approval normalizes it before handoff.
    const started = await withModToolCall(first.binding, { toolCall: { id: randomUUID(),
      name: "execute", args: { command, run_in_background: true } } }, new Set(),
      () => first.sandbox.executeBackground(command))
    if (typeof started !== "string") throw Error("Expected original native task receipt")
    expect(mint).toHaveBeenCalledTimes(priorMints + 1)
    const taskId = started.match(/id:\s*([a-f0-9]+)/i)?.[1]
    expect(taskId).toBeTruthy()
    await vi.waitUntil(() => {
      const result = first.sandbox.getTaskOutput(taskId!)
      if (!result) throw Error("Native background task receipt disappeared before ready")
      if (result.completed && !existsSync(ready))
        throw Error(`Native background task ended before ready: ${JSON.stringify(result)}`)
      return existsSync(ready)
    }, { timeout: 10000 })
    const pid = JSON.parse(readFileSync(ready, "utf8")).pid as number
    expect(alive(pid)).toBe(true)
    return { taskId: taskId!, pid }
  }
  return { ...scope, workspace, signal, create, first, command, start, release }
}

it("keeps the actual approved native PID across runtime replacement and retrieves its original result", async () => {
  const f = fixture(), task = await f.start()
  f.first.instance.release()
  f.first.instance.release()
  const next = f.create("next")
  await delay(250)
  expect(alive(task.pid)).toBe(true)
  expect(next.sandbox.getTaskOutput(task.taskId)).toMatchObject({ completed: false })
  writeFileSync(f.release, "go")
  await vi.waitFor(() => expect(next.sandbox.getTaskOutput(task.taskId)).toMatchObject({
    completed: true, exitCode: 0, output: "native-business-complete"
  }), { timeout: 10000 })
  await vi.waitFor(() => expect(alive(task.pid)).toBe(false), { timeout: 10000 })
  next.instance.release()
})

it("the original native Stop IPC drains only its idle thread's actual process", async () => {
  const f = fixture(), task = await f.start()
  f.first.instance.release()
  const foreign = fixture(), other = await foreign.start()
  foreign.first.instance.release()
  const cancelled = vi.fn()
  const handler = actualAgentCancelHandler({
    withThreadRunMutationLock, getLocalThreadRunLease: () => undefined,
    activeRuns: new Map(), turnStates: new Map(),
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
    sendDesktopForeignOwnerBusy: vi.fn(), coordinatorWorkerManager: {},
    sendCoordinatorWorkers: vi.fn(), LocalSandbox,
    flushPendingStreamTranscriptMessages: vi.fn(), handleAutoModeAgentCancelled: cancelled, console
  })
  await expect(handler({ sender: {} }, { threadId: f.threadId })).resolves.toBe(true)
  expect(alive(task.pid)).toBe(false)
  expect(LocalSandbox.hasActiveBackgroundTasks(f.threadId)).toBe(false)
  expect(alive(other.pid)).toBe(true)
  expect(cancelled).toHaveBeenCalledExactlyOnceWith(f.threadId)
  await expect(handler({ sender: {} }, { threadId: f.threadId })).resolves.toBe(false)
  expect(alive(other.pid)).toBe(true)
})

it.each(["stop", "settings", "global-master", "manager-close", "thread-recreate", "workspace-change"])(
  "terminates the real native process on %s after the old turn has retired", async scenario => {
    const f = fixture(), task = await f.start()
    f.first.instance.release()
    f.create("next")
    if (scenario === "stop") await LocalSandbox.cancelBackgroundTasksAndWait(f.threadId)
    if (scenario === "settings") manager!.configure(f.workspace, false, false)
    if (scenario === "global-master") globallyEnabled = false
    if (scenario === "manager-close") { manager!.close(); manager = undefined; setModsManager(undefined) }
    if (scenario === "thread-recreate") {
      db.deleteThread(f.threadId)
      db.createThread(f.threadId, { workspacePath: f.workspace })
    }
    if (scenario === "workspace-change") {
      const replacement = join(root, randomUUID())
      mkdirSync(replacement)
      db.updateThread(f.threadId, { metadata: JSON.stringify({ workspacePath: replacement }) })
    }
    await vi.waitFor(() => expect(alive(task.pid)).toBe(false), { timeout: 10000 })
    await vi.waitFor(() => expect(f.first.sandbox.getTaskOutput(task.taskId))
      .toMatchObject({ completed: true, exitCode: 130 }), { timeout: 10000 })
  }
)

it("retains exact source revocation without extending the original source token", async () => {
  const f = fixture()
  let current = true
  const token = issueRuntimePluginSourceToken({ mode: "host", threadId: f.threadId,
    projectId: "project", operationId: "operation", stageId: "stage", workspace: f.workspace,
    incarnationKey: "incarnation", packageDigest: "a".repeat(64),
    plugin: { id: "source", name: "source", path: f.workspace, version: "1", description: "",
      author: "", enabled: true, skillCount: 0, mcpServerCount: 0, hookCount: 0,
      createdAt: "", updatedAt: "" }
  }, undefined, () => { if (!current) throw Error("SOURCE_REVOKED") })
  const task = await withRuntimePluginSource(token, f.start)
  f.first.instance.release()
  f.create("next")
  expect(alive(task.pid)).toBe(true)
  current = false
  await vi.waitFor(() => expect(alive(task.pid)).toBe(false), { timeout: 10000 })
})

it("does not transfer a real child job out of its original short runtime owner", async () => {
  const f = fixture("actual-child"), task = await f.start()
  expect(db.getThreadCore(f.threadId)).toBeNull()
  f.signal.abort()
  await vi.waitFor(() => expect(alive(task.pid)).toBe(false), { timeout: 10000 })
  await vi.waitFor(() => expect(f.first.sandbox.getTaskOutput(task.taskId))
    .toMatchObject({ completed: true, exitCode: 130 }), { timeout: 10000 })
})

it("rejects a replaced captured directory and releases its native owner idempotently", async () => {
  const f = fixture()
  const owner = await modCallContext.run({
    identity: { callId: "native", threadId: f.threadId, turnId: "first", agentId: "main",
      workspace: manager!.workspaceKey(f.workspace), origin: "model", grantEpoch: 0 },
    runtimeAuthority: f.first.instance.authority, toolId: "host:execute", routeClaimed: false,
    effectiveArgs: { command: f.command, cwd: f.workspace }, protectedOutput: false, readOnly: false
  }, () => manager!.registerNativeBackground({ command: f.command, cwd: f.workspace },
    new AbortController().signal))
  expect(owner).toBeDefined()
  // Windows locks a running process's cwd, so replacement is tested before any process owns it.
  renameSync(f.workspace, `${f.workspace}-retired`)
  mkdirSync(f.workspace)
  expect(() => owner!.assertLive()).toThrow("MODS_CALL_SCOPE_CHANGED")
  await vi.waitFor(() => expect(owner!.signal.aborted).toBe(true))
  owner!.release()
  owner!.release()
})

it("rejects the original input authorizer before handing off or spawning the native command", async () => {
  const f = fixture()
  const authorize = vi.fn(async () => { throw Error("NATIVE_DENIED") })
  await expect(modCallContext.run({
    identity: { callId: "denied-native", threadId: f.threadId, turnId: "first", agentId: "main",
      workspace: manager!.workspaceKey(f.workspace), origin: "model", grantEpoch: 0 },
    runtimeAuthority: f.first.instance.authority, toolId: "host:execute", routeClaimed: false,
    protectedOutput: false, readOnly: false, authorize
  }, () => LocalSandbox.prototype.executeBackground.call(f.first.sandbox, f.command)))
    .rejects.toThrow()
  expect(authorize).toHaveBeenCalledOnce()
  expect(existsSync(join(f.workspace, "ready.json"))).toBe(false)
  expect(LocalSandbox.hasActiveBackgroundTasks(f.threadId)).toBe(false)
})

it("does not mint before final native input admission or for a changed command", async () => {
  const f = fixture()
  const context = { identity: { callId: "native", threadId: f.threadId, turnId: "first",
    agentId: "main", workspace: manager!.workspaceKey(f.workspace), origin: "model" as const, grantEpoch: 0 },
    runtimeAuthority: f.first.instance.authority, toolId: "host:execute", routeClaimed: false,
    protectedOutput: false, readOnly: false }
  expect(() => modCallContext.run(context, () => manager!.registerNativeBackground(
    { command: f.command, cwd: f.workspace }, new AbortController().signal
  ))).toThrow("MODS_BACKGROUND_OWNER_REQUIRED")
  expect(() => modCallContext.run({ ...context, effectiveArgs: { command: "different", cwd: f.workspace } },
    () => manager!.registerNativeBackground({ command: f.command, cwd: f.workspace },
      new AbortController().signal))).toThrow("MODS_BACKGROUND_OWNER_REQUIRED")
  expect(LocalSandbox.hasActiveBackgroundTasks(f.threadId)).toBe(false)
})
