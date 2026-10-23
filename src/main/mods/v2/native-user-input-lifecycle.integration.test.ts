import { setTimeout as delay } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { functionUserInputInvoker } from "./native-user-input"
import * as requests from "../../services/user-input"

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

const threadId = "native-sdk-ask-lifecycle"
const sessions: FunctionSession[] = []
const controllers: AbortController[] = []

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  requests.cancelUserInputsForThread(threadId, "test cleanup")
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

function controller() {
  const result = new AbortController()
  controllers.push(result)
  return result
}

async function fixture() {
  const run = controller()
  const waiting = new Set<string>()
  const hooks = {
    onWaitStart: vi.fn(({ id }: { id: string }) => {
      waiting.add(id)
    }),
    onWaitEnd: vi.fn(({ id }: { id: string }) => {
      waiting.delete(id)
    })
  }
  const invoke = functionUserInputInvoker({
    threadId,
    abortSignal: run.signal,
    interactionWaitHooks: hooks
  })
  const callTool = vi.fn(async (_plugin: unknown, input: ModObject, signal: AbortSignal) => {
    if (input.tool === "request_user_input") return { result: await invoke(input, signal) }
    if (input.tool !== "read_file") throw Error("Unexpected native tool")
    return { result: "FOLLOWING_TOOL_COMPLETED" }
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start", async ($,e,next)=>{
      await $.command.register({name:"ask",description:"Ask"});
      return next(e)
    });
    on("command.run", {command:"ask"}, async ($)=>{
      const answer = await $.ui.ask("Continue?",["Continue","Stop"]);
      const following = await $.tool.call({tool:"read_file",file_path:"next.txt"});
      return {text:answer+":"+following.result}
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "native-ask",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId,
      callTool,
      publish: async (value) => value,
      assertLive: () => run.signal.throwIfAborted()
    }
  )
  sessions.push(session)
  return { session, run, waiting, hooks, callTool }
}

async function pendingRequest() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const request = requests.getPendingUserInputForThread(threadId)
    if (request) {
      expect(requests.acknowledgeUserInputRequest(request.requestId, threadId)).toBe(true)
      return request
    }
    await delay(5)
  }
  throw Error("The real SDK question did not open")
}

function answer(requestId: string) {
  return requests.submitUserInputResponse({
    requestId,
    answers: {
      mod_question: {
        type: "option",
        questionId: "mod_question",
        optionIndex: 0,
        label: "Continue",
        description: "Continue"
      }
    }
  })
}

it("continues actual QuickJS ui.ask after a delayed native answer and executes the following tool", async () => {
  const f = await fixture()
  const completion = f.session.run("ask", "")
  const request = await pendingRequest()
  await delay(35)
  expect(answer(request.requestId)).toBe(true)
  expect(await completion).toEqual({ text: "Continue:FOLLOWING_TOOL_COMPLETED" })
  expect(f.callTool).toHaveBeenCalledTimes(2)
  expect(f.hooks.onWaitEnd).toHaveBeenCalledTimes(1)
  expect(f.waiting.size).toBe(0)
})

it("releases an operation-cancelled ui.ask wait while its original run stays live and accepts a fresh question", async () => {
  const f = await fixture()
  const operation = controller()
  const completed = f.session.run("ask", "", operation.signal).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error })
  )
  const request = await pendingRequest()
  operation.abort(Error("Only the component operation stopped"))
  expect((await completed).error).toBeDefined()
  await expect.poll(() => f.waiting.size).toBe(0)
  expect(f.run.signal.aborted).toBe(false)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(answer(request.requestId)).toBe(false)
  expect(f.hooks.onWaitEnd).toHaveBeenCalledTimes(1)
  expect(f.callTool).toHaveBeenCalledTimes(1)

  const next = f.session.run("ask", "")
  const fresh = await pendingRequest()
  expect(fresh.requestId).not.toBe(request.requestId)
  expect(answer(fresh.requestId)).toBe(true)
  expect(await next).toEqual({ text: "Continue:FOLLOWING_TOOL_COMPLETED" })
  expect(f.waiting.size).toBe(0)
  expect(f.hooks.onWaitEnd).toHaveBeenCalledTimes(2)
})

it("does not resume the real native run after it is cancelled independently of the SDK operation", async () => {
  const f = await fixture()
  const operation = controller()
  const completed = f.session.run("ask", "", operation.signal).catch((error: unknown) => error)
  const request = await pendingRequest()
  f.run.abort(Error("Original native run stopped"))
  const error = await completed
  expect(error).toBeInstanceOf(Error)
  expect(isModObject(error) && "text" in error).toBe(false)
  expect(operation.signal.aborted).toBe(false)
  expect(requests.getPendingUserInputForThread(threadId)).toBeNull()
  expect(answer(request.requestId)).toBe(false)
  expect(f.hooks.onWaitEnd).not.toHaveBeenCalled()
  expect(f.callTool).toHaveBeenCalledTimes(1)
})
