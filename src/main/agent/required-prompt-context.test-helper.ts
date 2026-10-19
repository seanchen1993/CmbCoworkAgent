import { AIMessageChunk, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { createAgent, createMiddleware } from "langchain"
import { vi } from "vitest"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import { withFunctionAgentExecution } from "../mods/v2/host-call"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createModModelBoundary, type FunctionModelStreamHost } from "./mods-model-boundary"
import { createPromptSourceMiddleware, observePromptSourceMiddleware } from "./mods-prompt-sources"

const sessions: FunctionSession[] = []
const owners: ModRuntimeAuthorities[] = []
export async function closeRequiredPromptFixtures() {
  await Promise.all(sessions.splice(0).map(session => session.close()))
  for (const owner of owners.splice(0)) owner.close()
  vi.restoreAllMocks()
}

export async function createRequiredPromptFixture(hook: string, nativeRewrite?: string, required = true, requiredText = "PROJECT_REQUIRED",
  scope: { workspace?: string; threadId?: string; agentId?: string; prompt?: string } = {}) {
  const workspace = scope.workspace ?? "/project"
  const threadId = scope.threadId ?? "thread"
  const agentId = scope.agentId ?? "main"
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hook}}}`)
  const session = new FunctionSession(
    [
      {
        name: "prompt-test",
        root: "/prompt-test",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId,
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await session.start()
  const owner = new ModRuntimeAuthorities()
  owners.push(owner)
  const { authority } = owner.create({
    workspace,
    threadId,
    turnId: "turn",
    agentId
  })
  const manager: FunctionModelStreamHost = {
    functionModelStream: (_owner, input, core, signal) =>
      Promise.resolve(dispatchFunctionStream([], input, { signal, core })),
    promptComposition: (_workspace, _thread, event, input, signal, core) =>
      session.promptComposition(event, input, signal, core)
  }
  const provider = new FakeStreamingChatModel({ chunks: [new AIMessageChunk("done")] })
  const stream = vi.spyOn(FakeStreamingChatModel.prototype, "stream")
  const boundary = createModModelBoundary(provider, manager, authority, {
    turnId: "turn",
    agentId,
    model: "fixture"
  })
  const agent = createAgent({
    model: boundary,
    systemPrompt: `BASE\n\n${requiredText}\n\nTAIL`,
    middleware: [
      createPromptSourceMiddleware({
        authority: () => authority,
        seed: () => [
          { id: "cmb:base", text: "BASE\n\n", scope: "session" },
          {
            id: "cmb:agents",
            text: `${requiredText}\n\n`,
            scope: "session",
            ...(required ? { requiredText } : {}),
            context: { name: "claudeMd" }
          },
          { id: "cmb:tail", text: "TAIL", scope: "session" }
        ]
      }),
      ...(nativeRewrite === undefined
        ? []
        : [
            observePromptSourceMiddleware(
              createMiddleware({
                name: "nativeOpaqueRewrite",
                wrapModelCall: (request, handler) =>
                  handler({ ...request, systemMessage: new SystemMessage(nativeRewrite) })
              })
            )
          ])
    ]
  })
  return {
    stream,
    invoke: () =>
      withFunctionAgentExecution(
        {
          workspace: authority.workspace,
          threadId: authority.threadId,
          turnId: authority.turnId,
          agentId: authority.agentId,
          runtimeAuthority: authority,
          userInitiated: false,
          leased: false,
          immediate: false
        },
        () => agent.invoke({ messages: [new HumanMessage(scope.prompt ?? "work")] })
      )
  }
}

