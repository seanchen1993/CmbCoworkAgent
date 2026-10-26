import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { FunctionUserConfigValues } from "./user-config-values"
import { FunctionModels } from "./models"
import { prepareFunctionModelPrompt } from "./model-prompt"
import { invokeFunctionFork, invokeFunctionModel } from "./model-provider"
import type { ResolvedModelConfig } from "../../models/registry"
import type { ModJson } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  await import("../../agent/runtime")
}, 60000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  startup = `await $.model.complete({model:"fixture",prompt:"startup-input",system:"native-rule"})`,
  extraHooks = "",
  settings: { sourceFiles?: number; modern?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "mods-startup-model-"))
  const path = join(root, "plugin"),
    threadId = randomUUID()
  const signal = new AbortController().signal
  const bodies: Array<Record<string, unknown>> = []
  let beforeReply: (() => Promise<void>) | undefined
  let publishBarrier: ((value: ModJson) => Promise<void>) | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    await beforeReply?.()
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({
        id: "startup",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "startup-answer" },
            finish_reason: "stop"
          }
        ]
      })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({
        id: "startup",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("Missing endpoint")
  const config = {
    id: "fixture",
    name: "Fixture",
    ref: "custom:fixture",
    source: "custom",
    model: "gpt-4",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture-key",
    maxTokens: 32000,
    maxOutputTokens: 2048
  } as ResolvedModelConfig
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name: "startup-demo",
      ...(settings.modern === false ? { cmbCompatibility: { modelProtocol: "legacy-v1" } } : {}),
      userConfig: {
        tone: { type: "string", title: "Tone", description: "Tone", default: "warm" }
      }
    })
  )
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  const count = settings.sourceFiles ?? 1
  const imports = Array.from({ length: count - 1 }, (_, i) => `import "./part${i}.ts";`).join("\n")
  for (let i = 0; i < count - 1; i++)
    await writeFile(
      join(path, "hooks", `part${i}.ts`),
      `/*${"x".repeat(15000)}*/export const marker${i}=${i}`
    )
  const code = `${imports}\nexport function register(on,options){
    on("prompt.compose",async($,e,next)=>{
      await $.store.set("prompt-hook-entered",true);
      const snapshot=await $.prompt.compose();
      if(!snapshot.sections.some(s=>s.text.includes("You are CMBDevClaw")))throw Error("wrong request");
      const out=await next(e);return {sections:[...out.sections,{id:"startup-rule",scope:"session",text:"rule-"+options.tone}]}
    });${extraHooks}
    on("session.start",async($,e,next)=>{const result=${startup};
      await $.store.set("startup",result);await $.command.register({name:"probe",description:options.tone});return next(e)})
  }`
  await writeFile(join(path, "hooks/register.ts"), code)
  const store = new ModControlStore(join(root, "control.sqlite"))
  const values = new FunctionUserConfigValues(store)
  const sources = [{ id: "p", name: "startup-demo", path, enabled: true }]
  const models = new FunctionModels(store, {
    assertScope: () => {},
    resolve: async () => config,
    captureStartup: (workspace, thread) => manager.captureStartupModelGuard(workspace, thread),
    prepare: (chosen, request, snapshot, _identity, active, assertLive) =>
      prepareFunctionModelPrompt(
        chosen,
        request,
        snapshot,
        (event, input, current, core) =>
          manager.independentModelPrompt(root, threadId, event, input, current, core),
        active,
        assertLive,
        async () => {}
      ),
    invoke: invokeFunctionModel,
    admit: async () => {},
    publish: async (_identity, text) => text,
    captureForkSnapshot: () => null,
    invokeFork: invokeFunctionFork
  })
  let complete = (...args: Parameters<FunctionModels["complete"]>) => models.complete(...args)
  let completeResult = (...args: Parameters<FunctionModels["completeResult"]>) => models.completeResult(...args)
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      clawApplicable: () => true,
      enabled: () => true,
      publish: async (_workspace, value) => {
        await publishBarrier?.(value)
        return value
      },
      changed: () => {},
      assertThread: () => {},
      completeModel: (...args) => complete(...args),
      completeModelResult: (...args) => completeResult(...args),
      forkModelResult: (...args) => models.forkResult(...args),
      capability: (workspace, thread, grant, method, input, active) =>
        method === "model.classify"
          ? models.classify(workspace, thread, grant, input, active)
          : models.fork(workspace, thread, grant, input, active)
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      const loading = new Set<Promise<FunctionGuestRuntime>>()
      const failures: unknown[] = []
      let closed = false
      let draining: Promise<void> | undefined
      const drain = (): Promise<void> => {
        closed = true
        return draining ??= (async () => {
          await Promise.allSettled([...loading])
          await Promise.allSettled(guests.map(async (guest) => {
            try {
              await guest.dispose()
              expect(guest.stats.disposed).toBe(true)
              expect(guest.stats.frames).toBe(0)
              expect(guest.stats.replies).toBe(0)
            } catch (error) {
              failures.push(error)
            }
          }))
          if (failures.length) throw new AggregateError(failures, "STARTUP_FIXTURE_DRAIN_FAILED")
        })()
      }
      return {
        load: (source, options) => {
          if (closed) return Promise.reject(new Error("STARTUP_FIXTURE_CLIENT_CLOSED"))
          const operation = (async () => {
            let guest: FunctionGuestRuntime
            try {
              guest = await FunctionGuestRuntime.create(source, options)
            } catch (error) {
              failures.push(error)
              throw error
            }
            // Keep the original disposal failure even if the Guest already set disposed=true.
            // The session may dispose first; its own retirement assertion remains authoritative.
            const originalDispose = guest.dispose.bind(guest)
            let disposalFailed = false
            let disposalFailure: unknown
            guest.dispose = (...args: Parameters<FunctionGuestRuntime["dispose"]>) => {
              if (disposalFailed) throw disposalFailure
              try {
                originalDispose(...args)
              } catch (error) {
                disposalFailed = true
                disposalFailure = error
                failures.push(error)
                throw error
              }
            }
            guests.push(guest)
            if (closed) {
              await guest.dispose()
              throw new Error("STARTUP_FIXTURE_CLIENT_CLOSED")
            }
            return guest
          })()
          loading.add(operation)
          void operation.then(() => loading.delete(operation), () => loading.delete(operation))
          return operation
        },
        stop: () => {
          closed = true
          const stopped: unknown[] = []
          for (const guest of guests) {
            try { guest.dispose() } catch (error) { stopped.push(error) }
          }
          void drain().catch(() => {})
          if (stopped.length) throw new AggregateError(stopped, "STARTUP_FIXTURE_STOP_FAILED")
        },
        stopAndDrain: drain
      }
    }
  )
  const compiled = await compileFunctionPlugin(path)
  store.grant(root, "function:startup-demo", compiled.digest, true)
  cleanup.push(async () => {
    manager.close()
    await new Promise((done) => setTimeout(done, 80))
    store.close()
    server.closeAllConnections()
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    )
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-startup-model-/)
    await rm(root, { recursive: true, force: true })
  })
  const save = (tone: string) =>
    values.save(
      root,
      compiled.name,
      compiled.userConfig!,
      "tone",
      tone,
      values.read(root, compiled.name).revision,
      () => {}
    )
  const reload = async () => {
    const view = await manager.userConfig(root, threadId, "p", signal, () => {})
    return manager.reloadUserConfig(
      root,
      threadId,
      "p",
      view.digest,
      view.savedRevision,
      signal,
      () => {}
    )
  }
  return {
    root,
    path,
    threadId,
    signal,
    manager,
    store,
    compiled,
    values,
    bodies,
    save,
    reload,
    ordinaryReentry: () => {
      complete = async () => {
        await manager.classicEvent(root, threadId, "prompt.context", { text: "unframed" }, signal)
        throw Error("unreachable")
      }
      completeResult = async () => {
        await manager.classicEvent(root, threadId, "prompt.context", { text: "unframed" }, signal)
        throw Error("unreachable")
      }
    },
    beforeReply: (operation: () => Promise<void>) => {
      beforeReply = operation
    },
    barrier: (operation: (value: ModJson) => Promise<void>) => {
      publishBarrier = operation
    }
  }
}

