import { getEventListeners } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: () => {} }
      }
    ]
  }
}))
vi.mock("../../app-attention-events", () => ({ emitAppAttention: () => {} }))
import * as requests from "../../services/user-input"
import { FunctionDispatcher, type FunctionDispatchOptions } from "../../mods/v2/dispatcher"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { createRequestUserInputTool } from "./user-input-tool"
import { modCallContext } from "../../mods/context"
import { ModsManager, setModsManager } from "../../mods/manager"
import { withModToolCall } from "../../mods/adapters"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { FunctionSession } from "../../mods/v2/session"

const threadId = "real-user-input-cancellation"
const controllers: AbortController[] = []
const guests: FunctionGuestRuntime[] = []
const managers: ModsManager[] = []
const sessions: FunctionSession[] = []
const roots: string[] = []
const input = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Continue?",
      options: [
        { label: "Continue", description: "Resume the original task" },
        { label: "Stop", description: "Stop the original task" }
      ]
    }
  ]
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  requests.cancelUserInputsForThread(threadId, "test cleanup")
  setModsManager(undefined)
  for (const manager of managers.splice(0)) manager.close()
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await Promise.all(guests.splice(0).map((guest) => guest.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
function controller() {
  const value = new AbortController()
  controllers.push(value)
  return value
}
async function pendingRequest() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const request = requests.getPendingUserInputForThread(threadId)
    if (request) {
      expect(requests.acknowledgeUserInputRequest(request.requestId, threadId)).toBe(true)
      return request
    }
    await delay(5)
  }
  throw Error("The real native input request did not open")
}
function answer(requestId: string) {
  return requests.submitUserInputResponse({
    requestId,
    answers: {
      choice: {
        type: "option",
        questionId: "choice",
        optionIndex: 0,
        label: "Continue",
        description: "Resume the original task"
      }
    }
  })
}
function toolFixture() {
  const run = controller()
  const waiting = new Set<string>()
  const waits = {
    onWaitStart: vi.fn(({ id }: { id: string }) => {
      waiting.add(id)
    }),
    onWaitEnd: vi.fn(({ id }: { id: string }) => {
      waiting.delete(id)
    })
  }
  const rejected = vi.fn()
  const tool = createRequestUserInputTool({
    threadId,
    abortSignal: run.signal,
    interactionWaitHooks: waits,
    onRejected: rejected
  })
  return { run, waits, waiting, rejected, tool }
}
async function dispatcherFixture(ambientOperation = false) {
  // Matches the original state Mod's non-owned tool path, without an ignored
  // delivery, external plugin or environment gate in this default regression.
  const guest = await FunctionGuestRuntime.create(
    'var __cmbFunctionMod={register(on){on("tool.call",($,e,next)=>next(e))}}'
  )
  guests.push(guest)
  const dispatcher = new FunctionDispatcher([
    { name: "pass-through", root: "/plugin", tier: "user", guest, capabilities: [] }
  ])
  const native = toolFixture()
  const core: FunctionDispatchOptions["core"] = async (_event, received, context) => {
    if (received.tool !== "request_user_input") return { result: "FOLLOWING_TOOL_COMPLETED" }
    const invoke = () =>
      native.tool.invoke(
        input,
        ambientOperation ? { signal: native.run.signal } : { signal: context.signal }
      )
    const text = ambientOperation
      ? await modCallContext.run(
          {
            identity: {
              callId: context.callId,
              threadId,
              turnId: "turn",
              agentId: "main",
              workspace: "/workspace",
              origin: "model",
              grantEpoch: 0
            },
            toolId: "host:request_user_input",
            routeClaimed: false,
            protectedOutput: false,
            readOnly: false,
            signal: context.signal
          },
          invoke
        )
      : await invoke()
    return { result: JSON.parse(text) }
  }
  return {
    ...native,
    dispatch: (tool: string, timeoutMs = 350) =>
      dispatcher.dispatch(
        "tool.call",
        { tool, tool_use_id: "actual-" + tool },
        { signal: native.run.signal, timeoutMs, core }
      )
  }
}

it("continues the real tool after delayed user submission, then executes the next tool", async () => {
  const f = await dispatcherFixture()
  const completed = f.dispatch("request_user_input", 700)
  const request = await pendingRequest()
  await delay(40)
  expect(answer(request.requestId)).toBe(true)
  expect(await completed).toMatchObject({ value: { result: { status: "submitted" } } })
  expect(f.waits.onWaitStart).toHaveBeenCalledTimes(1)
  expect(f.waits.onWaitEnd).toHaveBeenCalledTimes(1)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(await f.dispatch("read_file")).toMatchObject({
    value: { result: "FOLLOWING_TOOL_COMPLETED" }
  })
})

