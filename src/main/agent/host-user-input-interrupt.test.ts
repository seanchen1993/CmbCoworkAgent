import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAgent, tool } from "langchain"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { Command } from "@langchain/langgraph"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { createRequestUserInputTool } from "./tools/user-input-tool"
import {
  createHostUserInputInterruptMiddleware,
  assertHostUserInputCheckpoint
} from "./host-user-input-interrupt"
import { HostUserInputStore } from "../services/host-user-input-store"
import {
  bindHostUserInputScope,
  configureHostUserInputPersistence,
  getPendingUserInputForThread,
  submitUserInputResponse,
  getHostInputContinuation,
  claimHostInputContinuation,
  enterHostInputToolBoundary,
  prepareHostInputInterrupt
} from "../services/user-input"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
  configureHostUserInputPersistence(undefined)
})
const questions = [
  {
    id: "choice",
    header: "Input",
    question: "Which input?",
    options: [
      { label: "First", description: "The first input" },
      { label: "Second", description: "The second input" }
    ]
  }
]
class LocalModel extends BaseChatModel {
  _llmType() {
    return "host-wait-boundary-test"
  }
  bindTools() {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const outputs = messages.filter((message) => message.getType() === "tool")
    const message =
      outputs.length === 0
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "write-once", name: "write_file", args: {} }]
          })
        : outputs.length === 1
          ? new AIMessage({
              content: "",
              tool_calls: [{ id: "ask-once", name: "request_user_input", args: { questions } }]
            })
          : new AIMessage("Completed after the saved answer")
    return { generations: [{ message, text: String(message.content) }] }
  }
}

it("reopens the real graph checkpoint and resumes only the pending input, never the earlier write", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-graph-input-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const inputs = new HostUserInputStore(join(root, "input.sqlite"))
  cleanup.push(() => inputs.close())
  configureHostUserInputPersistence({ store: () => inputs, isCurrent: () => true })
  const binding = {
    projectId: "project",
    operationId: "op",
    stageId: "stage",
    installedPluginId: "plugin",
    expectedVersion: 1,
    pluginDigest: "a".repeat(64),
    inputFingerprint: "b".repeat(64),
    incarnationKey: "incarnation"
  }
  let release = bindHostUserInputScope("thread", binding, () => {})
  cleanup.push(() => release())
  const path = join(root, "checkpoint.sqlite")
  const saver = new SqlJsSaver(path)
  const create = (checkpointer: SqlJsSaver) =>
    createAgent({
      model: new LocalModel({}),
      checkpointer,
      middleware: [createHostUserInputInterruptMiddleware()],
      tools: [
        tool(
          () => {
            const output = join(root, "writes.txt")
            let count = 0
            try {
              count = Number(readFileSync(output, "utf8"))
            } catch {
              /* First actual write. */
            }
            writeFileSync(output, String(count + 1))
            return "written"
          },
          {
            name: "write_file",
            description: "Record a real local side effect",
            schema: z.object({})
          }
        ),
        createRequestUserInputTool({
          threadId: "thread",
          requestUserInputConfig: {
            allowAutoResolution: false,
            autoResolutionType: "user_message"
          }
        })
      ]
    })
  const config = { configurable: { thread_id: "thread" } }
  try {
    await create(saver).invoke({ messages: [new HumanMessage("Write, ask, finish")] }, config)
  } finally {
    await saver.close()
  }
  release()
  expect(readFileSync(join(root, "writes.txt"), "utf8")).toBe("1")
  const request = getPendingUserInputForThread("thread")!
  expect(request).toBeTruthy()
  expect(
    submitUserInputResponse({
      requestId: request.requestId,
      answers: {
        choice: {
          type: "option",
          questionId: "choice",
          optionIndex: 0,
          label: "First",
          description: "The first input"
        }
      }
    })
  ).toBe(true)
  const cold = new SqlJsSaver(path)
  cleanup.push(() => cold.close())
  const graph = create(cold)
  const record = getHostInputContinuation(request.requestId)!
  const checkpoint = await graph.getState(config)
  assertHostUserInputCheckpoint(checkpoint, record)
  expect(() =>
    assertHostUserInputCheckpoint(
      { ...(checkpoint as Record<string, unknown>), next: ["tools", "another"] },
      record
    )
  ).toThrow("CHECKPOINT_UNSAFE")
  expect(() =>
    assertHostUserInputCheckpoint(checkpoint, {
      ...record,
      continuation: { ...record.continuation!, toolCallId: "forged" }
    })
  ).toThrow("CHECKPOINT_UNSAFE")
  claimHostInputContinuation(request.requestId)
  expect(() => claimHostInputContinuation(request.requestId)).toThrow("CONTINUATION_UNAVAILABLE")
  release = bindHostUserInputScope("thread", binding, () => {})
  const result = await graph.invoke(
    new Command({ resume: { requestId: request.requestId } }),
    config
  )
  expect(result.messages.at(-1)?.content).toBe("Completed after the saved answer")
  expect(readFileSync(join(root, "writes.txt"), "utf8")).toBe("1")
  expect(inputs.get(request.requestId)?.status).toBe("consumed")
})

