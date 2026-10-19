import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionProcessHost } from "./process-sdk"
import { withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function fixture(body: string) {
  const workspace = await mkdtemp(join(tmpdir(), "platform-flow-lifetime-"))
  const threadId = randomUUID()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on.capability({apiVersion:"devclaw.capability/v1",id:"work",version:"1.0.0",title:"Work",
      scope:"conversation",stateSchema:{type:"object"},actions:[{id:"run",title:"Run",
        inputSchema:{type:"object"},outputSchema:{type:"object"},
        requiredPermissions:["process.spawn"],cancellable:true,idempotency:"keyed"}]},
      {act:async($,event)=>{${body}}})
  }}`)
  const approve = vi.fn(async () => {})
  const session = new FunctionSession(
    [
      {
        name: "flow-process",
        root: workspace,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId,
      assertLive() {
        // This fixture keeps its session source and grants unchanged throughout execution.
      },
      publish: async (value) => value,
      cwd: () => workspace,
      authorizeProcess: approve
    }
  )
  expect(
    claimLocalThreadRunLease({ threadId, owner: "mods", runId: "native-flow-test" }).acquired
  ).toBe(true)
  closes.push(async () => {
    releaseLocalThreadRunLease(threadId, "mods", "native-flow-test")
    await session.close(true)
    await rm(workspace, { recursive: true, force: true })
  })
  const run = (signal: AbortSignal) =>
    withFunctionExecution(
      {
        workspace,
        threadId,
        userInitiated: true,
        leased: true,
        immediate: false
      },
      () =>
        session.runPlatformFlowAction(
          { provider: "flow-process", id: "work", version: "1.0.0" },
          "run",
          {
            version: 1,
            input: {},
            config: {},
            task: "Physical task",
            runId: "flow",
            stepId: "step",
            executionId: "one"
          },
          "flow:actual-process",
          signal
        )
    )
  return { session, run, approve }
}

it("waits for the actual process result and settles its resource before returning a terminal flow action", async () => {
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    "process.stdout.write('physical-output');setTimeout(()=>{},80)"
  ])
  const f = await fixture(`const stream=$.process.spawn({argv:${argv}});
    let text="";for await(const chunk of stream)text+=chunk.text;
    const result=await stream.result;return {status:result.code===0?"succeeded":"failed",output:{text,code:result.code}}`)
  const result = await f.run(new AbortController().signal)
  expect(result).toMatchObject({
    status: "succeeded",
    value: {
      status: "succeeded",
      output: { text: "physical-output", code: 0 }
    }
  })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.session.ownedResourceCount).toBe(0)
})

it("does not finish cancellation until the real process backend acknowledges physical cleanup", async () => {
  const actual = FunctionProcessHost.prototype.spawn
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  let result: Promise<unknown> | undefined
  const spy = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    result = backend.result
    return {
      ...backend,
      close: async () => {
        entered.resolve()
        await release.promise
        try {
          await backend.close()
        } finally {
          closed.resolve()
        }
      }
    }
  })
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    "process.stdout.write('started');setInterval(()=>{},1000)"
  ])
  const f = await fixture(`const stream=$.process.spawn({argv:${argv}});
    for await(const chunk of stream){};return {status:"succeeded",output:{code:(await stream.result).code}}`)
  const controller = new AbortController()
  let settled = false
  const pending = f.run(controller.signal).finally(() => {
    settled = true
  })
  void pending.catch(() => {})
  try {
    await expect.poll(() => f.approve.mock.calls.length).toBe(1)
    await expect.poll(() => result !== undefined).toBe(true)
    controller.abort(Error("cancel actual flow"))
    await entered.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await pending.catch(() => {})
    await closed.promise
    await result!.catch(() => {})
    expect(settled).toBe(true)
    expect(f.session.ownedResourceCount).toBe(0)
  } finally {
    release.resolve()
    await pending.catch(() => {})
    spy.mockRestore()
  }
})

it("drains an unawaited background process before publishing its callback result", async () => {
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    "process.stdout.write('started');setInterval(()=>{},1000)"
  ])
  const f = await fixture(`const stream=$.process.spawn({argv:${argv}});
    await stream[Symbol.asyncIterator]().next();
    return {status:"running",output:{submitted:true}}`)
  const result = await f.run(new AbortController().signal)
  expect(result).toMatchObject({ status: "succeeded", value: { status: "running" } })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.session.ownedResourceCount).toBe(0)
})
