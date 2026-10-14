import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { currentFunctionExecution } from "./execution-context"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionNamedState } from "./named-state"
import { FunctionPluginPromptQueue } from "./plugin-prompt-queue"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(throwAfterSubmit: boolean) {
  const state = new FunctionNamedState()
  const stored = new Map<string, ModJson>()
  const nativeRuns: unknown[] = []
  const accepted: ModObject[] = []
  const preparationScopes: Array<{ userInitiated?: boolean; leased?: boolean }> = []
  const queue = new FunctionPluginPromptQueue({
    busy: () => true,
    claim: () => undefined,
    run: async (_, input) => { nativeRuns.push(input) },
    onIdle: () => () => {}
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",async($,e)=>{
      await $.state.get({plugin:"prompt-source",key:"draw-snapshot"});
      try {
        await $.state.set({plugin:"prompt-source",key:"source-write"},"forbidden");
        await $.store.set("source-write-error","unexpectedly allowed");
      } catch(error) {
        await $.store.set("source-write-error",error.code);
      }
      void $.prompt.submit({text:"independent child"});
      ${throwAfterSubmit ? 'throw Error("ordinary source render failure");' : ""}
      return {type:"Text",props:{},children:["source finished"]};
    });
    on("prompt.submit",async($,e,next)=>{
      const seed=await $.state.get({plugin:"prompt-source",key:"fresh-seed"});
      const wrote=await $.state.set({plugin:"prompt-source",key:"child-write"},seed.value+1);
      await $.store.set("child-receipt",{seed:seed.value,wrote});
      return next(e);
    });
  }}`)
  const session = new FunctionSession([
    {
      name: "prompt-source",
      root: "/plugin",
      tier: "user",
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    }
  ], {
    workspace: "/project",
    threadId: "prompt-source-isolation",
    namedState: state,
    assertLive: () => {},
    publish: async value => value,
    reservePluginPrompt: (_, origin, lifetime) => {
      const ticket = queue.reserve({
        workspace: "/project",
        threadId: "prompt-source-isolation",
        origin,
        signal: lifetime,
        assertLive: () => lifetime.throwIfAborted()
      })
      return {
        ...ticket,
        accept: (input: ModObject) => {
          const result = ticket.accept(input)
          accepted.push(structuredClone(input))
          return result
        }
      }
    },
    preparePluginPrompt: async (_, signal, assertAdmission, _cancelAdmission, run) => {
      assertAdmission()
      signal.throwIfAborted()
      const scope = currentFunctionExecution()
      preparationScopes.push({ userInitiated: scope?.userInitiated, leased: scope?.leased })
      // The drawing read an older immutable map; this child must read current session state.
      state.write({ plugin: "prompt-source", key: "fresh-seed", value: 41 }, {})
      return run(assertAdmission)
    },
    state: () => ({
      get: async key => stored.get(key),
      keys: async () => [...stored.keys()],
      set: async (key, value) => { stored.set(key, value) },
      delete: key => { stored.delete(key) }
    })
  })
  cleanup.push(async () => {
    queue.close()
    await session.close()
  })
  await session.start()
  return { session, state, stored, queue, nativeRuns, accepted, preparationScopes }
}

for (const throws of [false, true]) {
  it(`isolates a real ui.render child after source ${throws ? "throw" : "return"}`, async () => {
    const f = await fixture(throws)
    const owner = await f.session.sites.mount("AbovePrompt")
    await f.session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8 })
    await expect.poll(() => f.stored.get("child-receipt")).toEqual({
      seed: 41,
      wrote: { isSet: true, version: 1 }
    })
    await expect.poll(() => f.accepted).toEqual([{
      text: "independent child",
      origin: { kind: "plugin", name: "prompt-source" },
      wait: false
    }])
    expect(f.stored.get("source-write-error")).toBe("MODS_STATE_RENDER_WRITE")
    expect(f.state.read({ plugin: "prompt-source", key: "source-write" }, {}))
      .toEqual({ version: 0 })
    expect(f.state.read({ plugin: "prompt-source", key: "child-write" }, {}))
      .toEqual({ value: 42, version: 1 })
    expect(f.preparationScopes).toEqual([{ userInitiated: false, leased: false }])
    // This fixture holds the actual native launch; child dispatch is not a started receipt.
    expect(f.nativeRuns).toEqual([])
    expect(f.queue.size).toBe(1)
  })
}
