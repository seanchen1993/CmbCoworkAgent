import { AsyncResource } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore, type ModGrant } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import { type DevelopmentScope } from "./development-session"
import { developmentNativeGrant } from "./development-native-authority"
import { currentFunctionExecution, withFunctionExecution } from "./execution-context"
import { assertFunctionGrant } from "./host-call"

type Host = ConstructorParameters<typeof FunctionModsManager>[1]
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const modelAnswer = {
  isAnswered: true as const,
  text: "native model answer",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }
}

async function fixture(
  capabilities: string[],
  body: string,
  options: {
    protocol?: "legacy-v1" | "result-v1"
    startup?: string
    hooks?: string
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "development-bridge-families-"))
  const storePath = join(root, "control.sqlite")
  const store = new ModControlStore(storePath)
  const other = new ModControlStore(join(root, "other.sqlite"))
  const scope: DevelopmentScope = {
    workspace: root,
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  const calls: string[] = []
  const retained: Array<{ grant: ModGrant; late: () => void }> = []
  let digest = ""
  const check = async (
    label: string,
    method: string,
    workspace: string,
    threadId: string,
    grant: ModGrant,
    signal: AbortSignal
  ) => {
    signal.throwIfAborted()
    expect(capabilities).toContain(method)
    expect(workspace).toBe(root)
    expect(threadId).toBe(scope.threadId)
    expect(currentFunctionExecution()).toMatchObject({ workspace: root, threadId })
    expect(grant).toMatchObject({ workspace: root, digest, epoch: 1, enabled: true })
    expect(grant.modId).toMatch(/^development:/)
    expect(Object.isFrozen(grant)).toBe(true)
    expect(developmentNativeGrant(store, root, grant.modId)).toBe(grant)
    expect(store.getGrant(root, grant.modId)).toBe(grant)
    expect(() => store.assertGrant(grant)).not.toThrow()
    expect(() => assertFunctionGrant(store, root, threadId, grant, signal)).not.toThrow()
    expect(() => store.assertGrant({ ...grant })).toThrow()
    expect(() => other.assertGrant(grant)).toThrow()
    await Promise.resolve()
    store.assertGrant(grant)
    retained.push({ grant, late: AsyncResource.bind(() => store.assertGrant(grant)) })
    calls.push(label)
  }
  const host: Host = {
    plugins: () => [],
    enabled: () => true,
    publish: async (_workspace, value) => value,
    changed: () => {},
    assertThread: (workspace, threadId) => {
      expect(workspace).toBe(root)
      expect(threadId).toBe(scope.threadId)
    },
    completeModelResult: async (w, t, g, _input, s) => {
      await check("completeResult", "model.complete", w, t, g, s)
      return modelAnswer
    },
    completeModel: async (w, t, g, _input, s) => {
      await check("complete", "model.complete", w, t, g, s)
      return "legacy native answer"
    },
    forkModelResult: async (w, t, g, _input, s) => {
      await check("forkResult", "model.fork", w, t, g, s)
      return modelAnswer
    },
    capability: async (w, t, g, method, _input, s) => {
      await check(method, method, w, t, g, s)
      return method === "model.classify" ? "yes" : { text: "legacy fork answer" }
    },
    callMcp: async (w, t, g, _input, s) => {
      await check("mcp", "mcp.call", w, t, g, s)
      return { content: [{ type: "text", text: "native MCP answer" }], isError: false }
    },
    checkTool: async (w, t, g, _input, s) => {
      await check("check", "tool.check", w, t, g, s)
      return { decision: "allow" }
    },
    authorizeHttp: async (w, t, g, _request, s) => {
      await check("httpApproval", "http.fetch", w, t, g, s)
    },
    authorizeProcess: async (w, t, g, _request, s) => {
      const method = capabilities.includes("process.spawn") ? "process.spawn" : "process.run"
      await check("processApproval", method, w, t, g, s)
    },
    runEffect: async (w, t, g, method, _input, s, run) => {
      await check(`effect:${method}`, method, w, t, g, s)
      const value = await run()
      store.assertGrant(g)
      return value
    },
    registeredTool: async (w, t, g, _input, _origin, s, run) => {
      await check("registered", "tool.register", w, t, g, s)
      return run()
    },
    sendPeer: async (w, t, g, _input, s) => {
      await check("peer", "session.send", w, t, g, s)
      return { isDelivered: true }
    },
    prepareAgent: async (w, t, g, input, s) => {
      await check("agentPrepare", "agent.spawn", w, t, g, s)
      return {
        ...input,
        description: "test child",
        subagentType: "general-purpose",
        tool_use_id: randomUUID(),
        parentModel: "fixture-model",
        provider: { plugin: "engine", tier: "core" },
        fork: false,
        background: true
      }
    },
    spawnAgent: async (w, t, g, _input, s) => {
      await check("agentSpawn", "agent.spawn", w, t, g, s)
      return {
        value: { agentId: "child", model: "fixture-model" },
        completion: Promise.resolve({
          turnId: "child-turn",
          agentId: "child",
          answer: "done",
          reason: "answer" as const,
          isAborted: false,
          durationMs: 1
        })
      }
    },
    abortTurn: async (w, t, g, _turnId, s) => {
      await check("abort", "turn.abort", w, t, g, s)
    }
  }
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(store, host, () => ({
    load: async (code, args) => {
      const guest = await FunctionGuestRuntime.create(code, args)
      guests.push(guest)
      return guest
    },
    stop: () => {
      for (const guest of guests) void guest.dispose()
    },
    stopAndDrain: async () => {
      await Promise.all(guests.map((guest) => guest.dispose()))
    }
  }))
  manager.configureDevelopmentAccess({ assertScope: (actual) => expect(actual).toEqual(scope) })
  cleanups.push(async () => {
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    store.close()
    other.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^development-bridge-families-/)
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, "source")
  await mkdir(join(source, "mods"), { recursive: true })
  await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "bridge-families" }))
  await writeFile(
    join(source, "mods", "manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "bridge-families",
      entry: "main.ts",
      cmbCompatibility: { modelProtocol: options.protocol ?? "result-v1" }
    })
  )
  await writeFile(
    join(source, "mods", "main.ts"),
    `export function register(on) {
    let registered;
    on("session.start",async($,e,next)=>{
      ${options.startup ?? ""}
      await $.command.register({name:"probe",description:"Bridge probe"});return next(e)
    });
    on("command.run",{command:"probe"},async($)=>{${body}});
    ${options.hooks ?? ""}
  }`
  )
  const compiled = await compileFunctionPlugin(source)
  digest = compiled.digest
  const revision = {
    componentId: randomUUID(),
    draftId: "bridge",
    revision: 1,
    bundleDigest: "a".repeat(64),
    compiledDigest: digest,
    sourcePath: source,
    turnId: "creator-turn",
    validation: "authorized-real" as const,
    capabilities: [
      "command.register",
      "event:session.start",
      "event:command.run",
      ...capabilities,
      ...(options.hooks ? ["event:tool.call"] : [])
    ]
  }
  manager.stageDevelopment(scope, revision, () => assertFunctionSourcesCurrent(compiled))
  manager.approveDevelopment(scope, revision.componentId, digest, revision.capabilities, () => {})
  manager.noteDevelopmentTurnSettled(scope, revision.turnId, "completed")
  await vi.waitFor(() => expect(manager.developmentStatus(scope)[0]?.phase).toBe("active"))
  const run = async () => {
    const descriptor = (await manager.commands(root, scope.threadId))[0]
    return withFunctionExecution(
      {
        workspace: root,
        threadId: scope.threadId,
        userInitiated: true,
        leased: false,
        immediate: false
      },
      () => manager.runCommand(root, scope.threadId, descriptor, "", new AbortController().signal)
    )
  }
  const assertNoGrants = () => {
    for (const { grant, late } of retained) {
      expect(store.getGrant(root, grant.modId)).toBeNull()
      expect(() => late()).toThrow()
    }
    expect(store.getGrant(root, "function:bridge-families")).toBeNull()
    const database = new DatabaseSync(storePath, { readOnly: true })
    try {
      expect(database.prepare("SELECT count(*) AS n FROM mods_grants").get()?.n).toBe(0)
    } finally {
      database.close()
    }
  }
  return { calls, run, assertNoGrants }
}

