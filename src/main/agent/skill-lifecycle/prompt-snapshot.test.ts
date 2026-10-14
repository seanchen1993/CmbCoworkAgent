import { expect, it, vi } from "vitest"
import { SkillPromptSnapshots } from "./prompt-snapshot"

it("expands the complete prompt once for concurrent and subsequent pages", async () => {
  const snapshots = new SkillPromptSnapshots()
  const render = vi.fn(async (text: string) => `INTRO\n${text}\nTAIL`)
  const read = () => snapshots.expand("source", "first\nsecond", render, () => {})
  const [a, b] = await Promise.all([read(), read()])
  expect(a.split("\n").slice(0, 2)).toEqual(["INTRO", "first"])
  expect(b.split("\n").slice(2)).toEqual(["second", "TAIL"])
  expect(await read()).toBe(a)
  expect(render).toHaveBeenCalledOnce()
})

it("rejects a changed source rather than combining old and new pages", async () => {
  const snapshots = new SkillPromptSnapshots()
  await snapshots.expand(
    "source",
    "old",
    async (text) => text,
    () => {}
  )
  await expect(
    snapshots.expand(
      "source",
      "new",
      async (text) => text,
      () => {}
    )
  ).rejects.toThrow("MODS_SKILL_SOURCE_CHANGED")
})

it("rejects recursive expansion instead of waiting on its own unfinished prompt", async () => {
  const snapshots = new SkillPromptSnapshots()
  await expect(
    snapshots.expand(
      "source",
      "raw",
      () =>
        snapshots.expand(
          "source",
          "raw",
          async (text) => text,
          () => {}
        ),
      () => {}
    )
  ).rejects.toThrow("MODS_SKILL_PROMPT_REENTRANT")
})

it("does not fall back to raw text after failure or publish after cancellation", async () => {
  const snapshots = new SkillPromptSnapshots()
  const failed = vi.fn(async () => {
    throw Error("denied")
  })
  for (let i = 0; i < 2; i++)
    await expect(snapshots.expand("source", "secret", failed, () => {})).rejects.toThrow("denied")
  expect(failed).toHaveBeenCalledOnce()
  let live = true
  await expect(
    snapshots.expand(
      "other",
      "raw",
      async () => {
        live = false
        return "new"
      },
      () => {
        if (!live) throw Error("revoked")
      }
    )
  ).rejects.toThrow("revoked")
})
