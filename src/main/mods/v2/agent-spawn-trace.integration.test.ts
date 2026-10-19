import { once } from "node:events"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs")
  const path = process.getBuiltinModule("node:path")
  const root = fs.mkdtempSync(
    path.join(process.getBuiltinModule("node:os").tmpdir(), "sdk-native-trace-")
  )
  const prior = Object.fromEntries(
    ["CMB_COWORK_AGENT_HOME", "CMB_COWORK_TRACES_DIR", "CMB_COWORK_TRACE_STORAGE_MODE"].map(
      (key) => [key, process.env[key]]
    )
  )
  process.env.CMB_COWORK_AGENT_HOME = root
  process.env.CMB_COWORK_TRACES_DIR = path.join(root, "traces")
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  return {
    root,
    prior,
    config: undefined as import("../../models/registry").ResolvedModelConfig | undefined
  }
})
vi.mock("electron", () => ({
  app: {
    getPath: () => fixture.root,
    getAppPath: () => process.cwd(),
    getName: () => "test",
    getVersion: () => "0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  dialog: {},
  safeStorage: {}
}))
vi.mock("../../models/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/registry")>()),
  getModelConfigByRef: () => fixture.config,
  getAvailableModelConfigOrDefault: () => fixture.config
}))
vi.mock("../../services/workspace-probe-worker?nodeWorker", async () => ({
  default: (await import("../../services/workspace-probe.test-helper"))
    .createWorkspaceProbeTestWorker
}))

import { ModsManager, setModsManager } from "../manager"
import {
  readThreadTraces,
  flushTraceWriteQueue,
  setTraceReporter,
  TraceCollector
} from "../../agent/trace/collector"
import { closeWorkspaceProbeWorker } from "../../services/workspace-probe-client"
import { removeWorkspaceProbeTestWorker } from "../../services/workspace-probe.test-helper"
import { initializeDatabase, closeDatabase, createThread, deleteThread, getThreadCore, getDb } from "../../db"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { FunctionConversationCoordinator } from "./conversation-coordinator"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { withFunctionAgentExecution } from "./host-call"
import { bindRuntimeTraceContext } from "../../agent/trace/live-tool-evidence"
import { publicFunctionToolName } from "./tool-sdk"
import { CreatorRequestBudgets, creatorModelSummary } from "../devtools/creator-request-budget"
import {
  bindCreatorModelAccounting,
  issueCreatorModelAccounting
} from "../devtools/creator-model-accounting"

