import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModObject } from "../../../shared/mods/types"

async function createSession(source: string) {
  const guest = await FunctionGuestRuntime.create(source)
  const session = new FunctionSession(
    [
      {
        name: "agent-offer",
        root: "/agent-offer",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/workspace",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  return { guest, session }
}

it("runs agent.offer through the host core and lets a Mod hide an agent", async () => {
  const { session } = await createSession(`var __cmbFunctionMod={register(on){
    on("agent.offer", {agent:"Plan"}, () => ({isOffered:false}))
  }}`)
  try {
    const seen: ModObject[] = []
    const result = await session.offerAgent(
      {
        agent: "Plan",
        description: "Read only",
        source: "built-in",
        provider: { plugin: "engine", tier: "core" }
      },
      undefined,
      async (input) => {
        seen.push(input)
        return { isOffered: true }
      }
    )
    expect(result).toEqual({ isOffered: false })
    expect(seen).toEqual([])
  } finally {
    await session.close()
  }
})

it("rejects an agent.offer rewrite of pinned provider identity", async () => {
  const { session } = await createSession(`var __cmbFunctionMod={register(on){
    on("agent.offer", async ($,e,next) => next({...e,provider:{plugin:"fake",tier:"user"}}))
  }}`)
  try {
    await expect(
      session.offerAgent({
        agent: "Explore",
        description: "Read only",
        source: "built-in",
        provider: { plugin: "engine", tier: "core" }
      })
    ).rejects.toThrow("MODS_AGENT_OFFER_PINNED")
  } finally {
    await session.close()
  }
})

it("dispatches classic events through the same guest/session chain", async () => {
  const { session } = await createSession(`var __cmbFunctionMod={register(on){
    on("classic.PreToolUse", {tool:"write_file"}, () => ({deny:"read only"}))
  }}`)
  try {
    await expect(
      session.classicEvent("classic.PreToolUse", {
        tool: "write_file",
        tool_use_id: "call-1",
        path: "a.txt"
      })
    ).resolves.toEqual({ deny: "read only" })
  } finally {
    await session.close()
  }
})
