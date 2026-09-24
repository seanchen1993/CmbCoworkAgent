import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { SESSION_CAPABILITIES } from "./session"

interface Claim {
  name: string
  availability?: string
}
const matrix = JSON.parse(
  readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")
) as { globals: Claim[]; sdk: Array<{ members: Claim[] }>; operationEvents: Claim[] }

it.each(["hooks", "Client"])(
  "matches declared global availability in a real %s VM",
  async (kind) => {
    expect(matrix.globals.filter((row) => !row.availability).map((row) => row.name)).toEqual([])
    const expression = `Object.fromEntries(${JSON.stringify(matrix.globals.map((row) => row.name))}
    .map(name=>[name,typeof globalThis[name]]))`
    const code =
      kind === "hooks"
        ? `var __cmbFunctionMod={register(on){on("command.run",()=>${expression})}}`
        : `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
    const guest = await FunctionGuestRuntime.create(code, { plugin: "availability" })
    try {
      const result = await guest.invoke(
        "0",
        kind === "hooks" ? {} : { kind: "render", props: {}, columns: 80, rows: 20 },
        async () => {
          throw Error("global inspection must not call the host")
        },
        {
          event: kind === "hooks" ? "command.run" : "surface.update",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "availability", root: "/plugin" }
        }
      )
      const values =
        kind === "hooks"
          ? (result.value as Record<string, string>)
          : (JSON.parse(
              (result.value as { tree: { children: string[] } }).tree.children[0]
            ) as Record<string, string>)
      for (const row of matrix.globals) {
        expect(["bounded", "metadata", "unavailable"], row.name).toContain(row.availability)
        if (row.availability === "bounded") expect(values[row.name], row.name).not.toBe("undefined")
        else expect(values[row.name], row.name).toBe("undefined")
      }
    } finally {
      guest.dispose()
    }
  }
)

it("does not expose SDK members explicitly declared unavailable", async () => {
  const claims = [
    ...new Map(
      [...matrix.sdk.flatMap((group) => group.members), ...matrix.operationEvents]
        .filter((row) => row.availability === "unavailable")
        .map((row) => [row.name, row])
    ).values()
  ]
  expect(claims.length).toBeGreaterThan(10)
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",$=>${JSON.stringify(claims.map((row) => row.name))}.map(name=>{
      const [noun,member]=name.split(".");return [name,typeof $[noun]?.[member]]
    }))}}`)
  try {
    const result = await guest.invoke(
      "0",
      {},
      async () => {
        throw Error("unexpected host call")
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [...SESSION_CAPABILITIES],
        plugin: { name: "availability", root: "/plugin" }
      }
    )
    expect(result.value).toEqual(claims.map((row) => [row.name, "undefined"]))
  } finally {
    guest.dispose()
  }
})