afterAll(async () => {
  setModsManager(undefined)
  await closeWorkspaceProbeWorker()
  await closeDatabase()
  await flushTraceWriteQueue()
  removeWorkspaceProbeTestWorker()
  for (const [key, value] of Object.entries(fixture.prior)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (
    dirname(fixture.root) !== resolve(tmpdir()) ||
    !basename(fixture.root).startsWith("sdk-native-trace-")
  )
    throw Error("Unexpected SDK trace fixture root")
  rmSync(fixture.root, { recursive: true, force: true })
})

it("keeps real Guest peer and completion after parent lease release with child trace and two provider requests", async () => {
  await initializeDatabase()
  const workspace = join(fixture.root, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "proof.txt"), "native-tool-proof")
  const requests: Record<string, unknown>[] = []
  const continueChild = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    requests.push(JSON.parse(text))
    // The captured parent link is history. Its completed collector cannot revoke a lawful child.
    if (requests.length === 1) {
      await parentTracer.finish("success")
      await continueChild.promise
    }
    const delta =
      requests.length === 1
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "native-read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ file_path: join(workspace, "proof.txt") })
                }
              }
            ]
          }
        : { role: "assistant", content: "native-tool-proof received" }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      `data: ${JSON.stringify({ id: `model-${requests.length}`, model: "fixture", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  fixture.config = {
    id: "fixture",
    ref: "custom:fixture",
    source: "custom",
    name: "Fixture",
    model: "fixture",
    apiKey: "fixture-only",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    maxOutputTokens: 128
  }
  const pluginRoot = join(fixture.root, "plugin")
  mkdirSync(join(pluginRoot, "mods"), { recursive: true })
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({ name: "sdk-trace", version: "1.0.0", mods: "mods/manifest.json" })
  )
  writeFileSync(
    join(pluginRoot, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "sdk-trace", entry: "main.ts" })
  )
  writeFileSync(
    join(pluginRoot, "mods/main.ts"),
    `export function register(on){let child;
    on("session.start",async($,e,next)=>{await $.command.register({name:"spawn",description:"Spawn actual child"});
      await $.command.register({name:"send",description:"Send actual peer",immediate:true});
      await $.command.register({name:"inspect",description:"Read actual completion",immediate:true});return next(e)});
    on("command.run",{command:"spawn"},async($)=>{child=await $.agent.spawn({prompt:"Read proof.txt with read_file then report its contents"});
      return {text:JSON.stringify(child)}});
    on("command.run",{command:"send"},async($)=>({text:JSON.stringify(await $.session.send({to:{agentId:child.agentId},text:"NATIVE_PEER_AFTER_PARENT_RELEASE"}))}));
    on("command.run",{command:"inspect"},async($)=>({text:JSON.stringify(await $.store.get("completed"))}));
    on("turn.complete",async($,e,next)=>{await $.store.set("completed",e);return next(e)});
    on("tool.call",async($,e,next)=>{await $.ui.log(JSON.stringify({tool:e.tool,agentId:e.agentId,id:e.tool_use_id}));return next(e)})
  }`
  )
  const plugin = { id: "sdk-trace-uuid", name: "sdk-trace", path: pluginRoot, enabled: true }
  const approvals: unknown[] = []
  const manager = new ModsManager(
    join(fixture.root, "mods.sqlite"),
    () => [plugin],
    async (...args) => {
      approvals.push(args)
      return true
    },
    () => {}
  )
  manager.configure(workspace, true, false)
  const canonical = manager.workspaceKey(workspace)
  const assertThread = (key: string, id: string) => {
    const row = getThreadCore(id)
    const workspace = row && JSON.parse(row.metadata ?? "{}").workspacePath
    if (typeof workspace !== "string" || manager.workspaceKey(workspace) !== key)
      throw Error("ACTUAL_THREAD_WORKSPACE_CHANGED")
  }
  const conversations = new FunctionConversationCoordinator(new FunctionConversationStore(getDb()), {
    authorities: { get: authority => manager.getFunctionConversationAuthority(authority) },
    assertScope: context => { assertThread(context.workspace, context.threadId) },
    readCurrentCheckpoint: async (_thread, signal, guard) => { signal.throwIfAborted(); guard(); return null },
    protect: async (_context, value, signal, guard) => { signal.throwIfAborted(); guard(); return value },
    apiMessages: projectFunctionSessionApiMessages,
    changed: () => {}
  })
  manager.setFunctionConversations(conversations)
  const events: Array<{ plugin: string; text: string }> = []
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    manager.store,
    {
      plugins: () => [plugin],
      enabled: () => manager.isEnabled(canonical),
      assertThread,
      openConversationOwner: conversations.openConversationOwner,
      activateConversationOwner: conversations.activateConversationOwner,
      changed() {
        /* No renderer exists in this Node integration. */
      },
      publish: async (_, value) => value,
      debugLog: (plugin, text) => events.push({ plugin, text }),
      prepareAgent: (...args) => manager.prepareFunctionAgentSpawn(...args),
      spawnAgent: (...args) => manager.spawnFunctionAgent(...args),
      sendPeer: (...args) => manager.sendFunctionPeer(...args)
    },
    () => {
      const local: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          local.push(guest)
          return guest
        },
        stop() {
          for (const guest of local) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(local.map((guest) => guest.dispose()))
        }
      }
    }
  )
  manager.attachFunctions({
    runtimeReady: (...args) => functions.runtimeReady(...args),
    registeredAgent: (...args) => functions.registeredAgent(...args),
    classicEvent: (...args) => functions.classicEvent(...args),
    hasEventHandler: (...args) => functions.hasEventHandler(...args),
    receivePeer: (...args) => functions.receivePeer(...args),
    toolCall: (binding, input, core) =>
      withFunctionAgentExecution(
        { ...binding, userInitiated: false, leased: true, immediate: false },
        () =>
          functions.interceptTool(binding.workspace, binding.threadId, input, binding.signal, core)
      ),
    invalidate: (...args) => functions.invalidate(...args),
    invalidateAll: () => functions.invalidateAll(),
    closeThread: (id) => functions.closeThread(id),
    close: () => functions.close()
  })
  const compiled = await compileFunctionPlugin(pluginRoot)
  await functions.approve(canonical, plugin.id, compiled.digest)
  setModsManager(manager)
  setTraceReporter({
    async report() {
      /* Keep this private test trace local. */
    }
  })
  // Native threads retain the user's original spelling; runtime ownership uses the canonical key.
  createThread("parent", { workspacePath: workspace, model: "custom:fixture" })
  expect(claimLocalThreadRunLease({ threadId: "parent", owner: "desktop", runId: "parent-turn" }).acquired).toBe(true)
  const parent = manager.createRuntimeAuthority({
    workspace: canonical,
    threadId: "parent",
    turnId: "parent-turn"
  })
  const release = manager.bindThread({ ...parent.authority, runtimeAuthority: parent.authority })
  manager.bindFunctionSession(parent.authority, "custom:fixture")
  const parentTracer = new TraceCollector("parent", "SDK spawn request", "custom:fixture", {
    includeSkillEval: false
  })
  bindRuntimeTraceContext(parent.authority, parentTracer.getTraceContext())
  const budgets = new CreatorRequestBudgets(manager.store)
  budgets.bindModel("creator", "original-request", undefined, { modelAttemptLimit: 2 })
  bindCreatorModelAccounting(
    parent.authority,
    issueCreatorModelAccounting(
      {
        assertCurrent() {
          /* This fixture owns one immutable goal until teardown. */
        },
        claim(traceId) {
          const id = budgets.claimModel("creator", "original-request", traceId)
          return {
            settle: (usage) => budgets.settleModel("creator", "original-request", id, usage)
          }
        },
        recordTrace: (usage) => budgets.recordModelTrace("creator", "original-request", usage)
      },
      undefined,
      undefined,
      { workspace: canonical, threadId: "parent" }
    )
  )
  const runtimeModule = await import("../../agent/runtime")
  const originalRuntime = runtimeModule.createAgentRuntime
  const diagnostic = vi
    .spyOn(runtimeModule, "createAgentRuntime")
    .mockImplementation(async (options) => {
      childThread = options.threadId
      try {
        return await originalRuntime(options)
      } catch (error) {
        console.error("Actual runtime fixture failure", error)
        throw error
      }
    })
  let childThread = ""
  try {
    const command = (name: string) => withFunctionAgentExecution(
      {
        ...parent.authority,
        runtimeAuthority: parent.authority,
        userInitiated: false,
        leased: name === "spawn",
        immediate: name !== "spawn"
      },
      async () => {
        const descriptor = (await functions.commands(canonical, "parent")).find(
          (row) => row.command === name
        )!
        if (name === "spawn") await manager.prepareFunctionConversationRuntime(parent.authority, new AbortController().signal)
        return functions.runCommand(canonical, "parent", descriptor, "", new AbortController().signal)
      }
    )
    const started = JSON.parse((await command("spawn")).text!)
    expect(started.agentId).toMatch(/^mods-agent:/)
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5000 })
    expect(releaseLocalThreadRunLease("parent", "desktop", "parent-turn")).toBe(true)
    expect(JSON.parse((await command("send")).text!)).toEqual({ isDelivered: true })
    continueChild.resolve()
    await vi.waitFor(async () => {
      const text = (await command("inspect")).text
      expect(text).toBeTruthy()
      expect(JSON.parse(text!)).toMatchObject({ agentId: started.agentId, reason: "answer", answer: "native-tool-proof received" })
    }, { timeout: 5000 })
    expect(getThreadCore(childThread)).toBeNull()
    expect(JSON.parse(getThreadCore("parent")!.metadata!).workspacePath).toBe(workspace)
    expect(approvals).toHaveLength(1)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain("native-tool-proof")
    await vi.waitFor(async () => {
      await flushTraceWriteQueue()
      const traces = await readThreadTraces(childThread)
      expect(traces).toHaveLength(1)
      expect(traces[0]).toMatchObject({
        traceKind: "subagent",
        executionMode: "normal",
        outcome: "success",
        totalModelCalls: 2,
        totalToolCalls: 1,
        parentTraceId: parentTracer.getTraceId(),
        parentThreadId: "parent"
      })
      expect(traces[0].subagentKind).toBeUndefined()
      const toolEvents = events
        .filter((event) => event.plugin === compiled.name)
        .map((event) => JSON.parse(event.text) as { tool: string; agentId: string; id: string })
        .filter((event) => event.tool === publicFunctionToolName("read_file"))
      expect(toolEvents, JSON.stringify(events)).toHaveLength(1)
      expect(toolEvents[0]).toMatchObject({ tool: "Read", id: "native-read" })
      expect(toolEvents[0].agentId).not.toBe("main")
      expect(creatorModelSummary(budgets.latest("creator")?.model)).toMatchObject({
        attempts: 2,
        recordedModelCalls: 2,
        recordedToolCalls: 1,
        traceIds: [traces[0].traceId],
        coverage: "partial",
        cost: { state: "unavailable", reason: "pricing-unavailable" }
      })
      expect(creatorModelSummary(budgets.latest("creator")?.model).cost).not.toHaveProperty(
        "amount"
      )
    })
  } finally {
    continueChild.resolve()
    releaseLocalThreadRunLease("parent", "desktop", "parent-turn")
    diagnostic.mockRestore()
    release()
    await parentTracer.finish("success")
    deleteThread("parent")
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    setModsManager(undefined)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 30000)
