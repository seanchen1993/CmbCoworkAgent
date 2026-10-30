import { expect, it } from "vitest"
import { assertModRuntimeAuthority, ModRuntimeAuthorities } from "./runtime-instance"

const scope = { workspace: "project", threadId: "thread", turnId: "turn" }

it("expires a same-agent same-turn predecessor without letting its disposer revoke the replacement", () => {
  const registry = new ModRuntimeAuthorities()
  const first = registry.create(scope)
  const next = registry.create(scope)
  expect(() => first.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  first.release()
  expect(registry.get(scope)).toBe(next.authority)
  assertModRuntimeAuthority(next.authority, scope)
  expect(() => assertModRuntimeAuthority(next.authority, { ...scope, agentId: "child" })).toThrow(
    "MODS_RUNTIME_SCOPE_CHANGED"
  )
  next.release()
  expect(registry.get(scope)).toBeUndefined()
})

it("revokes descendants on parent replacement and rejects a foreign parent", () => {
  const registry = new ModRuntimeAuthorities()
  const parent = registry.create(scope)
  const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority, "task")
  const grandchild = registry.create(
    { ...scope, agentId: "grandchild" },
    undefined,
    child.authority
  )
  expect(() => registry.create(scope, undefined, grandchild.authority)).toThrow(
    "MODS_RUNTIME_SCOPE_CHANGED"
  )
  parent.authority.assertLive()
  expect(child.authority.parentCallId).toBe("task")
  registry.create(scope)
  expect(() => child.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => grandchild.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  const foreign = new ModRuntimeAuthorities().create(scope)
  expect(() =>
    registry.create({ ...scope, agentId: "child" }, undefined, foreign.authority)
  ).toThrow("MODS_RUNTIME_SCOPE_CHANGED")
})

it("bounds live authority entries without evicting an unrelated active runtime", () => {
  const registry = new ModRuntimeAuthorities()
  const first = registry.create(scope)
  for (let index = 1; index < 100; index++)
    registry.create({ ...scope, threadId: `thread-${index}` })
  expect(() => registry.create({ ...scope, threadId: "overflow" })).toThrow("MODS_RUNTIME_CAPACITY")
  first.authority.assertLive()
  registry.close()
})

it("closes scopes on abort, thread close and application close without crossing projects", () => {
  const registry = new ModRuntimeAuthorities(),
    controller = new AbortController()
  const first = registry.create(scope, controller.signal)
  const other = registry.create({ ...scope, workspace: "other", threadId: "other" })
  controller.abort()
  expect(() => first.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(registry.get(scope)).toBeUndefined()
  const second = registry.create(scope)
  registry.closeThread(scope.threadId)
  expect(() => second.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  other.authority.assertLive()
  registry.close()
  expect(() => other.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => registry.create(scope)).toThrow("MODS_RUNTIME_CLOSED")
})
