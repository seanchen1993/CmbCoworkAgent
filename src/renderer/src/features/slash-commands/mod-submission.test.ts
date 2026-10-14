import { expect, it, vi } from "vitest"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { mayBeModCommand, resolveModSubmission, resolveScopedModSubmission } from "./mod-submission"

const command: ModCommandDescriptor = {
  apiVersion: "cmb.mods/v2",
  modId: "function:demo",
  name: "Demo",
  command: "demo",
  digest: "new-snapshot",
  grantEpoch: 2,
  workspaceEpoch: 1,
  turnId: "functions:t"
}

it("waits for the cold host registry before deciding a slash command is ordinary chat", async () => {
  let resolve!: (commands: ModCommandDescriptor[]) => void
  const load = vi.fn(
    () =>
      new Promise<ModCommandDescriptor[]>((r) => {
        resolve = r
      })
  )
  let settled = false
  const pending = resolveModSubmission("/demo one\ntwo", load).then((result) => {
    settled = true
    return result
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  resolve([command])
  expect(await pending).toEqual({ descriptor: command, args: { text: "one\ntwo" } })
})

it("keeps native commands and plain messages independent, and refuses unresolved legacy commands", async () => {
  const load = vi.fn(async () => [command])
  for (const text of ["hello", "/goal continue", "/browser docs", "/tmp/file"])
    expect(await resolveModSubmission(text, load)).toBeNull()
  expect(load).not.toHaveBeenCalled()
  expect(mayBeModCommand("/demo args")).toBe(true)
  await expect(resolveModSubmission("/mod missing {}", load)).rejects.toThrow("尚未授权")
  expect(await resolveModSubmission("/not-registered args", load)).toBeNull()
  await expect(
    resolveModSubmission("/demo", async () => {
      throw Error("host unavailable")
    })
  ).rejects.toThrow("host unavailable")
})

it("waits for fresh enablement and directory despite an initially disabled UI snapshot", async () => {
  const enabled = Promise.withResolvers<boolean>()
  const registry = Promise.withResolvers<ModCommandDescriptor[]>()
  const load = vi.fn(() => registry.promise)
  const assertCurrent = vi.fn()
  let settled = false
  const pending = resolveScopedModSubmission("/demo first", {
    enabled: () => enabled.promise,
    load,
    assertCurrent
  }).then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  expect(load).not.toHaveBeenCalled()
  expect(settled).toBe(false)
  enabled.resolve(true)
  await Promise.resolve()
  expect(load).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  registry.resolve([command])
  expect(await pending).toEqual({ descriptor: command, args: { text: "first" } })
  expect(assertCurrent).toHaveBeenCalledTimes(3)
})

it("does not fall back on scope change or unavailable host facts", async () => {
  for (const boundary of ["enabled", "catalog"] as const) {
    let current = true
    await expect(
      resolveScopedModSubmission("/unknown text", {
        enabled: async () => {
          if (boundary === "enabled") current = false
          return true
        },
        load: async () => {
          current = false
          return []
        },
        assertCurrent: () => {
          if (!current) throw Error("scope changed")
        }
      })
    ).rejects.toThrow("scope changed")
  }
  for (const boundary of ["enabled", "catalog"] as const) {
    await expect(
      resolveScopedModSubmission("/demo", {
        enabled: async () => {
          if (boundary === "enabled") throw Error("host unavailable")
          return true
        },
        load: async () => {
          throw Error("host unavailable")
        },
        assertCurrent: () => {}
      })
    ).rejects.toThrow("host unavailable")
  }
})

it("preserves disabled and confirmed unknown slash text and native command behavior", async () => {
  const enabled = vi.fn(async () => false),
    load = vi.fn(async () => [])
  const scope = { enabled, load, assertCurrent: () => {} }
  expect(await resolveScopedModSubmission("/demo arg", scope)).toBeNull()
  expect(load).not.toHaveBeenCalled()
  enabled.mockResolvedValue(true)
  expect(await resolveScopedModSubmission("/unknown arg", scope)).toBeNull()
  expect(load).toHaveBeenCalledOnce()
  enabled.mockClear()
  for (const text of ["hello", "/goal resume", "/browser docs", "/tmp/file"])
    expect(await resolveScopedModSubmission(text, scope)).toBeNull()
  expect(enabled).not.toHaveBeenCalled()
})
