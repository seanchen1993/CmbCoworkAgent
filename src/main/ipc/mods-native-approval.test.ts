import { expect, it, vi } from "vitest"
import { ModApprovalInbox } from "./mods-approval-inbox"
import { confirmNativeModApproval } from "./mods-native-approval"
import { createWorkflowPlatformProvider } from "../mods/v2/platform-workflow-provider"
import type { NativePlatformCallContext } from "../mods/v2/platform-capabilities-types"
import type { WorkflowRunObservation } from "../agent/workflow/observation"

function fixture() {
  const changed = vi.fn()
  const inbox = new ModApprovalInbox(changed)
  const controller = new AbortController()
  let current = true
  const context: NativePlatformCallContext = {
    workspace: "/repository",
    threadId: "chat",
    incarnation: "one",
    generation: "one",
    caller: { name: "generic-board", provider: "generic-board", digest: "one", generation: "one" },
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted()
      if (!current) throw Error("OWNER_REVOKED")
    },
    publish: vi.fn(),
    invoke: vi.fn()
  }
  const request = (label = "允许读取") =>
    confirmNativeModApproval(inbox, context, {
      title: "Repository",
      message: "Read this repository?",
      detail: "/repository",
      allowLabel: label
    })
  const decide = (decision: "allow" | "deny") =>
    inbox.decide({ requestId: inbox.snapshot().current!.requestId, decision })
  return {
    inbox,
    changed,
    controller,
    context,
    request,
    decide,
    revoke: () => {
      current = false
    }
  }
}

it("pauses repeated repository, workflow and project approvals from the same caller", async () => {
  const f = fixture()
  const first = f.request()
  f.decide("deny")
  expect(await first).toBe(false)
  const notifications = f.changed.mock.calls.length
  for (let tick = 0; tick < 100; tick++) {
    for (const label of ["允许读取", "取消工作流", "连续执行项目"])
      expect(() => f.request(label)).toThrow("MODS_APPROVAL_PAUSED")
  }
  expect(f.changed).toHaveBeenCalledTimes(notifications)
  expect(f.inbox.snapshot().queued).toBe(0)
})

it.each(["cancel", "revoke"])("removes a waiting native request on %s", async (kind) => {
  const f = fixture()
  const first = f.request()
  const rejected = expect(first).rejects.toThrow()
  const requestId = f.inbox.snapshot().current!.requestId
  if (kind === "cancel") f.controller.abort(Error("USER_STOPPED"))
  else f.revoke()
  f.inbox.prune()
  await rejected
  expect(f.inbox.snapshot().current).toBeNull()
  expect(() => f.inbox.decide({ requestId, decision: "allow" })).toThrow("MODS_APPROVAL_STALE")
})

it("rechecks the exact project version while waiting, even when the plugin remains live", async () => {
  const f = fixture()
  let version = 1
  const first = confirmNativeModApproval(
    f.inbox,
    f.context,
    {
      message: "Continue this project?",
      allowLabel: "连续执行项目"
    },
    () => {
      if (version !== 1) throw Error("PROJECT_VERSION_CHANGED")
    }
  )
  const rejected = expect(first).rejects.toThrow("PROJECT_VERSION_CHANGED")
  const requestId = f.inbox.snapshot().current!.requestId
  version++
  expect(() => f.inbox.decide({ requestId, decision: "allow" })).toThrow("PROJECT_VERSION_CHANGED")
  await rejected
  expect(f.inbox.snapshot().current).toBeNull()
})

it("never cancels a workflow on denial or when the active run changes during confirmation", async () => {
  const f = fixture()
  let runId = "run-one"
  const cancel = vi.fn(() => true)
  const provider = createWorkflowPlatformProvider({
    active: async () =>
      ({
        runId,
        status: "running",
        agents: [],
        worktrees: []
      }) as unknown as WorkflowRunObservation,
    latest: async () => null,
    inspect: async () => null,
    changed: () => () => {},
    confirmCancel: (context) =>
      confirmNativeModApproval(f.inbox, context, {
        message: "Cancel run-one?",
        allowLabel: "取消工作流"
      }),
    cancel,
    settled: async () => {}
  })
  const first = provider.act!(f.context, "cancel", { runId })
  await vi.waitFor(() => expect(f.inbox.snapshot().current).not.toBeNull())
  f.decide("deny")
  expect(await first).toMatchObject({ requested: false, reason: "user-declined" })
  expect(cancel).not.toHaveBeenCalled()
  f.inbox.resume(f.inbox.snapshot().paused[0].id)
  const next = provider.act!(f.context, "cancel", { runId })
  await vi.waitFor(() => expect(f.inbox.snapshot().current).not.toBeNull())
  runId = "run-two"
  f.decide("allow")
  expect(await next).toMatchObject({ requested: false, reason: "not-active" })
  expect(cancel).not.toHaveBeenCalled()
})