it.each([
  [
    "model.complete",
    "result-v1",
    '$.model.complete({model:"default",prompt:"hi"})',
    "completeResult"
  ],
  ["model.complete", "legacy-v1", '$.model.complete({model:"default",prompt:"hi"})', "complete"],
  ["model.fork", "result-v1", '$.model.fork({prompt:"hi"})', "forkResult"],
  ["model.fork", "legacy-v1", '$.model.fork({prompt:"hi"})', "model.fork"],
  ["model.classify", "result-v1", '$.model.classify("hello",["yes","no"])', "model.classify"],
  ["mcp.call", "result-v1", '$.mcp.call("configured","probe",{})', "mcp"],
  [
    "tool.check",
    "result-v1",
    '$.tool.check({tool:"read_file",input:{file_path:"file.txt"}})',
    "check"
  ],
  ["session.send", "result-v1", '$.session.send({to:{sessionId:"peer"},text:"hello"})', "peer"],
  ["agent.spawn", "result-v1", '$.agent.spawn({prompt:"review"})', "agentSpawn"],
  ["turn.abort", "result-v1", '$.turn.abort({turnId:"current-turn"})', "abort"]
] as const)(
  "admits %s (%s) through an exact temporary native identity",
  async (method, protocol, expression, expected) => {
    const f = await fixture(
      [method],
      `const value=await ${expression};return {text:JSON.stringify(value??null)}`,
      { protocol }
    )
    const result = await f.run()
    expect(result.text).not.toBe("")
    expect(f.calls).toContain(expected)
    if (method === "agent.spawn") expect(f.calls).toContain("agentPrepare")
    f.assertNoGrants()
  }
)