it("composes the actual cold startup model request without awaiting its unfinished session", async () => {
  const f = await fixture()
  expect(await f.manager.commands(f.root, f.threadId)).toHaveLength(1)
  expect(f.bodies).toHaveLength(1)
  expect(
    JSON.stringify(f.bodies[0]),
    JSON.stringify(await f.manager.logs(f.root, f.threadId))
  ).toContain("rule-warm")
  expect(f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")).toMatchObject({isAnswered:true,text:"startup-answer"})
}, 15000)

it("a real provider response beyond five seconds completes within the shared startup deadline", async () => {
  const f = await fixture()
  f.beforeReply(async () => {
    await new Promise((done) => setTimeout(done, 5200))
  })
  const start = performance.now()
  await f.manager.commands(f.root, f.threadId)
  expect(performance.now() - start).toBeGreaterThan(5200)
  expect(f.bodies).toHaveLength(1)
  expect(f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")).toMatchObject({isAnswered:true,text:"startup-answer"})
}, 15000)

it.each([[false,false],[false,true],[true,false],[true,true]])(
  "ordinary same-session startup reentry fails immediately, quiet=%s modern=%s",
  async (quiet,modern) => {
    const f = await fixture(undefined,"",{modern})
    f.ordinaryReentry()
    if (quiet)
      expect(await f.manager.hasEventHandler(f.root, f.threadId, "prompt.compose")).toBe(true)
    const started = performance.now()
    // The host propagates a terminal downstream error instead of waiting on its own initialization.
    await expect(f.manager.commands(f.root, f.threadId)).rejects.toThrow("组件启动期间不能再次进入")
    expect(performance.now() - started).toBeLessThan(2000)
    expect(f.bodies).toHaveLength(0)
  },
  5000
)

it("quiet registration discovery runs no model, then its first start uses the dedicated route", async () => {
  const f = await fixture()
  expect(await f.manager.hasEventHandler(f.root, f.threadId, "prompt.compose")).toBe(true)
  expect(f.bodies).toHaveLength(0)
  expect(await f.manager.commands(f.root, f.threadId)).toHaveLength(1)
  expect(f.bodies).toHaveLength(1)
  expect(JSON.stringify(f.bodies[0])).toContain("rule-warm")
}, 15000)

it("uses the new instance's rules on explicit reload and refuses model effects during automatic adoption", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  await f.manager.commands(f.root, f.threadId)
  expect(f.bodies).toHaveLength(1)
  const reloaded = await f.reload()
  expect(reloaded.state, JSON.stringify(reloaded)).toBe("applied")
  expect(f.bodies).toHaveLength(2)
  expect(JSON.stringify(f.bodies[1])).toContain("rule-formal")
  expect(JSON.stringify(f.bodies[1])).not.toContain("rule-warm")
}, 15000)

it("rejects changed source after the provider returns and never publishes the startup result", async () => {
  const f = await fixture()
  f.beforeReply(async () => {
    await writeFile(join(f.path, "hooks/register.ts"), "export function register(){}")
  })
  await expect(f.manager.commands(f.root, f.threadId)).rejects.toThrow()
  expect(f.bodies).toHaveLength(1)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")
  ).toBeUndefined()
}, 15000)

