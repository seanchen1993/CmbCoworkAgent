// Actual createAgentRuntime + graph + HTTP model request capture.
// The model is a local deterministic server; no workflow launch or model billing occurs.
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({ root: "", database: "", endpoint: "" }))
vi.mock("electron", () => ({
  app: {
    getPath: () => fixture.root || tmpdir(),
    getName: () => "test",
    getVersion: () => "0",
    getAppPath: () => process.cwd()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getDbPath: () => fixture.database,
  getPlugins: () => [],
  getEnabledSkillsSources: async () => [],
  getEnabledSkillMiddlewareSources: async () => [],
  getEnabledPluginSkillSourceMetadata: () => [],
  getEnabledPluginSkillMiddlewareSources: async () => [],
  getDisabledSkillDirs: () => [],
  getSkillsDir: () => join(fixture.root, "skills"),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: () => {}
}))
vi.mock("../models/registry", async (original) => ({
  ...(await original<typeof import("../models/registry")>()),
  getAvailableModelConfigOrDefault: () => ({
    id: "local-test",
    model: "local-test",
    baseUrl: fixture.endpoint,
    apiKey: "local-not-a-secret",
    maxTokens: 32000
  }),
  getModelConfigByRef: () => ({
    id: "local-test",
    model: "local-test",
    baseUrl: fixture.endpoint,
    apiKey: "local-not-a-secret",
    maxTokens: 32000
  })
}))
vi.mock("../services/workspace-probe-worker?nodeWorker", async () => ({
  default: (await import("../services/workspace-probe.test-helper")).createWorkspaceProbeTestWorker
}))
import { closeWorkspaceProbeWorker } from "../services/workspace-probe-client"
import { removeWorkspaceProbeTestWorker } from "../services/workspace-probe.test-helper"
import * as db from "../db"
import { createAgentRuntime, closeCheckpointer } from "./runtime"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
const requests: Array<{
  tools?: Array<{ function?: { name?: string } }>
  messages: Array<{ role: string; content: unknown }>
}> = []
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  requests.push(body)
  const delegate = body.messages.some((message: { role: string; content: unknown }) =>
    message.role === "user" && String(message.content).includes("DELEGATE_CONTEXT_FIXTURE")) &&
    !body.messages.some((message: { role: string }) => message.role === "tool")
  const answer = delegate ? {
    role: "assistant", content: "", tool_calls: [{ id: "inspect-pom", type: "function",
      function: { name: "task", arguments: JSON.stringify({ subagent_type: "Explore",
        description: "INSPECT_POM_ONLY: report the pom/git/java version facts. Do not modify files." }) } }]
  } : { role: "assistant", content: "Done." }
  if (body.stream !== true) {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        id: "actual-http-model",
        object: "chat.completion",
        created: 1,
        model: "local-test",
        choices: [
          { index: 0, message: answer, finish_reason: delegate ? "tool_calls" : "stop" }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
    return
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const chunk = {
    id: "actual-http-model",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-test",
    choices: [{ index: 0, delta: delegate ? { ...answer, tool_calls: answer.tool_calls!.map(call => ({ ...call, index: 0 })) } : answer, finish_reason: null }]
  }
  response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end(
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`
  )
})
let previousHome: string | undefined
beforeAll(async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "host-mode-real-runtime-"))
  mkdirSync(join(fixture.root, "skills"))
  fixture.database = join(fixture.root, "actual.sqlite")
  previousHome = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = fixture.root
  await db.initializeDatabase()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("TEST_HTTP_LISTENER_MISSING")
  fixture.endpoint = `http://127.0.0.1:${address.port}/v1`
})
afterAll(async () => {
  await closeWorkspaceProbeWorker()
  removeWorkspaceProbeTestWorker()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await db.closeDatabase()
  if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previousHome
  rmSync(fixture.root, { recursive: true, force: true })
})
it.each(["ordinary", "normal", "workflow"] as const)(
  "exposes workflow to the real model only for the explicitly frozen Host mode: %s",
  async (mode) => {
    const threadId = randomUUID()
    const selected = mode === "workflow" ? "workflow" : "normal"
    db.createThread(threadId, { agentMode: selected, workspacePath: fixture.root })
    const token =
      mode === "ordinary"
        ? undefined
        : issueRuntimePluginSourceToken({
            mode: "host",
            executionMode: selected,
            threadId,
            incarnationKey: "fixture-incarnation",
            projectId: "generic-supplier",
            operationId: randomUUID(),
            stageId: "implementation",
            workspace: fixture.root,
            packageDigest: "a".repeat(64),
            inputFingerprint: "b".repeat(64),
            plugin: {
              id: "supplier",
              name: "supplier",
              version: "1.0.0",
              path: fixture.root,
              enabled: true,
              description: "",
              author: "",
              skillCount: 0,
              mcpServerCount: 0,
              createdAt: "",
              updatedAt: ""
            }
          })
    const controller = new AbortController()
    const start = requests.length
    try {
      await withRuntimePluginSource(token, async () => {
        const runtime = await createAgentRuntime({
          threadId,
          workspacePath: fixture.root,
          agentMode: selected,
          toolStrategy: "standard",
          disableMcpTools: true,
          memoryEnabled: false,
          disableMemoryInjection: true,
          turnCompletionTodoGateEnabled: false,
          abortSignal: controller.signal
        })
        await runtime.invoke(
          { messages: [new HumanMessage("Reply Done without calling tools.")] },
          { configurable: { thread_id: threadId }, recursionLimit: 30, signal: controller.signal }
        )
      })
      expect(requests.length).toBeGreaterThan(start)
      const tools = requests
        .slice(start)
        .flatMap((request) => request.tools ?? [])
        .map((tool) => tool.function?.name)
      expect(tools.includes("workflow")).toBe(mode === "workflow")
    } finally {
      controller.abort()
      await closeCheckpointer(threadId)
    }
  },
  30000
)

// Real runtime -> original task tool -> Explore graph -> actual model transport.
// Only the local model's answers are deterministic; source/role/prompt assembly is production.
it.each(["host", "legacy", "ordinary"] as const)(
  "keeps delegated work separate from the parent stage goal in %s mode",
  async (mode) => {
    const threadId = randomUUID()
    db.createThread(threadId, { agentMode: "normal", workspacePath: fixture.root })
    const parentTask = "PARENT_STAGE_GOAL: finish the entire stage. FEEDBACK_A FEEDBACK_B FEEDBACK_C FEEDBACK_D"
    const background = "HOST_BACKGROUND: bound stage only; host actions must not be duplicated; existing permissions and approvals still apply."
    const knowledge = "REQUIRED_KNOWLEDGE_AND_CONFIG: deployment is disabled; use only the approved workspace."
    const token = mode === "ordinary" ? undefined : issueRuntimePluginSourceToken({
      mode, threadId, incarnationKey: "fixture-incarnation", projectId: "generic-supplier",
      operationId: randomUUID(), stageId: "design", workspace: fixture.root,
      packageDigest: "a".repeat(64), stagePrompt: parentTask,
      subagentContextPrompt: background, requiredContextText: knowledge,
      plugin: { id: "supplier", name: "supplier", version: "1.0.0", path: fixture.root,
        enabled: true, description: "", author: "", skillCount: 0, mcpServerCount: 0,
        createdAt: "", updatedAt: "" }
    })
    const start = requests.length
    const controller = new AbortController()
    try {
      await withRuntimePluginSource(token, async () => {
        const runtime = await createAgentRuntime({
          threadId, workspacePath: fixture.root, agentMode: "normal", toolStrategy: "standard",
          isHarnessProjectSession: mode !== "ordinary", pluginPromptInject: parentTask,
          harnessAgentsPrompt: knowledge, disableMcpTools: true, memoryEnabled: false,
          disableMemoryInjection: true, turnCompletionTodoGateEnabled: false,
          abortSignal: controller.signal
        })
        await runtime.invoke({ messages: [new HumanMessage("DELEGATE_CONTEXT_FIXTURE")] },
          { configurable: { thread_id: threadId }, recursionLimit: 30, signal: controller.signal })
      })
      const observed = requests.slice(start)
      const parent = observed.find(request => request.messages.some(message =>
        message.role === "user" && String(message.content).includes("DELEGATE_CONTEXT_FIXTURE")))!
      expect(parent).toBeDefined()
      expect(JSON.stringify(parent.messages.filter(message => message.role === "system"))).toContain(parentTask)
      const child = observed.find(request => request.messages.some(message =>
        message.role === "user" && String(message.content).includes("INSPECT_POM_ONLY")))!
      expect(child).toBeDefined()
      const prompt = JSON.stringify(child.messages.filter(message => message.role === "system"))
      expect(child.tools?.some(tool => ["write_file", "edit_file", "workflow"].includes(tool.function?.name ?? ""))).toBe(false)
      expect(child.tools?.some(tool => tool.function?.name === "execute")).toBe(true)
      if (mode === "host") {
        expect(prompt).toContain(background)
        expect(prompt).toContain(knowledge)
        expect(prompt).not.toContain("PARENT_STAGE_GOAL")
        for (const marker of ["FEEDBACK_A", "FEEDBACK_B", "FEEDBACK_C", "FEEDBACK_D"])
          expect(prompt).not.toContain(marker)
      } else if (mode === "legacy") {
        expect(prompt).toContain(parentTask)
        expect(prompt).toContain(knowledge)
      } else {
        expect(prompt).not.toContain(parentTask)
        expect(prompt).not.toContain(knowledge)
      }
    } finally {
      controller.abort()
      await closeCheckpointer(threadId)
    }
  }, 30000
)
