import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { app } from "electron"
import { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { FunctionDispatcher } from "../../src/main/mods/v2/dispatcher"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"

const root = process.argv[2]
const destination = process.argv[3]
const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.cjs"))
void app.whenReady().then(async () => {
  try {
    const compiled = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/conformance"))
    const guest = await client.load(compiled.code, compiled.options)
    const dispatcher = new FunctionDispatcher([
      { name: compiled.name, root: compiled.root, tier: "user", guest, capabilities: [] }
    ])
    const run = async (): Promise<void> => {
      const result = await dispatcher.dispatch(
        "command.run",
        { command: "cmb-order", args: "" },
        {
          core: async (_, e) => ({ text: e.args })
        }
      )
      assert.deepEqual(result.value, { text: "A(B(AB))" })
    }
    for (let index = 0; index < 30; index++) await run()
    const samples: number[] = []
    for (let index = 0; index < 450; index++) {
      const start = performance.now()
      await run()
      samples.push(performance.now() - start)
    }
    await guest.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(client.stats.frames, 0)
    assert.equal(client.stats.replies, 0)
    await writeFile(destination, JSON.stringify({ samples, stats: client.stats }))
    client.stop()
    app.exit(0)
  } catch (error) {
    console.error(error)
    client.stop()
    app.exit(1)
  }
})
