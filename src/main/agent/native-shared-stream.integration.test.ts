import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage
} from "@langchain/core/messages"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { RunnableConfig } from "@langchain/core/runnables"
import { mergeConfigs } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph"
import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai"
import { createMiddleware } from "langchain"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager, type FunctionNativeConversationRuntime } from "../mods/manager"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import type { FunctionConversationSharedCheckpointScope } from "../mods/v2/conversation-shared-checkpointer"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { captureThreadIncarnation, THREAD_INCARNATION_METADATA_KEY } from "../services/thread-incarnation"
import {
  captureConversationCheckpointRead,
  functionConversationCanonicalStamp,
  readFunctionConversationCheckpointMembership
} from "../checkpointer/function-conversation-checkpoint-membership"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createFunctionConversationMiddleware } from "./mods-conversation"
import {
  createFunctionConversationSharedAgent,
  captureFunctionConversationNativeTaskConfig
} from "./mods-conversation-shared-invocation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease, getLocalThreadRunLease } from "./thread-run-lease"
import * as nativeLifetime from "./function-conversation-native-lifetime"
import * as nativeTools from "./function-conversation-native-tools"
import { FunctionConversationNativeKeeper,
  type FunctionConversationNativeKeeperAdmission } from "./function-conversation-native-keeper"
import { readFunctionConversationNativeNodeSlotData,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { readFunctionConversationNativeSharedPolicySource } from "../mods/native-conversation-policy-source"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { readFunctionConversationNativeModelCurrent,
  readFunctionConversationNativeSharedToolCurrent } from "./native-model-current"
import { createFunctionConversationNativeHost } from "./function-conversation-native-host"
import { createNativeConversationStreamProjection, projectNativeConversationMessageForStream,
  readNativeConversationStreamProjection,
  type NativeConversationStreamProjectionSharedSource } from "./native-conversation-stream-projection"
import * as nativePolicySources from "../mods/native-conversation-policy-source"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => "", getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => Promise<void>> = []
const fixtureFetch = globalThis.fetch
const fixtureHttpOrigins = new Set<string>()
const unexpectedNetworkRequests: string[] = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-stream-actual-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close())
  )
  vi.restoreAllMocks()
  unexpectedNetworkRequests.length = 0
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason as unknown)
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Actual Shared stream cleanup failed")
})
afterAll(async () => {
  const failures: unknown[] = []
  try {
    await appDb.closeDatabase()
  } catch (reason) {
    failures.push(reason)
  }
  try {
    removeOwnedDirectory(directory, tmpdir(), "cmb-shared-stream-actual-")
  } catch (reason) {
    failures.push(reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length)
    throw new AggregateError(failures, "Actual Shared stream database cleanup failed")
})

function removeOwnedDirectory(path: string, parent: string, prefix: string): void {
  if (!path) return
  const target = resolve(path)
  if (dirname(target) !== resolve(parent) || !basename(target).startsWith(prefix))
    throw Error("ACTUAL_SHARED_STREAM_OWN_DIRECTORY_REQUIRED")
  rmSync(target, { recursive: true, force: true })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ACTUAL_SHARED_STREAM_RECORD_REQUIRED")
  return value as Record<string, unknown>
}
function messages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("ACTUAL_SHARED_STREAM_MESSAGES_REQUIRED")
  return value
}
const seed = () => ({
  messages: [new HumanMessage({ id: randomUUID(), content: "complete actual shared input" })]
})

function captureParentAbortMarker(config: RunnableConfig): () => void {
  const field =
    config.configurable &&
    Object.getOwnPropertyDescriptor(config.configurable, "__pregel_abort_signals")
  if (!field || !("value" in field) || !field.value || typeof field.value !== "object")
    throw Error("ACTUAL_SHARED_PARENT_ABORT_MARKER_REQUIRED")
  const marker: object = field.value
  const keys = Reflect.ownKeys(marker),
    fields = Object.getOwnPropertyDescriptors(marker)
  return () => {
    expect(
      Object.getOwnPropertyDescriptor(config.configurable!, "__pregel_abort_signals")?.value
    ).toBe(marker)
    expect(Reflect.ownKeys(marker)).toEqual(keys)
    for (const key of keys) {
      const before = Object.getOwnPropertyDescriptor(fields, key)?.value as
        | PropertyDescriptor
        | undefined
      const after = Object.getOwnPropertyDescriptor(marker, key)
      if (!before || !after || !("value" in before) || !("value" in after))
        throw Error("ACTUAL_SHARED_PARENT_ABORT_MARKER_DATA_REQUIRED")
      expect(after.value).toBe(before.value)
      expect(after.enumerable).toBe(before.enumerable)
      expect(after.writable).toBe(before.writable)
      expect(after.configurable).toBe(before.configurable)
    }
  }
}

