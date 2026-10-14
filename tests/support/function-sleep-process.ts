import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import type { ModJson } from "../../src/shared/mods/types"
import { basicSdkInput, runBasicSdk } from "../../src/main/mods/v2/basic-sdk"

export async function checkSleepCancellation(client: FunctionRuntimeClient): Promise<string[]> {
  const guest = await client.load(`var __cmbFunctionMod={register(on){on("command.run",async $=>{
    const controller=new AbortController(),reason={cancel:"one"};
    const first=$.clock.sleep(5000,{signal:controller.signal}).catch(error=>error===reason);
    const second=$.clock.sleep(100);await $.clock.sleep(1);controller.abort(reason);
    const reasonKept=await first;const status=await $.session.id();await second;return {reasonKept,status};
  })}}`)
  const signals: AbortSignal[] = []
  try {
    const result = await guest.invoke(
      "0",
      {},
      async (method, args, signal) => {
        if (method === "session.id")
          return {
            value: signals
              .slice(0, 2)
              .map((signal) => signal.aborted)
              .join("|")
          }
        signals.push(signal)
        const value = await runBasicSdk(method, basicSdkInput(method, args as ModJson[]), {
          threadId: "sleep",
          workspace: "/sleep",
          plugin: "sleep",
          registry: new Map(),
          signal
        })
        return value === undefined ? {} : { value }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["clock.sleep", "session.id"],
        plugin: { name: "sleep", root: "/sleep" }
      }
    )
    assert.deepEqual(result, { value: { reasonKept: true, status: "true|false" } })
    assert.equal(client.stats.calls, 0)
    return [
      "real utility sleep signal cancels only its native host timer and preserves guest reason identity"
    ]
  } finally {
    await guest.dispose()
  }
}
