import assert from "node:assert/strict"
import { FunctionSession, SESSION_CAPABILITIES } from "../../src/main/mods/v2/session"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { ModRuntimeAuthorities } from "../../src/main/mods/runtime-instance"
import {
  currentFunctionExecution,
  withFunctionExecution
} from "../../src/main/mods/v2/execution-context"

/** Real Electron utility process: provider closures never cross the JSON protocol. */
export async function checkEngineNouns(client: FunctionRuntimeClient, workspace: string) {
  const load = async (name: string, source: string) => ({
    name,
    root: workspace,
    tier: "user" as const,
    capabilities: [...SESSION_CAPABILITIES],
    guest: await client.load(`var __cmbFunctionMod={register(on){${source}}}`)
  })
  const consumer = await load(
    "noun-consumer",
    `
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"noun-probe",description:"Provider probe"});return next(e)
    });
    on("command.run",{command:"noun-probe"},async($,e)=>({text:await $.company.read({text:e.args})}));
    on("company.read",async($,e,next)=>{
      const value=await next({...e,text:e.text+"!"});return {value:value.value+"?"}
    });
  `
  )
  const provider = await load(
    "noun-provider",
    `
    on("engine.create",async($,e,next)=>{
      const built=await next(e);
      return {...built,company:{read:async(input)=>input.text+":"+await built.session.model()}}
    });
  `
  )
  const authorities = new ModRuntimeAuthorities()
  const controller = new AbortController()
  const { authority } = authorities.create(
    { workspace, threadId: "noun-thread", turnId: "noun-turn" },
    controller.signal
  )
  let reads = 0
  const seen = new Set<string>()
  const session = new FunctionSession([consumer, provider], {
    workspace,
    threadId: "noun-thread",
    assertLive: (plugin) => {
      if (plugin) seen.add(plugin.name)
      const scope = currentFunctionExecution()
      if (scope) assert.equal(scope.runtimeAuthority, authority)
    },
    publish: async (value) => value,
    readSession: async () => {
      reads++
      assert.equal(currentFunctionExecution()?.runtimeAuthority, authority)
      assert.equal(currentFunctionExecution()?.leased, true)
      return "host-model"
    }
  })
  const scoped = <T>(run: () => Promise<T>) =>
    withFunctionExecution(
      {
        workspace,
        threadId: "noun-thread",
        turnId: "noun-turn",
        runtimeAuthority: authority,
        leased: true,
        immediate: false,
        userInitiated: true
      },
      run
    )
  try {
    await scoped(() => session.start())
    const samples: number[] = []
    for (let index = 0; index < 30; index++) {
      const start = performance.now()
      assert.deepEqual(await scoped(() => session.run("noun-probe", "process")), {
        text: "process!:host-model?"
      })
      if (index >= 5) samples.push(performance.now() - start)
    }
    assert.equal(reads, 30)
    assert.deepEqual([...seen].sort(), ["noun-consumer", "noun-provider"])
    await session.close()
    await assert.rejects(
      scoped(() => session.run("noun-probe", "closed")),
      /MODS_SESSION_CLOSED/
    )
    assert.equal(reads, 30)
    samples.sort((a, b) => a - b)
    return { count: samples.length, p50Ms: samples[12], p95Ms: samples[23], maxMs: samples[24] }
  } finally {
    await session.close()
    authorities.close()
  }
}
