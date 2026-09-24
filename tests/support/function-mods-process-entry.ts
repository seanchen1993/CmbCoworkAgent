import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { EventEmitter, once } from "node:events"
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
import { randomUUID } from "node:crypto"
import type { FunctionUiElement } from "../../src/shared/mods/v2/ui"
import { ModControlStore } from "../../src/main/mods/control-store"
import { CLIENT_BOOTSTRAP } from "../../src/main/mods/v2/client-bootstrap"
import { checkEngineNouns } from "./function-engine-nouns-process"
import { CODEGEN_PROBE_COUNT, CODEGEN_PROBE_SOURCE } from "../fixtures/mods-v2/codegen-probes"
import { checkGlobalAvailability } from "./function-global-availability-process"
import { checkBase64Globals } from "./function-base64-process"

const root = resolve(process.argv[2])
const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.cjs"))
const checks: string[] = []
let temporaryProject: string | undefined
let paneStore: ModControlStore | undefined
void app.whenReady().then(async () => {
  try {
    checks.push(...(await checkGlobalAvailability(client, root)))
    checks.push(...(await checkBase64Globals(client)))
    const codegenGuest = await client.load(`${CODEGEN_PROBE_SOURCE}
      var __cmbFunctionMod={register(on){on("command.run",()=>codegenProbe())}}`)
    const codegenResult = await codegenGuest.invoke("0", {}, async () => ({}), {
      event: "command.run",
      origin: { plugin: "engine", tier: "core" },
      capabilities: [],
      plugin: { name: "codegen-probe", root }
    })
    assert.deepEqual(
      codegenResult.value,
      Array.from({ length: CODEGEN_PROBE_COUNT }, () => ({
        name: "TypeError",
        message: "MODS_CODE_GENERATION_DENIED"
      }))
    )
    await codegenGuest.dispose()
    checks.push("real utility guest rejects eval and indirect constructor code generation")
    const matcherGuest = await client.load(`var __cmbFunctionMod={register(on){
      const matcher={command:"before"};
      on("turn.step",($,e,next)=>next(e));
      on("command.run",matcher,($,e)=>({text:e.command}));
      on("session.start",()=>{matcher.command="after";return {text:"changed"}});
    }}`)
    assert.equal(matcherGuest.registrations[0].hasMatcher, false)
    assert.equal(matcherGuest.registrations[1].hasMatcher, true)
    for (let index = 0; index < 32; index++) assert.equal(await matcherGuest.matches("0", {}), true)
    assert.equal(await matcherGuest.matches("1", { command: "before" }), true)
    await matcherGuest.invoke("2", {}, async () => ({}), {
      event: "session.start",
      origin: { plugin: "engine", tier: "core" },
      capabilities: [],
      plugin: { name: "matcher-probe", root }
    })
    assert.equal(await matcherGuest.matches("1", { command: "before" }), false)
    assert.equal(await matcherGuest.matches("1", { command: "after" }), true)
    await matcherGuest.dispose()
    await assert.rejects(matcherGuest.matches("0", {}), /MODS_UNLOADED/)
    checks.push(
      "unconditional host matching retains dynamic guest matchers and disposal across real utility IPC"
    )
    const clockGuest = await client.load(`var __cmbFunctionMod={register(on){
      on("command.run",async $=>({text:await $.session.id()}));
    }}`)
    const wallClock = Date.now
    try {
      const corrected = Date.now() + 3600000
      Date.now = () => corrected
      const result = await clockGuest.invoke(
        "0",
        {},
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 350))
          return { value: "alive" }
        },
        {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["session.id"],
          plugin: { name: "clock-probe", root },
          timeoutMs: 2000
        }
      )
      assert.deepEqual(result.value, { text: "alive" })
    } finally {
      Date.now = wallClock
      await clockGuest.dispose()
    }
    checks.push("real utility IPC survives wall-clock correction during a pending guest host call")
    const engineNounsPerformance = await checkEngineNouns(client, root)
    checks.push(
      "engine.create cross-guest noun fold, original authority, middleware and closed zero-call comparison"
    )
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

    const toolPlugin = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/tool-sdk"))
    const toolContext = new AsyncLocalStorage<string>()
    const toolSession = new FunctionSession(
      [
        {
          name: toolPlugin.name,
          root: toolPlugin.root,
          tier: "user",
          guest: await client.load(toolPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "tools",
        assertLive: () => undefined,
        publish: async (v) => v,
        callTool: async (_, input) => {
          assert.equal(toolContext.getStore(), "tool authority")
          assert.notEqual(input.tool_use_id, "forged")
          assert.equal(input.agentId, undefined)
          return { result: input.file_path, text: input.file_path }
        }
      }
    )
    const toolAnswer = await toolContext.run("tool authority", () =>
      toolSession.run("tool-probe", "input")
    )
    assert.deepEqual(JSON.parse(String(toolAnswer.text)), {
      result: "rewritten",
      text: "rewritten",
      context: ["tool-sdk"]
    })
    assert.deepEqual(JSON.parse(String((await toolSession.run("tool-probe", "deny")).text)), {
      deny: "No read"
    })
    await toolSession.close()
    checks.push("tool SDK contract and host authority survive real utilityProcess callbacks")

    const mcpPlugin = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/mcp-sdk"))
    let mcpCalls = 0
    const mcpSession = new FunctionSession(
      [
        {
          name: mcpPlugin.name,
          root: mcpPlugin.root,
          tier: "user",
          guest: await client.load(mcpPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "mcp",
        assertLive: () => {},
        publish: async (v) => v,
        callMcp: async (_, input) => {
          assert.equal(toolContext.getStore(), "mcp authority")
          assert.deepEqual(input, { server: "Company Mail", tool: "send", args: {} })
          mcpCalls++
          return {
            content: [{ type: "resource_link", uri: "test://resource", name: "resource" }],
            isError: false,
            structuredContent: { count: mcpCalls }
          }
        }
      }
    )
    assert.deepEqual(
      JSON.parse(
        String(
          (await toolContext.run("mcp authority", () => mcpSession.run("mcp-probe", "empty"))).text
        )
      ),
      {
        content: [{ type: "resource_link", uri: "test://resource", name: "resource" }],
        isError: false,
        structuredContent: { count: 1 }
      }
    )
    assert.equal(mcpCalls, 1)
    await mcpSession.close()
    checks.push(
      "official MCP SDK fixture preserves structured blocks and host context across utilityProcess"
    )

    const permissionPlugin = await compileFunctionPlugin(
      join(root, "tests/fixtures/mods-v2/tool-check")
    )
    let permissionCalls = 0
    const permissionSession = new FunctionSession(
      [
        {
          name: permissionPlugin.name,
          root: permissionPlugin.root,
          tier: "user",
          guest: await client.load(permissionPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "permission",
        assertLive: () => {},
        publish: async (value) => value,
        callTool: async () => {
          throw Error("Permission query invoked a tool")
        },
        checkTool: async (plugin, input) => {
          assert.equal(toolContext.getStore(), "permission authority")
          assert.equal(plugin.name, "tool-check")
          assert.equal(input.tool, "Read")
          assert.equal(input.tool_use_id, undefined)
          permissionCalls++
          return { decision: "ask", reason: String((input.input as ModObject).file_path) }
        }
      }
    )
    for (const [args, file] of [
      ["", "fixture.txt"],
      ["rewrite", "original.txt"]
    ]) {
      const answer = await toolContext.run("permission authority", () =>
        permissionSession.run("permission-probe", args)
      )
      assert.deepEqual(JSON.parse(String(answer.text)), { decision: "ask", reason: file })
      checks.push(`official permission query preserves bare result and pinned input: ${file}`)
    }
    assert.equal(permissionCalls, 4)
    await permissionSession.close()

    const registryPlugin = await compileFunctionPlugin(
      join(root, "tests/fixtures/mods-v2/tool-registry")
    )
    const registrySession = new FunctionSession(
      [
        {
          name: registryPlugin.name,
          root: registryPlugin.root,
          tier: "user",
          guest: await client.load(registryPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      { workspace: root, threadId: "registry", assertLive: () => {}, publish: async (v) => v }
    )
    assert.equal((await registrySession.registeredTools())[0].name, "mcp__tool-registry__echo")
    assert.deepEqual(
      JSON.parse(String((await registrySession.run("registry-probe", "hello")).text)),
      {
        registered: { tool: "mcp__tool-registry__echo" },
        tools: [{ name: "mcp__tool-registry__echo", description: "Echo replaced", mcp: true }],
        answer: { result: "hello", context: ["tool-registry"] }
      }
    )
    const registryTimes: number[] = []
    for (let i = 0; i < 120; i++) {
      const before = performance.now()
      assert.deepEqual(
        await registrySession.interceptTool(
          { tool: "mcp__tool-registry__echo", tool_use_id: `model-${i}`, text: "model" },
          undefined,
          async () => {
            throw Error("Unexpected native fallback")
          }
        ),
        { result: "model", context: ["engine"] }
      )
      if (i >= 20) registryTimes.push(performance.now() - before)
    }
    registryTimes.sort((a, b) => a - b)
    await registrySession.close()
    checks.push(
      "same official registered tool fixture is discovered and served across utilityProcess without native fallback"
    )

    const ingressPlugin = await compileFunctionPlugin(
      join(root, "tests/fixtures/mods-v2/model-tools")
    )
    let ingressCalls = 0
    const ingressSession = new FunctionSession(
      [
        {
          name: ingressPlugin.name,
          root: ingressPlugin.root,
          tier: "user",
          guest: await client.load(ingressPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "ingress",
        assertLive: () => {},
        publish: async (value) => value
      }
    )
    const ingress = (file_path: string) =>
      toolContext.run("model authority", () =>
        ingressSession.interceptTool(
          { tool: "read_file", tool_use_id: "model-tool-id", file_path },
          undefined,
          async (input) => {
            assert.equal(toolContext.getStore(), "model authority")
            return { result: input.file_path, text: input.file_path, ref: ++ingressCalls }
          }
        )
      )
    assert.deepEqual(await ingress("input"), {
      result: "second",
      text: "second",
      ref: 2,
      context: ["engine", "first"]
    })
    assert.deepEqual(await ingress("deny"), { deny: "No read" })
    assert.deepEqual(await ingress("throw-after"), { result: "once", text: "once", ref: 3 })
    assert.equal(ingressCalls, 3)
    const ingressTimes: number[] = []
    for (let index = 0; index < 120; index++) {
      const before = performance.now()
      const answer = await ingress("input")
      assert.equal(answer.text, "second")
      if (index >= 20) ingressTimes.push(performance.now() - before)
    }
    ingressTimes.sort((a, b) => a - b)
    await ingressSession.close()
    checks.push(
      "same official engine tool fixture preserves origin, refs, context and recovery across utilityProcess"
    )

    const modelPlugin = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/model-sdk"))
    const modelCalls: string[] = []
    const modelSession = new FunctionSession(
      [
        {
          name: modelPlugin.name,
          root: modelPlugin.root,
          tier: "user",
          guest: await client.load(modelPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "models",
        assertLive: () => {},
        publish: async (v) => v,
        completeModel: async (_, input) => {
          modelCalls.push(String(input.prompt))
          return String(input.prompt)
        }
      }
    )
    assert.equal((await modelSession.run("model-probe", "input")).text, "model-sdk:first:second")
    assert.equal((await modelSession.run("model-probe", "short")).text, "local answer")
    assert.deepEqual(modelCalls, ["first", "second"])
    await modelSession.close()
    checks.push("same official model SDK source preserves operation results across utilityProcess")

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
          entries: [{ name: "hello.txt", kind: "file", size: 2, isLink: false }],
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

    const boardPlugin = await compileFunctionPlugin(join(root, "resources/mods/function-commands"))
    paneStore = new ModControlStore(join(temporaryProject, "panes-control.sqlite"))
    const boardState = paneStore.functionState
    const boardSession = new FunctionSession(
      [
        {
          name: boardPlugin.name,
          root: boardPlugin.root,
          tier: "user",
          guest: await client.load(boardPlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "board",
        assertLive: () => {},
        publish: async (value) => value,
        state: () => ({
          get: async (key) => boardState.get("board", key),
          keys: async () => boardState.keys("board"),
          set: async (key, value) => {
            boardState.set("board", key, value)
          },
          delete: (key) => {
            boardState.delete("board", key)
          }
        })
      }
    )
    await boardSession.run("claw-board", "")
    const paneTimes: number[] = []
    for (let index = 0; index < 120; index++) {
      const before = performance.now()
      const [pane] = await boardSession.panes.snapshot()
      let button: FunctionUiElement | undefined
      const visit = (node: FunctionUiElement | string): void => {
        if (typeof node === "string") return
        if (node.props.key === "count") button = node
        node.children?.forEach(visit)
      }
      visit(pane.tree)
      assert.ok(button?.press)
      await boardSession.panes.act({
        pane: pane.key,
        generation: pane.generation,
        plugin: button.press.plugin,
        handle: button.press.handle,
        kind: "press",
        intentId: randomUUID()
      })
      assert.equal(boardState.get("board", "board-count"), index + 1)
      if (index >= 20) paneTimes.push(performance.now() - before)
    }
    paneTimes.sort((a, b) => a - b)
    await boardSession.close()
    paneStore.close()
    paneStore = undefined
    checks.push(
      "TSX panes keep captured SDK callbacks across 120 drawings in the real utility process"
    )

    const surfacePlugin = await compileFunctionPlugin(
      join(root, "tests/fixtures/mods-v2/client-board")
    )
    const clientState = new Map<string, ModJson>()
    const clientMessages = new EventEmitter()
    const surfaceSession = new FunctionSession(
      [
        {
          name: surfacePlugin.name,
          root: surfacePlugin.root,
          tier: "user",
          guest: await client.load(surfacePlugin.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "surface",
        assertLive: () => undefined,
        publish: async (v) => v,
        loadClient: async (plugin, module) => {
          assert.equal(plugin, surfacePlugin.name)
          assert.ok(Object.hasOwn(surfacePlugin.clients, module))
          return client.load(CLIENT_BOOTSTRAP + "\n" + surfacePlugin.clients[module], { plugin })
        },
        state: () => ({
          get: async (k) => clientState.get(k),
          keys: async () => [...clientState.keys()],
          set: async (k, v) => {
            clientState.set(k, v)
            if (k === "client-message") clientMessages.emit("message", v)
          },
          delete: (k) => {
            clientState.delete(k)
          }
        })
      }
    )
    await surfaceSession.run("client-board", "")
    const clientTimes: number[] = []
    for (let index = 0; index < 120; index++) {
      const before = performance.now()
      const [pane] = await surfaceSession.panes.snapshot()
      const surface = pane.clients![0]
      assert.equal(surface.error, undefined)
      const button = surface.tree.children![1] as FunctionUiElement
      // Posting is frame-coalesced. Observe actual guest delivery before issuing another press.
      const delivered = once(clientMessages, "message", { signal: AbortSignal.timeout(2000) })
      await Promise.all([
        delivered,
        surfaceSession.clients.act({
          pane: pane.key,
          instance: surface.id,
          intentId: randomUUID(),
          kind: "press",
          handle: button.press!.handle
        })
      ])
      assert.deepEqual(clientState.get("client-message"), { count: index + 1 })
      if (index >= 20) clientTimes.push(performance.now() - before)
    }
    clientTimes.sort((a, b) => a - b)
    await surfaceSession.close()
    checks.push(
      "isolated Client preserves state, controls and messages across 120 production process frames"
    )

    const vectors = await compileFunctionPlugin(join(root, "tests/fixtures/mods-v2/svg-pane"))
    const vectorSession = new FunctionSession(
      [
        {
          ...vectors,
          tier: "user",
          guest: await client.load(vectors.code),
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: root,
        threadId: "vectors",
        assertLive: () => {},
        publish: async (v) => v,
        loadClient: (plugin, module) =>
          client.load(CLIENT_BOOTSTRAP + "\n" + vectors.clients[module], { plugin })
      }
    )
    try {
      await vectorSession.run("svg-pane", "")
      const [pane] = await vectorSession.panes.snapshot()
      assert.equal((pane.tree.children![0] as FunctionUiElement).type, "Svg")
      assert.equal(pane.clients![0].tree.type, "Svg")
      assert.equal(pane.clients![0].error, undefined)
      // Unchanged snapshots reuse the captured draw and the same isolated Client identity.
      for (let index = 0; index < 100; index++) {
        const [again] = await vectorSession.panes.snapshot()
        assert.equal(again.generation, pane.generation)
        assert.equal(again.clients![0].id, pane.clients![0].id)
      }
    } finally {
      await vectorSession.close()
    }
    checks.push(
      "bounded SVG leaves cross real guest and Client processes, with 100 stable cached snapshots"
    )

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
      runtime: { node: process.versions.node, electron: process.versions.electron },
      engineNounsPerformance,
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
      modelToolPerformance: {
        count: ingressTimes.length,
        p50Ms: ingressTimes[49],
        p95Ms: ingressTimes[94],
        maxMs: ingressTimes[99],
        scope:
          "model tool ingress with two explicit next calls through utilityProcess; 20 warmups; stub tool core, no native I/O or filtering"
      },
      registeredToolPerformance: {
        count: registryTimes.length,
        p50Ms: registryTimes[49],
        p95Ms: registryTimes[94],
        maxMs: registryTimes[99],
        scope:
          "registered echo tool through utilityProcess and schema validation; 20 warmups; no SQLite, I/O or content filtering"
      },
      filesPerformance: {
        count: fileTimes.length,
        p50Ms: fileTimes[49],
        p95Ms: fileTimes[94],
        maxMs: fileTimes[99],
        scope:
          "complete command, two file hooks, five real project file operations; 20 warmups; no content filtering configured"
      },
      panesPerformance: {
        count: paneTimes.length,
        p50Ms: paneTimes[49],
        p95Ms: paneTimes[94],
        maxMs: paneTimes[99],
        scope:
          "redraw and press through production session and utilityProcess; real SQLite state; 20 warmups; no content filtering"
      },
      clientsPerformance: {
        count: clientTimes.length,
        p50Ms: clientTimes[49],
        p95Ms: clientTimes[94],
        maxMs: clientTimes[99],
        scope:
          "Client snapshot, press and owner ui.message across two utility VMs; 20 warmups; in-memory message store; timers active"
      }
    }
    await writeFile(join(__dirname, "process-report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    client.stop()
    await rm(temporaryProject, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error("Last completed process checks:", checks.slice(-3))
    console.error(error)
    client.stop()
    paneStore?.close()
    if (temporaryProject) await rm(temporaryProject, { recursive: true, force: true })
    app.exit(1)
  }
})
