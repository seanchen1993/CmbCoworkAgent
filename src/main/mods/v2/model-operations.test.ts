import { expect, it } from "vitest"
import { SESSION_CAPABILITIES, FunctionSession } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ModJson } from "../../../shared/mods/types"

it("advertises distinct model fork and classify operations at the session boundary", () => {
  expect(SESSION_CAPABILITIES).toEqual(expect.arrayContaining(["model.complete", "model.fork", "model.classify"]))
})

it("routes the real turn.step stream through the loaded plugin chain", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step", async function*($,e,next){
      for await (const chunk of next(e)) yield {...chunk,text:chunk.text.toUpperCase()}
      return {answer:"hook-result"}
    })
  }}`)
  const session = new FunctionSession(
    [{name:"stream-mod",root:"/stream-mod",tier:"user",guest,capabilities:[...SESSION_CAPABILITIES]}],
    {threadId:"thread",workspace:"/workspace",assertLive:()=>undefined,publish:async (value)=>value}
  )
  try {
    const stream = await session.turnStep(
      {turnId:"turn",index:0,model:"fixture",messageCount:1},
      async function* (): AsyncGenerator<ModJson, ModJson> {
        yield {kind:"text",index:0,text:"raw"}
        return {answer:"provider-result"}
      }
    )
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([{kind:"text",index:0,text:"RAW"}])
    expect(await stream.result).toEqual({answer:"hook-result"})
  } finally {
    guest.dispose()
  }
})
