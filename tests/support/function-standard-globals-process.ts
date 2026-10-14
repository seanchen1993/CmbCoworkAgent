import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"
import {
  EXPECTED_STANDARD_GLOBALS_PROBE,
  STANDARD_GLOBALS_PROBE_SOURCE
} from "./function-standard-globals-probe"

export async function checkStandardGlobals(client: FunctionRuntimeClient): Promise<string[]> {
  const checks: string[] = []
  for (const surface of [false, true]) {
    const guest = await client.load(
      STANDARD_GLOBALS_PROBE_SOURCE +
        (surface
          ? `${CLIENT_BOOTSTRAP}\nvar evidence; standardGlobalsProbe().then(value=>evidence=value);
        var __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(evidence||null))}}`
          : 'var __cmbFunctionMod={register(on){on("command.run",()=>standardGlobalsProbe())}}')
    )
    try {
      const invoke = () =>
        guest.invoke(
          "0",
          surface ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
          async () => {
            throw Error("Standard globals must not invoke host capabilities")
          },
          {
            event: surface ? "surface.update" : "command.run",
            origin: { plugin: "engine", tier: "core" },
            capabilities: [],
            plugin: { name: "standard", root: "/standard" }
          }
        )
      let actual: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await invoke()
        actual = surface
          ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
          : result.value
        if (actual) break
      }
      assert.deepEqual(actual, EXPECTED_STANDARD_GLOBALS_PROBE)
      checks.push(
        `real utility ${surface ? "Client" : "hooks"} standard globals and digest vectors`
      )
    } finally {
      await guest.dispose()
    }
  }
  return checks
}
