import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import type { FunctionHostReply } from "../../src/shared/mods/v2/contracts"

export async function checkModuleChannel(client: FunctionRuntimeClient): Promise<string[]> {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    on("command.run",async $=>{const timer=$.clock.after(100,()=>{});await $.session.id();
      timer.cancel();return {text:"done"}})
  }}`)
  let signal: AbortSignal | undefined
  let release: ((reply: FunctionHostReply) => void) | undefined
  let cleaned = 0
  guest.bindModuleHost!(
    async (method, args, active) => {
      assert.equal(method, "resource.close")
      assert.deepEqual(args, { id: "resource-a" })
      signal = active
      return new Promise((resolve) => {
        release = resolve
      })
    },
    () => {
      cleaned++
    }
  )
  try {
    const result = await guest.invoke(
      "0",
      {},
      async (method) => {
        if (method === "clock.after") return { value: { id: "resource-a" } }
        if (method === "session.id") return { value: "session-a" }
        throw Error("Unexpected frame method")
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["clock.after", "session.id"],
        plugin: { name: "module", root: "/module" }
      }
    )
    assert.deepEqual(result, { value: { text: "done" } })
    assert(signal)
    assert.equal(signal.aborted, false)
    assert.equal(client.stats.calls, 1)
    await guest.dispose()
    assert.equal(signal.aborted, true)
    assert.equal(cleaned, 1)
    assert.equal(client.stats.calls, 0)
    release!({ value: null })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cleaned, 1)
    return [
      "real utility module resource call outlives only its hook frame and is revoked on unload"
    ]
  } finally {
    await guest.dispose()
  }
}
