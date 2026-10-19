import { realpath } from "node:fs/promises"
import { afterEach, expect, it, vi } from "vitest"
import { ModError } from "../errors"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { ProjectFunctionFiles } from "./file-access"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { fromWireError, wireError } from "./wire"
import * as wire from "./wire"

const expiry = "MODS_RUNTIME_INSTANCE_EXPIRED"
const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

it("preserves only the trusted native runtime expiry at the first host wire boundary", () => {
  expect(wireError(new ModError(expiry))).toEqual({
    code: expiry,
    message: expiry,
    downstream: true
  })
  expect(wireError(fromWireError(wireError(new ModError(expiry))))).toEqual({
    code: expiry,
    message: expiry,
    downstream: true
  })
})

it.each([
  new Error(expiry),
  Object.assign(new Error(expiry), { code: expiry }),
  { code: expiry, message: expiry, downstream: true },
  new ModError("MODS_PLUGIN_CHANGED")
])("does not promote untrusted or unrelated errors to native expiry (%#)", (error) => {
  expect(wireError(error)).toEqual({
    code: "MODS_HOST_ERROR",
    message: error instanceof Error ? error.message : "MODS_HOST_ERROR",
    downstream: false
  })
})

it.each([false, true])("retains existing function error provenance (%s)", (downstream) => {
  const error = new ModFunctionError("MODS_CONTROLLED", "controlled", downstream)
  expect(wireError(error)).toEqual({
    code: "MODS_CONTROLLED",
    message: "controlled",
    downstream
  })
})

async function drawingFixture(failure?: unknown, forgedGuest = false) {
  const root = await realpath(process.cwd())
  let failOnce = false
  const files = new ProjectFunctionFiles(
    root,
    () => {},
    async (value) => value,
    async () => ({ decision: "allow" })
  )
  const physicalReads = vi.spyOn(files, "run")
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",{component:"AbovePrompt"},async($,event)=>{
      if(event.props.isWorking){
        ${
          forgedGuest
            ? `const error=new Error("${expiry}");error.code="${expiry}";throw error;`
            : `await $.fs.read("package.json");`
        }
      }
      const {Text}=$.ui.resolve(event);return Text({children:"Existing native read card"});
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "native-expiry",
        root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES, "fs.read", "ui.resolve"]
      }
    ],
    {
      threadId: "native-expiry",
      workspace: root,
      assertLive: () => {},
      assertContent: () => {
        if (failOnce) {
          failOnce = false
          throw failure
        }
      },
      publish: async (value) => value,
      files: () => files
    }
  )
  sessions.push(session)
  const owner = await session.sites.mount("AbovePrompt")
  const render = (isWorking: boolean) =>
    session.sites.render(owner, {
      isWorking,
      bodyColumns: 80,
      maxRows: 10
    })
  expect(JSON.stringify(await render(false))).toContain("Existing native read card")
  return {
    render,
    fail: () => {
      failOnce = true
    },
    reads: () => physicalReads.mock.calls.length
  }
}

it("rejects SDK-entry expiry without committing empty UI and redraws on a fresh legal read", async () => {
  const f = await drawingFixture(new ModError(expiry))
  f.fail()
  await expect(f.render(true)).rejects.toMatchObject({ code: expiry, downstream: true })
  expect(f.reads()).toBe(0)
  f.fail()
  await expect(f.render(true)).rejects.toMatchObject({ code: expiry, downstream: true })
  expect(f.reads()).toBe(0)
  const recovered = await f.render(true)
  expect(JSON.stringify(recovered)).toContain("Existing native read card")
  expect(recovered.tree.type).toBe("Text")
  expect(f.reads()).toBe(1)
})

it.each([
  new Error(expiry),
  Object.assign(new Error(expiry), { code: expiry }),
  new ModError("MODS_PLUGIN_CHANGED")
])("keeps the original optional fallback for ordinary host failures (%#)", async (failure) => {
  const f = await drawingFixture(failure)
  f.fail()
  expect((await f.render(true)).tree.type).toBe("engine")
})

