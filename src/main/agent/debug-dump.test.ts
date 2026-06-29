import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { dumpAgentInputDebug, dumpModelCallDebug, dumpSystemPromptDebug } from "./debug-dump"

const oldEnabled = process.env.CMB_COWORK_AGENT_DEBUG_DUMP
const oldDir = process.env.CMB_COWORK_AGENT_DEBUG_DIR

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
}

describe("agent debug dump", () => {
  afterEach(() => {
    if (oldEnabled === undefined) delete process.env.CMB_COWORK_AGENT_DEBUG_DUMP
    else process.env.CMB_COWORK_AGENT_DEBUG_DUMP = oldEnabled
    if (oldDir === undefined) delete process.env.CMB_COWORK_AGENT_DEBUG_DIR
    else process.env.CMB_COWORK_AGENT_DEBUG_DIR = oldDir
  })

  it("writes nothing unless explicitly enabled", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cmb-debug-disabled-"))
    const output = mkdtempSync(join(tmpdir(), "cmb-debug-output-"))
    delete process.env.CMB_COWORK_AGENT_DEBUG_DUMP
    process.env.CMB_COWORK_AGENT_DEBUG_DIR = output

    dumpSystemPromptDebug({
      workspacePath: workspace,
      threadId: "thread-a",
      systemPrompt: "system"
    })

    expect(() => readJson(join(output, "thread-a", "latest-system-prompt.json"))).toThrow()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(output, { recursive: true, force: true })
  })

  it("writes system prompt, agent input, and model call snapshots when enabled", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cmb-debug-enabled-"))
    const output = mkdtempSync(join(tmpdir(), "cmb-debug-output-"))
    process.env.CMB_COWORK_AGENT_DEBUG_DUMP = "1"
    process.env.CMB_COWORK_AGENT_DEBUG_DIR = output

    dumpSystemPromptDebug({
      workspacePath: workspace,
      threadId: "thread-b",
      modelId: "model-a",
      systemPrompt: "SYSTEM PROMPT",
      toolNames: ["read_file"]
    })
    dumpAgentInputDebug({
      workspacePath: workspace,
      threadId: "thread-b",
      input: { messages: [{ role: "user", content: "hi" }] }
    })
    const toolCalls = [{ id: "call-a", name: "read_file", args: { path: "README.md" } }]
    dumpModelCallDebug({
      workspacePath: workspace,
      threadId: "thread-b",
      inputMessages: [{ role: "system", content: "SYSTEM PROMPT" }],
      outputMessage: { role: "assistant", content: "ok", toolCalls },
      toolCalls
    })

    const dir = join(output, "thread-b")
    expect(readJson(join(dir, "latest-system-prompt.json")).systemPrompt).toBe("SYSTEM PROMPT")
    expect(readJson(join(dir, "latest-agent-input.json")).kind).toBe("agent_stream_input")
    const modelCall = readJson(join(dir, "latest-model-call.json"))
    expect(modelCall.kind).toBe("model_call")
    expect(modelCall.toolCalls).toEqual(toolCalls)
    rmSync(workspace, { recursive: true, force: true })
    rmSync(output, { recursive: true, force: true })
  })
})
