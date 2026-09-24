import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"
import { BASE64_PROBE_SOURCE, expectedBase64Probe } from "../fixtures/mods-v2/base64-probes"

export async function checkBase64Globals(client: FunctionRuntimeClient): Promise<string[]> {
  const checks: string[] = []
  for (const surface of [false, true]) {
    const guest = await client.load(
      `${BASE64_PROBE_SOURCE}\n${
        surface
          ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(base64Probe()))}}`
          : 'var __cmbFunctionMod={register(on){on("command.run",()=>base64Probe())}}'
      }`,
      { plugin: "base64" }
    )
    try {
      const result = await guest.invoke(
        "0",
        surface ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
        async () => {
          throw Error("Base64 globals must not invoke the host")
        },
        {
          event: surface ? "surface.update" : "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "base64", root: "/base64" }
        }
      )
      const actual = surface
        ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
        : result.value
      assert.deepEqual(actual, expectedBase64Probe())
      checks.push(
        `real utility ${surface ? "Client" : "hooks"} base64 vectors and errors match native results`
      )
    } finally {
      await guest.dispose()
    }
  }
  return checks
}
