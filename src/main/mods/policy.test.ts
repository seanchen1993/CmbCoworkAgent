import { describe, expect, it, vi } from "vitest"
import { ToolMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { ModGuestRuntime } from "./guest-runtime"
import type { ModObject } from "../../shared/mods/types"
import type { ModHostCall } from "./guest-runtime"
import { ModError } from "./errors"

const control = vi.hoisted(() => ({ fail: false, guestFailures: 0, invokes: 0 }))
vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      if (control.fail) throw Error("host failed")
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      control.invokes++
      if (control.guestFailures > 0) {
        control.guestFailures--
        return Promise.reject(new ModError("MODS_GUEST_ERROR"))
      }
      if (control.fail) return Promise.reject(Error("host failed"))
      return this.guests.get(id)!.invoke(handler, event, call)
    }
    stop() {
      this.guests.forEach((guest) => guest.dispose())
      this.guests.clear()
      this.version++
    }
  }
}))
import { ManagedModPolicy, DEFAULT_MOD_POLICY, parseManagedModDeployment } from "./policy"

describe("application-owned isolated policy", () => {
  it("filters a bounded large connector result including nested values and maximum configured literals", async () => {
    const literals = Array.from(
      { length: 64 },
      (_, i) => `PRIVATE_VALUE_${i.toString().padStart(2, "0")}`
    )
    const policy = new ManagedModPolicy({
      ...DEFAULT_MOD_POLICY,
      required: true,
      redactLiterals: literals
    })
    const text = literals.join(" ").repeat(240)
    try {
      const result = await policy.filter({ text, nested: { text }, isError: true })
      expect(JSON.stringify(result.value)).not.toContain("PRIVATE_VALUE_")
      expect(result.value).toEqual({
        text: "[REDACTED]".concat(" [REDACTED]".repeat(63)).repeat(240),
        nested: { text: "[REDACTED]".concat(" [REDACTED]".repeat(63)).repeat(240) },
        isError: true
      })
      expect(result.ruleIds).toContain("deployment-literal")
    } finally {
      policy.stop()
    }
  })
  it("retries only pure policy computation once and remains closed after repeated failure", async () => {
    const policy = new ManagedModPolicy({
      ...DEFAULT_MOD_POLICY,
      required: true,
      redactLiterals: ["private-value"]
    })
    try {
      control.guestFailures = 1
      const before = control.invokes
      expect((await policy.filter("private-value")).value).toBe("[REDACTED]")
      expect(control.invokes - before).toBe(2)
      control.guestFailures = 2
      const failed = control.invokes
      await expect(policy.filter("new private-value")).rejects.toThrow("POLICY_UNAVAILABLE")
      expect(control.invokes - failed).toBe(2)
    } finally {
      control.guestFailures = 0
      policy.stop()
    }
  })
  it("filters every observable field and keeps tool status and graph routing", async () => {
    const policy = new ManagedModPolicy({
      ...DEFAULT_MOD_POLICY,
      redactLiterals: ["internal-number"]
    })
    try {
      const message = new ToolMessage({
        content: "internal-number sk-secret-token-123456789",
        tool_call_id: "call",
        status: "error",
        artifact: { text: "internal-number" },
        metadata: { secret: "hidden" },
        additional_kwargs: { text: "internal-number" }
      })
      const command = new Command({ update: { messages: [message], count: 9 }, goto: "review" })
      const published = await policy.publish(command, "call")
      expect(published.goto).toEqual(command.goto)
      const result = (published.update as { messages: ToolMessage[] }).messages[0]
      expect(result.status).toBe("error")
      expect(result.tool_call_id).toBe("call")
      expect(JSON.stringify(result)).not.toMatch(/internal-number|sk-secret|hidden/)
      expect(result.content).toContain("[REDACTED]")
    } finally {
      policy.stop()
    }
  })

  it("enforces exact tool denial without giving the policy an SDK capability", async () => {
    const policy = new ManagedModPolicy({
      ...DEFAULT_MOD_POLICY,
      required: true,
      denyTools: ["host:execute"]
    })
    const identity = {
      callId: "call",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      workspace: "workspace",
      origin: "model" as const,
      grantEpoch: 0
    }
    try {
      await expect(
        policy.admit(identity, "host:execute", { command: "echo test" })
      ).rejects.toThrow("POLICY_TOOL_DENIED")
      await expect(policy.admit(identity, "host:read_file", {})).resolves.toBeUndefined()
    } finally {
      policy.stop()
    }
  })

  it("fails closed when its worker is unavailable and rebuilds without replaying a tool", async () => {
    const policy = new ManagedModPolicy()
    control.fail = true
    try {
      await expect(policy.filter("raw")).rejects.toThrow("POLICY_UNAVAILABLE")
      control.fail = false
      expect((await policy.filter("safe")).value).toBe("safe")
    } finally {
      control.fail = false
      policy.stop()
    }
  })

  it("bounds deployment data and accepts only the application policy ABI", () => {
    expect(() =>
      parseManagedModDeployment({ ...DEFAULT_MOD_POLICY, id: "plugin-policy" })
    ).toThrow()
    expect(() =>
      parseManagedModDeployment({ ...DEFAULT_MOD_POLICY, redactLiterals: [""] })
    ).toThrow()
    expect(() =>
      parseManagedModDeployment({ ...DEFAULT_MOD_POLICY, denyTools: Array(65).fill("x") })
    ).toThrow()
  })
  it("honors cancellation even on a cached policy result", async () => {
    const policy = new ManagedModPolicy()
    try {
      expect((await policy.filter("cached")).ruleIds).toContain("baseline-v1")
      await expect(policy.filter("cached", AbortSignal.abort())).rejects.toThrow("CANCELLED")
    } finally {
      policy.stop()
    }
  })
})
