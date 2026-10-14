import { describe, expect, it, vi } from "vitest"
import { createPromptCallAdmission, readPromptCallDrainReceipt } from "./prompt-call-admission"

const digest = "a".repeat(64)
function setup(assertCurrent = () => {}, maxCalls = 8) {
  const parent = new AbortController()
  const admission = createPromptCallAdmission({
    signal: parent.signal,
    deadline: Date.now() + 10000,
    maxCalls,
    assertCurrent
  })
  return { parent, admission }
}
function deferred() {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

describe("prompt call admission and drain, not graph proof", () => {
  it("admits actual callbacks, closes new admission, and returns only a private drain token", async () => {
    const f = setup()
    try {
      await expect(f.admission.run("model", digest, async () => "response")).resolves.toBe(
        "response"
      )
      await f.admission.run("result-tool", digest, async () => "accepted")
      const token = await f.admission.seal()
      expect(readPromptCallDrainReceipt(token)).toMatchObject({
        coverage: "admitted-call-drain-only",
        calls: [
          { sequence: 0, kind: "model", state: "settled" },
          { sequence: 1, kind: "result-tool", state: "settled" }
        ]
      })
      expect(readPromptCallDrainReceipt({ ...token })).toBeUndefined()
      expect(readPromptCallDrainReceipt(new Proxy(token, {}))).toBeUndefined()
      expect(await f.admission.seal()).toBe(token)
      const late = vi.fn(async () => undefined)
      await expect(f.admission.run("model", digest, late)).rejects.toThrow("ADMISSION_CLOSED")
      expect(late).not.toHaveBeenCalled()
    } finally {
      f.admission.dispose()
    }
  })

  it("waits for a new active generation after an earlier call completed", async () => {
    const f = setup(),
      work = deferred()
    try {
      await f.admission.run("model", digest, async () => "first")
      const second = f.admission.run("model", digest, () => work.promise)
      let sealed = false
      const receipt = f.admission.seal().then((value) => {
        sealed = true
        return value
      })
      await Promise.resolve()
      expect(sealed).toBe(false)
      work.resolve("second")
      await second
      expect(readPromptCallDrainReceipt(await receipt)?.calls).toHaveLength(2)
    } finally {
      f.admission.dispose()
    }
  })

  it("does not certify failed or abort-ignoring in-flight work", async () => {
    const f = setup(),
      work = deferred()
    try {
      const running = f.admission.run("model", digest, () => work.promise)
      const caught = running.catch((error) => error)
      const sealed = f.admission.seal()
      f.parent.abort(Error("owner gone"))
      await expect(sealed).rejects.toThrow("owner gone")
      work.resolve("late response")
      expect(await caught).toBeInstanceOf(Error)
      await expect(f.admission.seal()).rejects.toThrow()
    } finally {
      f.admission.dispose()
    }
  })

  it("keeps a failed call unknown even after another call succeeds", async () => {
    const f = setup()
    try {
      await expect(
        f.admission.run("model", digest, async () => {
          throw Error("provider failed")
        })
      ).rejects.toThrow("provider failed")
      await expect(f.admission.run("model", digest, async () => "retry")).rejects.toThrow(
        "ADMISSION_CLOSED"
      )
      await expect(f.admission.seal()).rejects.toThrow("CALL_UNKNOWN")
    } finally {
      f.admission.dispose()
    }
  })

  it("rechecks ownership after the last callback before returning a receipt", async () => {
    let live = true
    const f = setup(() => {
      if (!live) throw Error("revoked")
    })
    try {
      await f.admission.run("model", digest, async () => "done")
      live = false
      await expect(f.admission.seal()).rejects.toThrow("revoked")
    } finally {
      f.admission.dispose()
    }
  })

  it("limits calls before invoking another provider", async () => {
    const f = setup(undefined, 1),
      extra = vi.fn(async () => "extra")
    try {
      await f.admission.run("model", digest, async () => "first")
      await expect(f.admission.run("model", digest, extra)).rejects.toThrow("ADMISSION_LIMIT")
      expect(extra).not.toHaveBeenCalled()
      await expect(f.admission.seal()).rejects.toThrow()
    } finally {
      f.admission.dispose()
    }
  })

  it("rejects reentrant new admission when the authority callback begins sealing", async () => {
    let armed = false
    let sealed: ReturnType<ReturnType<typeof setup>["admission"]["seal"]> | undefined
    const f = setup(() => {
      if (armed) {
        armed = false
        sealed = f.admission.seal()
      }
    })
    const invoke = vi.fn(async () => "must not run")
    try {
      armed = true
      await expect(f.admission.run("model", digest, invoke)).rejects.toThrow("ADMISSION_CLOSED")
      expect(invoke).not.toHaveBeenCalled()
      expect(readPromptCallDrainReceipt(await sealed)?.calls).toEqual([])
    } finally {
      f.admission.dispose()
    }
  })

  it("cleans timers and listeners on failure even without a later dispose", async () => {
    vi.useFakeTimers()
    const f = setup()
    const remove = vi.spyOn(f.parent.signal, "removeEventListener")
    try {
      await expect(
        f.admission.run("model", digest, async () => {
          throw Error("failed")
        })
      ).rejects.toThrow("failed")
      await expect(f.admission.seal()).rejects.toThrow("CALL_UNKNOWN")
      expect(vi.getTimerCount()).toBe(0)
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    } finally {
      f.admission.dispose()
      remove.mockRestore()
      vi.useRealTimers()
    }
  })

  it("bounds seal when the provider never honors cancellation", async () => {
    vi.useFakeTimers()
    const f = setup(),
      work = deferred()
    try {
      const running = f.admission.run("model", digest, () => work.promise).catch((error) => error)
      const sealed = f.admission.seal().catch((error) => error)
      await vi.advanceTimersByTimeAsync(10000)
      expect(await sealed).toBeInstanceOf(Error)
      expect(vi.getTimerCount()).toBe(0)
      work.resolve("too late")
      expect(await running).toBeInstanceOf(Error)
    } finally {
      f.admission.dispose()
      vi.useRealTimers()
    }
  })
})
