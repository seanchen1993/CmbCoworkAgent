import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createMemoryMiddleware, createSkillsMiddleware, FilesystemBackend } from "deepagents"
import { buildFunctionSessionContextSources } from "./context-sources"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { MemorySaver } from "@langchain/langgraph"
import { readLiveContextUsage } from "./context-usage"
import { expect, it, vi } from "vitest"
import type { ModsManager } from "../mods/manager"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createFunctionSessionViewMiddleware } from "./mods-session-view"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware
} from "./turn-completion-integrity"

class ScriptedModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = []
  constructor(private readonly script: AIMessage[]) {
    super({})
  }
  _llmType() {
    return "mods-session-script"
  }
  bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const message = this.script.shift()
    if (!message) throw Error("Unexpected model call")
    return { generations: [{ text: String(message.content), message }] }
  }
}

it("observes real model/tool/final graph states and preserves completion recovery routing", async () => {
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({
    workspace: "/root",
    threadId: "thread",
    turnId: "turn"
  })
  let current: readonly unknown[] = []
  const manager = {
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn((_authority, messages: readonly unknown[]) => {
      current = messages
    }),
    updateFunctionSessionRequest: vi.fn()
  }
  const model = new ScriptedModel([
    new AIMessage({ content: "", response_metadata: { finish_reason: "stop" } }),
    new AIMessage({
      content: "reading",
      tool_calls: [{ id: "call", name: "inspect", args: {}, type: "tool_call" }]
    }),
    new AIMessage({ content: "finished", response_metadata: { finish_reason: "stop" } })
  ])
  const inspect = tool(
    async () => {
      expect((current.at(-1) as AIMessage).tool_calls?.[0]?.id).toBe("call")
      return "tool result"
    },
    { name: "inspect", description: "Inspect", schema: z.object({}) }
  )
  try {
    const agent = createAgent({
      model,
      tools: [inspect],
      middleware: [
        createTurnCompletionGateMiddleware({ ownerRunToken: "turn" }),
        createFunctionSessionViewMiddleware(
          manager as unknown as ModsManager,
          authority,
          "actual-model",
          "physical-run",
          32000
        )
      ]
    })
    const result = await agent.invoke(
      { messages: [new HumanMessage("inspect")] },
      { configurable: { thread_id: "thread" } }
    )
    expect(model.calls).toHaveLength(3)
    expect(current).toEqual(result.messages)
    expect((current.at(-1) as AIMessage).content).toBe("finished")
    expect(current.some((message) => (message as BaseMessage).getType() === "tool")).toBe(true)
    expect(manager.bindFunctionSession).toHaveBeenCalledWith(authority, "actual-model", 32000)
    expect(manager.functionTurns.observe).toHaveBeenCalledTimes(3)
    expect(manager.functionTurns.observe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["thread", "physical-run"],
      ["thread", "physical-run"],
      ["thread", "physical-run"]
    ])
    expect(manager.functionTurns.observe.mock.calls.map((call) => call[2].content)).toEqual([
      "",
      "reading",
      "finished"
    ])
    expect(
      manager.functionTurns.observe.mock.calls.every((call) => call[2].getType() === "ai")
    ).toBe(true)
  } finally {
    authorities.close()
    clearTurnCompletionGateState("thread", "turn")
  }
})

it("observes the private compaction boundary through real graph middleware state", async () => {
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({
    workspace: "/root",
    threadId: "thread",
    turnId: "turn"
  })
  let observedMessages: readonly unknown[] = []
  let observedState: unknown
  const manager = {
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn(
      (_authority, messages: readonly unknown[], state: unknown) => {
        observedMessages = messages
        observedState = state
      }
    ),
    updateFunctionSessionRequest: vi.fn()
  }
  try {
    const agent = createAgent({
      model: new ScriptedModel([new AIMessage("no provider usage yet")]),
      tools: [],
      middleware: [
        createFunctionSessionViewMiddleware(
          manager as unknown as ModsManager,
          authority,
          "actual",
          "run",
          32000
        )
      ],
      checkpointer: new MemorySaver()
    })
    const config = { configurable: { thread_id: "thread" } }
    await agent.updateState(
      config,
      {
        messages: [
          new AIMessage({
            content: "old",
            usage_metadata: { input_tokens: 900, output_tokens: 1, total_tokens: 901 }
          })
        ],
        _summarizationEvent: {
          cutoffIndex: 0,
          usageStartIndex: 1,
          summaryMessage: new HumanMessage("summary"),
          filePath: null
        }
      },
      "model_request"
    )
    await agent.invoke({ messages: [new HumanMessage("continue")] }, config)
    expect(observedState).toHaveProperty("_summarizationEvent.usageStartIndex", 1)
    expect(
      await readLiveContextUsage(
        observedMessages,
        observedState,
        new AbortController().signal,
        () => {}
      )
    ).toBeUndefined()
  } finally {
    authorities.close()
  }
})

