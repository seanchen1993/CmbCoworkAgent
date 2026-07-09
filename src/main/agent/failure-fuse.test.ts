import { beforeEach, describe, expect, it } from "vitest"
import { MiddlewareError } from "langchain"
import {
  buildToolFailureFingerprint,
  clearFailureFuseState,
  FailureFuseHaltError,
  getFailureFuseMode,
  getFailureFuseHaltError,
  isFailureFuseHaltError,
  shouldAttachFailureFuseFeedback,
  shouldSendFailureFuseNotice,
  recordToolFailure,
  recordToolSuccess
} from "./failure-fuse"
import type { ToolFailureSignal } from "../hooks/tool-failure"

function signal(
  message = "Command failed at C:\\Users\\alice\\repo\\src\\a.ts:12:4"
): ToolFailureSignal {
  return {
    kind: "exit-nonzero",
    message,
    errorType: "unknown",
    isInterrupt: false,
    isTimeout: false
  }
}

beforeEach(() => {
  clearFailureFuseState()
  delete process.env.CMB_AGENT_FAILURE_FUSE_WARN
  delete process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK
  delete process.env.CMB_AGENT_FAIL_FAST
})

describe("failure fuse", () => {
  it("defaults user notices on and lets debug override warning mode", () => {
    expect(getFailureFuseMode()).toBe("warn")

    process.env.CMB_AGENT_FAILURE_FUSE_WARN = "0"
    expect(getFailureFuseMode()).toBe("off")

    process.env.CMB_AGENT_FAILURE_FUSE_WARN = "false"
    expect(getFailureFuseMode()).toBe("off")

    process.env.CMB_AGENT_FAILURE_FUSE_WARN = "1"
    expect(getFailureFuseMode()).toBe("warn")

    process.env.CMB_AGENT_FAILURE_FUSE_WARN = "0"
    process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK = "1"
    expect(getFailureFuseMode()).toBe("warn")

    process.env.CMB_AGENT_FAIL_FAST = "1"
    expect(getFailureFuseMode()).toBe("debug")
  })

  it("splits user notices from model feedback", () => {
    const decision = {
      action: "warn" as const,
      fingerprint: "execute|exit-nonzero|unknown|boom",
      count: 2,
      threshold: 3,
      reason: "same failure repeated",
      toolName: "execute",
      lastError: "boom"
    }

    expect(shouldSendFailureFuseNotice(decision)).toBe(true)
    expect(shouldAttachFailureFuseFeedback(decision)).toBe(false)

    process.env.CMB_AGENT_FAILURE_FUSE_WARN = "0"
    expect(shouldSendFailureFuseNotice(decision)).toBe(false)
    expect(shouldAttachFailureFuseFeedback(decision)).toBe(false)

    process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK = "1"
    expect(shouldSendFailureFuseNotice(decision)).toBe(false)
    expect(shouldAttachFailureFuseFeedback(decision)).toBe(true)
  })

  it("does nothing in off mode", () => {
    const input = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(),
      mode: "off" as const
    }

    expect(recordToolFailure(input).action).toBe("observe")
    expect(recordToolFailure(input).count).toBe(0)
    expect(recordToolFailure(input).threshold).toBe(0)
  })

  it("does not inspect tool args when fuse mode is off", () => {
    const throwingArgs = new Proxy(
      {},
      {
        get() {
          throw new Error("tool args should not be read")
        },
        ownKeys() {
          throw new Error("tool args should not be enumerated")
        }
      }
    )

    expect(
      recordToolFailure({
        threadId: "thread-1",
        turnId: "turn-1",
        toolName: "write_file",
        toolArgs: throwingArgs,
        signal: signal(),
        mode: "off"
      }).action
    ).toBe("observe")
  })

  it("does not inspect tool args on success when there is no matching failure state", () => {
    const throwingArgs = new Proxy(
      {},
      {
        get() {
          throw new Error("tool args should not be read")
        },
        ownKeys() {
          throw new Error("tool args should not be enumerated")
        }
      }
    )

    expect(() =>
      recordToolSuccess({
        threadId: "thread-1",
        turnId: "turn-1",
        toolName: "write_file",
        toolArgs: throwingArgs
      })
    ).not.toThrow()
  })

  it("warns on the second same failure and strongly warns on the third within a turn", () => {
    const input = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(),
      mode: "warn" as const
    }

    expect(recordToolFailure(input).action).toBe("observe")
    expect(recordToolFailure(input).action).toBe("warn")
    const third = recordToolFailure(input)
    expect(third.action).toBe("strong_warn")
    expect(third.count).toBe(3)
  })

  it("does not aggregate the same fingerprint across turns for reminder decisions", () => {
    const base = {
      threadId: "thread-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(),
      mode: "warn" as const
    }

    expect(recordToolFailure({ ...base, turnId: "turn-1" }).action).toBe("observe")
    expect(recordToolFailure({ ...base, turnId: "turn-2" }).action).toBe("observe")
  })

  it("halts immediately in debug mode", () => {
    const decision = recordToolFailure({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      signal: signal(),
      mode: "debug"
    })

    expect(decision.action).toBe("halt")
    expect(decision.threshold).toBe(1)
  })

  it("does not count aborts", () => {
    const decision = recordToolFailure({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      signal: {
        kind: "abort",
        message: "user aborted",
        errorType: "unknown",
        isInterrupt: true,
        isTimeout: false
      },
      mode: "warn"
    })

    expect(decision.action).toBe("observe")
    expect(decision.count).toBe(0)
  })

  it("normalizes noisy error text in fingerprints", () => {
    const left = buildToolFailureFingerprint({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(
        "Failed C:\\Users\\alice\\repo\\x.ts:10:2 id 11111111-1111-4111-8111-111111111111"
      ),
      mode: "warn"
    })
    const right = buildToolFailureFingerprint({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(
        "Failed C:\\Users\\bob\\repo\\x.ts:20:9 id 22222222-2222-4222-8222-222222222222"
      ),
      mode: "warn"
    })

    expect(left).toBe(right)
  })

  it("resets a tool's current-turn failures after success", () => {
    const input = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(),
      mode: "warn" as const
    }

    expect(recordToolFailure(input).action).toBe("observe")
    expect(recordToolFailure(input).action).toBe("warn")
    recordToolSuccess({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" }
    })
    expect(recordToolFailure(input).action).toBe("observe")
  })

  it("does not reset a failure fingerprint after a different-args success", () => {
    const input = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "npm test" },
      signal: signal(),
      mode: "warn" as const
    }

    expect(recordToolFailure(input).action).toBe("observe")
    expect(recordToolFailure(input).action).toBe("warn")
    recordToolSuccess({
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      toolArgs: { command: "pnpm test" }
    })
    expect(recordToolFailure(input).action).toBe("strong_warn")
  })

  it("keeps same-category failures with different full args in separate counters", () => {
    const base = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolName: "execute",
      signal: signal("npm failed with the same stderr"),
      mode: "warn" as const
    }

    expect(recordToolFailure({ ...base, toolArgs: { command: "npm test" } }).action).toBe("observe")
    expect(recordToolFailure({ ...base, toolArgs: { command: "npm run lint" } }).action).toBe(
      "observe"
    )
    expect(recordToolFailure({ ...base, toolArgs: { command: "npm test" } }).action).toBe("warn")
  })

  it("unwraps LangChain middleware-wrapped halt errors without treating wrappers as direct halt errors", () => {
    const haltError = new FailureFuseHaltError({
      action: "halt",
      fingerprint: "execute|exit-nonzero|unknown|boom",
      count: 3,
      threshold: 3,
      reason: "same failure repeated",
      toolName: "execute",
      lastError: "boom"
    })
    const wrapped = MiddlewareError.wrap(haltError, "toolHookMiddleware")

    expect(isFailureFuseHaltError(wrapped)).toBe(false)
    expect(getFailureFuseHaltError(wrapped)).toBe(haltError)
  })
})
