import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { ToolInputParsingException } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { describe, expect, it, vi } from "vitest"
import type { BotTask } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"
import { createBotGroupDeliveryCheck, createBotGroupMessageTool } from "./group-delivery"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  readTurnCompletionGateReport
} from "../agent/turn-completion-integrity"

const task: BotTask = {
  id: "task",
  botId: "a",
  threadId: "group-g-a",
  requestId: "user-1",
  message: "Check",
  state: "running",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  origin: { kind: "group", groupId: "g", messageId: "group-user-1" }
}
function receipt(groupId = "g", taskId = task.id, status: "success" | "error" = "success") {
  return [
    new HumanMessage({ id: task.requestId, content: "Check" }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "send-1", name: "bot_send_message", args: { content: "Verified" } }]
    }),
    new ToolMessage({
      tool_call_id: "send-1",
      name: "bot_send_message",
      status,
      content: JSON.stringify({ kind: "bot-group-message", groupId, taskId, messageId: "posted-1" })
    }),
    new AIMessage("")
  ]
}

describe("formal group delivery", () => {
  it("allows a member with completed same-request peer work to pass without a public echo", async () => {
    let eligible = true
    const publishGroupMessage = vi.fn()
    const sent = vi.fn()
    const send = createBotGroupMessageTool(
      task,
      () => ({ publishGroupMessage }) as unknown as LocalBotHost,
      new AbortController().signal,
      sent,
      () => eligible
    )
    const call = {
      type: "tool_call" as const,
      id: "completed-peer-pass",
      name: send.name,
      args: { content: "(pass)" }
    }
    const result = await send.invoke(call)
    const messages = [
      new HumanMessage("Original assignment"),
      new AIMessage({ content: "", tool_calls: [call] }),
      result,
      new AIMessage("")
    ]
    expect(createBotGroupDeliveryCheck(task, false, () => eligible)(messages)).toBeUndefined()
    expect(createBotGroupDeliveryCheck(task)(messages)).toContain("bot_send_message")
    expect(
      createBotGroupDeliveryCheck(task, false, () => eligible)([new AIMessage("(pass)")])
    ).toBeUndefined()
    expect(
      createBotGroupDeliveryCheck(
        task,
        false,
        () => eligible
      )([new AIMessage("Here is my separate analysis")])
    ).toContain("bot_send_message")
    expect(publishGroupMessage).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
    // A newly injected user request restores the ordinary delivery obligation.
    const check = createBotGroupDeliveryCheck(task, false, () => eligible)
    eligible = false
    expect(check(messages)).toContain("bot_send_message")
    await send.invoke(call)
    expect(publishGroupMessage).toHaveBeenCalledOnce()
  })

  it.each(["private", "current-group"] as const)(
    "rejects raw attachment arguments before any text publication in %s mode",
    async (mode) => {
      const privateMode = mode === "private"
      const selectedTask: BotTask = privateMode
        ? { ...task, threadId: "private-a", origin: { kind: "user" } }
        : task
      const publishGroupMessage = vi.fn(() => ({ groupId: "g", messageId: "must-not-post" }))
      const sent = vi.fn()
      const send = createBotGroupMessageTool(
        selectedTask,
        () => ({ publishGroupMessage }) as unknown as LocalBotHost,
        new AbortController().signal,
        sent
      )
      const args = {
        content: "Requested text",
        ...(privateMode ? { groupId: "28661550-76ec-4b27-928b-21a04de8b087" } : {}),
        files: ["result.txt"]
      }
      const pending = send.invoke({
        type: "tool_call",
        id: "raw-attachment-send",
        name: send.name,
        args
      })
      await expect(pending).rejects.toThrow(ToolInputParsingException)
      await expect(pending).rejects.toThrow(/files/)
      expect(publishGroupMessage).not.toHaveBeenCalled()
      expect(sent).not.toHaveBeenCalled()
      expect(args.files).toEqual(["result.txt"])
    }
  )

  it("returns an actual schema error to the model before one authorized text-only retry", async () => {
    const groupId = "28661550-76ec-4b27-928b-21a04de8b087"
    const privateTask: BotTask = {
      ...task,
      threadId: "private-schema-retry",
      origin: { kind: "user" }
    }
    const publishGroupMessage = vi.fn(() => ({ groupId, messageId: "posted-once" }))
    const sent = vi.fn()
    class RetryModel extends BaseChatModel {
      calls = 0
      _llmType() {
        return "group-argument-recovery-regression"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        this.calls++
        if (this.calls > 3) throw new Error("A successful text retry must not be repeated")
        if (this.calls === 2) {
          const failure = messages.filter(ToolMessage.isInstance).at(-1)!
          expect(failure).toMatchObject({
            name: "bot_send_message",
            tool_call_id: "invalid-attachment"
          })
          // Stock ToolNode does not set error status; assert its actual schema-error body.
          expect(String(failure.content)).toContain("Error invoking tool 'bot_send_message'")
          expect(String(failure.content)).toContain(
            "Received tool input did not match expected schema"
          )
          expect(String(failure.content)).toContain("files")
          expect(publishGroupMessage).not.toHaveBeenCalled()
          expect(sent).not.toHaveBeenCalled()
        }
        const message = new AIMessage({
          content: this.calls === 3 ? "已按要求发送纯文字。" : "",
          response_metadata: { finish_reason: this.calls === 3 ? "stop" : "tool_calls" },
          ...(this.calls < 3
            ? {
                tool_calls: [
                  {
                    id: this.calls === 1 ? "invalid-attachment" : "authorized-text-retry",
                    name: "bot_send_message",
                    args: {
                      groupId,
                      content: "Approved text only",
                      ...(this.calls === 1 ? { files: ["result.txt"] } : {})
                    }
                  }
                ]
              }
            : {})
        })
        return { generations: [{ text: String(message.content), message }] }
      }
    }
    const model = new RetryModel({})
    const agent = createAgent({
      model,
      tools: [
        createBotGroupMessageTool(
          privateTask,
          () => ({ publishGroupMessage }) as unknown as LocalBotHost,
          new AbortController().signal,
          sent
        )
      ]
    })
    const result = await agent.invoke({
      messages: [new HumanMessage("向已选群只发这条文字 Approved text only，不附文件。")]
    })
    expect(model.calls).toBe(3)
    expect(publishGroupMessage).toHaveBeenCalledExactlyOnceWith(
      task.id,
      "authorized-text-retry",
      "Approved text only",
      groupId
    )
    expect(sent).not.toHaveBeenCalled()
    const toolResults = result.messages.filter(ToolMessage.isInstance)
    expect(toolResults).toHaveLength(2)
    expect(toolResults[1].status).toBe("success")
    expect(JSON.parse(toolResults[1].content as string)).toEqual({
      kind: "bot-group-message",
      taskId: task.id,
      groupId,
      messageId: "posted-once"
    })
    expect(result.messages.filter(AIMessage.isInstance)[0].tool_calls?.[0].args).toEqual({
      groupId,
      content: "Approved text only",
      files: ["result.txt"]
    })
  })

  it("requires an exact group target for private publication and preserves the private reply", async () => {
    const privateTask: BotTask = { ...task, threadId: "private-a", origin: { kind: "user" } }
    const groupId = "28661550-76ec-4b27-928b-21a04de8b087"
    const publishGroupMessage = vi.fn(() => ({ groupId, messageId: "public-post" }))
    const sent = vi.fn()
    const send = createBotGroupMessageTool(
      privateTask,
      () => ({ publishGroupMessage }) as unknown as LocalBotHost,
      new AbortController().signal,
      sent
    )
    await expect(send.invoke({ content: "Do not guess a group" })).rejects.toThrow()
    await expect(
      send.invoke({ groupId: "A group display name", content: "Do not resolve by name" })
    ).rejects.toThrow()
    expect(publishGroupMessage).not.toHaveBeenCalled()
    const result = await send.invoke({
      type: "tool_call",
      id: "private-send",
      name: send.name,
      args: { groupId, content: "A public message, not the private final reply" }
    })
    expect(publishGroupMessage).toHaveBeenCalledExactlyOnceWith(
      task.id,
      "private-send",
      "A public message, not the private final reply",
      groupId
    )
    expect(JSON.parse(result.content as string)).toEqual({
      kind: "bot-group-message",
      taskId: task.id,
      groupId,
      messageId: "public-post"
    })
    expect(sent).not.toHaveBeenCalled()
  })

  it("keeps private target publication errors and temporary-agent rejection as real errors", async () => {
    const privateTask: BotTask = { ...task, threadId: "private-a", origin: { kind: "user" } }
    const publishGroupMessage = vi.fn(() => {
      throw new Error("Group membership changed")
    })
    const sent = vi.fn()
    const send = createBotGroupMessageTool(
      privateTask,
      () => ({ publishGroupMessage }) as unknown as LocalBotHost,
      new AbortController().signal,
      sent
    )
    const call = {
      type: "tool_call" as const,
      id: "private-denied",
      name: send.name,
      args: { groupId: "28661550-76ec-4b27-928b-21a04de8b087", content: "Not delivered" }
    }
    const result = await send.invoke(call)
    expect(result.status).toBe("error")
    expect(JSON.parse(result.content as string)).toEqual({
      ok: false,
      error: "Group membership changed"
    })
    publishGroupMessage.mockClear()
    const child = await send.invoke(call, {
      configurable: { cmb_subagent_owner_tool_call_id: "temporary-task" }
    })
    expect(child.status).toBe("error")
    expect(publishGroupMessage).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })

  it.each(["你好！有什么可以帮你的吗？", "已回复问候", ""])(
    "ends the actual send→receipt→private-final graph without another model request: %s",
    async (final) => {
      class GreetingModel extends BaseChatModel {
        calls = 0
        _llmType() {
          return "group-greeting-regression"
        }
        bindTools() {
          return this
        }
        async _generate(): Promise<ChatResult> {
          if (++this.calls > 2) throw new Error("A successful greeting must not be retried")
          const message = new AIMessage({
            content: this.calls === 1 ? "" : final,
            response_metadata: { finish_reason: this.calls === 1 ? "tool_calls" : "stop" },
            ...(this.calls === 1
              ? {
                  tool_calls: [
                    {
                      id: "greeting-send",
                      name: "bot_send_message",
                      args: { content: "你好！有什么可以帮你的吗？" }
                    }
                  ]
                }
              : {})
          })
          return { generations: [{ text: String(message.content), message }] }
        }
      }
      const model = new GreetingModel({})
      const publishGroupMessage = vi.fn(() => ({ groupId: "g", messageId: "posted" }))
      const onRecovery = vi.fn()
      const agent = createAgent({
        model,
        tools: [
          createBotGroupMessageTool(
            task,
            () => ({ publishGroupMessage }) as unknown as LocalBotHost,
            new AbortController().signal,
            vi.fn()
          )
        ],
        middleware: [
          createTurnCompletionGateMiddleware({
            ownerRunToken: "greeting-run",
            checkFinalDelivery: createBotGroupDeliveryCheck(task),
            onRecovery
          })
        ]
      })
      try {
        await agent.invoke(
          { messages: [new HumanMessage("你们好")] },
          { configurable: { thread_id: task.threadId } }
        )
        expect(model.calls).toBe(2)
        expect(publishGroupMessage).toHaveBeenCalledExactlyOnceWith(
          task.id,
          "greeting-send",
          "你好！有什么可以帮你的吗？"
        )
        expect(onRecovery).not.toHaveBeenCalled()
        expect(readTurnCompletionGateReport(task.threadId, "greeting-run")?.unresolved).toBeNull()
      } finally {
        clearTurnCompletionGateState(task.threadId, "greeting-run")
      }
    }
  )

  it("rejects a temporary task subagent posting under its parent Bot identity", async () => {
    const publishGroupMessage = vi.fn(() => ({ groupId: "g", messageId: "posted" })),
      sent = vi.fn()
    const send = createBotGroupMessageTool(
      task,
      () => ({ publishGroupMessage }) as unknown as LocalBotHost,
      new AbortController().signal,
      sent
    )
    const result = await send.invoke(
      { type: "tool_call", id: "child-send", name: send.name, args: { content: "47" } },
      { configurable: { cmb_subagent_owner_tool_call_id: "task-call" } }
    )
    expect(result.status).toBe("error")
    expect(publishGroupMessage).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })

  it("keeps an optional SendMessage pass private without manufacturing a public receipt", async () => {
    const review: BotTask = {
      ...task,
      origin: { kind: "discussion", groupId: "g", messageId: "m", round: 1 }
    }
    const publishGroupMessage = vi.fn(() => ({ groupId: "g", messageId: "posted" })),
      sent = vi.fn(),
      host = { publishGroupMessage } as unknown as LocalBotHost
    const send = createBotGroupMessageTool(review, () => host, new AbortController().signal, sent)
    const call = {
      type: "tool_call" as const,
      id: "pass-1",
      name: send.name,
      args: { content: "(pass)" }
    }
    const result = await send.invoke(call)
    expect(publishGroupMessage).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
    const transcript = [
      new HumanMessage("Optional turn"),
      new AIMessage({ content: "", tool_calls: [call] }),
      result,
      new AIMessage("")
    ]
    expect(createBotGroupDeliveryCheck(review)(transcript)).toBeUndefined()
    expect(createBotGroupDeliveryCheck(task)(transcript)).toContain("bot_send_message")
    expect(createBotGroupDeliveryCheck(review)([transcript[0], result, transcript[3]])).toContain(
      "bot_send_message"
    )
    // A literal answer to a direct user request is not an optional abstention.
    const direct = createBotGroupMessageTool(task, () => host, new AbortController().signal, sent)
    await direct.invoke(call)
    expect(publishGroupMessage).toHaveBeenCalledExactlyOnceWith(task.id, "pass-1", "(pass)")
  })

  it("lets a real asynchronous handoff yield without forcing a waiting acknowledgement", () => {
    const check = createBotGroupDeliveryCheck(task)
    const dispatch = (status: "success" | "error", result: object) => [
      new HumanMessage("Ask the peer"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "delegate", name: "bot_delegate", args: {} }]
      }),
      new ToolMessage({ tool_call_id: "delegate", status, content: JSON.stringify(result) }),
      new AIMessage("Dispatched privately")
    ]
    const receipt = { taskId: "real-peer-task", botId: "b", state: "queued" }
    expect(check(dispatch("success", receipt))).toBeUndefined()
    expect(check(dispatch("error", receipt))).toContain("bot_send_message")
    expect(check(dispatch("success", { ok: false, error: "Denied" }))).toContain("bot_send_message")
    expect(
      check([new HumanMessage("Ask the peer"), new AIMessage(JSON.stringify(receipt))])
    ).toContain("bot_send_message")
  })

  it("does not let a skipped callback message hide a peer result that was never posted", async () => {
    const callback: BotTask = {
      ...task,
      origin: {
        kind: "bot",
        groupId: "g",
        fromBotId: "b",
        rootTaskId: "root",
        depth: 1,
        expectsReply: false
      }
    }
    const publishGroupMessage = vi.fn(),
      sent = vi.fn()
    const send = createBotGroupMessageTool(
      callback,
      () => ({ publishGroupMessage }) as unknown as LocalBotHost,
      new AbortController().signal,
      sent
    )
    const call = {
      type: "tool_call" as const,
      id: "skip",
      name: send.name,
      args: { content: "(pass)" }
    }
    const result = await send.invoke(call)
    const transcript = [
      new HumanMessage("Peer result"),
      new AIMessage({ content: "", tool_calls: [call] }),
      result,
      new AIMessage("")
    ]
    expect(publishGroupMessage).not.toHaveBeenCalled()
    expect(createBotGroupDeliveryCheck(callback, false)(transcript)).toContain("bot_send_message")
    expect(createBotGroupDeliveryCheck(callback, true)(transcript)).toBeUndefined()
  })

  it("requires the current turn's successful, paired, identity-bound receipt", () => {
    const check = createBotGroupDeliveryCheck(task)
    expect(check(receipt())).toBeUndefined()
    expect(check([new HumanMessage("Check"), new AIMessage("I posted it")])).toContain(
      "bot_send_message"
    )
    for (const messages of [
      receipt("other-group"),
      receipt("g", "other-task"),
      receipt("g", task.id, "error")
    ])
      expect(check(messages)).toContain("bot_send_message")
    expect(check([receipt()[0], receipt()[2], new AIMessage("")])).toContain("bot_send_message")
  })

  it.each([
    "你好！有什么可以帮你的吗？",
    "已回复问候",
    "<think>Already posted.</think>",
    "(pass)",
    "Member A W5B_OK"
  ])(
    "does not request another send after a real receipt followed by private final text: %s",
    (final) => {
      const messages = receipt()
      messages[messages.length - 1] = new AIMessage(final)
      // The user's greeting was sent twice because this boundary incorrectly
      // reported missing delivery after a successful public send. Private final
      // text cannot invalidate that receipt or prove that another send is owed.
      expect(createBotGroupDeliveryCheck(task)(messages)).toBeUndefined()
    }
  )

  it("does not reuse a prior turn's receipt or mistake quoted tool JSON for a tool result", () => {
    const check = createBotGroupDeliveryCheck(task)
    expect(
      check([...receipt(), new HumanMessage("New question"), new AIMessage("Done")])
    ).toContain("bot_send_message")
    expect(
      check([new HumanMessage(String(receipt()[2].content)), new AIMessage("Done")])
    ).toContain("bot_send_message")
  })

  it("skips native plumbing boundaries and accepts actual verified attachment delivery", () => {
    const check = createBotGroupDeliveryCheck(task)
    expect(
      check([
        ...receipt(),
        new HumanMessage("[[CMB_TURN_COMPLETION_GATE_V1:missing_delivery]]"),
        new AIMessage("")
      ])
    ).toBeUndefined()
    const files = [{ filePath: "/group/report.md", name: "report.md", size: 12 }]
    expect(
      check([
        new HumanMessage("Deliver the file"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "file-1", name: "bot_deliver_files", args: { files: ["report.md"] } }]
        }),
        new ToolMessage({
          tool_call_id: "file-1",
          content: JSON.stringify({ kind: "bot-file-delivery", files })
        }),
        new AIMessage("")
      ])
    ).toBeUndefined()
  })

  it("never accepts a private file-return receipt as public attachment delivery", () => {
    for (const name of ["bot_return_files", "bot_deliver_files"]) {
      const messages = [
        new HumanMessage("Deliver the requested report to this group"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "return-1", name, args: { files: ["draft.md"] } }]
        }),
        new ToolMessage({
          tool_call_id: "return-1",
          name,
          content: JSON.stringify({
            kind: "bot-file-return",
            files: [{ filePath: "/group/draft.md", name: "draft.md", size: 12 }]
          })
        }),
        new AIMessage("")
      ]
      expect(createBotGroupDeliveryCheck(task)(messages)).toContain("bot_deliver_files")
    }
  })

  it("preserves private peer results and only permits pass on internal/optional turns", () => {
    const final = (text: string) => [new HumanMessage("Work"), new AIMessage(text)]
    const peer: BotTask = {
      ...task,
      origin: {
        kind: "bot",
        groupId: "g",
        fromBotId: "b",
        rootTaskId: "root",
        depth: 1,
        expectsReply: true
      }
    }
    expect(createBotGroupDeliveryCheck(peer)(final("Verified privately"))).toBeUndefined()
    expect(createBotGroupDeliveryCheck(peer)(final(""))).toContain("private result")
    expect(createBotGroupDeliveryCheck(peer)(final("(pass)"))).toContain("private result")
    const review: BotTask = {
      ...task,
      origin: { kind: "discussion", groupId: "g", messageId: "m", round: 1 }
    }
    expect(createBotGroupDeliveryCheck(review)(final("(pass)"))).toBeUndefined()
    expect(createBotGroupDeliveryCheck(review)(final("New result"))).toContain("bot_send_message")
    expect(createBotGroupDeliveryCheck(task)(final("(pass)"))).toContain("bot_send_message")
    const callback: BotTask = {
      ...peer,
      origin: {
        ...(peer.origin as Extract<BotTask["origin"], { kind: "bot" }>),
        expectsReply: false
      }
    }
    expect(createBotGroupDeliveryCheck(callback)(final("(pass)"))).toContain("bot_send_message")
    expect(createBotGroupDeliveryCheck(callback, true)(final("(pass)"))).toBeUndefined()
  })

  it.each([true, false])(
    "only preserves the existing silence policy for confirmed successful commands (%s)",
    (success) => {
      const notice: BotTask = {
        ...task,
        origin: {
          kind: "notification",
          notificationKind: "command",
          groupId: "g",
          key: "cmd",
          commandSucceeded: success
        }
      }
      const result = createBotGroupDeliveryCheck(notice)([
        new HumanMessage("Receipt"),
        new AIMessage(BOT_ROUTINE_SILENT)
      ])
      if (success) expect(result).toBeUndefined()
      else expect(result).toContain("bot_send_message")
    }
  )

  it("allows quiet group reaction feedback but still requires real delivery for a correction", () => {
    const feedback: BotTask = { ...task, origin: {
      kind: "notification", notificationKind: "reaction", groupId: "g", key: "answer"
    } }
    const check = createBotGroupDeliveryCheck(feedback)
    expect(check([new HumanMessage("Feedback"), new AIMessage(BOT_ROUTINE_SILENT)])).toBeUndefined()
    expect(check([new HumanMessage("Feedback"), new AIMessage("Corrected")])).toContain("bot_send_message")
    expect(check(receipt())).toBeUndefined()
    expect(createBotGroupDeliveryCheck(task)([new AIMessage(BOT_ROUTINE_SILENT)])).toContain("bot_send_message")
  })

  it("returns the real host receipt, preserves tool errors, and honors cancellation", async () => {
    const controller = new AbortController(),
      sent = vi.fn()
    const publishGroupMessage = vi.fn(() => ({ groupId: "g", messageId: "posted-1" }))
    const host = { publishGroupMessage } as unknown as LocalBotHost
    const send = createBotGroupMessageTool(task, () => host, controller.signal, sent)
    const call = {
      type: "tool_call" as const,
      id: "send-1",
      name: send.name,
      args: { content: "Verified" }
    }
    const result = await send.invoke(call)
    expect(typeof result.content).toBe("string")
    expect(JSON.parse(result.content as string)).toMatchObject({
      kind: "bot-group-message",
      taskId: task.id,
      groupId: "g",
      messageId: "posted-1"
    })
    expect(publishGroupMessage).toHaveBeenCalledWith(task.id, "send-1", "Verified")
    expect(sent).toHaveBeenCalledExactlyOnceWith("Verified")
    publishGroupMessage.mockImplementationOnce(() => {
      throw new Error("Member removed")
    })
    const failure = await send.invoke(call)
    expect(failure.status).toBe("error")
    expect(typeof failure.content).toBe("string")
    expect(JSON.parse(failure.content as string).error).toBe("Member removed")
    expect(sent).toHaveBeenCalledTimes(1)
    controller.abort(new Error("Stopped"))
    await expect(send.invoke(call)).rejects.toThrow("Stopped")
    expect(publishGroupMessage).toHaveBeenCalledTimes(2)
  })
})
