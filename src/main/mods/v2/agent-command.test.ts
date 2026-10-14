import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../runtime-instance"
import type { ModThreadBinding } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { withFunctionExecution, currentFunctionExecution } from "./execution-context"
import { functionCallAuthority, withFunctionAgentExecution } from "./host-call"
import { withFunctionCommandBinding } from "./command-binding"
import { withFunctionAgentCommand, type FunctionAgentCommandHost } from "./agent-command"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function fixture(leased = true) {
  const workspace = "/project"
  const threadId = randomUUID()
  const runId = randomUUID()
  const controller = new AbortController()
  const runtimes = new ModRuntimeAuthorities()
  let binding: ModThreadBinding | undefined
  if (leased) claimLocalThreadRunLease({ threadId, runId, owner: "mods" })
  cleanup.push(() => {
    runtimes.close()
    releaseLocalThreadRunLease(threadId, "mods", runId)
  })
  const manager: FunctionAgentCommandHost["manager"] = {
    needsCommandBinding: vi.fn(() => !binding || binding.commandOnly === true),
    functionUserScope: vi.fn(() =>
      binding?.runtimeAuthority
        ? { runtimeAuthority: binding.runtimeAuthority, turnId: binding.turnId, agentId: "main" }
        : {}
    ),
    createRuntimeAuthority: vi.fn((value) => runtimes.create(value, value.signal)),
    bindThread: vi.fn((value) => {
      binding = value
      return () => {
        if (binding === value) binding = undefined
      }
    })
  }
  const host: FunctionAgentCommandHost = {
    manager,
    assertLive: vi.fn(),
    assertStandalone: vi.fn()
  }
  const scope = { workspace, threadId, leased: true, immediate: false, userInitiated: true }
  const execute = <T>(run: () => Promise<T>) =>
    withFunctionAgentCommand(host, workspace, threadId, controller.signal, run)
  return {
    host,
    scope,
    controller,
    runtimes,
    runId,
    execute,
    binding: () => binding,
    replace: (value: ModThreadBinding) => {
      binding = value
    }
  }
}

