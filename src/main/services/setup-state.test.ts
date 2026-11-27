import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { hasWorkspaceBeenInitialised, markWorkspaceInitialised } from "./setup-state"

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})
afterEach(() => vi.clearAllMocks())

it("stops waiting for the marker when the caller cancels", async () => {
  const pending = Promise.withResolvers<string>()
  vi.mocked(readFile).mockReturnValueOnce(pending.promise)
  const stop = new AbortController()
  const read = hasWorkspaceBeenInitialised("/workspace", stop.signal)
  stop.abort()
  expect(readFile).toHaveBeenCalledOnce()
  await expect(read).resolves.toBe(false)
  pending.resolve('{"initialisedAt":"later"}')
})

it("repairs a corrupt marker in place and keeps it valid during concurrent retries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cmb-marker-"))
  try {
    const dir = join(workspace, ".cmbdevclaw")
    const file = join(dir, "setup-state.json")
    await mkdir(dir)
    await writeFile(file, "?".repeat(200))
    if (process.platform !== "win32") await chmod(file, 0o640)
    const previous = await stat(file)
    await Promise.all(Array.from({ length: 8 }, () => markWorkspaceInitialised(workspace)))
    const marker = await readFile(file, "utf8")
    expect(JSON.parse(marker).initialisedAt).toEqual(expect.any(String))
    for (let i = 0; i < 25; i++) {
      const [, ...reads] = await Promise.all([
        markWorkspaceInitialised(workspace),
        ...Array.from({ length: 8 }, () => hasWorkspaceBeenInitialised(workspace))
      ])
      expect(reads).toEqual(Array(8).fill(true))
    }
    expect(await readFile(file, "utf8")).toBe(marker)
    const after = await stat(file)
    expect(after.ino).toBe(previous.ino)
    expect(after.mode).toBe(previous.mode)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