it("blocks the prompt hook when publication changes the saved version before actual admission", async () => {
  const f = await fixture()
  let changed = false
  f.barrier(async (value) => {
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "surfaces" in value
    ) {
      changed = true
      f.save("changed-at-publication")
    }
  })
  await expect(f.manager.commands(f.root, f.threadId)).rejects.toThrow()
  expect(changed).toBe(true)
  expect(f.bodies).toHaveLength(0)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "prompt-hook-entered")
  ).toBeUndefined()
}, 15000)

it.each([false,true])("rejects stale model publication before after-hooks, modern=%s", async modern => {
  const f = await fixture(
    undefined,
    `on("model.complete",async($,e,next)=>{
    const result=await next(e);await $.store.set("model-after-entered",true);return result})`, {modern}
  )
  let changed = false
  f.barrier(async (value) => {
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value.value === "startup-answer" ||
        (typeof value.value === "object" && value.value !== null && !Array.isArray(value.value) &&
          value.value.text === "startup-answer"))
    ) {
      changed = true
      f.save("changed-after-provider")
    }
  })
  await expect(f.manager.commands(f.root, f.threadId)).rejects.toThrow()
  expect(changed).toBe(true)
  expect(f.bodies).toHaveLength(1)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "model-after-entered")
  ).toBeUndefined()
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")
  ).toBeUndefined()
}, 15000)