it("creates only a temporary host owner and leaves the independently owned child result alive", async () => {
  const f = fixture()
  const child = Promise.withResolvers<string>()
  let authority: ModRuntimeAuthority | undefined
  const result = await withFunctionExecution(f.scope, async () => {
    const value = await f.execute(async () => {
      authority = functionCallAuthority(f.scope.workspace, f.scope.threadId)
      expect(authority).toBeDefined()
      expect(f.binding()).toMatchObject({ commandOnly: true, runtimeAuthority: authority })
      expect(f.binding()?.invokeTool).toBeUndefined()
      await withFunctionAgentExecution(
        { ...f.scope, threadId: "independent-child", userInitiated: false, leased: false },
        async () => {
          expect(currentFunctionExecution()?.threadId).toBe("independent-child")
        }
      )
      return { completion: child.promise }
    })
    expect(currentFunctionExecution()?.runtimeAuthority).toBeUndefined()
    return value
  })
  expect(f.binding()).toBeUndefined()
  expect(() => authority!.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  child.resolve("child completed after creator")
  expect(await result.completion).toBe("child completed after creator")
})

it.each([{ userInitiated: false }, { immediate: true }, { leased: false }, { agentId: "child" }])(
  "refuses a cold non-command scope: %j",
  async (override) => {
    const f = fixture()
    const run = vi.fn()
    await expect(
      withFunctionExecution({ ...f.scope, ...override }, () => f.execute(run))
    ).rejects.toThrow("MODS_AGENT_COMMAND_SCOPE_REQUIRED")
    expect(f.host.manager.createRuntimeAuthority).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  }
)

it("refuses background calls without an execution scope", async () => {
  const f = fixture()
  await expect(f.execute(async () => 1)).rejects.toThrow("MODS_AGENT_COMMAND_SCOPE_REQUIRED")
  expect(f.host.manager.createRuntimeAuthority).not.toHaveBeenCalled()
})

it("requires a physical command lease, not merely the leased flag", async () => {
  const f = fixture(false)
  await expect(withFunctionExecution(f.scope, () => f.execute(async () => 1))).rejects.toThrow(
    "MODS_FS_WRITE_LEASE"
  )
})

it("does not revive an old scope by capturing a replacement physical lease", async () => {
  const f = fixture()
  const replacement = randomUUID()
  cleanup.push(() => {
    releaseLocalThreadRunLease(f.scope.threadId, "mods", replacement)
  })
  await withFunctionExecution(f.scope, async () => {
    releaseLocalThreadRunLease(f.scope.threadId, "mods", f.runId)
    claimLocalThreadRunLease({ threadId: f.scope.threadId, owner: "mods", runId: replacement })
    await expect(f.execute(async () => 1)).rejects.toThrow("MODS_FS_WRITE_LEASE")
  })
  expect(f.host.manager.createRuntimeAuthority).not.toHaveBeenCalled()
})

it("retains an existing caller authority without creating or replacing any binding", async () => {
  const f = fixture(false)
  const instance = f.runtimes.create({ ...f.scope, turnId: "existing", agentId: "worker" })
  const value = await withFunctionExecution(
    {
      ...f.scope,
      leased: false,
      userInitiated: false,
      agentId: "worker",
      turnId: "existing",
      runtimeAuthority: instance.authority
    },
    () => f.execute(async () => functionCallAuthority(f.scope.workspace, f.scope.threadId))
  )
  expect(value).toBe(instance.authority)
  expect(f.host.manager.createRuntimeAuthority).not.toHaveBeenCalled()
  expect(f.host.assertStandalone).not.toHaveBeenCalled()
})

it("rechecks for a new main runtime after waiting for the shared native binding lock", async () => {
  const f = fixture()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const holder = withFunctionExecution(f.scope, () =>
    withFunctionCommandBinding(
      "native",
      f.scope.workspace,
      f.scope.threadId,
      f.controller.signal,
      async () => () => {},
      async () => {
        ready.resolve()
        await release.promise
      }
    )
  )
  await ready.promise
  const queued = withFunctionExecution(f.scope, () => f.execute(async () => 1))
  const rejected = expect(queued).rejects.toThrow("MODS_AGENT_COMMAND_RUNTIME_CHANGED")
  const main = f.runtimes.create({ ...f.scope, turnId: "new-main", agentId: "main" })
  f.replace({ ...f.scope, turnId: "new-main", runtimeAuthority: main.authority })
  release.resolve()
  await holder
  await rejected
  expect(f.host.manager.createRuntimeAuthority).not.toHaveBeenCalled()
  expect(f.binding()?.runtimeAuthority).toBe(main.authority)
  main.authority.assertLive()
})

it("checks host revocation and releases an owner after a failed run", async () => {
  const f = fixture()
  let authority: ModRuntimeAuthority | undefined
  await expect(
    withFunctionExecution(f.scope, () =>
      f.execute(async () => {
        authority = functionCallAuthority(f.scope.workspace, f.scope.threadId)
        throw Error("failure")
      })
    )
  ).rejects.toThrow("failure")
  expect(f.binding()).toBeUndefined()
  expect(() => authority!.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  vi.mocked(f.host.assertLive).mockImplementation(() => {
    throw Error("grant-revoked")
  })
  await expect(withFunctionExecution(f.scope, () => f.execute(async () => 1))).rejects.toThrow(
    "grant-revoked"
  )
  expect(f.host.manager.createRuntimeAuthority).toHaveBeenCalledOnce()
})

it("releases the authority when adapter binding fails", async () => {
  const f = fixture()
  vi.mocked(f.host.manager.bindThread).mockImplementation(() => {
    throw Error("binding-failed")
  })
  await expect(withFunctionExecution(f.scope, () => f.execute(async () => 1))).rejects.toThrow(
    "binding-failed"
  )
  expect(f.runtimes.get(f.scope)).toBeUndefined()
})
