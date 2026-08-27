import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import { resolveChatScrollVirtualRangeSnapshot } from "./ChatMessageVirtualList"
import {
  areChatScrollMarkerRailPropsEqual,
  createChatScrollQuestionProjector,
  createChatScrollQuestionRevisionProjector,
  findChatScrollQuestionIndexForMessageIndex
} from "./ChatScrollNavigator"

function message(
  id: string,
  role: Message["role"],
  content = id,
  extra: Partial<Message> = {}
): Message {
  return { id, role, content, created_at: new Date(0), ...extra }
}

describe("chat scroll navigator virtualization bridge", () => {
  it("resolves the owning user while a tall assistant row has unloaded its user row", () => {
    const messages = [
      message("u-1", "user"),
      message("a-1", "assistant"),
      message("u-2", "user"),
      message("a-2-tall", "assistant"),
      message("tool-2", "tool"),
      message("u-3", "user")
    ]
    const visibleMessageIndexes = [0, 1, 2, 3, 4, 5]
    const range = resolveChatScrollVirtualRangeSnapshot(messages, visibleMessageIndexes, {
      startIndex: 3,
      endIndex: 3
    })

    expect(range).toEqual({
      firstMessageIndex: 3,
      firstMessageIdentity: "assistant:a-2-tall:::",
      lastMessageIndex: 3
    })
    expect(findChatScrollQuestionIndexForMessageIndex([0, 2, 5], range?.firstMessageIndex)).toBe(1)
    expect(findChatScrollQuestionIndexForMessageIndex([0, 2, 5], 4)).toBe(1)
    expect(findChatScrollQuestionIndexForMessageIndex([0, 2, 5], 5)).toBe(2)
  })

  it("maps projected Virtuoso positions back to transcript indexes", () => {
    const messages = [
      message("hidden-system", "system"),
      message("u-1", "user"),
      message("hidden-tool", "tool"),
      message("a-1", "assistant")
    ]
    expect(
      resolveChatScrollVirtualRangeSnapshot(messages, [1, 3], {
        startIndex: 1,
        endIndex: 1
      })
    ).toMatchObject({ firstMessageIndex: 3, lastMessageIndex: 3 })
  })
})