it.each([false, true])(
  "clears real pending input on a dispatch deadline and admits a fresh request (native operation context: %s)",
  async (ambient) => {
    const f = await dispatcherFixture(ambient)
    const completed = f.dispatch("request_user_input").then(
      () => undefined,
      (error) => error
    )
    const request = await pendingRequest()
    const error = await completed
    expect(error).toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
    expect(error.message).toContain("组件处理超过总等待期限")
    expect(f.run.signal.aborted).toBe(false)
    expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
    expect(answer(request.requestId)).toBe(false)
    expect(f.waits.onWaitEnd).toHaveBeenCalledTimes(1)
    expect(f.waiting.size).toBe(0)
    const next = f.dispatch("request_user_input", 700)
    const fresh = await pendingRequest()
    expect(fresh.requestId).not.toBe(request.requestId)
    expect(answer(fresh.requestId)).toBe(true)
    expect(await next).toMatchObject({ value: { result: { status: "submitted" } } })
    expect(f.waiting.size).toBe(0)
    expect(await f.dispatch("read_file")).toMatchObject({
      value: { result: "FOLLOWING_TOOL_COMPLETED" }
    })
  }
)

it("preserves run cancellation, refuses a late reply and never resumes its terminal interaction", async () => {
  const f = toolFixture(),
    call = controller()
  const completed = f.tool.invoke(input, { signal: call.signal })
  const request = await pendingRequest()
  f.run.abort(Error("Native run stopped"))
  expect(JSON.parse(await completed)).toMatchObject({ status: "cancelled" })
  expect(answer(request.requestId)).toBe(false)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(f.waits.onWaitEnd).not.toHaveBeenCalled()
  expect(f.rejected).toHaveBeenCalledExactlyOnceWith("user-input-cancelled")
})

it("does not open an interaction or publish waiting for an already cancelled native run", async () => {
  const f = toolFixture()
  const operation = controller()
  f.run.abort(Error("Native run already stopped"))
  const result = await f.tool.invoke(input, { signal: operation.signal })
  expect(JSON.parse(result)).toMatchObject({
    status: "cancelled",
    error: "Native run already stopped"
  })
  expect(operation.signal.aborted).toBe(false)
  expect(f.waits.onWaitStart).not.toHaveBeenCalled()
  expect(f.waits.onWaitEnd).not.toHaveBeenCalled()
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(f.rejected).toHaveBeenCalledExactlyOnceWith("user-input-cancelled")
})

it("cancels the native question through the actual withModToolCall bridge even when Runnable keeps the run signal", async () => {
  const f = toolFixture()
  const root = await mkdtemp(join(tmpdir(), "native-input-bridge-"))
  roots.push(root)
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  managers.push(manager)
  manager.configure(root, true, false)
  setModsManager(manager)
  const guest = await FunctionGuestRuntime.create(
    'var __cmbFunctionMod={register(on){on("tool.call",($,e,next)=>next(e))}}'
  )
  guests.push(guest)
  const dispatcher = new FunctionDispatcher([
    { name: "pass-through", root, tier: "user", guest, capabilities: [] }
  ])
  manager.attachFunctions({
    invalidate: () => {},
    closeThread: () => {},
    close: () => {},
    toolCall: async (binding, received, core) => {
      const result = await dispatcher.dispatch("tool.call", received, {
        signal: binding.signal,
        timeoutMs: 350,
        core: (_event, value, context) => {
          if (!context.signal) throw Error("Missing original dispatcher signal")
          return core(value, context.signal)
        }
      })
      if (!isModObject(result.value)) throw Error("Invalid real native tool result")
      return result.value
    }
  })
  const completion = withModToolCall(
    { workspace: root, threadId, turnId: "native-turn", signal: f.run.signal },
    { toolCall: { name: "request_user_input", id: "native-question", args: input } },
    new Set(["request_user_input"]),
    async () => {
      expect(modCallContext.getStore()).toMatchObject({
        toolId: "host:request_user_input",
        identity: { threadId }
      })
      return f.tool.invoke(input, { signal: f.run.signal })
    }
  ).then(
    () => undefined,
    (error) => error
  )
  const request = await pendingRequest()
  expect(await completion).toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  expect(f.run.signal.aborted).toBe(false)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(answer(request.requestId)).toBe(false)
  expect(f.waits.onWaitEnd).toHaveBeenCalledTimes(1)
  expect(f.waiting.size).toBe(0)
})

