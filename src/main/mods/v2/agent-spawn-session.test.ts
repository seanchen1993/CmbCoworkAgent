import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
const complete: FunctionTurnComplete = {
  turnId: "child-turn",
  agentId: "child",
  answer: "review finished",
  reason: "answer",
  isAborted: false,
  durationMs: 1
}

it("registers a hook-rewritten role and returns a detached live-owner snapshot", async () => {
  const session = await fixture(`
    on("agent.register",async($,e,next)=>next({...e,prompt:"rewritten review"}));
    on("command.run",async($)=>$.agent.register({name:"reviewer",description:"review",
      prompt:"original",tools:[],maxTurns:2}));
  `)
  expect(await session.run("spawn", "")).toEqual({ agent: "agents:reviewer" })
  const value = session.registeredAgent("agents:reviewer")!
  expect(value.spec).toMatchObject({ prompt: "rewritten review", tools: [], maxTurns: 2 })
  value.spec.prompt = "mutation"
  expect(session.registeredAgent("agents:reviewer")!.spec.prompt).toBe("rewritten review")
  await session.close()
  expect(() => session.registeredAgent("agents:reviewer")).toThrow()
})

it("does not persist a denied role registration", async () => {
  const session = await fixture(`
    on("agent.register",async()=>({deny:"disabled"}));
    on("command.run",async($)=>{try{await $.agent.register({name:"reviewer",description:"review",
      prompt:"review"})}catch(e){return {error:e.code}}});
  `)
  expect(await session.run("spawn", "")).toEqual({ error: "MODS_OPERATION_DENIED" })
  expect(session.registeredAgent("agents:reviewer")).toBeUndefined()
})

async function fixture(code: string, extra: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"spawn",description:"spawn"});return next(e)
    });${code}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "agents",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "parent",
      assertLive() {
        /* This fixture retains its grant until teardown. */
      },
      publish: async (v) => v,
      prepareAgent: async (_plugin, args) => ({
        ...args,
        description: "test",
        subagentType: "general-purpose",
        tool_use_id: "spawn-call",
        parentModel: "actual-model",
        provider: { plugin: "engine", tier: "core" },
        fork: false,
        background: true
      }),
      spawnAgent: async () => ({
        value: { agentId: "child", model: "actual-model" },
        completion: Promise.resolve(complete)
      }),
      ...extra
    }
  )
  sessions.push(session)
  return session
}

it("delivers even an immediate completion after the guest registers its await continuation", async () => {
  const session = await fixture(`const waiting={};
    on("command.run",async($)=>{
      const child=await $.agent.spawn({prompt:"Review"});
      return await new Promise(resolve=>{waiting[child.agentId]=resolve});
    });
    on("turn.complete",async($,e,next)=>{
      waiting[e.agentId]?.({text:e.answer});return next(e);
    });`)
  expect(await session.run("spawn", "")).toEqual({ text: "review finished" })
})

it("an agent.spawn refusal never creates a child resource", async () => {
  const spawn = vi.fn()
  const session = await fixture(
    `
    on("command.run",async($)=>$.agent.spawn({prompt:"Review"}));
    on("agent.spawn",async()=>({deny:"disabled"}));`,
    { spawnAgent: spawn }
  )
  expect(await session.run("spawn", "")).toEqual({ deny: "disabled" })
  expect(spawn).not.toHaveBeenCalled()
})

it("keeps a child alive after creator return and cancels it when the module is closed", async () => {
  let childSignal!: AbortSignal
  const session = await fixture(`on("command.run",async($)=>$.agent.spawn({prompt:"Review"}));`, {
    spawnAgent: async (_plugin, _input, _startup, lifetime) => {
      childSignal = lifetime
      return {
        value: { agentId: "child", model: "actual-model" },
        completion: new Promise((resolve) =>
          lifetime.addEventListener(
            "abort",
            () =>
              resolve({
                ...complete,
                reason: "aborted",
                isAborted: true
              }),
            { once: true }
          )
        )
      }
    }
  })
  expect(await session.run("spawn", "")).toEqual({ agentId: "child", model: "actual-model" })
  expect(childSignal.aborted).toBe(false)
  await session.close()
  expect(childSignal.aborted).toBe(true)
})

it.each(["return {unexpected:true}", "return {deny:'after start'}"])(
  "closes a started child when an after-hook changes its startup result: %s",
  async (after) => {
    let childSignal!: AbortSignal
    const session = await fixture(
      `
      on("command.run",async($)=>{try{return await $.agent.spawn({prompt:"Review"})}
        catch(error){return {error:error.code}}});
      on("agent.spawn",async($,e,next)=>{await next(e);${after}});
    `,
      {
        spawnAgent: async (_plugin, _input, _startup, lifetime) => {
          childSignal = lifetime
          return {
            value: { agentId: "child", model: "actual-model" },
            completion: new Promise((resolve) =>
              lifetime.addEventListener(
                "abort",
                () =>
                  resolve({
                    ...complete,
                    reason: "aborted",
                    isAborted: true
                  }),
                { once: true }
              )
            )
          }
        }
      }
    )
    const result = await session.run("spawn", "")
    expect(result).toEqual(
      after.includes("unexpected") ? { error: "MODS_AGENT_SPAWN_RESULT" } : { deny: "after start" }
    )
    expect(childSignal.aborted).toBe(true)
  }
)