it("publishes the host context-source snapshot with each model request", async () => {
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({
    workspace: "/root",
    threadId: "thread",
    turnId: "turn"
  })
  const manager = {
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn(),
    updateFunctionSessionRequest: vi.fn()
  }
  const contextSources = {
    memoryFiles: [{ path: "/root/MEMORY.md", type: "memory", tokens: 2 }],
    mcpTools: [{ name: "search", serverName: "github", tokens: 3, isLoaded: true }],
    agents: [{ agentType: "Explore", source: "built-in", tokens: 4 }]
  }
  try {
    const agent = createAgent({
      model: new ScriptedModel([new AIMessage("done")]),
      tools: [],
      middleware: [
        createFunctionSessionViewMiddleware(
          manager as unknown as ModsManager,
          authority,
          "actual",
          "run",
          32000,
          undefined,
          contextSources
        )
      ]
    })
    await agent.invoke(
      { messages: [new HumanMessage("hello")] },
      { configurable: { thread_id: "thread" } }
    )
    expect(manager.updateFunctionSessionRequest).toHaveBeenCalledWith(
      authority,
      expect.objectContaining({ contextSources })
    )
  } finally {
    authorities.close()
  }
})

it("captures actual skill frontmatter and loaded memory from production middleware only when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-context-sources-"))
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({ workspace: root, threadId: "thread", turnId: "turn" })
  const manager = {
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn(),
    updateFunctionSessionRequest: vi.fn()
  }
  try {
    await mkdir(join(root, "skills", "folder-name"), { recursive: true })
    await writeFile(join(root, "MEMORY.md"), "real loaded memory", "utf8")
    await writeFile(
      join(root, "skills", "folder-name", "SKILL.md"),
      "---\nname: real-skill\ndescription: Review source carefully\n---\nFull instructions stay unloaded",
      "utf8"
    )
    const backend = new FilesystemBackend({ rootDir: root, virtualMode: true })
    for (const enabled of [true, false]) {
      manager.updateFunctionSessionRequest.mockClear()
      const model = new ScriptedModel([new AIMessage("done")])
      const agentOptions = {
        model,
        systemPrompt: "base instructions",
        tools: [],
        middleware: [
          ...(enabled
            ? [
                createSkillsMiddleware({ backend, sources: ["/skills"] }),
                createMemoryMiddleware({ backend, sources: ["/MEMORY.md", "/missing.md"] })
              ]
            : []),
          createFunctionSessionViewMiddleware(
            manager as unknown as ModsManager,
            authority,
            "actual",
            "run",
            32000,
            undefined,
            (request) =>
              buildFunctionSessionContextSources(
                {
                  memorySources: enabled ? ["/MEMORY.md", "/missing.md"] : undefined,
                  skillSources: enabled ? ["/skills"] : undefined,
                  pluginSkillSources: [{ sourceDir: "/skills", pluginName: "real-plugin" }]
                },
                request
              )
          )
        ]
      }
      // Match runtime.ts's interop boundary between the installed deepagents
      // and langchain middleware type versions; execution uses the real graph.
      const agent = createAgent(agentOptions as unknown as Parameters<typeof createAgent>[0])
      await agent.invoke({ messages: [new HumanMessage("hello")] })
      const sources = manager.updateFunctionSessionRequest.mock.calls[0][1].contextSources
      if (enabled) {
        expect(sources.memoryFiles).toEqual([{ path: "/MEMORY.md", type: "memory", tokens: 5 }])
        expect(sources.skills).toMatchObject({
          totalSkills: 1,
          includedSkills: 1,
          skillFrontmatter: [
            {
              name: "real-skill",
              source: "/skills/folder-name/SKILL.md",
              pluginName: "real-plugin"
            }
          ]
        })
        expect(JSON.stringify(model.calls[0][0].content)).toContain("real-skill")
        expect(JSON.stringify(model.calls[0][0].content)).not.toContain(
          "Full instructions stay unloaded"
        )
      } else {
        expect(sources.memoryFiles).toEqual([])
        expect(sources.skills).toBeUndefined()
        expect(JSON.stringify(model.calls[0][0].content)).not.toContain("real-skill")
      }
    }
  } finally {
    authorities.close()
    if (
      dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith("mods-context-sources-")
    )
      await rm(root, { recursive: true, force: true })
  }
})
