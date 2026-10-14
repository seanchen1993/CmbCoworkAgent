import { DatabaseSync } from "node:sqlite"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY as occurrenceKey,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY as sourceKey
} from "../../shared/message-role-collision"
import {
  createFunctionConversationSharedAgent,
  readCurrentFunctionConversationSharedNativeDomain,
  readFunctionConversationSharedNativeFactory
} from "./mods-conversation-shared-invocation"

// These ordinary graphs never open an AppDB or Desktop authority. The optional
// Native recipe receives a real isolated Store, but its capture always misses.
vi.mock("../storage", () => ({
  getDbPath: () => {
    throw Error("ORDINARY_SHARED_TEST_MUST_NOT_OPEN_APP_DB")
  },
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => "", getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const databases: NativeSqliteAdapter[] = []
afterEach(() => {
  const failures: unknown[] = []
  for (const database of databases.splice(0).reverse()) {
    try {
      database.close()
    } catch (reason) {
      failures.push(reason)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Shared identity database cleanup failed")
})

class RepeatingSharedProvider extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly issued: AIMessage[] = []

  constructor(private readonly label: string) {
    super({})
  }

  _llmType(): string {
    return "ordinary-shared-identity-provider"
  }
  bindTools(): this {
    return this
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const index = this.requests.length
    const message = new AIMessage({
      id: "shared-provider-reused",
      content: `${this.label} reply ${index}`,
      tool_calls:
        index <= 2 ? [{ id: `shared-call-${index}`, name: "shared_read", args: { index } }] : []
    })
    this.issued.push(message)
    return { generations: [{ message, text: String(message.content) }] }
  }
}

function fixture(nativeRecipe: boolean, label: string) {
  const model = new RepeatingSharedProvider(label)
  const effect = vi.fn((index: number) => `${label} evidence ${index}`)
  const read = tool(({ index }) => effect(index), {
    name: "shared_read",
    description: "Read the requested local test evidence",
    schema: z.object({ index: z.number().int().min(1).max(2) })
  })
  const capture = vi.fn(() => undefined)
  const captureRuntime = vi.fn(() => {
    throw Error("NO_SHARED_NATIVE_RUNTIME_ADMISSION")
  })
  const flush = vi.fn(() => {
    throw Error("NO_SHARED_NATIVE_TRANSCRIPT_FLUSH")
  })
  let store: FunctionConversationStore | undefined
  if (nativeRecipe) {
    const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(database)
    store = new FunctionConversationStore(database)
  }
  const agent = createFunctionConversationSharedAgent(
    {
      model,
      tools: [read],
      checkpointer: new MemorySaver()
    },
    capture,
    store
      ? { store, agentId: "ordinary_shared_fallback", model: "local", captureRuntime, flush }
      : undefined
  )
  const factory = readFunctionConversationSharedNativeFactory(agent.graph)
  if (nativeRecipe) {
    expect(factory).toBeDefined()
    expect(readCurrentFunctionConversationSharedNativeDomain(factory!, agent.graph)).toBeUndefined()
  } else {
    expect(factory).toBeUndefined()
  }
  return { agent, model, effect, capture, captureRuntime, flush }
}

function conversation(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.filter((message) => message.getType() !== "system")
}

describe("ordinary identity through the actual Shared Agent factory", () => {
  it.each([
    ["with Native options whose real capture returns undefined", true],
    ["without Native options", false]
  ] as const)("keeps all repeated-ID tool cycles %s", async (description, nativeRecipe) => {
    const f = fixture(nativeRecipe, "original")
    const config = { configurable: { thread_id: `shared-ordinary-identity:${description}` } }
    const configured = f.agent.withConfig(config)
    const user = new HumanMessage({ id: "original-user", content: "read twice" })
    const completed = await configured.invoke({ messages: [user] })
    expect(completed.messages.map((message) => message.content)).toEqual([
      "read twice",
      "original reply 1",
      "original evidence 1",
      "original reply 2",
      "original evidence 2",
      "original reply 3"
    ])
    expect(completed.messages.map((message) => message.getType())).toEqual([
      "human",
      "ai",
      "tool",
      "ai",
      "tool",
      "ai"
    ])
    expect(new Set(completed.messages.map((message) => message.id)).size).toBe(6)
    expect(f.effect.mock.calls).toEqual([[1], [2]])
    expect(f.model.requests).toHaveLength(3)
    expect(conversation(f.model.requests[2]).map((message) => message.content)).toEqual([
      "read twice",
      "original reply 1",
      "original evidence 1",
      "original reply 2",
      "original evidence 2"
    ])
    const assistants = completed.messages.filter(AIMessage.isInstance)
    assistants.forEach((message, index) => expect(message).toBe(f.model.issued[index]))
    expect(assistants.map((message) => message.additional_kwargs[sourceKey])).toEqual(
      Array(3).fill("shared-provider-reused")
    )
    expect(assistants.map((message) => message.additional_kwargs[occurrenceKey])).toEqual([1, 2, 3])
    expect(assistants.map((message) => message.tool_calls?.map((call) => call.id))).toEqual([
      ["shared-call-1"],
      ["shared-call-2"],
      []
    ])
    expect(
      completed.messages.filter(ToolMessage.isInstance).map((message) => message.tool_call_id)
    ).toEqual(["shared-call-1", "shared-call-2"])
    const checkpoint = await configured.graph.getState(config)
    expect(checkpoint.values.messages.map((message: BaseMessage) => message.content)).toEqual(
      completed.messages.map((message) => message.content)
    )

    const continued = await configured.invoke({
      messages: [
        new HumanMessage({
          id: "original-continuation",
          content: "continue without another tool"
        })
      ]
    })
    expect(continued.messages).toHaveLength(8)
    expect(conversation(f.model.requests[3]).map((message) => message.content)).toEqual([
      ...completed.messages.map((message) => message.content),
      "continue without another tool"
    ])
    expect(
      continued.messages
        .filter(AIMessage.isInstance)
        .map((message) => message.additional_kwargs[occurrenceKey])
    ).toEqual([1, 2, 3, 4])
    expect(f.effect.mock.calls).toEqual([[1], [2]])
    if (nativeRecipe) expect(f.capture).toHaveBeenCalled()
    else expect(f.capture).not.toHaveBeenCalled()
    expect(f.captureRuntime).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()

    // A fresh provider and Saver use the same configured thread ID without
    // inheriting the original graph's history or occurrence counter.
    const other = fixture(nativeRecipe, "independent")
    const isolated = await other.agent.withConfig(config).invoke({
      messages: [
        new HumanMessage({
          id: "independent-user",
          content: "separate read twice"
        })
      ]
    })
    expect(conversation(other.model.requests[0]).map((message) => message.content)).toEqual([
      "separate read twice"
    ])
    expect(isolated.messages.map((message) => message.content)).toEqual([
      "separate read twice",
      "independent reply 1",
      "independent evidence 1",
      "independent reply 2",
      "independent evidence 2",
      "independent reply 3"
    ])
    expect(
      isolated.messages
        .filter(AIMessage.isInstance)
        .map((message) => message.additional_kwargs[occurrenceKey])
    ).toEqual([1, 2, 3])
    expect(other.effect.mock.calls).toEqual([[1], [2]])
    expect(other.captureRuntime).not.toHaveBeenCalled()
    expect(other.flush).not.toHaveBeenCalled()
    expect(f.model.requests).toHaveLength(4)
    expect(
      (await configured.graph.getState(config)).values.messages.map(
        (message: BaseMessage) => message.content
      )
    ).toEqual(continued.messages.map((message) => message.content))
  })
})