/** Real HTTP model, parent Pregel task, Manager authority, Saver and child Scope. */
async function fixture(
  options: { hold?: boolean; holdOpening?: boolean; tool?: boolean; protected?: boolean;
    parentProjection?: boolean;
    toolGuard?: "count" | "body" | "path" | "global-disable" | "source-global-disable" | "abort" | "target-retire" |
      "destination-incarnation" } = {}
) {
  const diagnosticStarted = performance.now()
  const root = mkdtempSync(join(directory, "workspace-"))
  const controller = new AbortController(),
    release = deferred<void>(),
    entered = deferred<void>()
  const openingEntered = deferred<void>()
  const requests: Record<string, unknown>[] = [],
    handlers: Promise<void>[] = []
  const runs: Promise<unknown>[] = [],
    children: Promise<unknown>[] = []
  const scopes: FunctionConversationSharedCheckpointScope[] = []
  const runtimes: FunctionNativeConversationRuntime[] = []
  const raw: AIMessageChunk[] = []
  const toolObservation = { measured: false, changed: false, uuid: "" }
  const toolReturn: { command?: Command } = {}
  let physicalChecks = 0, physicalCallback: (() => void) | undefined
  let globallyEnabled = true
  let manager: ModsManager | undefined = undefined
  let saver: SqlJsSaver | undefined = undefined
  let owner: (() => void) | undefined = undefined
  let unbind: (() => void) | undefined = undefined
  let parent: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined = undefined
  let parentRuntime: FunctionNativeConversationRuntime | undefined
  let parentHost: ReturnType<typeof createFunctionConversationNativeHost> | undefined
  const sharedSource: { value?: NativeConversationStreamProjectionSharedSource } = {}
  let threadId = "",
    runId = "",
    leased = false,
    listening = false,
    httpOrigin = "",
    effects = 0,
    finished = 0
  let closing: Promise<void> | undefined
  const phase = (name: string) => {
    if (process.env.CMB_SHARED_STREAM_DIAGNOSTIC !== "1") return
    console.info(
      "Shared stream diagnostic",
      JSON.stringify({
        phase: name,
        elapsedMs: Math.round(performance.now() - diagnosticStarted),
        requests: requests.length,
        rawChunks: raw.length,
        effects,
        finished
      })
    )
  }
  const server = createServer((request, response) => {
    const work = (async () => {
      const pieces: Buffer[] = []
      for await (const piece of request) pieces.push(Buffer.from(piece))
      const body = record(JSON.parse(Buffer.concat(pieces).toString("utf8")))
      requests.push(body)
      expect(body.stream).toBe(true)
      const number = requests.length,
        toolCall = options.tool && number === 1
      const parts = toolCall ? ["actual ", "tool request"] : ["complete ", "shared answer"]
      const disconnected = deferred<void>()
      response.once("close", () => {
        phase("http-close")
        disconnected.resolve()
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      try {
        for (let index = 0; index < parts.length; index++) {
          response.write(
            `data: ${JSON.stringify({
              id: "actual-reused-shared-provider",
              object: "chat.completion.chunk",
              created: 1,
              model: "actual-shared-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(index === 0 ? { role: "assistant" } : {}),
                    content: parts[index],
                    ...(toolCall && index === 0
                      ? {
                          tool_calls: [
                            {
                              index: 0,
                              id: "actual-shared-tool-call",
                              type: "function",
                              function: {
                                name: "actual_shared_stream_tool",
                                arguments: '{"value":"complete"}'
                              }
                            }
                          ]
                        }
                      : {})
                  },
                  finish_reason:
                    index === parts.length - 1 ? (toolCall ? "tool_calls" : "stop") : null
                }
              ]
            })}\n\n`
          )
          if (index === 0) {
            phase("http-first-write")
            entered.resolve()
            if (options.hold) await Promise.race([release.promise, disconnected.promise])
          }
          if (response.destroyed) return
        }
        response.end("data: [DONE]\n\n")
      } finally {
        finished++
        phase("http-finally")
      }
    })()
    handlers.push(work)
    void work.catch(() => {
      response.destroy()
    })
  })
  cleanups.push(
    () =>
      (closing ??= (async () => {
        const failures: unknown[] = []
        const attempt = async (work: () => unknown | Promise<unknown>) => {
          try {
            await work()
          } catch (error) {
            failures.push(error)
          }
        }
        await attempt(() => controller.abort(Error("ACTUAL_SHARED_STREAM_FIXTURE_FINISHED")))
        await attempt(() => release.resolve())
        await Promise.allSettled([...runs, ...children])
        if (parentHost) {
          await attempt(() => parentHost?.close())
          await attempt(() => parentHost?.whenDrained())
        }
        await attempt(() => owner?.())
        await attempt(() => unbind?.())
        await attempt(() => parent?.release())
        await attempt(() => manager?.close())
        await attempt(() => saver?.close())
        if (leased)
          await attempt(() => {
            if (!releaseLocalThreadRunLease(threadId, "desktop", runId))
              throw Error("ACTUAL_SHARED_STREAM_LEASE_RELEASE_REQUIRED")
          })
        await attempt(() => server.closeAllConnections())
        if (listening)
          await attempt(
            () =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
              )
          )
        await attempt(async () => {
          const results = await Promise.allSettled(handlers)
          for (const result of results)
            if (result.status === "rejected") failures.push(result.reason)
        })
        fixtureHttpOrigins.delete(httpOrigin)
        await attempt(() => removeOwnedDirectory(root, directory, "workspace-"))
        if (failures.length === 1) throw failures[0]
        if (failures.length)
          throw new AggregateError(failures, "Actual Shared stream resources failed")
      })())
  )
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      listening = true
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw Error("ACTUAL_SHARED_STREAM_HTTP_REQUIRED")
  httpOrigin = `http://127.0.0.1:${address.port}`
  fixtureHttpOrigins.add(httpOrigin)
  // This is a local HTTP protocol regression. Tokenizer bookkeeping must not silently
  // introduce a second provider/network dependency after the actual SSE has completed.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input :
      input instanceof URL ? input.href : input.url)
    if (!fixtureHttpOrigins.has(url.origin)) {
      unexpectedNetworkRequests.push(url.origin)
      return Promise.reject(Error("ACTUAL_SHARED_STREAM_EXTERNAL_NETWORK_FORBIDDEN"))
    }
    return fixtureFetch(input, init)
  })
  manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => undefined,
    undefined,
    undefined,
    () => globallyEnabled
  )
  const actualManager = manager
  actualManager.configure(root, true, options.protected ?? false)
  const workspace = actualManager.workspaceKey(root)
  threadId = randomUUID()
  runId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_SHARED_STREAM_LEASE_REQUIRED")
  leased = true
  parent = actualManager.createRuntimeAuthority({
    workspace,
    threadId,
    turnId: runId,
    signal: controller.signal
  })
  const actualParent = parent
  if (options.parentProjection) {
    const register = nativePolicySources.registerFunctionConversationSharedNativePolicySource
    const observer = vi.spyOn(nativePolicySources, "registerFunctionConversationSharedNativePolicySource")
      .mockImplementation((input) => {
        register(input)
        sharedSource.value ??= { proof: input.proof, authority: input.authority }
      })
    cleanups.push(async () => { observer.mockRestore() })
  }
  unbind = actualManager.bindThread({
    workspace,
    threadId,
    turnId: runId,
    signal: controller.signal,
    runtimeAuthority: actualParent.authority,
    ...(options.toolGuard ? { assertLive: () => { physicalChecks++; physicalCallback?.() } } : {})
  })
  const guard = actualManager.captureFunctionRuntimeGuard(actualParent.authority)
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: (scope) => actualManager.getFunctionConversationAuthority(scope) },
    assertScope: guard,
    readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted()
      current()
      return value
    },
    apiMessages: projectFunctionSessionApiMessages,
    changed: () => undefined
  })
  actualManager.setFunctionConversations(coordinator)
  owner = coordinator.openConversationOwner({
    owner: {},
    workspace,
    threadId,
    readOnly: false,
    signal: controller.signal,
    assertCurrent: guard
  })
  saver = new SqlJsSaver(join(root, "actual-checkpoint.sqlite"))
  const actualSaver = saver
  const capture = () => {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_SHARED_STREAM_AUTHORITY_REQUIRED")
    const scope = actualManager.captureFunctionConversationSharedScope(authority)
    if (scope && !scopes.includes(scope)) scopes.push(scope)
    return scope
  }
  const observe = createMiddleware({
    name: "actual-shared-stream-observer",
    wrapModelCall: (request, handler) => {
      const authority = currentFunctionExecution()?.runtimeAuthority
      if (!authority || authority === actualParent.authority)
        throw Error("ACTUAL_SHARED_STREAM_CHILD_REQUIRED")
      const runtime = actualManager.captureFunctionNativeConversationRuntime(authority)
      if (!runtime || runtime.target.ref.kind !== "child")
        throw Error("ACTUAL_SHARED_STREAM_RUNTIME_REQUIRED")
      if (!runtimes.includes(runtime)) runtimes.push(runtime)
      return handler(request)
    }
  })
  const actualTool = tool(
    ({ value }: { value: string }) => {
      effects++
      phase("tool-effect")
      if (options.toolGuard === "path") {
        const command = new Command({ update: { messages: [new ToolMessage({
          content: `actual shared tool ${value}`, tool_call_id: "actual-shared-tool-call",
          name: "actual_shared_stream_tool"
        })] } })
        toolReturn.command = command
        return command
      }
      return `actual shared tool ${value}`
    },
    {
      name: "actual_shared_stream_tool",
      description: "Actual shared stream side effect",
      schema: z.object({ value: z.string() })
    }
  )
  if (options.toolGuard) {
    type Guard = { guard(work: { readonly admission: FunctionConversationNativeKeeperAdmission },
      signal: AbortSignal, mutation: () => void): void }
    const prototype = FunctionConversationNativeKeeper.prototype as unknown as Guard
    const originalGuard = prototype.guard, install = nativeTools.installFunctionConversationNativeTools
    const ledgers: nativeTools.FunctionConversationNativeTools[] = []
    const factory = vi.spyOn(nativeTools, "installFunctionConversationNativeTools")
      .mockImplementation((...args) => {
        const ledger = install(...args)
        ledgers.push(ledger)
        return ledger
      })
    const keeper = vi.spyOn(prototype, "guard").mockImplementation(function (
      this: FunctionConversationNativeKeeper, work, signal, mutation) {
      const runtime = runtimes[0], admission = work.admission
      if (!runtime || toolObservation.measured || admission.door !== "tool-result") {
        Reflect.apply(originalGuard, this, [work, signal, mutation])
        return
      }
      expect(ledgers).toHaveLength(1)
      const slot = admission.occurrence as FunctionConversationNativeNodeSlot
      const originalSlot = readFunctionConversationNativeNodeSlotData(slot)
      const returned = ledgers[0].read(slot)
      expect(returned.message).toBe(originalSlot.message)
      expect(Object.getPrototypeOf(returned.message)).toBe(ToolMessage.prototype)
      expect(returned.door).toBe("tool-result")
      expect(returned.message.content).toEqual(admission.message.content)
      const policy = readFunctionConversationNativeSharedPolicySource(returned.policy, runtime)
      if (!policy) throw Error("ACTUAL_SHARED_TOOL_POLICY_REQUIRED")
      if (options.toolGuard === "global-disable" || options.toolGuard === "source-global-disable")
        expect(returned.policy.value.protected).toBe(true)
      const current = readFunctionConversationNativeSharedToolCurrent(admission.assertCurrent, runtime)
      if (!current) throw Error("ACTUAL_SHARED_TOOL_CURRENT_REQUIRED")
      expect(current.sharedRuntime).toBe(runtime)
      expect(readFunctionConversationNativeModelCurrent(admission.assertCurrent, runtime))
        .toBeUndefined()
      expect(readFunctionConversationNativeSharedToolCurrent(admission.assertCurrent, { ...runtime }))
        .toBeUndefined()
      expect(readFunctionConversationNativeSharedToolCurrent(() => admission.assertCurrent(), runtime))
        .toBeUndefined()
      expect(runtime.database.exec(
        "SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
        [runtime.target.ref.conversationId, admission.message.id!])[0].values).toEqual([[0]])
      toolObservation.measured = true
      toolObservation.uuid = admission.message.id ?? ""
      if (!toolObservation.uuid) throw Error("ACTUAL_SHARED_TOOL_UUID_REQUIRED")
      let expectedChecks: number | undefined = undefined
      if (options.toolGuard === "count") {
        const beforeSource = physicalChecks
        originalSlot.assertCurrent()
        const sourceChecks = physicalChecks - beforeSource
        expect(sourceChecks).toBeGreaterThan(0)
        const beforePolicy = physicalChecks
        policy.assertCurrent()
        const policyChecks = physicalChecks - beforePolicy
        expect(policyChecks).toBeGreaterThan(0)
        expectedChecks = sourceChecks + policyChecks
      }
      const beforeBase = physicalChecks
      returned.assertCurrent()
      const baseChecks = physicalChecks - beforeBase
      expect(baseChecks).toBeGreaterThan(0)
      if (expectedChecks !== undefined) expect(baseChecks).toBe(expectedChecks)
      const beforeCurrent = physicalChecks
      admission.assertCurrent()
      expect(physicalChecks - beforeCurrent).toBe(baseChecks)
      if (options.toolGuard !== "count") {
        const beforeTarget = physicalChecks
        runtime.target.assertCurrent()
        const targetChecks = physicalChecks - beforeTarget
        expect(targetChecks).toBeGreaterThan(0)
        const lateTool = options.toolGuard === "body" || options.toolGuard === "path"
        const attackAt = physicalChecks + targetChecks +
          (options.toolGuard === "source-global-disable" ? 1 : lateTool ? baseChecks : 0)
        physicalCallback = () => {
          if (physicalChecks !== attackAt) return
          physicalCallback = undefined
          toolObservation.changed = true
          if (options.toolGuard === "body") originalSlot.message.content = "late actual tool body"
          else if (options.toolGuard === "global-disable" || options.toolGuard === "source-global-disable")
            globallyEnabled = false
          else if (options.toolGuard === "abort") controller.abort(Error("ACTUAL_SHARED_TOOL_CANCEL"))
          else if (options.toolGuard === "target-retire") coordinator.registry.retire(runtime.target)
          else if (options.toolGuard === "destination-incarnation") {
            const destination = runtime.destination.threadId
            const original = appDb.getThreadCore(destination)
            if (!original) throw Error("ACTUAL_SHARED_TOOL_DESTINATION_REQUIRED")
            appDb.deleteThread(destination)
            const replacement = appDb.createThread(destination, { workspacePath: workspace })
            runtime.database.run("UPDATE threads SET created_at=? WHERE thread_id=?", [
              original.created_at, destination
            ])
            expect(captureThreadIncarnation(replacement).token)
              .not.toBe(runtime.destination.incarnation.token)
            expect(controller.signal.aborted).toBe(false)
          } else {
            const command = toolReturn.command
            if (!command) throw Error("ACTUAL_SHARED_TOOL_COMMAND_REQUIRED")
            const update: unknown = Object.getOwnPropertyDescriptor(command, "update")?.value
            if (!update || typeof update !== "object") throw Error("ACTUAL_SHARED_TOOL_UPDATE_REQUIRED")
            const output: unknown = Object.getOwnPropertyDescriptor(update, "messages")?.value
            if (!Array.isArray(output)) throw Error("ACTUAL_SHARED_TOOL_MESSAGES_REQUIRED")
            const field = Object.getOwnPropertyDescriptor(output, "0")
            if (!field || !("value" in field) || field.value !== originalSlot.message)
              throw Error("ACTUAL_SHARED_TOOL_RETURN_ADDRESS_REQUIRED")
            Object.defineProperty(output, "0", { ...field, value: undefined })
          }
        }
      }
      try {
        Reflect.apply(originalGuard, this, [work, signal, mutation])
      } catch (error) {
        if (options.toolGuard === "path") expect(() => { throw error })
          .toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
        throw error
      }
    })
    cleanups.push(async () => {
      physicalCallback = undefined
      keeper.mockRestore()
      factory.mockRestore()
    })
  }
  const modelParameters = {
    model: "actual-shared-model",
    apiKey: "local-test-key",
    streaming: true,
    streamUsage: false,
    maxRetries: 0,
    configuration: { baseURL: `${httpOrigin}/v1` }
  }
  const completions = new ChatOpenAICompletions(modelParameters)
  let localTokenEstimates = 0
  // As in the existing native compaction/function-completion model policy, only auxiliary
  // estimated usage is local. No provider-reported usage, native payload or tool fact is replaced.
  completions.getNumTokens = async (content: unknown) => {
    localTokenEstimates++
    const text = typeof content === "string" ? content : JSON.stringify(content) ?? ""
    return Math.ceil(text.length / 4)
  }
  // bindTools/withConfig construct another ChatOpenAI from its original fields. Passing the
  // real completions instance here preserves the local estimator in that actual execution path.
  const model = new ChatOpenAI({ ...modelParameters, completions })
  const agent = createFunctionConversationSharedAgent(
    {
      model,
      tools: options.tool ? [actualTool] : [],
      middleware: [
        observe,
        createFunctionConversationMiddleware({
          store,
          capture: (runtime) => capture()?.captureNode(runtime)
        })
      ]
    },
    capture,
    {
      store,
      agentId: "actual-shared-stream",
      model: "actual-shared-model",
      captureRuntime: (authority) =>
        actualManager.captureFunctionNativeConversationRuntime(authority),
      flush: (runtime) => runtime.assertCurrent()
    }
  )
  const callback = new (class extends BaseCallbackHandler {
    name = "actual-shared-original-chunks"
    held = false
    constructor() {
      super({ _awaitHandler: true, raiseError: true })
    }
    async handleChainStart() {
      if (options.holdOpening && !this.held) {
        this.held = true
        openingEntered.resolve()
        await release.promise
      }
    }
    handleLLMNewToken(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMNewToken"]>>) {
      const chunk = args[5]?.chunk
      if (!chunk || !("message" in chunk) || !AIMessageChunk.isInstance(chunk.message))
        throw Error("ACTUAL_SHARED_STREAM_ORIGINAL_CHUNK_REQUIRED")
      raw.push(chunk.message)
      phase("sdk-token")
    }
  })()
  const execute = <T>(action: (config: RunnableConfig) => Promise<T>): Promise<T> => {
    let returned!: T,
      settled = false
    const state = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: (_old, incoming) => incoming,
        default: () => []
      })
    })
    const graph = new StateGraph(state)
      .addNode("actual-shared-parent", (_state, config) => {
        const child = actualManager.withSharedAgent(
          actualParent.authority,
          `mod-task:${randomUUID()}`,
          controller.signal,
          { blockedToolNames: new Set(), readOnly: false },
          async () => {
            phase("child-action-begin")
            returned = await action(mergeConfigs(config, { callbacks: [callback] }))
            settled = true
            phase("child-action-done")
            return { messages: [] }
          },
          runId,
          { type: "actual-shared-stream", description: "Complete streaming regression" },
          {
            invocation: Object.freeze({}),
            saver: actualSaver,
            config: captureFunctionConversationNativeTaskConfig(config)
          }
        )
        children.push(child)
        return child
      })
      .addEdge(START, "actual-shared-parent")
      .addEdge("actual-shared-parent", END)
      .compile({ checkpointer: actualSaver })
    const run = graph
      .invoke(seed(), {
        configurable: { thread_id: threadId },
        signal: controller.signal,
        durability: "async"
      })
      .then(() => {
        if (!settled) throw Error("ACTUAL_SHARED_STREAM_ACTION_SETTLEMENT_REQUIRED")
        return returned
      })
    runs.push(run)
    void run.catch(() => undefined)
    return run
  }
  const verifySaved = async (count: number) => {
    phase("verify-saved-begin")
    expect(runtimes).toHaveLength(1)
    const runtime = runtimes[0],
      target = runtime.target.ref
    const rows = store.readRows(target)
    expect(rows).toHaveLength(count)
    expect(rows.every((row) => !row.inbox)).toBe(true)
    const tuple = await actualSaver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: target.checkpointNamespace }
    })
    if (!tuple) throw Error("ACTUAL_SHARED_STREAM_CHECKPOINT_REQUIRED")
    const native = messages(tuple.checkpoint.channel_values.messages)
    for (const row of rows) {
      const message = native.find((value) => value.id === row.uuid)
      if (!message) throw Error("ACTUAL_SHARED_STREAM_CANONICAL_REQUIRED")
      expect(message).toBeInstanceOf(row.door === "tool-result" ? ToolMessage : AIMessage)
      expect(message.additional_kwargs.function_row).toEqual(
        functionConversationCanonicalStamp(target, row)
      )
      expect(serializeFunctionConversationNativeMessage(message)).toBe(row.nativePayload)
    }
    const incarnation = captureThreadIncarnation(thread)
    const recovery = store.readCheckpointRecoverySnapshot(
      target,
      {
        checkpointThreadId: threadId,
        checkpointIncarnation: incarnation,
        checkpointId: tuple.checkpoint.id
      },
      guard
    ).snapshot
    const read = await captureConversationCheckpointRead(
      store,
      actualSaver,
      tuple.config,
      () => ({
        target,
        checkpointThreadId: threadId,
        checkpointIncarnation: incarnation,
        cut: recovery.cut,
        frontier: recovery.frontier,
        stateDigest: recovery.stateDigest,
        assertCurrent: guard
      }),
      guard
    )
    if (!read.proof) throw Error("ACTUAL_SHARED_STREAM_MEMBERSHIP_REQUIRED")
    const membership = readFunctionConversationCheckpointMembership(read.proof, store, target)
    expect(membership.members.map((member) => member.uuid)).toEqual(rows.map((row) => row.uuid))
    const ui = appDb.withCanonicalThreadMessageReadScope(runtime.destination.threadId, (reader) =>
      rows.map((row) => ({
        columns: reader.readColumns(row.uuid),
        snapshot: reader.readSnapshot(row.uuid)
      }))
    )
    expect(ui.map((value) => value.snapshot?.id)).toEqual(rows.map((row) => row.uuid))
    expect(ui.every((value) => value.columns?.thread_id === runtime.destination.threadId)).toBe(
      true
    )
    expect(appDb.getThreadMessages(threadId)).toEqual([])
    phase("verify-saved-done")
    return { rows, native, ui, membership }
  }
  await coordinator.prepareRuntime(workspace, threadId)
  if (options.parentProjection) {
    await actualManager.prepareFunctionConversationRuntime(actualParent.authority, controller.signal, runId)
    parentRuntime = actualManager.captureFunctionNativeConversationRuntime(actualParent.authority)
    if (!parentRuntime || parentRuntime.target.ref.kind !== "main")
      throw Error("ACTUAL_SHARED_PARENT_NATIVE_RUNTIME_REQUIRED")
    const original = parentRuntime
    parentHost = createFunctionConversationNativeHost({ runtime: original, store,
      agentId: "main", model: "actual-shared-parent", flush: () => original.assertCurrent() })
  } else await actualManager.prepareFunctionConversationRuntime(actualParent.authority, controller.signal)
  phase("fixture-ready")
  return {
    agent,
    controller,
    execute,
    verifySaved,
    requests,
    scopes,
    runtimes,
    store,
    saver: actualSaver,
    parentRuntime,
    parentHost,
    sharedSource,
    threadId,
    toolObservation,
    raw,
    entered: entered.promise,
    openingEntered: openingEntered.promise,
    release: () => release.resolve(),
    effects: () => effects,
    finished: () => finished,
    localTokenEstimates: () => localTokenEstimates,
    unexpectedNetworkRequests: () => [...unexpectedNetworkRequests],
    phase,
    async assertDrained() {
      for (const scope of scopes) await scope.whenDrained()
      const results = await Promise.allSettled(handlers)
      for (const result of results) if (result.status === "rejected") throw result.reason
      expect(finished).toBe(requests.length)
    }
  }
}

