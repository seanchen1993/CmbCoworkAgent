import { beforeEach, expect, it, vi } from "vitest"
import type { AgentRunSteerRequest } from "../agent/agent-run-service"
import type { LocalBotHost } from "./host"
import type { FeatureOwner } from "./feature-store"
import { steerFeatureTurn } from "./feature-steering"

const io = vi.hoisted(() => ({
  steer: vi.fn(),
  lease: vi.fn(),
  question: vi.fn(),
  answer: vi.fn()
}))
vi.mock("../agent/agent-run-service", () => ({ steerAgentRun: io.steer }))
vi.mock("../agent/thread-run-lease", () => ({ getLocalThreadRunLease: io.lease }))
vi.mock("../services/user-input", () => ({
  getPendingUserInputForThread: io.question,
  submitUserInputResponse: io.answer
}))

beforeEach(() => {
  vi.resetAllMocks()
  io.steer.mockResolvedValue({ queued: true })
  io.lease.mockReturnValue({ owner: "desktop", runId: "physical-1" })
})
function fixture() {
  const owner = {
    id: "feature-1",
    botId: "bot",
    audience: "im:group-1",
    projectId: "p",
    slug: "f"
  } as FeatureOwner
  const host = {
    getBot: vi.fn(() => ({ archived: false, deleting: false })),
    featureChanged: vi.fn(),
    imGateway: {
      binding: vi.fn(() => ({
        realm: "gateway",
        principal: "owner",
        binding: {
          botId: "bot",
          state: "active",
          version: 1
        }
      }))
    },
    featureTurns: { operation: vi.fn(() => "original") },
    featureStore: {
      receipt: vi.fn(() => ({ followId: owner.id, state: "active" })),
      owner: vi.fn(),
      active: vi.fn(),
      finish: vi.fn()
    }
  }
  const verify = vi.fn()
  const run = () =>
    steerFeatureTurn({
      host: host as unknown as LocalBotHost,
      owner,
      threadId: "thread",
      operationId: "correction",
      message: "保留原目录，把时间改为下午四点",
      verify
    })
  const message = () => (io.steer.mock.calls.at(-1)![0] as AgentRunSteerRequest).message
  return { host, owner, verify, run, message }
}

it("keeps one physical run and settles the correction only after durable injection", async () => {
  const f = fixture()
  expect(await f.run()).toBe(true)
  expect(io.steer).toHaveBeenCalledWith(
    expect.objectContaining({ owner: "desktop", runId: "physical-1", threadId: "thread" })
  )
  expect(f.host.featureStore.active).toHaveBeenCalledWith("correction", "thread")
  expect(f.host.featureStore.finish).not.toHaveBeenCalled()
  expect(f.message().beforeInject!()).toBe(true)
  expect(f.host.featureStore.finish).not.toHaveBeenCalled()
  f.message().onInjected!()
  expect(f.host.featureStore.finish).toHaveBeenCalledExactlyOnceWith("correction")
})

it("revalidates the original thread and group ownership at consumption", async () => {
  const f = fixture()
  await f.run()
  io.lease.mockReturnValue({ owner: "desktop", runId: "replacement" })
  expect(f.message().beforeInject!()).toBe(false)
  f.message().onDiscarded!()
  expect(f.host.featureStore.finish).toHaveBeenCalledWith(
    "correction",
    expect.stringContaining("未被接收")
  )
})

it("does not inject into another conversation's owned run", async () => {
  const f = fixture()
  f.host.featureStore.receipt.mockReturnValue({ followId: "foreign", state: "active" })
  await expect(f.run()).rejects.toThrow("另一项交办")
  expect(io.steer).not.toHaveBeenCalled()
})

it("can steer an authorized native project run, but leaves idle sessions to normal continuation", async () => {
  const f = fixture()
  f.host.featureTurns.operation.mockReturnValue(undefined as unknown as string)
  expect(await f.run()).toBe(true)
  expect(f.verify).toHaveBeenCalled()
  io.lease.mockReturnValue(undefined)
  expect(await f.run()).toBe(false)
})

it("preserves new-question ownership after immediate consumption", async () => {
  const f = fixture()
  io.steer.mockImplementation(async (request: AgentRunSteerRequest) => {
    expect(request.message.beforeInject!()).toBe(true)
    request.message.onInjected!()
    io.question.mockReturnValue({ requestId: "new-question" })
    return { queued: true }
  })
  await f.run()
  expect(io.answer).not.toHaveBeenCalled()
})

it("retains the existing skip-old-question behavior for a pending correction", async () => {
  const f = fixture()
  io.question.mockReturnValue({ requestId: "old-question" })
  await f.run()
  expect(io.answer).toHaveBeenCalledWith(
    { requestId: "old-question", answers: {}, ignored: true },
    expect.anything()
  )
})

it("never reports a refused steer as a started continuation", async () => {
  const f = fixture()
  io.steer.mockResolvedValue({ queued: false, reason: "no_active_run" })
  await expect(f.run()).rejects.toThrow("补充尚未接收")
  expect(io.answer).not.toHaveBeenCalled()
})

it("withdraws a queued correction if its Feature/group is removed before consumption", async () => {
  const f = fixture()
  await f.run()
  f.verify.mockImplementation(() => {
    throw new Error("group revoked")
  })
  expect(f.message().beforeInject!()).toBe(false)
  f.message().onDiscarded!()
  expect(f.host.featureStore.finish).toHaveBeenCalledWith(
    "correction",
    expect.stringContaining("未被接收")
  )
})

it("withdraws a correction after its channel changes even while the project run remains alive", async () => {
  const f = fixture()
  await f.run()
  f.host.imGateway.binding.mockReturnValue({
    realm: "gateway",
    principal: "owner",
    binding: {
      botId: "bot",
      state: "active",
      version: 2
    }
  })
  expect(f.message().beforeInject!()).toBe(false)
})
