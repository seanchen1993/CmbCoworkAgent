import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { HookResult } from "../hooks/types"
vi.mock("../mods/manager", async (original) => ({
  ...await original<typeof import("../mods/manager")>(), getModsManager: () => null
}))
import { LocalSandbox } from "./local-sandbox"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("real sandbox writes retain actual path and bytes while read output can be replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "classic-output-native-"))
  roots.push(root)
  const sandbox = new LocalSandbox({rootDir:root,runId:"thread",windowsSandbox:"none"})
  const runHooks = vi.spyOn(sandbox as unknown as { runHooks(event: string): Promise<HookResult | null> }, "runHooks")
  runHooks.mockImplementation(async (event) => event === "PostToolUse" ? {
    exitCode:0,stdout:"",stderr:"",blocked:false,updatedToolOutput:"replacement"
  } : null)
  const path = join(root,"actual.txt")
  const written = await sandbox.write(path,"real bytes")
  expect(written.error).toBeUndefined()
  expect(written.path).toBe(path)
  expect(await readFile(path,"utf8")).toBe("real bytes")
  expect(await sandbox.read(path)).toBe("replacement")
  runHooks.mockResolvedValue(null)
  expect(await sandbox.read(path)).toContain("real bytes")
})
