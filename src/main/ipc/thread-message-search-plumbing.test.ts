import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

describe("thread message search IPC plumbing", () => {
  it("exposes the bounded database search without replacing legacy transcript APIs", () => {
    const handlers = readFileSync(new URL("./threads.ts", import.meta.url), "utf8")
    const preload = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8")
    const declarations = readFileSync(
      new URL("../../preload/index.d.ts", import.meta.url),
      "utf8"
    )

    expect(handlers).toContain('ipcMain.handle("threads:messages"')
    expect(handlers).toContain('"threads:messages-page"')
    expect(handlers).toContain('"threads:search-messages"')
    expect(handlers).toMatch(/threads:search-messages[\s\S]*searchThreadMessages\(threadId, query, options\)/)

    expect(preload).toMatch(/searchMessages:[\s\S]*threads:search-messages/)
    expect(declarations).toMatch(/searchMessages:[\s\S]*Promise<ThreadMessageSearchPage>/)
  })
})