it.each(["execute", "execute_background", "task", "Job", "mcp_external_write"])(
  "does not offer checkpoint continuation after an unproved %s lifetime",
  (toolName) => {
    const root = mkdtempSync(join(tmpdir(), "host-input-unsafe-tool-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const inputs = new HostUserInputStore(join(root, "input.sqlite"))
    cleanup.push(() => inputs.close())
    configureHostUserInputPersistence({ store: () => inputs, isCurrent: () => true })
    cleanup.push(
      bindHostUserInputScope(
        "thread",
        {
          projectId: "project",
          operationId: "op",
          stageId: "stage",
          installedPluginId: "plugin",
          expectedVersion: 1,
          pluginDigest: "a".repeat(64),
          inputFingerprint: "b".repeat(64),
          incarnationKey: "incarnation"
        },
        () => {}
      )
    )
    const settle = enterHostInputToolBoundary("thread", toolName)
    settle()
    expect(prepareHostInputInterrupt("thread", "ask", questions)).toBeUndefined()
    expect(inputs.pending("thread")).toBeUndefined()
  }
)

it("keeps a mixed tool batch on the original live wait without minting a replayable checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-input-mixed-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const inputs = new HostUserInputStore(join(root, "input.sqlite"))
  cleanup.push(() => inputs.close())
  const saver = new SqlJsSaver(join(root, "checkpoint.sqlite"))
  cleanup.push(() => saver.close())
  configureHostUserInputPersistence({ store: () => inputs, isCurrent: () => true })
  cleanup.push(
    bindHostUserInputScope(
      "thread",
      {
        projectId: "project",
        operationId: "op",
        stageId: "stage",
        installedPluginId: "plugin",
        expectedVersion: 1,
        pluginDigest: "a".repeat(64),
        inputFingerprint: "b".repeat(64),
        incarnationKey: "incarnation"
      },
      () => {}
    )
  )
  class MixedModel extends LocalModel {
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      const message = messages.some((item) => item.getType() === "tool")
        ? new AIMessage("finished")
        : new AIMessage({
            content: "",
            tool_calls: [
              { id: "mixed-write", name: "write_file", args: {} },
              { id: "mixed-ask", name: "request_user_input", args: { questions } }
            ]
          })
      return { generations: [{ message, text: String(message.content) }] }
    }
  }
  const graph = createAgent({
    model: new MixedModel({}),
    checkpointer: saver,
    middleware: [createHostUserInputInterruptMiddleware()],
    tools: [
      tool(
        () => {
          writeFileSync(join(root, "mixed.txt"), "actual mixed-batch write")
          return "written"
        },
        { name: "write_file", description: "Write once", schema: z.object({}) }
      ),
      createRequestUserInputTool({
        threadId: "thread",
        requestUserInputConfig: {
          allowAutoResolution: false,
          autoResolutionType: "user_message"
        }
      })
    ]
  })
  const completion = graph.invoke(
    { messages: [new HumanMessage("Write and ask together")] },
    { configurable: { thread_id: "thread" } }
  )
  await vi.waitFor(() => expect(getPendingUserInputForThread("thread")).not.toBeNull())
  const pending = getPendingUserInputForThread("thread")!
  expect(inputs.get(pending.requestId)?.continuation).toBeUndefined()
  expect(
    submitUserInputResponse({
      requestId: pending.requestId,
      answers: {
        choice: {
          type: "option",
          questionId: "choice",
          optionIndex: 0,
          label: "First",
          description: "The first input"
        }
      }
    })
  ).toBe(true)
  expect((await completion).messages.at(-1)?.content).toBe("finished")
  expect(readFileSync(join(root, "mixed.txt"), "utf8")).toBe("actual mixed-batch write")
})
