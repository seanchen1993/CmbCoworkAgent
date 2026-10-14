import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProjectLibrary, projectDeliveryDestination } from "./project-library"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture, prepareFixture, TEST_FINGERPRINT } from "./host-fixtures.test-helper"
import { validateHostStage } from "./host-validators"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
)
function fixture(upload?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "project-library-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HostProjectStore(join(root, "state.sqlite"))
  cleanup.push(() => store.close())
  store.create(hostProjectFixture(root))
  writeFileSync(join(root, "document.md"), "# First checked deliverable\n")
  const operation = store.prepare(prepareFixture())
  const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
  const state = store.get("local-docs")!
  store.recordResult(ticket, { outcome: "succeeded", receipts: validateHostStage(state, ticket) })
  const path = join(root, "library.sqlite")
  const library = new ProjectLibrary(path, upload)
  cleanup.push(() => library.close())
  const capture = (kind: "knowledge" | "delivery" = "knowledge") =>
    library.capture(state, store.getOperation(operation.operationId)!, {
      kind,
      title: "Checked knowledge",
      note: "Only a reference"
    })
  return { root, store, state, library, path, capture }
}

describe("shared project knowledge and delivery", () => {
  it("captures only checked bytes and keeps independent reusable snapshots", () => {
    const f = fixture()
    const saved = f.capture()
    const copy = f.library.reuse("local-docs", saved.id, "other-project")
    writeFileSync(join(f.root, "document.md"), "edited later")
    expect(() => f.capture()).toThrow("EVIDENCE_STALE")
    expect(f.library.read("local-docs", saved.id, "document.md").text).toContain("First checked")
    expect(f.library.knowledgeContext("other-project")).toContain("First checked")
    expect(f.library.knowledgeContext("unrelated-project")).toBe("")
    expect(() => f.library.read("other-project", saved.id, "document.md")).toThrow("NOT_FOUND")
    f.library.remove("local-docs", saved.id)
    expect(f.library.read("other-project", copy.id, "document.md").text).toContain("First checked")
    expect(f.store.get("local-docs")).toEqual(f.state)
  })
  it("rejects failed, cross-project and unchecked operations, caps knowledge prompt", () => {
    const f = fixture()
    const op = f.store.listOperations("local-docs")[0]
    for (const changed of [
      { ...op, status: "failed" as const },
      { ...op, projectId: "other" },
      { ...op, receipts: [] }
    ])
      expect(() =>
        f.library.capture(f.state, changed, { kind: "knowledge", title: "no", note: "" })
      ).toThrow()
    for (let i = 0; i < 4; i++)
      f.library.capture(f.state, op, {
        kind: "knowledge",
        title: `copy-${i}`,
        note: "x".repeat(4000)
      })
    expect(f.library.knowledgeContext("local-docs").length).toBeLessThanOrEqual(8010)
  })
  it("uploads real multipart to localhost and sends the catalog last, skips confirmed retries", async () => {
    const requests: string[] = []
    let rejectCatalog = true
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      requests.push(body)
      res.writeHead(body.includes("DEVCLAW_ARTIFACT_CATALOG.json") && rejectCatalog ? 500 : 200)
      res.end("ok")
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    cleanup.push(() => server.close())
    const address = server.address() as { port: number }
    const f = fixture()
    const saved = f.capture("delivery")
    const input = {
      endpoint: `http://127.0.0.1:${address.port}/upload`,
      remotePath: "P/DEV/Features/F"
    }
    const first = await f.library.send("local-docs", saved.id, input, () => {})
    expect(first.status).toBe("partial")
    expect(first.files[0].status).toBe("uploaded")
    expect(requests[0]).toContain('name="path"')
    expect(requests[0]).toContain('filename="document.md"')
    expect(requests[0]).toContain("P/DEV/Features/F")
    expect(requests[1]).toContain("DEVCLAW_ARTIFACT_CATALOG.json")
    rejectCatalog = false
    expect((await f.library.send("local-docs", saved.id, input, () => {})).status).toBe("sent")
    expect(requests).toHaveLength(3)
    await f.library.send("local-docs", saved.id, input, () => {})
    expect(requests).toHaveLength(3)
    expect(f.store.get("local-docs")).toEqual(f.state)
  })
  it("records dropped connections as unknown and requires an explicit retry", async () => {
    let calls = 0
    const f = fixture((async () => {
      calls++
      throw Error("connection dropped")
    }) as typeof fetch)
    const saved = f.capture("delivery")
    const result = await f.library.send(
      "local-docs",
      saved.id,
      { endpoint: "https://example.invalid/upload", remotePath: "P/F" },
      () => {}
    )
    expect(result.status).toBe("unknown")
    expect(result.files[0].status).toBe("unknown")
    expect(calls).toBe(1)
    expect(f.library.list("local-docs")[0].status).toBe("unknown")
    await expect(
      f.library.send(
        "local-docs",
        saved.id,
        { endpoint: "https://changed.invalid/upload", remotePath: "P/F" },
        () => {}
      )
    ).rejects.toThrow("DESTINATION_CHANGED")
    expect(calls).toBe(1)
  })
  it("rechecks authorization before dispatch and cannot send knowledge", async () => {
    let calls = 0
    const f = fixture((async () => {
      calls++
      return new Response("ok")
    }) as typeof fetch)
    const input = { endpoint: "https://example.invalid/upload", remotePath: "P/F" }
    await expect(f.library.send("local-docs", f.capture().id, input, () => {})).rejects.toThrow(
      "DELIVERY_REQUIRED"
    )
    await expect(
      f.library.send("local-docs", f.capture("delivery").id, input, () => {
        throw Error("revoked")
      })
    ).rejects.toThrow("revoked")
    expect(calls).toBe(0)
  })
  it("retains unknown catalog outcome and releases in-memory ownership after storage failure", async () => {
    let calls = 0
    const f = fixture((async () => {
      if (++calls === 2) throw Error("catalog response lost")
      return new Response("ok", { status: 200 })
    }) as typeof fetch)
    const saved = f.capture("delivery")
    const input = { endpoint: "https://example.invalid/upload", remotePath: "P/F" }
    const result = await f.library.send("local-docs", saved.id, input, () => {})
    expect(result.status).toBe("unknown")
    expect(result.catalogStatus).toBe("unknown")
    expect(result.files[0].status).toBe("uploaded")
    expect((await f.library.send("local-docs", saved.id, input, () => {})).status).toBe("sent")
    expect(calls).toBe(3)
    const next = f.capture("delivery")
    const save = vi.spyOn(f.library as unknown as { save: (entry: unknown) => void }, "save")
    save.mockImplementationOnce(() => {
      throw Error("SQLITE_BUSY")
    })
    const failed = await f.library.send("local-docs", next.id, input, () => {})
    expect(failed.status).toBe("partial")
    save.mockRestore()
    expect((await f.library.send("local-docs", next.id, input, () => {})).status).toBe("sent")
  })
  it("rejects sensitive paths before opening a file", () => {
    const f = fixture()
    f.state.manifest.artifacts[0].path = ".env.production"
    expect(() => f.capture()).toThrow("SENSITIVE_PATH")
  })
  it("rejects unsafe destinations without fetching", () => {
    for (const endpoint of [
      "http://remote.example/upload",
      "file:///tmp",
      "https://user:pass@site/upload",
      "https://site/upload?token=secret",
      "https://site/upload#x"
    ])
      expect(() => projectDeliveryDestination(endpoint, "P/F")).toThrow()
    for (const path of ["../etc", "C:/temp", "a\\b", "/absolute", "CON/file"])
      expect(() => projectDeliveryDestination("https://site/upload", path)).toThrow()
  })
})