describe("chat scroll question structural revision", () => {
  it("publishes the released-history boundary instead of silently joining question segments", () => {
    const projectQuestions = createChatScrollQuestionProjector()
    const messages = [
      message("u-old", "user", "old question"),
      message("a-old", "assistant"),
      message("u-latest", "user", "latest question"),
      message("a-latest", "assistant")
    ]

    const projection = projectQuestions(messages, 1, "u-latest")

    expect(projection.questions.map((question) => question.id)).toEqual(["u-old", "u-latest"])
    expect(projection.gapBeforeQuestionIndex).toBe(1)
  })

  it("refreshes a same-array tail when request_user_input appears but ignores text tokens", () => {
    const user = message("u-1", "user", "question")
    const assistant = message("a-1", "assistant", "")
    const messages = [user, assistant]
    const projectRevision = createChatScrollQuestionRevisionProjector()
    const projectQuestions = createChatScrollQuestionProjector()

    const initialRevision = projectRevision({
      scopeKey: "thread-1",
      messages,
      structureVersion: 1,
      changedMessages: messages
    })
    const initialProjection = projectQuestions(messages, initialRevision)
    expect(initialProjection.questions[0].userInputRequests).toHaveLength(0)

    assistant.content = "ordinary streaming token"
    expect(
      projectRevision({
        scopeKey: "thread-1",
        messages,
        structureVersion: 1,
        changedMessages: [assistant]
      })
    ).toBe(initialRevision)

    assistant.tool_calls = [
      {
        id: "request-1",
        name: "request_user_input",
        args: {
          questions: [{ id: "q-1", header: "Choice", question: "Continue?" }]
        }
      }
    ]
    const requestRevision = projectRevision({
      scopeKey: "thread-1",
      messages,
      structureVersion: 1,
      changedMessages: [assistant]
    })
    expect(requestRevision).toBe(initialRevision + 1)
    expect(projectQuestions(messages, requestRevision).questions[0]).toMatchObject({
      id: "u-1",
      userInputRequests: [
        {
          status: "pending",
          questions: [{ id: "q-1", header: "Choice", question: "Continue?" }]
        }
      ]
    })

    assistant.content = "another ordinary streaming token"
    expect(
      projectRevision({
        scopeKey: "thread-1",
        messages,
        structureVersion: 1,
        changedMessages: [assistant]
      })
    ).toBe(requestRevision)
  })

  it("bounds token-frame inspection to the changed suffix", () => {
    const projectRevision = createChatScrollQuestionRevisionProjector()
    const assistant = message("tail", "assistant", "")
    const messages = [assistant]
    const initialRevision = projectRevision({
      scopeKey: "thread-poison",
      messages,
      structureVersion: 1,
      changedMessages: [assistant]
    })
    const changedMessages = new Array<Message>(10_000)
    for (let index = 10_000 - 64; index < 10_000; index += 1) {
      changedMessages[index] = message(`tail-${index}`, "assistant", `token-${index}`)
    }
    const poison = new Proxy(changedMessages, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && Number(property) < 9_936) {
          throw new Error("walked historical transcript")
        }
        return Reflect.get(target, property, receiver)
      }
    })

    expect(
      projectRevision({
        scopeKey: "thread-poison",
        messages,
        structureVersion: 1,
        changedMessages: poison
      })
    ).toBe(initialRevision)
  })

  it("keeps a 20k question projection stable across 100 ordinary tool appends", () => {
    const projectRevision = createChatScrollQuestionRevisionProjector()
    const projectQuestions = createChatScrollQuestionProjector()
    let messages: Message[] = [message("u-0", "user", "question")]
    messages.push(
      ...Array.from({ length: 19_999 }, (_, index) =>
        message(`a-${index}`, "assistant", `assistant-${index}`)
      )
    )
    const initialRevision = projectRevision({
      scopeKey: "thread-20k",
      messages,
      structureVersion: 1,
      changedMessages: messages
    })
    const initialProjection = projectQuestions(messages, initialRevision)

    for (let index = 0; index < 100; index += 1) {
      const ordinaryTool = message(`ordinary-tool-${index}`, "tool", "unused", {
        tool_call_id: `ordinary-call-${index}`
      })
      Object.defineProperty(ordinaryTool, "content", {
        configurable: true,
        get(): never {
          throw new Error("ordinary tool content must stay cold")
        }
      })
      messages = [...messages, ordinaryTool]
      const nextRevision = projectRevision({
        scopeKey: "thread-20k",
        messages,
        structureVersion: index + 2,
        changedMessages: messages
      })
      expect(nextRevision).toBe(initialRevision)
      expect(projectQuestions(messages, nextRevision)).toBe(initialProjection)
    }

    messages = [...messages, message("u-after-tools", "user", "next question")]
    const userRevision = projectRevision({
      scopeKey: "thread-20k",
      messages,
      structureVersion: 102,
      changedMessages: messages
    })
    expect(userRevision).toBe(initialRevision + 1)
    expect(projectQuestions(messages, userRevision).questions).toHaveLength(2)
  })

  it("keeps same-tail ordinary tool-call structure frames off the 20k prefix", () => {
    const projectRevision = createChatScrollQuestionRevisionProjector()
    const projectQuestions = createChatScrollQuestionProjector()
    const target: Message[] = [message("u-0", "user", "question")]
    target.push(
      ...Array.from({ length: 19_998 }, (_, index) =>
        message(`a-${index}`, "assistant", `assistant-${index}`)
      ),
      message("a-tail", "assistant", "tail")
    )
    let allowHistoryReads = true
    const allowedIndexes = new Set([0, Math.floor((target.length - 1) / 2), target.length - 1])
    const messages = new Proxy(target, {
      get(array, property, receiver) {
        if (
          !allowHistoryReads &&
          typeof property === "string" &&
          /^\d+$/.test(property) &&
          !allowedIndexes.has(Number(property))
        ) {
          throw new Error("walked stable 20k prefix")
        }
        return Reflect.get(array, property, receiver)
      }
    })
    const initialRevision = projectRevision({
      scopeKey: "thread-same-tail",
      messages,
      structureVersion: 1,
      changedMessages: messages
    })
    const initialProjection = projectQuestions(messages, initialRevision)
    allowHistoryReads = false

    for (let index = 0; index < 100; index += 1) {
      const ordinaryToolCall = {
        id: `ordinary-${index}`,
        name: "ordinary_tool",
        args: {}
      }
      Object.defineProperty(ordinaryToolCall, "args", {
        configurable: true,
        get(): never {
          throw new Error("ordinary tool args must stay cold")
        }
      })
      const tail = message("a-tail", "assistant", `token-${index}`, {
        tool_calls: [ordinaryToolCall]
      })
      Object.defineProperty(tail, "status", {
        configurable: true,
        get(): never {
          throw new Error("ordinary assistant status must stay cold")
        }
      })
      target[target.length - 1] = tail
      const nextRevision = projectRevision({
        scopeKey: "thread-same-tail",
        messages,
        structureVersion: index + 2,
        changedMessages: [tail]
      })
      expect(nextRevision).toBe(initialRevision)
      expect(projectQuestions(messages, nextRevision)).toBe(initialProjection)
    }

    const requestTail = message("a-tail", "assistant", "request", {
      tool_calls: [
        {
          id: "request-tail",
          name: "request_user_input",
          args: { questions: [{ id: "q", question: "Continue?" }] }
        }
      ]
    })
    target[target.length - 1] = requestTail
    expect(
      projectRevision({
        scopeKey: "thread-same-tail",
        messages,
        structureVersion: 102,
        changedMessages: [requestTail]
      })
    ).toBe(initialRevision + 1)
  })

  it("invalidates trusted tail appends only at real question boundaries", () => {
    const projectRevision = createChatScrollQuestionRevisionProjector()
    let messages = [message("u-1", "user", "question")]
    const initialRevision = projectRevision({
      scopeKey: "thread-boundary",
      messages,
      structureVersion: 1,
      changedMessages: messages
    })

    messages = [...messages, message("a-plain", "assistant", "answer")]
    expect(
      projectRevision({
        scopeKey: "thread-boundary",
        messages,
        structureVersion: 2,
        changedMessages: messages
      })
    ).toBe(initialRevision)

    messages = [...messages, message("u-2", "user", "next question")]
    const userRevision = projectRevision({
      scopeKey: "thread-boundary",
      messages,
      structureVersion: 3,
      changedMessages: messages
    })
    expect(userRevision).toBe(initialRevision + 1)

    messages = [
      ...messages,
      message("a-request", "assistant", "", {
        tool_calls: [
          {
            id: "request-boundary",
            name: "request_user_input",
            args: { questions: [{ id: "q", question: "Continue?" }] }
          }
        ]
      })
    ]
    expect(
      projectRevision({
        scopeKey: "thread-boundary",
        messages,
        structureVersion: 4,
        changedMessages: messages
      })
    ).toBe(userRevision + 1)
  })
})

