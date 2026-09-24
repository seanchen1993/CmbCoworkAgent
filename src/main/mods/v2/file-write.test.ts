import { randomUUID } from "node:crypto"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { withFunctionExecution } from "./execution-context"
import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionPlugin } from "./dispatcher"
import type { ModObject } from "../../../shared/mods/types"

const close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of close.splice(0)) await fn()
})
async function fixture(hook = "", answer: ModObject = { result: { path: "written" } }) {
  const workspace = resolve("output/fs-write-unit")
  const threadId = randomUUID()
  claimLocalThreadRunLease({ threadId, owner: "mods", runId: "write" })
  let live = true
  const callTool = vi.fn<
    (plugin: FunctionPlugin, input: ModObject, signal: AbortSignal) => Promise<ModObject>
  >(async () => answer)
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"write",description:"write"});return next(e)});
    on("command.run",{command:"write"},async($,e)=>{
      try {const value=await $.fs.write(...JSON.parse(e.args));return {text:String(value)}}
      catch(error){return {text:"ERROR:"+(error.code||error.message)}}
    });
    ${hook}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "writer",
        root: workspace,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId,
      assertLive: () => {
        if (!live) throw Error("revoked")
      },
      publish: async (v) => v,
      callTool
    }
  )
  close.push(async () => {
    await session.close()
    guest.dispose()
    releaseLocalThreadRunLease(threadId, "mods", "write")
  })
  return {
    workspace,
    session,
    callTool,
    revoke: () => {
      live = false
    },
    run: (args: unknown[]) =>
      withFunctionExecution(
        { workspace, threadId, leased: true, immediate: false, userInitiated: true },
        () => session.run("write", JSON.stringify(args))
      )
  }
}

it("maps real guest fs.write arguments to the native host exactly once after hook rewriting", async () => {
  const f = await fixture(
    'on("fs.write",async($,e,next)=>next({...e,path:"nested/changed.md",text:e.text+"!"}));'
  )
  expect(await f.run(["original.md", "content"])).toEqual({ text: "undefined" })
  expect(f.callTool).toHaveBeenCalledTimes(1)
  expect(f.callTool.mock.calls[0][1]).toMatchObject({
    tool: "write_file",
    file_path: resolve(f.workspace, "nested/changed.md"),
    content: "content!",
    tool_use_id: expect.any(String)
  })
})
it("preserves an empty fs.write veto without invoking a native write", async () => {
  const f = await fixture('on("fs.write",()=>({deny:""}));')
  expect(await f.run(["out.md", "content"])).toEqual({ text: "ERROR:MODS_OPERATION_DENIED" })
  expect(f.callTool).not.toHaveBeenCalled()
})
it.each([
  { args: ["out.md"] },
  { args: ["out.md", 2] },
  { args: ["out.md", "content", "extra"] },
  { args: ["", "content"] }
])("rejects invalid positional arguments before native writing $args", async ({ args }) => {
  const f = await fixture()
  expect(await f.run(args)).toEqual({ text: "ERROR:MODS_FS_WRITE_ARGUMENTS" })
  expect(f.callTool).not.toHaveBeenCalled()
})
it("keeps the existing native tool parameter budget", async () => {
  const f = await fixture()
  expect(await f.run(["out.md", "x".repeat(16001)])).toEqual({ text: "ERROR:MODS_TOOL_ARGUMENTS" })
  expect(f.callTool).not.toHaveBeenCalled()
})
it("does not convert a native failure envelope into successful void", async () => {
  const f = await fixture("", { result: { error: "disk full" }, isError: true, text: "disk full" })
  expect(await f.run(["out.md", "content"])).toEqual({ text: "ERROR:MODS_FS_WRITE_FAILED" })
  expect(f.callTool).toHaveBeenCalledTimes(1)
})
it("does not accept a non-void hook replacement and retains normal optional-hook fallback", async () => {
  const f = await fixture('on("fs.write",()=>({value:true}));')
  expect(await f.run(["out.md", "content"])).toEqual({ text: "undefined" })
  expect(f.callTool).toHaveBeenCalledTimes(1)
})
it("rejects late native success after revocation without claiming a rollback", async () => {
  const f = await fixture()
  f.callTool.mockImplementationOnce(async () => {
    f.revoke()
    return { result: { path: "written" } }
  })
  await expect(f.run(["out.md", "content"])).rejects.toThrow()
  expect(f.callTool).toHaveBeenCalledTimes(1)
})
