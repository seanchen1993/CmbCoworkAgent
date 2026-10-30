import { expect, it, vi } from "vitest"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { mayBeModCommand, resolveModSubmission } from "./mod-submission"

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
