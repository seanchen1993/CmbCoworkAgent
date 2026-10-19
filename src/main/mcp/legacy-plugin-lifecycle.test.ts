import { existsSync, readFileSync, realpathSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

// Isolate application persistence and manager startup only. Transport, SDK server,
// configuration conversion, capability discovery, invocation and close are real.
const fixture = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name?: string
    path: string
    enabled: boolean
    mcpServerCount: number
  }>
}))
vi.mock("../storage", () => ({
  getEnabledMcpConnectors: () => [],
  getPlugins: () => fixture.plugins,
  getUserInfo: () => ({}),
  getOpenworkDir: () => fixture.root,
  parseMcpJsonFile: (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers
}))
vi.mock("../mods/manager", () => ({
  getModsManager: () => null,
  authorizeCurrentModInput: async () => {}
}))

import {
  closeGlobalMcpCapabilityService,
  closeProjectCapabilityMcpService,
  getGlobalMcpCapabilityService,
  getProjectMcpCapabilityService
} from "./capability-service"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { functionMcpResult, resolveFunctionMcpTool } from "../mods/v2/mcp-sdk"
import { FunctionRegisteredTools } from "../mods/v2/registered-tools"
import { scheduleFunctionTool, withFunctionExecution } from "../mods/v2/execution-context"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { createAgent } from "langchain"
import { tool } from "@langchain/core/tools"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { z } from "zod"

it("passes only a portable static test-peer flag through real SDK stdio and logs in its private TEMP", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "portable-peer-temp-"))
  const privateTemp = join(fixture.root, "private-temp")
  await mkdir(privateTemp)
  const original = { TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH }
  process.env.TEMP = privateTemp
  process.env.TMP = privateTemp
  process.env.PATH = dirname(process.execPath) + delimiter + (original.PATH ?? "")
  await cp(resolve("tests/support/project-package-mcp-server.mjs"), join(fixture.root, "server.mjs"))
  await writeFile(join(fixture.root, ".mcp.json"), JSON.stringify({ mcpServers: {
    portable: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "-", "portable"],
      env: { CMB_E2E_PACKAGE_MCP_JOURNAL: "-" } }
  } }))
  fixture.plugins = [{ id: "portable", path: fixture.root, enabled: true, mcpServerCount: 1 }]
  const service = getGlobalMcpCapabilityService()
  try {
    const [tool] = await service.listTools()
    expect((await service.invoke(tool.capabilityId, { text: "actual-private-temp" })).text).toContain("portable:actual-private-temp")
    const journal = join(privateTemp, "package-mcp.jsonl")
    const rows = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: "call", text: "actual-private-temp", revision: "portable" })
    expect(decodeURIComponent(rows[0].source).replaceAll("\\", "/")).toContain(fixture.root.replaceAll("\\", "/") + "/server.mjs")
    await closeGlobalMcpCapabilityService()
    await vi.waitFor(() => expect(() => process.kill(rows[0].pid, 0)).toThrow(), { timeout: 5000 })
    await writeFile(join(fixture.root, ".mcp.json"), JSON.stringify({ mcpServers: {
      portable: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "-", "no-test-flag"] }
    } }))
    const unlogged = getGlobalMcpCapabilityService()
    const [ordinaryTool] = await unlogged.listTools()
    expect((await unlogged.invoke(ordinaryTool.capabilityId, { text: "still-functional" })).text).toContain("no-test-flag:still-functional")
    expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1)
  } finally {
    await closeGlobalMcpCapabilityService()
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 15000)

