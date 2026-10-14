import assert from "node:assert/strict"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { app } from "electron"
import { getOpenworkDir, getPlugins } from "../../src/main/storage"
import { ModsManager } from "../../src/main/mods/manager"
import { ClawStore } from "../../src/main/mods/claw-store"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import { createAuthoringInstallService } from "../../src/main/mods/devtools/authoring-install-factory"
import { AuthoringDraftStore } from "../../src/main/mods/devtools/authoring-store"
import { createAuthoringTemplate } from "../../src/main/mods/devtools/authoring-templates"
import type { ClawProfile } from "../../src/shared/mods/claw"
import { TraceCollector, flushTraceWriteQueue } from "../../src/main/agent/trace/collector"
import {
  recordToolCallTraceNode,
  recordToolResultTraceNode
} from "../../src/main/agent/trace/turn-trace-recorder"
import { traceCodeExecCalls } from "../../src/main/agent/trace/live-tool-evidence"
import { CodeExecBridge } from "../../src/main/code-exec/bridge"
import type { McpCapabilityService } from "../../src/main/mcp/capability-types"

app.setPath("userData", process.env.CMB_COWORK_AGENT_HOME!)
void app
  .whenReady()
  .then(async () => {
    const root = getOpenworkDir()
    const manager = new ModsManager(
      join(root, "control.sqlite"),
      getPlugins,
      async () => false,
      () => {}
    )
    const functions = new FunctionModsManager(manager.store, {
      plugins: getPlugins,
      enabled: () => true,
      clawApplicable: () => true,
      registeredTool: async (_workspace, _threadId, grant, _input, _origin, _signal, run) => {
        manager.store.assertGrant(grant)
        return run()
      },
      publish: async (_workspace, value) => value,
      changed: () => {}
    })
    try {
      const service = createAuthoringInstallService(manager, functions)
      const drafts = new AuthoringDraftStore(manager.store)
      const scope = {
        workspace: root,
        signal: new AbortController().signal,
        assertCurrent: () => {}
      }
      for (const kind of ["command", "tool", "panel"] as const) {
        const id = `example-${kind}`
        const source = createAuthoringTemplate({
          id,
          kind,
          name: id,
          instruction: `${kind} evidence`
        })
        drafts.save({
          workspace: root,
          id,
          name: id,
          source,
          expectedRevision: 0,
          assertCurrent: () => {}
        })
        const prepared = await service.prepare(
          { draftId: id, revision: 1, sourceDigest: source.digest },
          scope
        )
        assert.deepEqual(
          prepared.review.components.map((component) => component.id),
          ["main"]
        )
        assert.equal(
          (
            await service.apply(
              { handle: prepared.handle, expectedCatalogDigest: prepared.catalogDigest },
              scope
            )
          ).state,
          "settled"
        )
      }
      assert.equal(getPlugins().length, 3)
      assert.deepEqual(await functions.commands(root, "examples"), [])
      const statuses = await functions.status(root)
      const profile: ClawProfile = { id: "examples", name: "Installed examples", capabilities: [] }
      for (const status of statuses) {
        assert.equal(status.state, "needs-approval")
        assert(status.digest)
        await functions.approve(root, status.pluginId, status.digest)
        profile.capabilities.push({
          pluginId: status.pluginId,
          name: status.name,
          digest: status.digest,
          components: { mode: "selected", ids: ["main"], config: {} }
        })
      }
      const claw = new ClawStore(manager.store)
      claw.write(root, { revision: 0, profiles: [profile], active: null }, 0)
      claw.apply(root, JSON.stringify(["examples", "legacy"]), profile, 1)
      functions.invalidate(root)
      const commands = await functions.commands(root, "examples")
      process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
      process.env.CMB_COWORK_TRACES_DIR = join(root, "owned-traces")
      const collector = new TraceCollector("examples", "Installed template evidence", "no-model", {
        includeSkillEval: false
      })
      const tracked = async <T>(name: string, callId: string, run: () => Promise<T>) => {
        const parent = recordToolCallTraceNode({
          tracer: collector,
          toolCall: { name, id: callId, args: {} },
          index: 0,
          llmMessageId: "explicit-host-test"
        })
        const value = await run()
        recordToolResultTraceNode({
          tracer: collector,
          kwargs: { content: "actual invocation settled" },
          messageId: callId + "-result",
          toolCallId: callId,
          parentId: parent
        })
        return value
      }
      assert.match(
        await tracked("read_file", "native-read", async () =>
          readFileSync(join(getPlugins()[0].path, "plugin.json"), "utf8")
        ),
        /example-/
      )
      const command = commands.find((item) => item.command === "example-command")
      assert(command)
      assert.match(
        (
          await tracked("mods.command", "mod-command", () =>
            functions.runCommand(root, "examples", command, "input", scope.signal)
          )
        ).text,
        /command evidence\ninput/
      )
      const tools = await functions.registeredTools(root, "examples")
      assert(tools.some((item) => item.name === "mcp__example-tool__format"))
      const result = await tracked("mcp__example-tool__format", "actual-tool-call", () =>
        functions.interceptTool(
          root,
          "examples",
          {
            tool: "mcp__example-tool__format",
            tool_use_id: "actual-tool-call",
            text: "input"
          },
          scope.signal,
          async () => {
            throw Error("registered tool must handle this call")
          }
        )
      )
      assert.match(JSON.stringify(result), /tool evidence/)
      const panel = commands.find((item) => item.command === "example-panel")
      assert(panel)
      await tracked("mods.panel", "mod-panel", () =>
        functions.runCommand(root, "examples", panel, "", scope.signal)
      )
      const panes = await functions.panes(root, "examples")
      assert.equal(panes.length, 1)
      assert.match(JSON.stringify(panes[0].tree), /panel evidence/)
      const capability: McpCapabilityService = {
        listTools: async () => [],
        getTool: async () => null,
        close: async () => {},
        invalidate: async () => {},
        invoke: async (name, args, assertCurrent) => {
          assertCurrent?.()
          const raw = await functions.interceptTool(
            root,
            "examples",
            {
              tool: name,
              tool_use_id: "nested-actual-call",
              text: String(args.text)
            },
            scope.signal,
            async () => {
              throw Error("registered tool unavailable")
            }
          )
          assertCurrent?.()
          return { capabilityId: name, raw, text: JSON.stringify(raw), isError: false }
        }
      }
      const bridge = new CodeExecBridge(
        traceCodeExecCalls(capability, collector.getTraceContext(), "code-exec-parent")
      )
      try {
        await tracked("code_exec", "code-exec-parent", async () => {
          const connection = await bridge.start()
          const response = await fetch(connection.bridgeUrl + "/call", {
            method: "POST",
            headers: {
              authorization: "Bearer " + connection.token,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              idOrAlias: "mcp__example-tool__format",
              args: { text: "nested actual result" }
            })
          })
          assert.equal(response.status, 200)
          assert.match(await response.text(), /tool evidence/)
        })
      } finally {
        await bridge.close()
      }
      const trace = await collector.finish("success")
      await flushTraceWriteQueue()
      const nodes = trace.nodes ?? []
      const parent = nodes.find((node) => node.type === "tool" && node.name === "code_exec")
      assert(parent)
      assert.equal(nodes.filter((node) => node.type === "tool").length, 6)
      assert.equal(nodes.filter((node) => node.type === "tool_result").length, 6)
      assert.equal(
        nodes.find((node) => node.parentId === parent.id && node.type === "tool")?.status,
        "success"
      )
      assert(nodes.some((node) => node.name === "read_file"))
      console.log(
        "PASS one actual collector: native read, Mods command/panel, registered MCP tool and authenticated CodeExec nested invocation"
      )
      console.log(
        "PASS three unmodified templates: real Worker install, explicit grant and Claw selection, command/tool/panel utility execution"
      )
    } finally {
      functions.close()
      manager.close()
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
