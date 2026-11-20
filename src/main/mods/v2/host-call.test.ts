import { expect, it, vi } from "vitest"
import type { ModIdentity } from "../../../shared/mods/types"
import { functionCallIdentity, functionCallTurn, runFunctionHostCall } from "./host-call"
import { withFunctionExecution } from "./execution-context"
import { modCallContext } from "../context"

const grant = {
  workspace: "/project",
  modId: "function:owner",
  digest: "snapshot",
  epoch: 1,
  enabled: true
}
const identity: ModIdentity = {
  workspace: "/project",
  threadId: "thread",
  turnId: "turn",
  agentId: "main",
  callId: "parent",
  modId: grant.modId,
  grantEpoch: 1,
  origin: "model"
}
const options = { origin: "mod" as const, fallbackTurnId: "fallback" }

function fixture() {
  const events: string[] = []
  let live = true
  const call = {
    identity,
    store: {
      settle: vi.fn((_id: string, status: string) => {
        events.push(status)
      }),
      blockPublication: vi.fn(() => {
        events.push("blocked")
      })
    },
    assertLive: vi.fn(() => {
      if (!live) throw Error("expired")
    }),
    admit: vi.fn(async () => {
      events.push("admit")
    }),
    claim: vi.fn(() => {
      events.push("claim")
    }),
    invoke: vi.fn(async () => {
      events.push("invoke")
      return "private"
    }),
    status: () => "succeeded" as const,
    recordResult: vi.fn(() => {
      events.push("account")
    }),
    publish: vi.fn(async () => {
      events.push("publish")
      return "protected"
    })
  }
  return {
    call,
    events,
    expire: () => {
      live = false
    }
  }
}

it("uses one admission, one reservation and one execution before publishing", async () => {
  const f = fixture()
  expect(await runFunctionHostCall(f.call)).toBe("protected")
  expect(f.events).toEqual(["admit", "claim", "invoke", "succeeded", "account", "publish"])
})

it("resolves a nested cold command's parent turn before binding an adapter without minting identity", async () => {
  const f = fixture()
  expect(functionCallTurn("/project", "thread")).toBeUndefined()
  await runFunctionHostCall({
    ...f.call,
    invoke: async () => {
      expect(functionCallTurn("/project", "thread")).toBe("turn")
      expect(() => functionCallTurn("/other", "thread")).toThrow("MODS_CALL_SCOPE_CHANGED")
      return "private"
    }
  })
  expect(functionCallTurn("/project", "thread")).toBeUndefined()
})

it.each(["admit", "claim", "invoke", "recordResult", "publish"] as const)(
  "keeps durable execution facts when %s fails and never retries",
  async (stage) => {
    const f = fixture()
    f.call[stage].mockImplementation(() => {
      throw Error("failure")
    })
    await expect(runFunctionHostCall(f.call)).rejects.toThrow("failure")
    expect(f.call.invoke.mock.calls.length).toBe(stage === "admit" || stage === "claim" ? 0 : 1)
    if (stage === "admit" || stage === "claim") {
      expect(f.call.store.settle).not.toHaveBeenCalled()
      expect(f.call.store.blockPublication).not.toHaveBeenCalled()
    } else {
      expect(f.call.store.settle).toHaveBeenCalledExactlyOnceWith(
        identity.callId,
        stage === "invoke" ? "unknown" : "succeeded"
      )
      expect(f.call.store.blockPublication).toHaveBeenCalledOnce()
    }
  }
)

it.each(["admit", "claim", "invoke", "publish"] as const)(
  "rechecks authority after %s without erasing a completed execution",
  async (stage) => {
    const f = fixture()
    if (stage === "claim") f.call.claim.mockImplementation(f.expire)
    else if (stage === "admit") f.call.admit.mockImplementation(async () => f.expire())
    else
      f.call[stage].mockImplementation(async () => {
        f.expire()
        return "late"
      })
    await expect(runFunctionHostCall(f.call)).rejects.toThrow("expired")
    if (stage === "admit") expect(f.call.store.settle).not.toHaveBeenCalled()
    else
      expect(f.call.store.settle).toHaveBeenCalledExactlyOnceWith(
        identity.callId,
        stage === "claim" ? "not_started" : "succeeded"
      )
    if (stage !== "publish") expect(f.call.publish).not.toHaveBeenCalled()
  }
)

it("attributes nested calls to the actual parent but retains the new caller's grant", async () => {
  const f = fixture()
  const other = { ...grant, modId: "function:consumer", epoch: 9 }
  f.call.invoke.mockImplementation(async () => {
    const child = functionCallIdentity("/project", "thread", other, options)
    expect(child).toMatchObject({
      parentCallId: "parent",
      turnId: "turn",
      agentId: "main",
      modId: "function:consumer",
      grantEpoch: 9,
      origin: "mod"
    })
    expect(child.callId).not.toBe(identity.callId)
    expect(() => functionCallIdentity("/other", "thread", other, options)).toThrow(
      "MODS_CALL_SCOPE_CHANGED"
    )
    return "done"
  })
  await runFunctionHostCall(f.call)
})

it("does not attribute concurrent operations to another call", async () => {
  await Promise.all(
    ["a", "b"].map(async (id) => {
      const f = fixture()
      f.call.identity = { ...identity, callId: id }
      f.call.invoke.mockImplementation(async () => {
        await Promise.resolve()
        expect(functionCallIdentity("/project", "thread", grant, options).parentCallId).toBe(id)
        return id
      })
      await runFunctionHostCall(f.call)
    })
  )
})

it("rejects detached continuations instead of promoting them to fresh host calls", async () => {
  const f = fixture()
  let resume!: () => void
  let delayed!: Promise<ModIdentity>
  f.call.invoke.mockImplementation(async () => {
    const gate = new Promise<void>((r) => {
      resume = r
    })
    delayed = gate.then(() => functionCallIdentity("/project", "thread", grant, options))
    return "done"
  })
  await runFunctionHostCall(f.call)
  const rejected = expect(delayed).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
  resume()
  await rejected
})

it("takes turn and agent from the live execution and refuses conflicting inherited identity", async () => {
  await withFunctionExecution(
    {
      workspace: "/project",
      threadId: "thread",
      turnId: "turn",
      agentId: "worker",
      leased: true,
      immediate: false,
      userInitiated: false
    },
    async () => {
      expect(functionCallIdentity("/project", "thread", grant, options)).toMatchObject({
        turnId: "turn",
        agentId: "worker"
      })
      modCallContext.run(
        {
          identity,
          toolId: "host:read_file",
          routeClaimed: true,
          protectedOutput: false,
          readOnly: true
        },
        () => {
          expect(() => functionCallIdentity("/project", "thread", grant, options)).toThrow(
            "MODS_CALL_SCOPE_CHANGED"
          )
        }
      )
    }
  )
})
