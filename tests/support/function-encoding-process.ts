import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"
import { ENCODING_PROBE_SOURCE, expectedEncodingProbe } from "./function-encoding-probe"

export async function checkEncodingGlobals(client: FunctionRuntimeClient): Promise<string[]> {
  const checks: string[] = []
  for (const surface of [false, true]) {
    const guest = await client.load(
      `${ENCODING_PROBE_SOURCE}\n${
        surface
          ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(encodingProbe()))}}`
          : 'var __cmbFunctionMod={register(on){on("command.run",()=>encodingProbe())}}'
      }`,
      { plugin: "encoding" }
    )
    try {
      const result = await guest.invoke(
        "0",
        surface ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
        async () => {
          throw Error("UTF-8 codecs must not invoke host capabilities")
        },
        {
          event: surface ? "surface.update" : "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "encoding", root: "/encoding" }
        }
      )
      const actual = surface
        ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
        : result.value
      assert.deepEqual(actual, expectedEncodingProbe())
      checks.push(
        `real utility ${surface ? "Client" : "hooks"} UTF-8, streaming and fatal vectors match native`
      )
    } finally {
      await guest.dispose()
    }
  }
  return checks
}
