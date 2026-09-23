import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { SESSION_CAPABILITIES } from "./session"

it("never presents an event-only adapter as a callable guest SDK method", async () => {
  const matrix = JSON.parse(
    readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")
  ) as {
    sdk: Array<{ members: Array<{ name: string; implementationStatus: string }> }>
  }
  const claims = matrix.sdk
    .flatMap((group) => group.members)
    .filter((row) => ["full", "adapted"].includes(row.implementationStatus))
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",($)=>({text:JSON.stringify(
      ${JSON.stringify(claims.map((row) => row.name))}.map(name=>{
        const [noun,method]=name.split(".");return [name,typeof $[noun]?.[method]];
      })
    )}));
  }}`)
  try {
    const result = await guest.invoke("0", {}, async () => ({}), {
      event: "session.start",
      origin: { plugin: "engine", tier: "core" },
      plugin: { name: "sdk-audit", root: "/sdk-audit" },
      capabilities: [...SESSION_CAPABILITIES]
    })
    const values = JSON.parse(String((result.value as { text: string }).text)) as string[][]
    expect(values.filter(([, type]) => type !== "function").map(([name]) => name)).toEqual([])
  } finally {
    guest.dispose()
  }
})