it("calls a configured server from a real preview guest outside ALS without borrowing global installation or grants", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "host-guest-mcp-connect-"))
  const retained = join(fixture.root, "retained 中文 space")
  await mkdir(join(retained, "mods"), { recursive: true })
  const journal = join(fixture.root, "guest.jsonl")
  await cp(resolve("tests/support/project-package-mcp-server.mjs"), join(retained, "server.mjs"))
  const config = JSON.stringify({
    mcpServers: {
      own: {
        command: process.execPath,
        args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", journal, "retained"]
      }
    }
  })
  await writeFile(join(retained, ".mcp.json"), config)
  await writeFile(
    join(retained, "plugin.json"),
    JSON.stringify({ name: "preview-sdk", version: "1.0.0" })
  )
  await writeFile(
    join(retained, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "guest-sdk", entry: "main.ts" })
  )
  await writeFile(
    join(retained, "mods/main.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"connect-own",description:"Connect own MCP"});
      await $.tool.register({name:"echo",description:"Call package MCP",isDeferred:false});return next(e)});
    on("tool.call",{tool:"mcp__guest-sdk__echo"},async($)=>({result:await $.mcp.call("own","echo",{text:"model-guest"})}));
    on("command.run",{command:"connect-own"},async($)=>{try{
      const reply=await $.mcp.call("own","echo",{text:"actual-guest"});
      return {text:JSON.stringify(reply)}
      }catch(error){return{text:"ACTUAL_SDK_ERROR:"+error.message}}
    })
  }`
  )
  const globalJournal = join(fixture.root, "global.jsonl")
  await writeFile(
    join(fixture.root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        global: {
          command: process.execPath,
          args: [resolve("tests/support/legacy-plugin-mcp-server.mjs"), globalJournal, "global"]
        }
      }
    })
  )
  fixture.plugins = [
    { id: "global", name: "global", path: fixture.root, enabled: true, mcpServerCount: 1 }
  ]
  const ordinary = getGlobalMcpCapabilityService()
  const [normal] = await ordinary.listTools()
  const source = {
    id: "dev-project-preview:actual-guest",
    name: "preview-sdk",
    path: retained,
    enabled: true,
    version: "1.0.0",
    description: "",
    author: "",
    skillCount: 0,
    mcpServerCount: 1,
    createdAt: "",
    updatedAt: ""
  }
  let active = true
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      capabilitySources: [],
      preserveParentContext: true,
      threadId: "stage",
      incarnationKey: "one",
      projectId: "project",
      operationId: "operation",
      workspace: fixture.root,
      packageDigest: "c".repeat(64),
      stageId: "draft",
      plugin: source
    },
    () => {
      if (readFileSync(join(retained, ".mcp.json"), "utf8") !== config)
        throw Error("SOURCE_CHANGED")
    },
    () => {
      if (!active) throw Error("PROJECT_SCOPE_REVOKED")
    }
  )
  const service = withRuntimePluginSource(token, () => getProjectMcpCapabilityService())
  const control = new ModControlStore(join(fixture.root, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  let scheduleModelCall = false
  const admission = vi.fn(async () => {})
  const registered = new FunctionRegisteredTools(control, {
    assertScope: () => {}, admit: admission, publish: async (_, value) => value
  })
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () =>
        fixture.plugins.map((plugin) => ({ ...plugin, name: plugin.name ?? plugin.id })),
      enabled: () => true,
      changed: () => {},
      publish: async (_, value) => value,
      clawApplicable: () => false,
      connectMcp: async (_workspace, _thread, grant, owner, signal, run) =>
        run((input, active) => {
          control.assertGrant(grant)
          return service.connectPluginServer!(
            owner,
            String(input.server),
            AbortSignal.any([signal, active]),
            () => control.assertGrant(grant)
          )
        }),
      registeredTool: (...args) => registered.call(...args),
      callMcp: async (_workspace, _thread, grant, input, signal) => {
        control.assertGrant(grant)
        const invoke = async () => {
          const tool = resolveFunctionMcpTool(
            await service.listTools(), String(input.server), String(input.tool)
          )
          return functionMcpResult(
            await service.invoke(tool.capabilityId, input.args as Record<string, unknown>)
          )
        }
        return scheduleModelCall
          ? scheduleFunctionTool({} as never, _workspace, _thread, "mcp:call", signal, invoke)
          : invoke()
      }
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() {
        for (const guest of guests) void guest.dispose()
      },
      async stopAndDrain() {
        await Promise.all(guests.map((guest) => guest.dispose()))
      }
    })
  )
  try {
    const input = {
      workspace: fixture.root,
      plugin: source,
      scope: { projectId: "project", packageDigest: "c".repeat(64) }
    }
    const facts = await manager.prepareRuntimeSourceFacts(input)
    await manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
    const [command] = await withRuntimePluginSource(token, () =>
      manager.commands(fixture.root, "stage")
    )
    // The native UI callback intentionally has no current runtime-source ALS.
    expect(
      (await manager.runCommand(fixture.root, "stage", command, "", new AbortController().signal))
        .text
    ).toContain("retained:actual-guest")
    // A real AgentNode model invokes the actual registered guest handler. Only the
    // admitted main task's original desktop lease enables its nested public MCP call.
    scheduleModelCall = true
    const authorityRegistry = new ModRuntimeAuthorities()
    const instance = authorityRegistry.create({ workspace: fixture.root, threadId: "stage", turnId: "model" })
    class Model extends FakeChatModel {
      bindTools() { return this }
      async _generate(messages: BaseMessage[]) {
        const message = ToolMessage.isInstance(messages.at(-1))
          ? new AIMessage("done") : new AIMessage({ content: "", tool_calls: [{
            name: "mcp__guest-sdk__echo", id: "actual-model-call", args: {}, type: "tool_call"
          }] })
        return { generations: [{ text: "", message }] }
      }
    }
    const model = createAgent({ model: new Model({}), tools: [tool(async () =>
      JSON.stringify(await manager.interceptTool(fixture.root, "stage", {
        tool: "mcp__guest-sdk__echo", tool_use_id: "actual-model-call"
      }, new AbortController().signal, async () => { throw Error("native fallback") })), {
      name: "mcp__guest-sdk__echo", description: "Call package MCP", schema: z.object({})
    })] })
    try {
      for (const owner of ["scheduler", "desktop"] as const) {
        expect(claimLocalThreadRunLease({ threadId: "stage", owner, runId: "model" }).acquired).toBe(true)
        try {
          const invoke = () => withFunctionExecution({ workspace: fixture.root, threadId: "stage",
            turnId: "model", runtimeAuthority: instance.authority, userInitiated: false,
            leased: true, immediate: false }, () => model.invoke({ messages: [{ role: "user", content: "probe" }] }))
          const result = await invoke()
          const response = result.messages.find(ToolMessage.isInstance)
          if (owner === "scheduler") {
            expect(JSON.stringify(response)).toContain("MODS_WRITE_REQUIRES_USER_ACTION")
            expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1)
          } else expect(JSON.stringify(response)).toContain("retained:model-guest")
        } finally { releaseLocalThreadRunLease("stage", owner, "model") }
      }
      expect(admission).toHaveBeenCalledTimes(2)
    } finally { authorityRegistry.close() }
    expect(
      (
        await service.connectPluginServer!(
          { pluginId: source.id, sourcePath: retained, root: realpathSync(retained) },
          "own",
          new AbortController().signal,
          () => {}
        )
      ).value
    ).toEqual({ isConnected: true, server: `plugin:${source.id}/own` })
    expect(control.getGrant(fixture.root, "function:guest-sdk")).toBeNull()
    expect(
      (
        await service.connectPluginServer!(
          { pluginId: "global", sourcePath: fixture.root, root: fixture.root },
          "global",
          new AbortController().signal,
          () => {}
        )
      ).value
    ).toMatchObject({ isConnected: false, reason: "unlisted" })
    control.grantProjectFunction(
      fixture.root,
      "project",
      "c".repeat(64),
      facts!.name,
      facts!.digest,
      false
    )
    await expect(
      manager.runCommand(fixture.root, "stage", command, "", new AbortController().signal)
    ).rejects.toThrow()
    active = false
    await expect(service.listTools()).rejects.toThrow("PROJECT_SCOPE_REVOKED")
    await closeProjectCapabilityMcpService(token)
    const calls = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls.map((row) => row.text)).toEqual(["actual-guest", "model-guest"])
    await vi.waitFor(() => expect(() => process.kill(calls[0].pid, 0)).toThrow(), {
      timeout: 5000,
      interval: 25
    })
    expect(
      (await ordinary.invoke(normal.capabilityId, { text: "after-project-close" })).text
    ).toContain("global:after-project-close")
  } finally {
    await closeProjectCapabilityMcpService(token)
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    control.close()
  }
}, 30000)

afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  fixture.plugins = []
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  fixture.root = ""
})

it("checks real host source bytes before spawning and drains a peer invalidated during initialization", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "host-mcp-content-fence-"))
  const original = readFileSync(resolve("tests/support/project-package-mcp-server.mjs"), "utf8")
  for (const timing of ["before", "during"] as const) {
    const retained = join(fixture.root, timing)
    await mkdir(retained)
    const journal = join(retained, "started.jsonl")
    const knowledge = join(retained, "knowledge.md")
    await writeFile(knowledge, "original")
    const peer = original
      .replace("import { appendFileSync }", "import { appendFileSync, writeFileSync }")
      .replace(
        '  if (message.method === "initialize")',
        `  if (message.method === "initialize") {
    appendFileSync(journal, JSON.stringify({event:"started",pid:process.pid})+"\\n");
    writeFileSync(${JSON.stringify(knowledge)}, "changed-during-initialize");`
      )
      .replace(
        '  else if (message.method === "tools/list")',
        '  } else if (message.method === "tools/list")'
      )
    await writeFile(join(retained, "server.mjs"), peer)
    await writeFile(
      join(retained, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          peer: {
            command: process.execPath,
            args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", journal, timing]
          }
        }
      })
    )
    const token = issueRuntimePluginSourceToken(
      {
        mode: "host",
        capabilitySources: [],
        preserveParentContext: true,
        threadId: timing,
        incarnationKey: timing,
        projectId: timing,
        operationId: timing,
        workspace: fixture.root,
        packageDigest: "b".repeat(64),
        stageId: "draft",
        plugin: {
          id: timing,
          name: timing,
          version: "1.0.0",
          path: retained,
          enabled: true,
          description: "",
          author: "",
          skillCount: 0,
          mcpServerCount: 1,
          createdAt: "",
          updatedAt: ""
        }
      },
      () => {
        if (readFileSync(knowledge, "utf8") !== "original") throw Error("PROJECT_KNOWLEDGE_CHANGED")
      },
      () => {}
    )
    const service = withRuntimePluginSource(token, () => getProjectMcpCapabilityService())
    try {
      if (timing === "before") await writeFile(knowledge, "changed-before-start")
      await expect(service.listTools()).rejects.toThrow("PROJECT_KNOWLEDGE_CHANGED")
      if (timing === "before") expect(existsSync(journal)).toBe(false)
      else {
        const started = JSON.parse(readFileSync(journal, "utf8").trim().split("\n")[0])
        await vi.waitFor(() => expect(() => process.kill(started.pid, 0)).toThrow(), {
          timeout: 5000,
          interval: 25
        })
      }
    } finally {
      await closeProjectCapabilityMcpService(token)
    }
  }
}, 30000)

it("isolates a host package MCP in its opaque source token and preserves global services", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "host-package-mcp-"))
  const retained = join(fixture.root, "retained 中文 space")
  await mkdir(retained)
  await cp(resolve("tests/support/project-package-mcp-server.mjs"), join(retained, "server.mjs"))
  const journal = join(fixture.root, "journal.jsonl")
  const config = (revision: string) =>
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            revision === "pinned"
              ? "${CLAUDE_PLUGIN_ROOT}/server.mjs"
              : resolve("tests/support/legacy-plugin-mcp-server.mjs"),
            journal,
            revision
          ]
        }
      }
    })
  await writeFile(join(fixture.root, ".mcp.json"), config("global"))
  await writeFile(join(retained, ".mcp.json"), config("pinned"))
  fixture.plugins = [
    { id: "mutable-installation", path: fixture.root, enabled: true, mcpServerCount: 1 }
  ]
  const global = getGlobalMcpCapabilityService()
  const [ordinary] = await global.listTools()
  expect((await global.invoke(ordinary.capabilityId, { text: "before" })).text).toContain(
    "global:before"
  )
  let active = true
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      capabilitySources: [],
      preserveParentContext: true,
      threadId: "host-stage",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace: fixture.root,
      packageDigest: "a".repeat(64),
      stageId: "draft",
      plugin: {
        id: "pinned-installation",
        path: retained,
        enabled: true,
        name: "pinned",
        version: "1.0.0",
        description: "",
        author: "",
        skillCount: 1,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    },
    () => {
      if (!active || readFileSync(join(retained, ".mcp.json"), "utf8") !== config("pinned"))
        throw Error("PINNED_SOURCE_CHANGED")
    }
  )
  const scoped = withRuntimePluginSource(token, () => getProjectMcpCapabilityService())
  expect(scoped).not.toBe(global)
  // The retained service keeps its original token even when the UI invokes outside ALS.
  const tools = await scoped.listTools()
  expect(tools).toHaveLength(1)
  expect(tools[0].pluginId).toBe("pinned-installation")
  expect((await scoped.invoke(tools[0].capabilityId, { text: "actual" })).text).toContain(
    "pinned:actual"
  )
  const actual = JSON.parse(readFileSync(journal, "utf8").trim().split("\n").at(-1)!)
  expect(decodeURIComponent(new URL(actual.source).pathname)).toContain(
    "/retained 中文 space/server.mjs"
  )
  expect((await global.invoke(ordinary.capabilityId, { text: "after" })).text).toContain(
    "global:after"
  )
  active = false
  await expect(scoped.invoke(tools[0].capabilityId, { text: "must-not-run" })).rejects.toThrow(
    "PINNED_SOURCE_CHANGED"
  )
  await closeProjectCapabilityMcpService(token)
  await vi.waitFor(() => expect(() => process.kill(actual.pid, 0)).toThrow(), {
    timeout: 5000,
    interval: 25
  })
  expect((await global.invoke(ordinary.capabilityId, { text: "after-close" })).text).toContain(
    "global:after-close"
  )
  expect(readFileSync(journal, "utf8")).not.toContain("must-not-run")
}, 30000)

it("executes a real legacy Plugin MCP tool and retires processes on disable, reload and removal", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "legacy-mcp-lifecycle-"))
  const journal = join(fixture.root, "journal.jsonl")
  const configPath = join(fixture.root, ".mcp.json")
  const plugin = { id: "legacy", path: fixture.root, enabled: true, mcpServerCount: 1 }
  fixture.plugins = [plugin]
  const configure = (revision: string) =>
    writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [resolve("tests/support/legacy-plugin-mcp-server.mjs"), journal, revision]
          }
        }
      })
    )
  const records = () =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { pid: number; event: string; revision: string; text?: string }
      )
  const dead = async (pid: number) => {
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow()
      },
      { timeout: 5_000, interval: 25 }
    )
  }
  await configure("one")
  const service = getGlobalMcpCapabilityService()
  const [tool] = await service.listTools()
  expect(tool).toMatchObject({
    capabilityId: "plugin:legacy/fixture:echo",
    sourceKind: "plugin",
    pluginId: "legacy"
  })
  const first = await service.invoke(tool.capabilityId, { text: "first" })
  expect(first.isError).toBe(false)
  expect(first.text).toContain("one:first")
  const firstPid = records().find((row) => row.event === "call")!.pid

  plugin.enabled = false
  expect(await service.listTools()).toEqual([])
  await expect(service.invoke(tool.capabilityId, { text: "disabled" })).rejects.toThrow(
    "MCP tool not found"
  )
  await dead(firstPid)
  expect(records().filter((row) => row.event === "call")).toHaveLength(1)

  plugin.enabled = true
  const [reenabled] = await service.listTools()
  expect(reenabled.connectionGeneration).not.toBe(tool.connectionGeneration)
  expect((await service.invoke(tool.capabilityId, { text: "reenabled" })).text).toContain(
    "one:reenabled"
  )
  const secondPid = records()
    .filter((row) => row.event === "call")
    .at(-1)!.pid
  expect(secondPid).not.toBe(firstPid)

  await configure("two")
  const [reloaded] = await service.listTools()
  expect(reloaded.connectionGeneration).not.toBe(reenabled.connectionGeneration)
  await dead(secondPid)
  expect((await service.invoke(tool.capabilityId, { text: "reloaded" })).text).toContain(
    "two:reloaded"
  )
  const thirdPid = records()
    .filter((row) => row.event === "call")
    .at(-1)!.pid

  fixture.plugins = []
  expect(await service.listTools()).toEqual([])
  await dead(thirdPid)
  await expect(service.invoke(tool.capabilityId, { text: "deleted" })).rejects.toThrow(
    "MCP tool not found"
  )
  expect(
    records()
      .filter((row) => row.event === "call")
      .map((row) => row.text)
  ).toEqual(["first", "reenabled", "reloaded"])
}, 30_000)
