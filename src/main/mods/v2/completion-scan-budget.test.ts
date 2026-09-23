import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { captureCompletionBinding } from "./completion-evidence"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "mods-scan-budget-"))
  roots.push(workspace)
  return { workspace, threadId: "thread", turnId: "turn", runtimeGeneration: 1, pluginDigests: {} }
}

it("bounds empty directory forests before granting completion evidence", async () => {
  const input = await fixture()
  for (let base = 0; base < 8192; base += 64)
    await Promise.all(
      Array.from({ length: 64 }, (_, index) => mkdir(join(input.workspace, `dir-${base + index}`)))
    )
  await expect(captureCompletionBinding(input)).rejects.toThrow("COMPLETION_EVIDENCE_ENTRY_LIMIT")
}, 30000)

it("does not charge overlapping scopes repeatedly or change their file fingerprints", async () => {
  const input = await fixture()
  await mkdir(join(input.workspace, "src"))
  await writeFile(join(input.workspace, "src", "index.ts"), "export const version = 1")
  const baseline = await captureCompletionBinding(input)
  const repeated = await captureCompletionBinding({
    ...input,
    paths: Array.from({ length: 9000 }, (_, index) => (index % 2 ? "src" : "."))
  })
  expect(repeated).toEqual(baseline)
}, 30000)

it("still captures an explicitly requested directory that an earlier broad scan excluded", async () => {
  const input = await fixture()
  await mkdir(join(input.workspace, "build"))
  await writeFile(join(input.workspace, "build", "artifact.txt"), "artifact")
  const binding = await captureCompletionBinding({ ...input, paths: [".", "build"] })
  expect(binding.files).toContainEqual(expect.objectContaining({ path: "build/artifact.txt" }))
})