describe("chat scroll marker rail memo boundary", () => {
  it("bails out every marker render while token content changes but structure is stable", () => {
    const projectRevision = createChatScrollQuestionRevisionProjector()
    const assistant = message("a-1", "assistant", "")
    const messages = [message("u-1", "user", "question"), assistant]
    const projectQuestions = createChatScrollQuestionProjector()
    const revision = projectRevision({
      scopeKey: "thread-markers",
      messages,
      structureVersion: 1,
      changedMessages: messages
    })
    const projection = projectQuestions(messages, revision)
    const onScrollToQuestionIndex = (): void => undefined
    const previousProps = {
      questions: projection.questions,
      activeQuestionIndex: 0,
      onScrollToQuestionIndex
    }
    let markerRenderCount = 1

    for (let token = 0; token < 1_000; token += 1) {
      assistant.content = `token-${token}`
      const nextRevision = projectRevision({
        scopeKey: "thread-markers",
        messages,
        structureVersion: 1,
        changedMessages: [assistant]
      })
      const nextProjection = projectQuestions(messages, nextRevision)
      const nextProps = { ...previousProps, questions: nextProjection.questions }
      if (!areChatScrollMarkerRailPropsEqual(previousProps, nextProps)) markerRenderCount += 1
    }

    expect(markerRenderCount).toBe(1)
  })
})
