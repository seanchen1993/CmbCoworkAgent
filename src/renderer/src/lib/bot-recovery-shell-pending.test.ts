import { afterEach, expect, it, vi } from "vitest"
import { createPendingBotRecoveryStore } from "./bot-recovery-pending"
import { createPendingShellStopStore } from "./bot-shell-pending"
import {
  matchesShellJobAddress,
  verifiesBotRecovery,
  verifiesShellStop
} from "./bot-run-operation-receipt"
import type { BotRun } from "../../../shared/bot-types"
import type { BotShellJobView } from "../../../shared/bot-shell-jobs"

afterEach(() => vi.unstubAllGlobals())
const recovery = {
  id: "run",
  revision: 4,
  nonce: "review",
  dataEpoch: "initial",
  decision: "resume" as const,
  note: "Verified",
  effects: []
}
const shell = {
  conversationId: "conversation",
  runId: "run",
  threadRootId: "branch",
  jobId: "bd7a5d87-d3e6-4a32-957b-4b60194bdf42",
  revision: 2,
  nonce: "5d864cb8-fbfa-4619-9e03-15f7860ad373",
  dataEpoch: "initial"
}
function fixture() {
  const data = new Map<string, string>()
  let unreadable = false,
    denied = false
  const storage = () => ({
    getItem: (key: string) => {
      if (unreadable) throw Error("read denied")
      return data.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      if (denied) throw Error("cleanup denied")
      data.delete(key)
    }
  })
  return {
    data,
    storage,
    unreadable: (value: boolean) => {
      unreadable = value
    },
    denied: (value: boolean) => {
      denied = value
    }
  }
}
it.each(["recovery", "shell"] as const)(
  "%s protects exact original flat intent, restores and unreadable bytes",
  (kind) => {
    const f = fixture(),
      input = kind === "recovery" ? recovery : shell,
      id = kind === "recovery" ? recovery.id : shell.jobId
    const store =
      kind === "recovery"
        ? createPendingBotRecoveryStore(f.storage)
        : createPendingShellStopStore(f.storage)
    // The union represents separate real stores; callers below use their actual typed request.
    const remember = (value: typeof input) =>
      kind === "recovery"
        ? createPendingBotRecoveryStore(f.storage).remember(value as typeof recovery)
        : createPendingShellStopStore(f.storage).remember(value as typeof shell)
    const acknowledge = (value: typeof input) =>
      kind === "recovery"
        ? createPendingBotRecoveryStore(f.storage).acknowledge(value as typeof recovery)
        : createPendingShellStopStore(f.storage).acknowledge(value as typeof shell)
    remember(input)
    const key = [...f.data.keys()][0],
      raw = f.data.get(key)!
    expect(JSON.parse(raw)).toEqual(input)
    expect(store.inspect(id, "replacement")).toMatchObject({ kind: "obsolete", raw })
    expect(() => remember({ ...input, dataEpoch: "replacement" })).toThrow("恢复前")
    expect(() => remember({ ...input, revision: 8 })).toThrow("尚未确认")
    expect(acknowledge({ ...input, revision: 8 })).toBe(false)
    expect(f.data.get(key)).toBe(raw)
    f.denied(true)
    expect(acknowledge(input)).toBe(false)
    expect(f.data.get(key)).toBe(raw)
    f.denied(false)
    expect(acknowledge(input)).toBe(true)
    expect(f.data.size).toBe(0)
    f.data.set(key, "damaged original")
    expect(store.inspect(id, "initial")).toEqual({ kind: "corrupt", raw: "damaged original" })
    expect(() => remember(input)).toThrow("无法核对")
    expect(store.discard(id, "initial", "other bytes")).toBe(false)
    expect(store.discard(id, "initial", "damaged original")).toBe(true)
    f.data.set(key, raw)
    f.unreadable(true)
    expect(store.inspect(id, "initial")).toEqual({ kind: "unreadable" })
    expect(() => remember(input)).toThrow("无法核对")
    expect(store.discard(id, "initial", raw)).toBe(false)
    expect(f.data.get(key)).toBe(raw)
  }
)
it("shell scope includes the original branch even when job ID and nonce match", () => {
  const f = fixture(),
    store = createPendingShellStopStore(f.storage)
  store.remember(shell)
  expect(store.acknowledge({ ...shell, threadRootId: "different" })).toBe(false)
  expect(() => store.remember({ ...shell, conversationId: "another" })).toThrow("尚未确认")
  expect(store.read(shell.jobId, "initial")).toEqual(shell)
  expect(store.inspect(shell.jobId, "initial", shell)).toMatchObject({
    kind: "valid",
    input: shell
  })
  expect(
    store.inspect(shell.jobId, "initial", { ...shell, threadRootId: "another" })
  ).toMatchObject({ kind: "corrupt", raw: [...f.data.values()][0] })
})
it("allows an actual cancelling receipt without claiming physical completion and rejects wrong identity or epoch", () => {
  const receipt = {
    id: shell.jobId,
    address: {
      conversationId: shell.conversationId,
      runId: shell.runId,
      threadRootId: shell.threadRootId
    },
    revision: 3,
    status: "cancelling",
    dataEpoch: "initial"
  } as BotShellJobView
  expect(verifiesShellStop(shell, receipt)).toBe(true)
  expect(verifiesShellStop(shell, { ...receipt, status: "running" })).toBe(false)
  expect(verifiesShellStop(shell, { ...receipt, revision: 4 })).toBe(false)
  expect(verifiesShellStop(shell, { ...receipt, dataEpoch: "replacement" })).toBe(false)
  expect(
    verifiesShellStop(shell, { ...receipt, address: { ...receipt.address, threadRootId: "other" } })
  ).toBe(false)
  expect(matchesShellJobAddress(shell, { ...receipt, id: "other" })).toBe(false)
  // Genuine legacy Store evidence is not rewritten with a renderer-made epoch; scoped RPC admission owns authority.
  expect(verifiesShellStop(shell, { ...receipt, dataEpoch: undefined })).toBe(true)
})
it("only confirms the reviewed run and decision receipt, not a different conversation or future interruption", () => {
  const original = {
    id: "run",
    botId: "bot",
    conversationId: "conversation",
    messageId: "message",
    threadRootId: "branch",
    revision: 4,
    status: "needs_review"
  } as BotRun
  const receipt = { ...original, revision: 5, status: "queued" as const }
  expect(verifiesBotRecovery(original, recovery, receipt)).toBe(true)
  for (const mismatch of [
    { id: "other" },
    { botId: "other" },
    { conversationId: "other" },
    { messageId: "other" },
    { threadRootId: "other" },
    { revision: 6 },
    { status: "running" as const }
  ])
    expect(verifiesBotRecovery(original, recovery, { ...receipt, ...mismatch })).toBe(false)
  expect(
    verifiesBotRecovery(
      original,
      { ...recovery, decision: "cancel" },
      { ...receipt, status: "cancelled" }
    )
  ).toBe(true)
})
