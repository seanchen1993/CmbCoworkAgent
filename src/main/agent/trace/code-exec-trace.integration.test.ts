import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  safeStorage: {}
}))

vi.mock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../../storage", () => ({ getUserInfo: () => null }))
vi.mock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: async () => null
}))
vi.mock("../../services/adoption-tracker", () => ({
  clearAdoptionContext: () => undefined,
  setAdoptionContext: () => undefined
}))
vi.mock("../skill-eval/documents", () => ({
  buildSkillEvalTraceExtension: () => undefined
}))
vi.mock("../skill-eval/window", () => ({
  appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
  getSkillEvalWindowAssistantText: () => "",
  getSkillEvalWindowContextByRawName: () => ({})
}))

import { TraceCollector, flushTraceWriteQueue } from "./collector"
import { traceCodeExecCalls } from "./live-tool-evidence"
import { CodeExecBridge } from "../../code-exec/bridge"
import type { McpCapabilityService } from "../../mcp/capability-types"

describe("real CodeExec HTTP observations and collector", () => {
  it("links authenticated transport calls under the exact native CodeExec parent", async () => {
    const owned = mkdtempSync(join(tmpdir(), "codeexec-trace-"))
    vi.stubEnv("CMB_COWORK_TRACE_STORAGE_MODE", "plaintext")
    vi.stubEnv("CMB_COWORK_TRACES_DIR", owned)
    const collector = new TraceCollector("thread", "test", "controlled-test", {
      includeSkillEval: false
    })
    const parent = collector.addToolNode({ name: "code_exec", toolCallId: "actual-call" })
    const invoke = vi.fn(async (name: string) => ({
      capabilityId: name,
      raw: { password: "do-not-record" },
      text: "do-not-record",
      isError: name.endsWith("failure")
    }))
    const service: McpCapabilityService = {
      listTools: async () => [],
      getTool: async () => null,
      invoke,
      close: async () => {},
      invalidate: async () => {}
    }
    const bridge = new CodeExecBridge(
      traceCodeExecCalls(service, collector.getTraceContext(), "actual-call")
    )
    try {
      const connection = await bridge.start()
      const send = (name: string, token: string) =>
        fetch(connection.bridgeUrl + "/call", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ idOrAlias: name, args: { password: "do-not-record" } })
        })
      expect((await send("mcp__test__success", "wrong")).status).toBe(401)
      expect(invoke).not.toHaveBeenCalled()
      expect((await send("mcp__test__success", connection.token)).status).toBe(200)
      expect((await send("mcp__test__failure", connection.token)).status).toBe(200)
      expect(invoke).toHaveBeenCalledTimes(2)
      collector.addToolResultNode({ parentId: parent, status: "success" })
      const trace = await collector.finish("success")
      const children = (trace.nodes ?? []).filter(
        (node) => node.parentId === parent && node.type === "tool"
      )
      expect(children).toHaveLength(2)
      expect(children.map((node) => node.status)).toEqual(["success", "error"])
      expect(
        (trace.nodes ?? []).filter((node) => node.type === "tool" && node.name === "code_exec")
      ).toHaveLength(1)
      expect(JSON.stringify(trace)).not.toContain("do-not-record")
      expect(
        children.every((node) => node.metadata?.evidenceCoverage === "host-call-observation")
      ).toBe(true)
    } finally {
      await bridge.close()
      await collector.finish("error")
      await flushTraceWriteQueue()
      vi.unstubAllEnvs()
      rmSync(owned, { recursive: true, force: true })
    }
  })
})