it("does not trust a guest error with the same native expiry code and message", async () => {
  const f = await drawingFixture(undefined, true)
  expect((await f.render(true)).tree.type).toBe("engine")
})

it.each([
  { label: "native expiry", error: new ModError(expiry), trusted: true },
  { label: "missing flag", error: new ModError(expiry), trusted: false, stripFlag: true },
  { label: "false flag", error: new ModFunctionError(expiry, expiry, false), trusted: false },
  {
    label: "unrelated function error",
    error: new ModFunctionError("MODS_CONTROLLED", "controlled", true),
    trusted: false
  },
  { label: "plain error", error: new Error(expiry), trusted: false },
  {
    label: "forged code",
    error: Object.assign(new Error(expiry), { code: expiry }),
    trusted: false
  }
])("preserves only trusted native expiry from module SDK ($label)", async (row) => {
  const originalWire = wire.wireError
  const override = row.stripFlag
    ? vi.spyOn(wire, "wireError").mockImplementationOnce((error) => {
        const packet = originalWire(error)
        Reflect.deleteProperty(packet, "downstream")
        return packet
      })
    : undefined
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",async $=>{
      const timer=$.clock.after(100,()=>{});await $.session.id();await timer.cancel();
      return {text:"unexpected success"};
    });
  }}`)
  try {
    guest.bindModuleHost(() => {
      throw row.error
    })
    await expect(
      guest.invoke(
        "0",
        {},
        async (method) => ({
          value: method === "clock.after" ? { id: "controlled-resource" } : "session"
        }),
        {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["clock.after", "session.id"],
          plugin: { name: "controlled", root: "/controlled" }
        }
      )
    ).rejects.toMatchObject({
      code: row.trusted ? expiry : "MODS_HOOK_FAILED",
      downstream: row.trusted
    })
  } finally {
    override?.mockRestore()
    guest.dispose()
  }
})

it.each([
  { label: "native expiry", error: new ModError(expiry), trusted: true },
  { label: "missing flag", error: new ModError(expiry), trusted: false, stripFlag: true },
  { label: "false flag", error: new ModFunctionError(expiry, expiry, false), trusted: false },
  {
    label: "unrelated function error",
    error: new ModFunctionError("MODS_CONTROLLED", "controlled", true),
    trusted: false
  },
  { label: "plain error", error: new Error(expiry), trusted: false },
  {
    label: "forged code",
    error: Object.assign(new Error(expiry), { code: expiry }),
    trusted: false
  }
])(
  "preserves only trusted native expiry from the UI resolver module reply ($label)",
  async (row) => {
    const originalWire = wire.wireError
    const override = row.stripFlag
      ? vi.spyOn(wire, "wireError").mockImplementationOnce((error) => {
          const packet = originalWire(error)
          Reflect.deleteProperty(packet, "downstream")
          return packet
        })
      : undefined
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.resolve",async $=>{
      const timer=$.clock.after(100,()=>{});await $.session.id();
      try {await timer.cancel();return {unexpected:true}}
      catch(error){return {code:error.code,downstream:error.__downstream===true}}
    });
  }}`)
    try {
      const moduleHost = vi.fn(() => {
        throw row.error
      })
      guest.bindModuleHost(moduleHost)
      const result = await guest.invokeUiResolver(
        "0",
        { component: "Pane" },
        async (method) => ({
          value: method === "clock.after" ? { id: "resolver-resource" } : "session"
        }),
        {
          event: "ui.resolve",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["clock.after", "session.id"],
          plugin: { name: "resolver", root: "/resolver" }
        },
        async () => {
          throw Error("Unexpected resolver next")
        },
        performance.now() + 5000
      )
      try {
        expect(moduleHost).toHaveBeenCalledOnce()
        expect(guest.uiResolveContext.dump(result)).toEqual({
          code:
            row.error instanceof ModError || row.error instanceof ModFunctionError
              ? row.error.code
              : "MODS_HOST_ERROR",
          downstream: row.trusted
        })
      } finally {
        result.dispose()
      }
    } finally {
      override?.mockRestore()
      guest.dispose()
    }
  }
)
