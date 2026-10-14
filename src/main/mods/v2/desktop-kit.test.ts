import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin, projectFunctionComponents } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"

it("the two shipped independent packages really compose a protected copy", async () => {
  const compiled = await Promise.all(
    ["mods-desktop-selection", "mods-copy-prefix"].map((name) =>
      compileFunctionPlugin(resolve("examples", name))
    )
  )
  const copied: string[] = [],
    plugins: FunctionPlugin[] = []
  for (const kit of compiled) {
    const projected = projectFunctionComponents(kit, { mode: "all", ids: [], config: {} })
    plugins.push({
      name: kit.name,
      root: kit.root,
      tier: "user" as const,
      guest: await FunctionGuestRuntime.create(projected.code, projected.options),
      capabilities: [...SESSION_CAPABILITIES]
    })
  }
  const caller = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"kit-probe",description:"probe"});return next(e)});
    on("command.run",{command:"kit-probe"},async($)=>({text:JSON.stringify(await $.ui.copy({text:"chosen"}))}));
  }}`)
  const session = new FunctionSession(
    [
      ...plugins,
      {
        name: "probe",
        root: "/probe",
        tier: "user",
        guest: caller,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/kit",
      threadId: "kit",
      assertLive: () => undefined,
      publish: async (value) => value,
      prepareDesktop: async () => ({
        assertLive: () => undefined,
        copy: async (input) => {
          copied.push(input.text)
          return { isCopied: true }
        },
        selection: async () => undefined,
        clearSelection: async () => undefined,
        drawings: async () => []
      })
    }
  )
  try {
    await session.start()
    expect((await session.commands()).map((row) => row.name)).toContain("selection-board")
    expect((await session.run("kit-probe", "")).text).toBe('{"isCopied":true}')
    expect(copied).toEqual(["[检视摘录] chosen"])
  } finally {
    await session.close()
  }
})