it.each([false, true])(
  "a guest catch cannot admit or use a stale startup snapshot, quiet=%s",
  async (quiet) => {
    const f = await fixture(
      `await (async()=>{try{return await $.model.complete({model:"fixture",prompt:"startup-input",system:"native-rule"})}catch{return "caught"}})()`
    )
    if (quiet) await f.manager.hasEventHandler(f.root, f.threadId, "prompt.compose")
    f.beforeReply(async () => {
      await writeFile(join(f.path, "hooks/register.ts"), "export function register(){}")
    })
    await expect(f.manager.commands(f.root, f.threadId)).rejects.toThrow()
    expect(f.bodies).toHaveLength(1)
    expect(
      f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")
    ).toBeUndefined()
  },
  15000
)

it("keeps two concurrent startup completions attached to their own actual prompts", async () => {
  const f = await fixture(
    `await Promise.all(["A","B"].map(id=>$.model.complete({model:"fixture",prompt:"input-"+id,system:"native-rule-"+id})))`
  )
  await f.manager.commands(f.root, f.threadId)
  expect(f.bodies).toHaveLength(2)
  const requests = f.bodies.map((body) => JSON.stringify(body))
  for (const id of ["A", "B"]) {
    const found = requests.find((body) => body.includes("input-" + id))!
    expect(found).toContain("native-rule-" + id)
    expect(found).not.toContain("input-" + (id === "A" ? "B" : "A"))
  }
}, 15000)

it("preserves modern completion result fields at startup", async () => {
  const f = await fixture(undefined, "", { modern: true })
  await f.manager.commands(f.root, f.threadId)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")
  ).toMatchObject({
    isAnswered: true,
    text: "startup-answer",
    usage: { input_tokens: 12, output_tokens: 3 }
  })
}, 15000)

it("a cold startup fork keeps its real nothing-to-fork result and uses no provider", async () => {
  const f = await fixture('await $.model.fork({prompt:"startup-fork"})', "", { modern: true })
  await f.manager.commands(f.root, f.threadId)
  expect(f.bodies).toHaveLength(0)
  expect(f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")).toEqual({
    isAnswered: false,
    reason: "nothing-to-fork"
  })
}, 15000)

it("bounds repeated real startup analysis with 128 source files near two MiB", async () => {
  const f = await fixture(undefined, "", { sourceFiles: 128 })
  const samples: number[] = []
  let start = performance.now()
  await f.manager.commands(f.root, f.threadId)
  samples.push(performance.now() - start)
  for (let i = 0; i < 3; i++) {
    f.save("large-" + i)
    start = performance.now()
    expect((await f.reload()).state).toBe("applied")
    samples.push(performance.now() - start)
  }
  expect(f.bodies).toHaveLength(4)
  const sorted = [...samples].sort((a, b) => a - b)
  await writeFile(
    "output/mods-startup-model-performance.json",
    JSON.stringify(
      {
        scope:
          "Actual QuickJS startup, 128 source files near 1.83 MiB, repeated full guards, private SDK compose, HTTP model and explicit full reload; local HTTP latency only; no renderer",
        samples,
        medianMs: sorted[2],
        maxMs: sorted[3]
      },
      null,
      2
    )
  )
  for (const body of f.bodies) expect(JSON.stringify(body)).toContain("rule-")
  expect(sorted[3]).toBeLessThan(15000)
}, 60000)

it("classifies at startup through actual composed rules without inventing a task history", async () => {
  const f = await fixture(
    'await $.model.classify("startup-classification",["startup-answer","other"],{model:"fixture"})'
  )
  await f.manager.commands(f.root, f.threadId)
  expect(f.bodies).toHaveLength(1)
  expect(JSON.stringify(f.bodies[0])).toContain("rule-warm")
  expect(f.store.functionState.get(JSON.stringify([f.root, "startup-demo"]), "startup")).toBe("startup-answer")
}, 15000)
