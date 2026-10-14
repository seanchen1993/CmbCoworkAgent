import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"
import { URL_PROBE_SOURCE, expectedUrlProbe } from "./function-url-probe"

export async function checkUrlGlobals(client: FunctionRuntimeClient): Promise<string[]> {
  const checks: string[] = []
  for (const surface of [false, true]) {
    const guest = await client.load(
      `${URL_PROBE_SOURCE}\n${
        surface
          ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(urlProbe()))}}`
          : 'var __cmbFunctionMod={register(on){on("command.run",()=>urlProbe())}}'
      }`,
      { plugin: "url" }
    )
    try {
      const result = await guest.invoke(
        "0",
        surface ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
        async () => {
          throw Error("URL must not invoke host capabilities")
        },
        {
          event: surface ? "surface.update" : "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "url", root: "/url" }
        }
      )
      const actual = surface
        ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
        : result.value
      assert.deepEqual(actual, expectedUrlProbe())
      checks.push(
        `real utility ${surface ? "Client" : "hooks"} URL and search parameters match native`
      )
    } finally {
      await guest.dispose()
    }
  }
  return checks
}
