import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { app } from "electron"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { ProjectFunctionFiles } from "../../src/main/mods/v2/file-access"
import type { ModJson, ModObject } from "../../src/shared/mods/types"
import { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { FunctionDispatcher } from "../../src/main/mods/v2/dispatcher"
import { dispatchFunctionStream } from "../../src/main/mods/v2/stream-dispatcher"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"
import { FunctionSession, SESSION_CAPABILITIES } from "../../src/main/mods/v2/session"

const root = resolve(process.argv[2])
const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.cjs"))
const checks: string[] = []
let temporaryProject: string | undefined
void app.whenReady().then(async () => {
  try {
    const compiled = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/conformance"))
    const guest = await client.load(compiled.code, compiled.options)
    const plugin = {
      guest,
      name: compiled.name,
      root: compiled.root,
      tier: "user" as const,
      capabilities: []
    }
    const engine = new FunctionDispatcher([plugin])
    const cases = [
      ["cmb-order", "A(B(AB))", 1],
      ["cmb-double", "1,2", 2],
      ["cmb-throw-before", "1", 1],
      ["cmb-throw-after", "1", 1],
      ["cmb-catch", "REFUSED_BY_CATCH", 0],
      ["cmb-short", "SHORT", 0],
      ["cmb-catch-replay", "true:throw:1:1", 1],
      ["cmb-catch-once", "false:throw:1:1", 1],
      ["cmb-undefined-after", "1", 1],
      ["cmb-undefined-before", "1", 1],
      ["cmb-pattern", "command.run:true:true", 0]
    ] as const
    for (const [command, text, calls] of cases) {
      let count = 0
      const result = await engine.dispatch(
        "command.run",
        { command, args: "", origin: { kind: "composer" } },
        {
          core: async (_, e) => {
            count++
            return { text: command === "cmb-order" ? e.args : String(count) }
          }
        }
      )
      assert.deepEqual(result.value, { text })
      assert.equal(count, calls)
      checks.push(command)
    }
    const traced = await engine.dispatch(
      "command.run",
      { command: "cmb-trace", args: "" },
      {
        core: async () => ({ text: "ok" })
      }
    )
    const trace = JSON.parse(String((traced.value as ModObject).text))
    assert.equal(trace.aborted, false)
    assert.equal(trace.origin.plugin, "engine")
    assert.ok(trace.entries > 0)
    checks.push("trace")
    let failures = 0
    await assert.rejects(
      engine.dispatch(
        "command.run",
        {
          command: "cmb-downstream-error",
          args: ""
        },
        {
          core: async () => {
            failures++
            throw Error("provider failed")
          }
        }
      ),
      /provider failed/
    )
    assert.equal(failures, 1)
    checks.push("downstream error")
    for (const [command, expected] of [
      ["cmb-pinned", "cmb-pinned:"],
      ["cmb-pinned-omitted", "cmb-pinned-omitted:"]
    ] as const) {
      const value = await engine.dispatch(
        "command.run",
        {
          command,
          args: "",
          origin: { kind: "composer" }
        },
        { core: async (_, e) => ({ text: `${e.command}:${e.args}` }) }
      )
      assert.deepEqual(value.value, { text: expected })
      checks.push(command)
    }

    for (const [model, texts, answer, requests] of [
      ["cmb-transform", ["ONE", "TWO"], "terminal-value", 1],
      ["cmb-delegate", ["one", "two"], "onetwo", 1],
      ["cmb-stream-fail", ["wrapped-one", "two"], "onetwo", 1],
      ["cmb-stream-double", ["one", "two", "one", "two"], "onetwo", 2],
      ["cmb-stream-throw-before", ["one", "two"], "onetwo", 1],
      ["cmb-stream-catch", ["one", "two"], "onetwo", 1]
    ] as const) {
      let count = 0
      const stream = dispatchFunctionStream(
        [plugin],
        {
          turnId: "probe",
          index: 0,
          model,
          messageCount: 1
        },
        {
          async *core(e) {
            count++
            yield { kind: "text", index: 0, text: "one" }
            yield { kind: "text", index: 0, text: "two" }
            return {
              turnId: e.turnId,
              index: e.index,
              answer: "onetwo",
              toolUses: [],
              stopReason: "end_turn",
              usage: null
            }
          }
        }
      )
      const chunks: ModJson[] = []
      for await (const chunk of stream) chunks.push((chunk as ModObject).text)
      assert.deepEqual(chunks, texts)
      assert.equal(((await stream.result) as ModObject).answer, answer)
      assert.equal(count, requests)
      checks.push(model)
    }

    const concurrent = await client.load(`var __cmbFunctionMod={register(on){
      on("command.run",async($,e)=>({text:await $.probe.wait(e.id)}))
    }}`)
    const releases = new Map<string, () => void>()
    const signals = new Map<string, AbortSignal>()
    const call = (id: string, signal?: AbortSignal) =>
      concurrent.invoke(
        "0",
        { id },
        async (_, args, hostSignal) => {
          const key = String((args as ModJson[])[0])
          signals.set(key, hostSignal)
          await new Promise<void>((resolve, reject) => {
            releases.set(key, resolve)
            hostSignal.addEventListener("abort", () => reject(Error("cancelled")), { once: true })
          })
          return { value: key }
        },
        {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["probe.wait"],
          plugin: { name: "probe", root },
          signal
        }
      )
    const controller = new AbortController()
    const a = call("a", controller.signal)
    const aRejected = assert.rejects(a, /MODS_CANCELLED/)
    const b = call("b")
    const deadline = Date.now() + 5000
    while (releases.size !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    assert.equal(releases.size, 2)
    controller.abort()
    await aRejected
    assert.equal(signals.get("a")?.aborted, true)
    assert.equal(signals.get("b")?.aborted, false)
    releases.get("b")!()
    assert.deepEqual(await b, { value: { text: "b" } })
    checks.push("concurrent frames and cancellation")
    await concurrent.dispose()

    const sdk = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/basic-session"))
    const sdkSession = new FunctionSession(
      [
        {
          name: sdk.name,
          root: sdk.root,
          tier: "user",
          guest: await client.load(sdk.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      { workspace: root, threadId: "thread", assertLive: () => undefined, publish: async (v) => v }
    )
    assert.deepEqual(JSON.parse(String((await sdkSession.run("sdk-probe", "")).text)), {
      registered: { command: "sdk-child" },
      description: "Child!",
      id: "nested:other:thread",
      now: 123,
      short: "undefined",
      next: "undefined"
    })
    await sdkSession.close()
    checks.push(
      "same official SDK conformance fixture through utilityProcess and the production session"
    )

    temporaryProject = await realpath(await mkdtemp(join(tmpdir(), "function-process-files-")))
    await mkdir(join(temporaryProject, "fixture"))
    await writeFile(join(temporaryProject, "fixture/hello.txt"), "hi")
    const fileTimes: number[] = []
    for (const [fixture, command, expected] of [
      ["command-held", "held-probe", { direct: true, indirect: true, calls: 0 }],
      [
        "readonly-files",
        "files-probe",
        {
          text: "HI",
          absolute: true,
          entries: [{ name: "hello.txt", kind: "file", size: 2 }],
          exists: true,
          missing: false,
          stat: { kind: "file", size: 2, modified: true }
        }
      ]
    ] as const) {
      const fixturePlugin = await compileFunctionPlugin(
        join(root, "tests/fixtures/mods-v2", fixture)
      )
      const fixtureGuest = await client.load(fixturePlugin.code, fixturePlugin.options)
      const files = new ProjectFunctionFiles(
        temporaryProject,
        () => undefined,
        async (value) => value
      )
      const fixtureSession = new FunctionSession(
        [
          {
            name: fixture,
            root: fixturePlugin.root,
            guest: fixtureGuest,
            tier: "user",
            capabilities: [...SESSION_CAPABILITIES]
          }
        ],
        {
          threadId: fixture,
          workspace: temporaryProject,
          assertLive: () => undefined,
          publish: async (v) => v,
          files: () => files
        }
      )
      assert.deepEqual(JSON.parse(String((await fixtureSession.run(command, "")).text)), expected)
      if (fixture === "readonly-files") {
        await assert.rejects(fixtureSession.run(command, "escape"), {
          code: "MODS_FS_OUTSIDE_PROJECT",
          downstream: true
        })
        for (let index = 0; index < 120; index++) {
          const before = performance.now()
          assert.deepEqual(
            JSON.parse(String((await fixtureSession.run(command, "")).text)),
            expected
          )
          if (index >= 20) fileTimes.push(performance.now() - before)
        }
      }
      await fixtureSession.close()
      checks.push(`${fixture}: same official source through utilityProcess and production session`)
    }
    fileTimes.sort((a, b) => a - b)

    const exhausted = await client.load(`var __cmbFunctionMod={register(on){
      on("command.run", async()=>{await Promise.resolve();const until=Date.now()+30;while(Date.now()<until){};return {text:"ok"}})
    }}`)
    for (let attempt = 0; attempt < 40 && !exhausted.stats.disposed; attempt++) {
      await exhausted
        .invoke("0", {}, async () => ({}), {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "budget", root }
        })
        .catch(() => undefined)
    }
    assert.equal(exhausted.stats.disposed, true)
    await assert.rejects(exhausted.matches("0", {}), /MODS_UNLOADED/)
    assert.equal(await guest.matches("0", { command: "cmb-pinned" }), true)
    checks.push("a single exhausted VM invalidates its proxy without killing another plugin")

    const samples: number[] = []
    for (let i = 0; i < 100; i++) {
      const before = performance.now()
      await engine.dispatch(
        "command.run",
        { command: "cmb-order", args: "" },
        {
          core: async (_, e) => ({ text: e.args })
        }
      )
      samples.push(performance.now() - before)
    }
    samples.sort((a, b) => a - b)
    await guest.dispose()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(client.stats.frames, 0)
    assert.equal(client.stats.replies, 0)
    assert.equal(client.stats.pending, 0)
    assert.equal(client.stats.calls, 0)
    assert.equal(client.stats.runtimes, 0)
    checks.push("unload releases frames, replies and VMs")
    const crashGuest = await client.load(`var __cmbFunctionMod={register(on){
      on("command.run",async($)=>({text:await $.probe.wait()}))
    }}`)
    let crashSignal: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const interrupted = crashGuest.invoke(
      "0",
      {},
      async (_, _args, signal) => {
        crashSignal = signal
        entered()
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("host exited")), { once: true })
        )
        return {}
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["probe.wait"],
        plugin: { name: "crash", root }
      }
    )
    const interruption = assert.rejects(interrupted, /MODS_HOST_EXITED/)
    await started
    assert.ok(client.stats.pid)
    process.kill(client.stats.pid!)
    await interruption
    assert.equal(crashSignal?.aborted, true)
    assert.equal(crashGuest.stats.disposed, true)
    await assert.rejects(crashGuest.matches("0", {}), /MODS_UNLOADED/)
    const replacement = await client.load(compiled.code)
    assert.equal(await replacement.matches("0", { command: "cmb-pinned" }), true)
    await replacement.dispose()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(client.stats.frames, 0)
    assert.equal(client.stats.replies, 0)
    checks.push("process crash revokes capabilities and stale handles; explicit reload recovers")
    const report = {
      passed: checks.length,
      checks,
      stats: client.stats,
      performance: {
        count: samples.length,
        p50Ms: samples[49],
        p95Ms: samples[94],
        maxMs: samples[99],
        scope: "two hooks plus matcher IPC; warmed isolated runtime"
      },
      filesPerformance: {
        count: fileTimes.length,
        p50Ms: fileTimes[49],
        p95Ms: fileTimes[94],
        maxMs: fileTimes[99],
        scope:
          "complete command, two file hooks, five real project file operations; 20 warmups; no content filtering configured"
      }
    }
    await writeFile(join(__dirname, "process-report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    client.stop()
    await rm(temporaryProject, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    client.stop()
    if (temporaryProject) await rm(temporaryProject, { recursive: true, force: true })
    app.exit(1)
  }
})