it("retires a real Function session with a pending native question, then permits a fresh session and following tool", async () => {
  const f = toolFixture()
  const root = await mkdtemp(join(tmpdir(), "native-input-retirement-"))
  roots.push(root)
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  managers.push(manager)
  manager.configure(root, true, false)
  setModsManager(manager)
  const createSession = async () => {
    const guest = await FunctionGuestRuntime.create(
      'var __cmbFunctionMod={register(on){on("tool.call",($,e,next)=>next(e))}}'
    )
    const session = new FunctionSession(
      [{ name: "retirable", root, tier: "user", guest, capabilities: [] }],
      { workspace: root, threadId, assertLive: () => undefined, publish: async (value) => value }
    )
    sessions.push(session)
    return session
  }
  let active = await createSession()
  manager.attachFunctions({
    invalidate: () => {},
    closeThread: () => {},
    close: () => {},
    toolCall: (binding, received, core) => active.interceptTool(received, binding.signal, core)
  })
  const invoke = (name: string) =>
    withModToolCall(
      { workspace: root, threadId, turnId: "native-turn", signal: f.run.signal },
      {
        toolCall: { name, id: "native-" + name, args: name === "request_user_input" ? input : {} }
      },
      new Set(["request_user_input", "read_file"]),
      async () =>
        name === "request_user_input"
          ? f.tool.invoke(input, { signal: f.run.signal })
          : "FOLLOWING_TOOL_COMPLETED"
    )
  const completion = invoke("request_user_input").then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error })
  )
  const original = await pendingRequest()
  await active.close(true)
  const retired = await completion
  expect(retired.error).toBeDefined()
  expect(f.run.signal.aborted).toBe(false)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(answer(original.requestId)).toBe(false)
  expect(f.waiting.size).toBe(0)
  active = await createSession()
  const next = invoke("request_user_input")
  const fresh = await pendingRequest()
  expect(fresh.requestId).not.toBe(original.requestId)
  expect(answer(fresh.requestId)).toBe(true)
  const response = await next
  if (typeof response !== "string") throw Error("Expected native user input JSON text")
  expect(JSON.parse(response)).toMatchObject({ status: "submitted" })
  expect(await invoke("read_file")).toBe("FOLLOWING_TOOL_COMPLETED")
  expect(f.waiting.size).toBe(0)
})

it.each([
  { thread: "another-thread", tool: "host:request_user_input" },
  { thread: threadId, tool: "host:execute" }
])("ignores a foreign native cancellation scope: $thread / $tool", async (sample) => {
  const f = toolFixture(),
    foreign = controller()
  foreign.abort(Error("Foreign operation stopped"))
  const completed = modCallContext.run(
    {
      identity: {
        callId: "foreign",
        threadId: sample.thread,
        turnId: "turn",
        agentId: "main",
        workspace: "/workspace",
        origin: "model",
        grantEpoch: 0
      },
      toolId: sample.tool,
      routeClaimed: false,
      protectedOutput: false,
      readOnly: false,
      signal: foreign.signal
    },
    () => f.tool.invoke(input)
  )
  const request = await pendingRequest()
  expect(answer(request.requestId)).toBe(true)
  expect(JSON.parse(await completed)).toMatchObject({ status: "submitted" })
  expect(f.rejected).not.toHaveBeenCalled()
})

it.each(["call-first", "run-first"] as const)(
  "settles competing signals once and removes the native request listener: %s",
  async (order) => {
    const observed = vi.spyOn(requests, "requestUserInput")
    const f = toolFixture(),
      call = controller()
    const removed = vi.fn(),
      stop = requests.subscribeRemovedUserInput(removed)
    try {
      const completed = f.tool.invoke(input, { signal: call.signal }).then(
        (value) => ({ value: JSON.parse(value), error: undefined }),
        (error) => ({ value: undefined, error })
      )
      const request = await pendingRequest()
      const active = observed.mock.calls[0][0].abortSignal
      expect(active).toBeDefined()
      if (!active) throw Error("Missing native cancellation signal")
      expect(getEventListeners(active, "abort")).toHaveLength(1)
      const first = order === "call-first" ? call : f.run
      const second = order === "call-first" ? f.run : call
      first.abort(Error("First cancellation"))
      const pendingAfterFirst = requests.getPendingUserInputForThread(threadId)
      second.abort(Error("Later cancellation"))
      // Runnable keeps its original rejection contract; cancelling its native
      // request must not turn the operation into a successful tool result.
      expect((await completed).error).toBe(call.signal.reason)
      expect(pendingAfterFirst).toBeNull()
      expect(removed).toHaveBeenCalledExactlyOnceWith(request.requestId, threadId)
      expect(getEventListeners(active, "abort")).toHaveLength(0)
      expect(f.rejected).toHaveBeenCalledTimes(1)
      expect(answer(request.requestId)).toBe(false)
    } finally {
      stop()
    }
  }
)
