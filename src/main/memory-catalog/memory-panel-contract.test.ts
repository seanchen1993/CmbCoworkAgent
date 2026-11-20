import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

function source(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf-8")
}

describe("MemoryPanel isolation contract", () => {
  it("does not perform the old listFiles plus getStats double scan on mount", () => {
    const panel = source("../../renderer/src/components/customize/MemoryPanel.tsx")
    expect(panel).toContain("window.api.memory.listFiles")
    expect(panel).not.toContain("window.api.memory.getStats")
    expect(panel).toContain("boundMemoryRenderWindow(page.items)")
    expect(panel).toContain("cancelCatalog(FILES_REQUEST_SCOPE)")
    expect(panel).toContain("cancelCatalog(FILE_DETAIL_REQUEST_SCOPE)")
  })

  it("keeps MemoryStore and synchronous Git outside catalog handlers", () => {
    const ipc = source("../ipc/memory.ts")
    const listFilesHandler = ipc.slice(
      ipc.indexOf('"memory:listFiles"'),
      ipc.indexOf('"memory:readFile"')
    )
    expect(listFilesHandler).not.toContain("getMemoryStore")
    expect(listFilesHandler).not.toContain("isMemoryEnabled")
    expect(listFilesHandler).not.toMatch(/readdirSync|readFileSync|statSync/)

    const paths = source("../memory/paths.ts")
    expect(paths).not.toContain("execFileSync")
  })
})
