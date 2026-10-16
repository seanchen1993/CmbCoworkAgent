import { AIMessageChunk, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { createAgent, createMiddleware } from "langchain"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import { withFunctionAgentExecution } from "../mods/v2/host-call"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createModModelBoundary, type FunctionModelStreamHost } from "./mods-model-boundary"
import { extractErrorDetail, isRetryableApiError } from "./failover"
import { createPromptSourceMiddleware, observePromptSourceMiddleware } from "./mods-prompt-sources"

const sessions: FunctionSession[] = []
const owners: ModRuntimeAuthorities[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  for (const owner of owners.splice(0)) owner.close()
  vi.restoreAllMocks()
})

async function fixture(hook: string, nativeRewrite?: string, required = true) {
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
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await session.start()
  const owner = new ModRuntimeAuthorities()
  owners.push(owner)
  const { authority } = owner.create({
    workspace: "/project",
    threadId: "thread",
    turnId: "turn",
    agentId: "main"
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
    agentId: "main",
    model: "fixture"
  })
  const agent = createAgent({
    model: boundary,
    systemPrompt: "BASE\n\nPROJECT_REQUIRED\n\nTAIL",
    middleware: [
      createPromptSourceMiddleware({
        authority: () => authority,
        seed: () => [
          { id: "cmb:base", text: "BASE\n\n", scope: "session" },
          {
            id: "cmb:agents",
            text: "PROJECT_REQUIRED\n\n",
            scope: "session",
            ...(required ? { requiredText: "PROJECT_REQUIRED" } : {}),
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
        () => agent.invoke({ messages: [new HumanMessage("work")] })
      )
  }
}

async function expectRequiredBlock(f: Awaited<ReturnType<typeof fixture>>) {
  const error = await f.invoke().then(
    () => undefined,
    (error: unknown) => error
  )
  expect(error).toBeInstanceOf(Error)
  expect(extractErrorDetail(error)).toMatchObject({
    code: "harness_context_unavailable",
    statusLabel: "必需项目知识被提示词处理改写"
  })
  expect(isRetryableApiError(error)).toBe(false)
  expect(f.stream).not.toHaveBeenCalled()
}

it.each([
  'on("prompt.context",async()=>({blocks:[]}))',
  'on("prompt.section",async($,event,next)=>event.name==="cmb:agents"?{text:null}:next(event))',
  'on("prompt.compose",async()=>({sections:[]}))',
  'on("prompt.compose",async()=>({sections:[{id:"fake",text:"PROJECT_CHANGED",scope:"session"}]}))'
])(
  "blocks a real prompt Hook removing resolved project knowledge before provider admission: %s",
  async (hook) => {
    const f = await fixture(hook)
    await expectRequiredBlock(f)
  }
)

it("retains required knowledge through opaque native rewrites and subsequent Mod replacement", async () => {
  const f = await fixture(
    'on("prompt.compose",async()=>({sections:[]}))',
    "NATIVE_PREFIX\nPROJECT_REQUIRED\nNATIVE_TAIL"
  )
  await expectRequiredBlock(f)
})

it("rejects an opaque native rewrite that already removed the required context", async () => {
  const f = await fixture("", "NATIVE_REPLACEMENT")
  await expectRequiredBlock(f)
})

it("allows real prompt extensions that retain required bytes and reports the actual provider input", async () => {
  const f = await fixture(`on("prompt.compose",async($,event,next)=>{
    const value=await next(event);
    return {sections:[...value.sections,{id:"extra",text:"LEGAL_EXTENSION",scope:"session"}]}
  })`)
  await f.invoke()
  expect(f.stream).toHaveBeenCalledTimes(1)
  const messages = f.stream.mock.calls[0][0] as SystemMessage[]
  expect(messages[0].content).toContain("PROJECT_REQUIRED")
  expect(messages[0].content).toContain("LEGAL_EXTENSION")
})

it("keeps ordinary unprotected prompt removal available", async () => {
  const f = await fixture('on("prompt.compose",async()=>({sections:[]}))', undefined, false)
  await f.invoke()
  expect(f.stream).toHaveBeenCalledTimes(1)
})
