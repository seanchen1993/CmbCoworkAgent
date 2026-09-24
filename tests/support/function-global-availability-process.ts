import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"

/** Presence/absence evidence only; this does not certify each global's full semantics. */
export async function checkGlobalAvailability(
  client: FunctionRuntimeClient,
  root: string
): Promise<string[]> {
  const { globals } = JSON.parse(
    readFileSync(join(root, "docs/mods-v2-compatibility-matrix.json"), "utf8")
  ) as { globals: Array<{ name: string; availability: string }> }
  const expression = `Object.fromEntries(${JSON.stringify(globals.map((row) => row.name))}
    .map(name=>[name,typeof globalThis[name]]))`
  const checks: string[] = []
  for (const surface of [false, true]) {
    const guest = await client.load(
      surface
        ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
        : `var __cmbFunctionMod={register(on){on("command.run",()=>${expression})}}`,
      { plugin: "availability" }
    )
    try {
      const result = await guest.invoke(
        "0",
        surface ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
        async () => {
          throw Error("global inspection must not call host capabilities")
        },
        {
          event: surface ? "surface.update" : "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "availability", root }
        }
      )
      const values = surface
        ? (JSON.parse(
            (result.value as { tree: { children: string[] } }).tree.children[0]
          ) as Record<string, string>)
        : (result.value as Record<string, string>)
      for (const row of globals) {
        assert(["bounded", "metadata", "unavailable"].includes(row.availability), row.name)
        if (row.availability === "bounded") assert.notEqual(values[row.name], "undefined", row.name)
        else assert.equal(values[row.name], "undefined", row.name)
      }
      checks.push(
        `real utility ${surface ? "Client" : "hooks"} VM matches declared global availability`
      )
    } finally {
      await guest.dispose()
    }
  }
  return checks
}