describe("actual native Shared streams", () => {
  // Correctness coverage for three canonical receipts and 12 parent drops, not a latency benchmark.
  it("drops the real child's live and closed AI and Tool shadows only from its genuine parent", async () => {
    const f = await fixture({ tool: true, parentProjection: true, protected: true })
    const parent = f.parentHost, runtime = f.parentRuntime
    if (!parent || !runtime) throw Error("ACTUAL_SHARED_PARENT_HOST_REQUIRED")
    const completions: Array<{ tuple: unknown[]; message: BaseMessage; wire: Record<string, unknown> }> = []
    await f.execute(async (config) => {
      const stream = await f.agent.stream(seed(), { ...config, streamMode: "messages" })
      for await (const value of stream) {
        if (!Array.isArray(value) || value.length !== 2)
          throw Error("ACTUAL_SHARED_COMPLETION_TUPLE_REQUIRED")
        const message = value[0]
        if (!(message instanceof BaseMessage) || !message.additional_kwargs.function_row) continue
        expect([AIMessage.prototype, ToolMessage.prototype]).toContain(Object.getPrototypeOf(message))
        const wire = projectNativeConversationMessageForStream(message)
        if (!wire) throw Error("ACTUAL_SHARED_PRIVATE_COMPLETION_REQUIRED")
        expect(readNativeConversationStreamProjection(wire, f.runtimes[0].destination.threadId)?.id)
          .toBe(message.id)
        expect(parent.message(value)).toBeUndefined()
        expect(parent.message([wire, value[1]])).toBeUndefined()
        completions.push({ tuple: value, message, wire })
      }
    })
    expect(completions).toHaveLength(3)
    expect(completions.map(({ message }) => message instanceof ToolMessage ? "tool" : "assistant"))
      .toEqual(["assistant", "tool", "assistant"])
    expect(completions.map(({ tuple }) => record(tuple[1]).langgraph_node))
      .toEqual(["model_request", "tools", "model_request"])
    expect(() => f.runtimes[0].assertCurrent()).toThrow()
    for (const completion of completions) {
      expect(() => readNativeConversationStreamProjection(completion.wire)).toThrow()
      expect(parent.message(completion.tuple)).toBeUndefined()
      expect(parent.message([completion.wire, completion.tuple[1]])).toBeUndefined()
    }
    const final = completions[2], originalContent = final.message.content
    try {
      final.message.content = "changed closed child body"
      expect(() => parent.message(final.tuple))
        .toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
    } finally { final.message.content = originalContent }
    const kwargs = record(final.wire.kwargs), originalWireContent = kwargs.content
    try {
      kwargs.content = "changed closed child wire"
      expect(() => parent.message([final.wire, final.tuple[1]]))
        .toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
    } finally { kwargs.content = originalWireContent }
    const saved = await f.verifySaved(3)
    expect(saved.rows.map((row) => row.uuid)).toEqual(completions.map(({ message }) => message.id))
    expect(saved.rows.map((row) => row.nativePayload))
      .toEqual(completions.map(({ message }) => serializeFunctionConversationNativeMessage(message)))
    expect(f.store.readRows(runtime.target.ref)).toEqual([])
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(f.requests).toHaveLength(2)
    expect(f.effects()).toBe(1)
    await f.assertDrained()
  }, 15_000)

  it("rejects unrelated parents, copied Shared proofs and a copied Main runtime for a real child shadow", async () => {
    const f = await fixture({ parentProjection: true })
    const other = await fixture({ parentProjection: true })
    const parent = f.parentHost, runtime = f.parentRuntime,
      otherParent = other.parentHost, otherRuntime = other.parentRuntime
    if (!parent || !runtime || !otherParent || !otherRuntime)
      throw Error("ACTUAL_SHARED_TWO_PARENT_HOSTS_REQUIRED")
    const copiedMain = createNativeConversationStreamProjection({ store: f.store,
      runtime: { ...runtime, assertCurrent: () => undefined } })
    cleanups.push(async () => { copiedMain.close() })
    let checked = false
    await f.execute(async (config) => {
      for await (const value of await f.agent.stream(seed(), { ...config, streamMode: "messages" })) {
        if (!Array.isArray(value) || value.length !== 2)
          throw Error("ACTUAL_SHARED_COMPLETION_TUPLE_REQUIRED")
        const message = value[0]
        if (!(message instanceof AIMessage) || !message.additional_kwargs.function_row) continue
        const source = f.sharedSource.value
        if (!source) throw Error("ACTUAL_SHARED_ORIGINAL_PRODUCER_REQUIRED")
        expect(() => createNativeConversationStreamProjection({ runtime: f.runtimes[0], store: f.store,
          sharedSource: { proof: { ...source.proof }, authority: source.authority } }))
          .toThrow("MODS_CONVERSATION_RESTORE_CHANGED")
        expect(() => otherParent.message(value))
          .toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
        expect(() => copiedMain.omitMessage(message)).toThrow("MODS_CALL_SCOPE_CHANGED")
        expect(() => parent.validate("messages", value))
          .toThrow("MODS_CONVERSATION_STREAM_PROJECTION_INVALID")
        expect(parent.message(value)).toBeUndefined()
        checked = true
      }
    })
    expect(checked).toBe(true)
    expect(f.store.readRows(runtime.target.ref)).toEqual([])
    expect(other.store.readRows(otherRuntime.target.ref)).toEqual([])
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(other.threadId)).toEqual([])
    expect(f.requests).toHaveLength(1)
    expect(other.requests).toEqual([])
    await f.assertDrained()
    await other.assertDrained()
  })

  it.each(["abort", "incarnation", "close"] as const)(
    "rejects a closed child's queued shadow after its actual parent %s", async (attack) => {
      const f = await fixture({ parentProjection: true })
      const parent = f.parentHost, runtime = f.parentRuntime
      if (!parent || !runtime) throw Error("ACTUAL_SHARED_PARENT_HOST_REQUIRED")
      const queued: { tuple?: unknown[] } = {}
      await f.execute(async (config) => {
        for await (const value of await f.agent.stream(seed(), { ...config, streamMode: "messages" })) {
          if (!Array.isArray(value) || value.length !== 2)
            throw Error("ACTUAL_SHARED_COMPLETION_TUPLE_REQUIRED")
          if (value[0] instanceof AIMessage && value[0].additional_kwargs.function_row) {
            expect(parent.message(value)).toBeUndefined()
            queued.tuple = value
          }
        }
      })
      if (!queued.tuple) throw Error("ACTUAL_SHARED_QUEUED_SHADOW_REQUIRED")
      expect(() => f.runtimes[0].assertCurrent()).toThrow()
      expect(parent.message(queued.tuple)).toBeUndefined()
      const original = appDb.getThreadCore(f.threadId)
      if (!original || !original.metadata) throw Error("ACTUAL_SHARED_PARENT_ROW_REQUIRED")
      try {
        if (attack === "abort") f.controller.abort(Error("ACTUAL_SHARED_PARENT_ABORTED"))
        else if (attack === "close") parent.close()
        else {
          const metadata = record(JSON.parse(original.metadata))
          appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [
            JSON.stringify({ ...metadata, [THREAD_INCARNATION_METADATA_KEY]: randomUUID() }), f.threadId
          ])
          const changed = appDb.getThreadCore(f.threadId)
          if (!changed) throw Error("ACTUAL_SHARED_CHANGED_PARENT_ROW_REQUIRED")
          expect(changed.created_at).toBe(original.created_at)
          expect(captureThreadIncarnation(changed).token)
            .not.toBe(captureThreadIncarnation(original).token)
          expect(f.controller.signal.aborted).toBe(false)
        }
        expect(() => parent.message(queued.tuple)).toThrow(attack === "abort"
          ? "ACTUAL_SHARED_PARENT_ABORTED" : attack === "close"
          ? "MODS_CONVERSATION_STREAM_PROJECTION_INVALID" : "MODS_CONVERSATION_NATIVE_RUN_CHANGED")
        expect(appDb.getDb().exec(
          "SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=?",
          [runtime.target.ref.conversationId])[0].values).toEqual([[0]])
        expect(appDb.getThreadMessages(f.threadId)).toEqual([])
      } finally {
        if (attack === "incarnation") appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?",
          [original.metadata, f.threadId])
      }
      expect(f.requests).toHaveLength(1)
      await f.assertDrained()
    })

  // The count case adds instrumented full checks to a complete tool turn; it is a functional gate.
  for (const attack of ["count", "body", "path", "global-disable", "source-global-disable", "abort",
    "target-retire", "destination-incarnation"] as const) {
    it(`keeps one final complete Shared tool guard for ${attack}`, async () => {
      const f = await fixture({ tool: true, toolGuard: attack,
        ...(attack === "global-disable" || attack === "source-global-disable" ? { protected: true } : {}) })
      const run = f.execute(async config => {
        const output: unknown[] = []
        const stream = await f.agent.stream(seed(), { ...config, streamMode: ["values", "updates"] })
        for await (const frame of stream) output.push(frame)
        return output
      })
      if (attack === "count") {
        await run
        const saved = await f.verifySaved(3)
        const result = saved.native.find(ToolMessage.isInstance)
        if (!result) throw Error("ACTUAL_SHARED_TOOL_MESSAGE_REQUIRED")
        expect(result.content).toBe("actual shared tool complete")
        expect(result.tool_call_id).toBe("actual-shared-tool-call")
        expect(result.name).toBe("actual_shared_stream_tool")
        expect(f.requests).toHaveLength(2)
        expect(f.requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({
          role: "tool", content: "actual shared tool complete", tool_call_id: "actual-shared-tool-call"
        })]))
        expect(saved.ui.find(row => row.snapshot?.id === result.id)?.columns)
          .toMatchObject({ content_json: JSON.stringify(result.content),
            tool_call_id: result.tool_call_id, name: result.name })
      } else {
        await expect(run).rejects.toThrow()
        expect(f.toolObservation.changed).toBe(true)
        expect(f.requests).toHaveLength(1)
        const runtime = f.runtimes[0], uuid = f.toolObservation.uuid
        expect(runtime.database.exec(
          "SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
          [runtime.target.ref.conversationId, uuid])[0].values).toEqual([[0]])
        expect(readFunctionConversationRawProjection(runtime.database, runtime.destination.threadId, uuid))
          .toBeUndefined()
        const tuple = await f.saver.getTuple({ configurable: { thread_id: runtime.binding.checkpointThreadId,
          checkpoint_ns: runtime.binding.runtimeCheckpointNamespace } })
        expect(messages(tuple?.checkpoint.channel_values.messages).some(message => message.id === uuid))
          .toBe(false)
      }
      expect(f.toolObservation.measured).toBe(true)
      expect(f.effects()).toBe(1)
      await f.assertDrained()
    }, attack === "count" ? 15_000 : undefined)
  }

  it("rejects invalid typed input through a Promise without evaluating its getter", async () => {
    const f = await fixture()
    let getters = 0
    await f.execute(async (config) => {
      const input = {
        get messages(): HumanMessage[] {
          getters++
          throw Error("ACTUAL_SHARED_INPUT_GETTER_MUST_NOT_RUN")
        }
      }
      let pending: ReturnType<typeof f.agent.stream> | undefined
      expect(() => {
        pending = f.agent.stream(input, { ...config, streamMode: "values" })
      }).not.toThrow()
      if (!pending) throw Error("ACTUAL_SHARED_TYPED_PROMISE_REQUIRED")
      expect(pending).toBeInstanceOf(Promise)
      await expect(pending).rejects.toMatchObject({
        code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID"
      })
    })
    expect(getters).toBe(0)
    expect(f.requests).toEqual([])
    expect(f.runtimes).toEqual([])
    await f.assertDrained()
  })

  it("keeps complete values and updates with one real tool call and full child checkpoint", async () => {
    const f = await fixture({ tool: true })
    const frames = await f.execute(async (config) => {
      const output: unknown[] = []
      f.phase("stream-open-begin")
      const stream = await f.agent.stream(seed(), { ...config, streamMode: ["values", "updates"] })
      f.phase("stream-open-done")
      for await (const frame of stream) {
        if (Array.isArray(frame) && (frame[0] === "values" || frame[0] === "updates"))
          f.phase(`frame-${frame[0]}`)
        output.push(frame)
      }
      f.phase("stream-consumed")
      return output
    })
    const selected = frames.map((value) => {
      if (!Array.isArray(value) || value.length !== 2)
        throw Error("ACTUAL_SHARED_MULTI_FRAME_REQUIRED")
      return value
    })
    expect(new Set(selected.map((value) => value[0]))).toEqual(new Set(["values", "updates"]))
    const values = selected.filter((value) => value[0] === "values")
    const final = messages(record(values.at(-1)?.[1]).messages)
    expect(final).toHaveLength(4)
    expect(final.filter(ToolMessage.isInstance)).toHaveLength(1)
    expect(final.at(-1)?.content).toBe("complete shared answer")
    expect(f.effects()).toBe(1)
    expect(f.requests).toHaveLength(2)
    expect(f.localTokenEstimates()).toBeGreaterThan(0)
    expect(f.unexpectedNetworkRequests()).toEqual([])
    const saved = await f.verifySaved(3)
    expect(saved.native.map(serializeFunctionConversationNativeMessage)).toEqual(
      final.map(serializeFunctionConversationNativeMessage)
    )
    await f.assertDrained()
  })

  it("returns both complete HTTP message chunks and the accepted completed value", async () => {
    const f = await fixture()
    const frames = await f.execute(async (config) => {
      const output: unknown[] = []
      const stream = await f.agent.stream(seed(), { ...config, streamMode: ["messages", "values"] })
      for await (const frame of stream) {
        if (Array.isArray(frame) && frame[0] === "messages") {
          expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("desktop")
          expect(f.runtimes[0].destination.threadId).not.toBe(f.threadId)
          expect(getLocalThreadRunLease(f.runtimes[0].destination.threadId)).toBeUndefined()
        }
        output.push(frame)
      }
      return output
    })
    const messageFrames = frames.filter((value) => Array.isArray(value) && value[0] === "messages")
    expect(f.raw.map((message) => message.content)).toEqual(["complete ", "shared answer"])
    const partials = messageFrames.flatMap((value) => {
      if (!Array.isArray(value) || !Array.isArray(value[1]) || value[1].length !== 2)
        throw Error("ACTUAL_SHARED_STREAM_MESSAGE_METADATA_REQUIRED")
      const [message, metadata] = value[1]
      expect(record(metadata).langgraph_node).toBe("model_request")
      if (AIMessageChunk.isInstance(message)) return [message.content]
      const wire = record(message)
      if (Array.isArray(wire.id) && wire.id.at(-1) === "AIMessageChunk")
        return [record(wire.kwargs).content]
      return []
    })
    expect(partials).toEqual(["complete ", "shared answer"])
    expect(partials.join("")).toBe("complete shared answer")
    const values = frames.filter((value) => Array.isArray(value) && value[0] === "values")
    const last = values.at(-1)
    if (!Array.isArray(last)) throw Error("ACTUAL_SHARED_FINAL_VALUE_REQUIRED")
    const final = messages(record(last[1]).messages)
    expect(final.at(-1)?.content).toBe("complete shared answer")
    expect(f.requests).toHaveLength(1)
    expect(f.effects()).toBe(0)
    const saved = await f.verifySaved(1)
    expect(saved.native.map(serializeFunctionConversationNativeMessage)).toEqual(
      final.map(serializeFunctionConversationNativeMessage)
    )
    await f.assertDrained()
  })

  it.each(["messages", "values"] as const)(
    "supports withConfig message defaults with an actual %s stream and full checkpoint",
    async (mode) => {
      const f = await fixture()
      const defaults: RunnableConfig & { streamMode: "messages" } = { streamMode: "messages" }
      const derived = f.agent.withConfig(defaults)
      const frames = await f.execute(async (config) => {
        const output: unknown[] = []
        const stream = await derived.stream(
          seed(),
          mode === "messages" ? config : { ...config, streamMode: "values" }
        )
        for await (const frame of stream) output.push(frame)
        return output
      })
      expect(f.raw.map((message) => message.content)).toEqual(["complete ", "shared answer"])
      expect(f.requests).toHaveLength(1)
      expect(f.effects()).toBe(0)
      const saved = await f.verifySaved(1)
      expect(saved.native.map((message) => message.content)).toEqual([
        "complete actual shared input",
        "complete shared answer"
      ])
      if (mode === "messages") {
        const partials = frames.flatMap((value) => {
          if (!Array.isArray(value) || value.length !== 2)
            throw Error("ACTUAL_SHARED_DEFAULT_MESSAGE_METADATA_REQUIRED")
          const [message, metadata] = value
          expect(record(metadata).langgraph_node).toBe("model_request")
          if (AIMessageChunk.isInstance(message)) return [message.content]
          const wire = record(message)
          if (Array.isArray(wire.id) && wire.id.at(-1) === "AIMessageChunk")
            return [record(wire.kwargs).content]
          return []
        })
        expect(partials).toEqual(["complete ", "shared answer"])
        expect(partials.join("")).toBe("complete shared answer")
      } else {
        const final = messages(record(frames.at(-1)).messages)
        expect(final.map(serializeFunctionConversationNativeMessage)).toEqual(
          saved.native.map(serializeFunctionConversationNativeMessage)
        )
      }
      await f.assertDrained()
    }
  )

  it("supports direct event iteration from the protected prelude through the complete model", async () => {
    const f = await fixture({ protected: true })
    const events = await f.execute(async (config) => {
      const output: unknown[] = []
      // The SDK merges full RunnableConfig callback metadata even though the agent's
      // stream configuration declaration omits it from fresh object literals.
      const configured: RunnableConfig & { version: "v2" } = {
        ...mergeConfigs(config, {
          metadata: { authorization: "Bearer synthetic-shared-prelude-value" }
        }),
        version: "v2"
      }
      // The SDK API is synchronous; callers do not await a Promise of an event stream.
      for await (const event of f.agent.streamEvents(seed(), configured)) output.push(event)
      return output
    })
    expect(record(events[0]).event).toBe("on_chain_start")
    expect(events.map((value) => record(value).event)).toContain("on_chat_model_stream")
    expect(record(events.at(-1)).event).toBe("on_chain_end")
    expect(JSON.stringify(events)).not.toContain("synthetic-shared-prelude-value")
    expect(f.requests).toHaveLength(1)
    await f.verifySaved(1)
    await f.assertDrained()
  })

  it("completes a filter with no public prelude without waiting for a first event to admit", async () => {
    const f = await fixture()
    const events = await f.execute(async (config) => {
      const output: unknown[] = []
      for await (const event of f.agent.streamEvents(
        seed(),
        { ...config, version: "v2" },
        { includeNames: ["no-actual-node-has-this-name"] }
      ))
        output.push(event)
      return output
    })
    expect(events).toEqual([])
    expect(f.requests).toHaveLength(1)
    await f.verifySaved(1)
    await f.assertDrained()
  })

  it("drains a held provider when returning early from a message stream", async () => {
    const f = await fixture({ hold: true })
    await f.execute(async (config) => {
      const assertParentMarker = captureParentAbortMarker(config)
      f.phase("stream-open-begin")
      const stream = await f.agent.stream(seed(), { ...config, streamMode: "messages" })
      f.phase("stream-open-done")
      f.phase("first-next-begin")
      const first = await stream.next()
      f.phase("first-next-done")
      expect(first.done).toBe(false)
      expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("desktop")
      expect(f.runtimes[0].destination.threadId).not.toBe(f.threadId)
      expect(getLocalThreadRunLease(f.runtimes[0].destination.threadId)).toBeUndefined()
      f.phase("return-begin")
      const returned = await stream.return()
      f.phase("return-done")
      assertParentMarker()
      expect(returned).toEqual({ done: true, value: undefined })
    })
    expect(f.requests).toHaveLength(1)
    expect(f.effects()).toBe(0)
    expect(f.runtimes.flatMap((runtime) => f.store.readRows(runtime.target.ref))).toEqual([])
    await f.assertDrained()
    expect(f.finished()).toBe(1)
  })

  it("aborts a true opening callback before admission without publishing prelude or entering a provider", async () => {
    const f = await fixture({ holdOpening: true })
    let frames = 0
    const run = f.execute(async (config) => {
      for await (const event of f.agent.streamEvents(seed(), { ...config, version: "v2" })) {
        void event
        frames++
      }
    })
    await f.openingEntered
    f.controller.abort(Error("ACTUAL_SHARED_STREAM_CALLER_CANCELLED"))
    f.release()
    const [settled] = await Promise.allSettled([run])
    expect(settled.status).toBe("rejected")
    expect(f.controller.signal.reason.message).toBe("ACTUAL_SHARED_STREAM_CALLER_CANCELLED")
    expect(frames).toBe(0)
    expect(f.requests).toEqual([])
    expect(f.effects()).toBe(0)
    expect(f.runtimes.flatMap((runtime) => f.store.readRows(runtime.target.ref))).toEqual([])
    await f.assertDrained()
  })

  it("returns an event stream before its first pull without opening SDK or provider work", async () => {
    const f = await fixture()
    await f.execute(async (config) => {
      const stream = f.agent.streamEvents(seed(), { ...config, version: "v2" })
      expect(typeof stream[Symbol.asyncIterator]).toBe("function")
      expect(await stream.return()).toEqual({ done: true, value: undefined })
    })
    expect(f.requests).toEqual([])
    expect(f.runtimes).toEqual([])
    expect(f.effects()).toBe(0)
    await f.assertDrained()
  })

  it("preserves an undefined cleanup rejection after an actual provider finally on return", async () => {
    const original = nativeLifetime.createFunctionConversationNativeSourceLifetimeFromInstallation
    let cleanupCalls = 0
    vi.spyOn(
      nativeLifetime,
      "createFunctionConversationNativeSourceLifetimeFromInstallation"
    ).mockImplementation((...args: Parameters<typeof original>) => {
      const actual = Reflect.apply(original, undefined, args) as ReturnType<typeof original>
      return Object.freeze({
        ...actual,
        async drain() {
          cleanupCalls++
          await actual.drain()
          throw undefined
        }
      })
    })
    const f = await fixture({ hold: true })
    await f.execute(async (config) => {
      const assertParentMarker = captureParentAbortMarker(config)
      f.phase("stream-open-begin")
      const stream = await f.agent.stream(seed(), { ...config, streamMode: "messages" })
      f.phase("stream-open-done")
      f.phase("first-next-begin")
      expect((await stream.next()).done).toBe(false)
      f.phase("first-next-done")
      f.phase("return-begin")
      const [result] = await Promise.allSettled([stream.return()])
      f.phase("return-settled")
      assertParentMarker()
      expect(result.status).toBe("rejected")
      if (result.status !== "rejected") throw Error("ACTUAL_SHARED_CLEANUP_REJECTION_REQUIRED")
      expect(result.reason).toBeUndefined()
    })
    expect(cleanupCalls).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(f.runtimes.flatMap((runtime) => f.store.readRows(runtime.target.ref))).toEqual([])
    await f.assertDrained()
    expect(f.finished()).toBe(1)
  })
})
