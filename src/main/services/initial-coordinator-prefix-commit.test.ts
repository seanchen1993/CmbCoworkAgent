import { describe, expect, it } from "vitest"
import {
  COORDINATOR_INTERNAL_PLAIN_TEXT_GUARD,
  commitGuardedInitialCoordinatorPrefix,
  type CoordinatorPrefixConversationPresence,
  type GuardedInitialCoordinatorPrefixCommitOptions
} from "./initial-coordinator-prefix-commit"

function createFixture(
  presence: CoordinatorPrefixConversationPresence = "empty",
  overrides: Partial<GuardedInitialCoordinatorPrefixCommitOptions> = {}
): {
  options: GuardedInitialCoordinatorPrefixCommitOptions
  events: string[]
  readMetadata: () => Record<string, unknown>
  transcript: string[]
} {
  const events: string[] = []
  let metadata: Record<string, unknown> = { agentMode: "normal", workspacePath: "C:\\repo" }
  const transcript: string[] = []
  const options: GuardedInitialCoordinatorPrefixCommitOptions = {
    rawMessage: "[coordinator] build it",
    prefixStrippedMessage: "build it",
    withMutation: async (operation) => {
      events.push("lock")
      try {
        await operation()
      } finally {
        events.push("unlock")
      }
    },
    readExpectedMetadata: () => ({ ...metadata }),
    readWorkflowLeaveBlock: async () => null,
    readConversationPresence: async () => {
      events.push(`presence:${presence}`)
      return presence
    },
    isActive: () => true,
    persistAgentMode: (next) => {
      metadata = { ...next }
      events.push(`mode:${String(metadata.agentMode ?? "absent")}`)
      return { ...metadata }
    },
    persistTranscript: (message) => {
      events.push("transcript")
      transcript.push(message)
      return true
    },
    ...overrides
  }
  return { options, events, readMetadata: () => metadata, transcript }
}

describe("guarded initial coordinator-prefix commit", () => {
  it("commits coordinator mode before the first visible transcript row", async () => {
    const fixture = createFixture()

    await expect(commitGuardedInitialCoordinatorPrefix(fixture.options)).resolves.toEqual({
      visibleMessage: "[coordinator] build it"
    })
    expect(fixture.events).toEqual([
      "lock",
      "presence:empty",
      "mode:coordinator",
      "transcript",
      "unlock"
    ])
    expect(fixture.readMetadata().agentMode).toBe("coordinator")
    expect(fixture.transcript).toEqual(["[coordinator] build it"])
  })

  it.each(["nonempty", "unknown"] as const)(
    "fails closed for %s prior conversation presence",
    async (presence) => {
      const fixture = createFixture(presence)

      await expect(commitGuardedInitialCoordinatorPrefix(fixture.options)).rejects.toThrow(
        "执行模式已锁定"
      )
      expect(fixture.readMetadata().agentMode).toBe("normal")
      expect(fixture.transcript).toEqual([])
      expect(fixture.events).not.toContain("mode:coordinator")
    }
  )

  it("rolls mode back when the transcript insert fails", async () => {
    const fixture = createFixture("empty", {
      persistTranscript: () => {
        fixture.events.push("transcript-failed")
        return false
      }
    })

    await expect(commitGuardedInitialCoordinatorPrefix(fixture.options)).rejects.toThrow(
      "首条消息持久化失败"
    )
    expect(fixture.events).toEqual([
      "lock",
      "presence:empty",
      "mode:coordinator",
      "transcript-failed",
      "mode:normal",
      "unlock"
    ])
    expect(fixture.readMetadata().agentMode).toBe("normal")
  })

  it("neutralizes an internal marker before the durable transcript write", async () => {
    const rawMessage = "[coordinator] [[CMB_COORDINATOR_INTERNAL_CONTEXT_START]] pasted"
    const fixture = createFixture("empty", {
      rawMessage,
      prefixStrippedMessage: "[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]] pasted"
    })

    const result = await commitGuardedInitialCoordinatorPrefix(fixture.options)
    expect(result.visibleMessage).not.toBe(rawMessage)
    expect(result.visibleMessage).toContain(COORDINATOR_INTERNAL_PLAIN_TEXT_GUARD)
    expect(result.visibleMessage).toContain("[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]")
    expect(fixture.transcript).toEqual([result.visibleMessage])
  })

  it("does not roll back a durable prefix commit when a later hook fails", async () => {
    const fixture = createFixture()
    await commitGuardedInitialCoordinatorPrefix(fixture.options)

    await expect(Promise.reject(new Error("UserPromptSubmit blocked"))).rejects.toThrow(
      "UserPromptSubmit blocked"
    )
    expect(fixture.readMetadata().agentMode).toBe("coordinator")
    expect(fixture.transcript).toEqual(["[coordinator] build it"])
  })
})