it("admits a registered development tool through its real guest handler", async () => {
  const f = await fixture(
    ["tool.register", "tool.call"],
    "const value=await $.tool.call({tool:registered.tool});return {text:JSON.stringify(value)}",
    {
      startup:
        'registered=await $.tool.register({name:"local",description:"Local",inputSchema:{type:"object",properties:{},additionalProperties:false}});',
      hooks:
        'on("tool.call",async($,e,next)=>e.tool===registered.tool?{result:"real registered guest"}:next(e));'
    }
  )
  expect((await f.run()).text).toContain("real registered guest")
  expect(f.calls).toEqual(["registered"])
  f.assertNoGrants()
})

it("performs a real loopback HTTP request after both native effect and request admission", async () => {
  const received: string[] = []
  const server = createServer((request, response) => {
    received.push(request.url!)
    response.end("real development HTTP bytes")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address() as { port: number }
  const f = await fixture(
    ["http.fetch"],
    `const value=await $.http.fetch("http://127.0.0.1:${address.port}/actual");return {text:value.text}`
  )
  expect((await f.run()).text).toBe("real development HTTP bytes")
  expect(received).toEqual(["/actual"])
  expect(f.calls).toEqual(["effect:http.fetch", "httpApproval"])
  f.assertNoGrants()
})

it.each(["process.run", "process.spawn"] as const)(
  "performs an isolated real %s with native approval",
  async (method) => {
    const argv = JSON.stringify([
      process.execPath,
      "-e",
      'process.stdout.write("real development process bytes")'
    ])
    const body =
      method === "process.run"
        ? `const value=await $.process.run(${argv});return {text:value.stdout}`
        : `const stream=$.process.spawn({argv:${argv}});let text="";for await(const chunk of stream)text+=chunk.text;await stream.result;return {text}`
    const f = await fixture([method], body)
    expect((await f.run()).text).toBe("real development process bytes")
    expect(f.calls).toEqual([`effect:${method}`, "processApproval"])
    f.assertNoGrants()
  }
)

it("does not inherit another SDK family's permission from an approved model method", async () => {
  const f = await fixture(
    ["model.complete"],
    'try{await $.model.classify("x",["yes","no"]);return {text:"escaped"}}catch(error){return {text:typeof $.model.classify+":"+String(error)}}'
  )
  expect((await f.run()).text).toMatch(/^undefined:TypeError:/)
  expect(f.calls).toEqual([])
  f.assertNoGrants()
})
