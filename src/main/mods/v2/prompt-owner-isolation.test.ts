import { withIndependentPromptFrame } from "./model-prompt-frame"
import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../runtime-instance"
import { FunctionGuestRuntime } from "./guest-runtime"
import { functionCallAgent, functionCallAuthority, withFunctionAgentExecution } from "./host-call"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const workspace = "/prompt-owner-workspace"
const threadId = "shared-thread"
const sessions: FunctionSession[] = []
const registries: ModRuntimeAuthorities[] = []

afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()))
  } finally {
    registries.splice(0).forEach((registry) => registry.close())
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function within<T>(authority: ModRuntimeAuthority, run: () => Promise<T>): Promise<T> {
  return withFunctionAgentExecution(
    {
      workspace: authority.workspace,
      threadId: authority.threadId,
      agentId: authority.agentId,
      turnId: authority.turnId,
      runtimeAuthority: authority,
      userInitiated: false,
      leased: false,
      immediate: false
    },
    run
  )
}

function facts(model: string): ModObject {
  return {
    model,
    promptModel: model,
    tools: [`tool-${model}`],
    surfaces: ["desktop"],
    outputStyle: null,
    traits: []
  }
}

function sections(text: string): ModObject {
  return { sections: [{ id: "core", text, scope: "session" }] }
}

it.each(["prompt.context", "prompt.attachment"] as const)(
  "%s cannot borrow a previous request's SDK compose binding", async event => {
    const f = await fixture(`on("${event}",async($,e)=>{
      let proof="UNSAFE";
      try{await $.prompt.compose()}catch(error){proof=String(error)};
      return ${event === "prompt.context" ? '{blocks:[{name:"proof",text:proof}]}' : '{text:proof}'}
    })`)
    const { authority } = f.owner("main", "turn")
    const input: ModObject = event === "prompt.context" ? { blocks: [] } :
      { type: "output_style", text: "BODY", origin: { kind: "engine" } }
    const read = () => within(authority, () => f.session.promptComposition(event, input,
      new AbortController().signal, async () => { throw Error("unused") }))
    expect(JSON.stringify(await read())).toContain("MODS_PROMPT_COMPOSE_PREPARING")
    await f.bind(authority, "OLD_MODEL")
    expect(JSON.stringify(await read())).toContain("MODS_PROMPT_COMPOSE_PREPARING")
    await f.bind(authority, "NEW_MODEL")
    expect(JSON.stringify(await f.inspect(authority))).toContain("NEW_MODEL")
  }
)

async function fixture(
  body = "",
  publish: (value: ModJson, signal: AbortSignal) => Promise<ModJson> = async (value) => value
) {
  const registry = new ModRuntimeAuthorities()
  registries.push(registry)
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"inspect",description:"Inspect bound request"});
      return next(e)
    });
    on("command.run",{command:"inspect"},async($)=>{
      try {return {text:JSON.stringify(await $.prompt.compose())}}
      catch(error) {return {text:String(error)}}
    });
    ${body}
  }}`)
  const session = new FunctionSession(
    [{
      name: "owner",
      root: "/owner",
      tier: "user",
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    }],
    { workspace, threadId, assertLive: () => {}, publish }
  )
  sessions.push(session)
  await session.start()
  const owner = (agentId: string, turnId: string, signal?: AbortSignal) =>
    registry.create({ workspace, threadId, agentId, turnId }, signal)
  const bind = (
    authority: ModRuntimeAuthority,
    text: string,
    signal = new AbortController().signal
  ) => within(authority, () => session.promptComposition(
    "prompt.compose", facts(text), signal, async () => sections(text)
  ))
  const inspect = (authority: ModRuntimeAuthority) =>
    within(authority, () => session.run("inspect", ""))
  return { registry, session, owner, bind, inspect }
}

it("keeps same-thread SDK snapshots separate for distinct live agents and turns", async () => {
  const f = await fixture()
  const a = f.owner("agent-a", "turn-a")
  const b = f.owner("agent-b", "turn-b")
  await f.bind(a.authority, "provider-a")
  await f.bind(b.authority, "provider-b")

  const [first, second] = await Promise.all([
    f.inspect(a.authority),
    f.inspect(b.authority)
  ])
  expect(JSON.parse(String(first.text))).toEqual(sections("provider-a"))
  expect(JSON.parse(String(second.text))).toEqual(sections("provider-b"))
  expect(JSON.parse(String((await f.inspect(a.authority)).text))).toEqual(sections("provider-a"))
})

it("never grants a replacement generation the previous generation's snapshot", async () => {
  const f = await fixture()
  const old = f.owner("agent-a", "same-turn")
  await f.bind(old.authority, "previous-provider")
  old.release()
  const replacement = f.owner("agent-a", "same-turn")

  expect((await f.inspect(replacement.authority)).text)
    .toContain("MODS_PROMPT_COMPOSE_UNAVAILABLE")
  await expect(f.inspect(old.authority)).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  await f.bind(replacement.authority, "replacement-provider")
  expect(JSON.parse(String((await f.inspect(replacement.authority)).text)))
    .toEqual(sections("replacement-provider"))
})

it("cannot borrow the parent's composing ALS store in a fresh child scope", async () => {
  const f = await fixture()
  const parent = f.owner("main", "parent-turn")
  const child = f.owner("flow-child", "child-turn")
  let childAnswer: ModObject | undefined
  let coreCalls = 0

  await within(parent.authority, () => f.session.promptComposition(
    "prompt.compose", facts("parent-provider"), new AbortController().signal,
    async () => {
      // A broken SDK may re-enter this retained parent core; do not make that failure recursive.
      if (++coreCalls === 1) childAnswer = await f.inspect(child.authority)
      return sections("private-parent-prompt")
    }
  ))

  expect(childAnswer?.text).toContain("MODS_PROMPT_COMPOSE_UNAVAILABLE")
  expect(childAnswer?.text).not.toContain("private-parent-prompt")
  expect(coreCalls).toBe(1)
})

it("aborting one agent's request does not remove another live agent's snapshot", async () => {
  const f = await fixture()
  const aController = new AbortController()
  const a = f.owner("agent-a", "turn-a", aController.signal)
  const b = f.owner("agent-b", "turn-b")
  await f.bind(a.authority, "provider-a", aController.signal)
  await f.bind(b.authority, "provider-b")
  aController.abort()

  expect(JSON.parse(String((await f.inspect(b.authority)).text))).toEqual(sections("provider-b"))
  await expect(f.inspect(a.authority)).rejects.toThrow()
})

it("a superseded request's abort cannot delete its owner's newer request", async () => {
  const f = await fixture()
  const owner = f.owner("agent-a", "turn-a")
  const first = new AbortController()
  const second = new AbortController()
  await f.bind(owner.authority, "first-provider", first.signal)
  await f.bind(owner.authority, "second-provider", second.signal)
  first.abort()

  expect(JSON.parse(String((await f.inspect(owner.authority)).text)))
    .toEqual(sections("second-provider"))
  second.abort()
  expect((await f.inspect(owner.authority)).text).toContain("MODS_PROMPT_COMPOSE_UNAVAILABLE")
})

it("rejects SDK access without an owner even after a live request was bound", async () => {
  const f = await fixture()
  const owner = f.owner("main", "turn-a")
  await f.bind(owner.authority, "private-provider")

  const answer = await f.session.run("inspect", "")
  expect(answer.text).toContain("MODS_PROMPT_COMPOSE_UNAVAILABLE")
  expect(answer.text).not.toContain("private-provider")
})

it("rejects a short-circuit Hook result when its owner expires during publication", async () => {
  const entered = deferred()
  const resume = deferred()
  let paused = false
  const f = await fixture(
    `on("prompt.compose",async()=>({sections:[
      {id:"short",text:"short-circuit-result",scope:"session"}
    ]}));`,
    async (value) => {
      if (!paused && JSON.stringify(value).includes("short-circuit-result")) {
        paused = true
        entered.resolve()
        await resume.promise
      }
      return value
    }
  )
  const owner = f.owner("flow-child", "child-turn")
  let coreCalls = 0
  const pending = within(owner.authority, () => f.session.promptComposition(
    "prompt.compose", facts("child-provider"), new AbortController().signal,
    async () => {
      coreCalls++
      return sections("core-result")
    }
  ))
  const rejected = expect(pending).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  await entered.promise
  owner.release()
  resume.resolve()

  await rejected
  expect(coreCalls).toBe(0)
})

it("skips child turn.step guests and aborts transport when its session closes", async () => {
  const f = await fixture(`on("turn.step",async function*(){
    yield {kind:"text",text:"guest-turn-step-was-called"};
    return {guest:true}
  });`)
  const owner = f.owner("flow-child", "child-turn")
  const enteredTransportWait = deferred()
  const transportClosed = deferred()
  let transportSignal: AbortSignal | undefined
  let requests = 0
  let finalized = 0
  const stream = await within(owner.authority, () => f.session.turnStep(
    {
      turnId: owner.authority.turnId,
      agentId: owner.authority.agentId,
      index: 0,
      model: "child-provider",
      messageCount: 1
    },
    async function* (_input, context): AsyncGenerator<ModJson, ModJson> {
      requests++
      expect(functionCallAgent(workspace, threadId)).toBe("flow-child")
      expect(functionCallAuthority(workspace, threadId)).toBe(owner.authority)
      transportSignal = context.signal
      const abortTransport = () => transportClosed.resolve()
      context.signal.addEventListener("abort", abortTransport, { once: true })
      try {
        yield { kind: "text", text: "original-provider-frame" }
        enteredTransportWait.resolve()
        await transportClosed.promise
        context.signal.throwIfAborted()
        return {}
      } finally {
        context.signal.removeEventListener("abort", abortTransport)
        finalized++
      }
    },
    new AbortController().signal,
    false
  ))

  expect((await within(owner.authority, () => stream.next())).value)
    .toEqual({ kind: "text", text: "original-provider-frame" })
  const pending = within(owner.authority, () => stream.next())
  const rejected = expect(pending).rejects.toThrow("MODS_SESSION_CLOSED")
  await enteredTransportWait.promise
  await f.session.close()
  await rejected

  expect(transportSignal?.aborted).toBe(true)
  expect(requests).toBe(1)
  expect(finalized).toBe(1)
  await expect(stream.result).rejects.toThrow("MODS_SESSION_CLOSED")
})


it("keeps standalone frames local and leaves the main compose snapshot intact", async () => {
  const f = await fixture()
  const main = f.owner("main", "same-turn")
  await f.bind(main.authority, "main-provider")
  const values = await Promise.all(["analysis-a", "analysis-b"].map((name) =>
    within(main.authority, () => withIndependentPromptFrame(() => f.session.promptComposition(
      "prompt.compose", facts(name), new AbortController().signal,
      async () => sections(name)
    )))))
  expect(values).toEqual([sections("analysis-a"), sections("analysis-b")])
  expect(JSON.parse(String((await f.inspect(main.authority)).text))).toEqual(sections("main-provider"))
})
