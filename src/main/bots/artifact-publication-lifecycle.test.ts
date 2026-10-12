import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-file-publication-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const files = new BotArtifacts(directory, store)
  cleanup.push(() => files.close())
  const { conversationId } = store.createBot({ nonce: "bot", name: "File owner" })
  // Complete the startup inventory before any failure. Reopening is not needed
  // to discover files created by a failed publication during the Host's lifetime.
  await files.recover()
  const bytes = Buffer.from("verified immutable evidence")
  const hash = createHash("sha256").update(bytes).digest("hex")
  const input = {
    id: "publication",
    conversationId,
    runId: null,
    name: "evidence.txt",
    mime: "text/plain"
  }
  return { directory, store, files, conversationId, bytes, hash, input }
}

it("reclaims bytes renamed before the task lease is revoked, without reopening the service", async () => {
  const f = await fixture()
  f.store.send({ nonce: "task", conversationId: f.conversationId, text: "Save evidence" })
  const { run, lease } = f.store.claim("host", 300_000)!
  await expect(
    f.files.publish({ ...f.input, runId: run.id }, f.bytes, lease, () => {
      f.store.fenceOwner(lease.owner, "Revoked before publication")
    })
  ).rejects.toMatchObject({ code: "stale_lease" })
  await f.files.collectDeleted()
  await expect(access(join(f.directory, f.hash))).rejects.toMatchObject({ code: "ENOENT" })
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect((await readdir(f.directory)).filter((name) => name.startsWith("pending-"))).toEqual([])
})

it.each(["buffer", "stream"] as const)(
  "reclaims a %s publication after database failure and permits an exact retry",
  async (kind) => {
    const f = await fixture()
    const source = join(f.directory, "staging.part")
    if (kind === "stream") await writeFile(source, f.bytes)
    const publish = () =>
      kind === "buffer"
        ? f.files.publish(f.input, f.bytes)
        : f.files.publishFromFile(f.input, source, f.bytes.length, f.hash)
    const failure = vi.spyOn(f.store, "publishArtifact").mockImplementation(() => {
      throw new Error("database unavailable")
    })
    await expect(publish()).rejects.toThrow("database unavailable")
    await f.files.collectDeleted()
    await expect(access(join(f.directory, f.hash))).rejects.toMatchObject({ code: "ENOENT" })
    expect(f.store.artifacts(f.conversationId)).toEqual([])
    failure.mockRestore()
    const artifact = await publish()
    await f.files.collectDeleted()
    expect((await f.files.read(artifact.id)).bytes).toEqual(f.bytes)
  }
)

it("preserves identical bytes already referenced by another Bot when a new publication fails", async () => {
  const f = await fixture()
  const other = f.store.createBot({ nonce: "other-bot", name: "Other owner" })
  const saved = await f.files.publish(
    { ...f.input, id: "other-reference", conversationId: other.conversationId },
    f.bytes
  )
  await expect(
    f.files.publish(f.input, f.bytes, undefined, () => {
      throw new Error("permission changed")
    })
  ).rejects.toThrow("permission changed")
  await f.files.collectDeleted()
  expect((await f.files.read(saved.id)).bytes).toEqual(f.bytes)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
})

it("preserves a concurrent same-hash publication while collecting the failed reference", async () => {
  const f = await fixture()
  const results = await Promise.allSettled([
    f.files.publish({ ...f.input, id: "failed" }, f.bytes, undefined, () => {
      throw new Error("approval revoked")
    }),
    f.files.publish({ ...f.input, id: "successful" }, f.bytes)
  ])
  expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "approval revoked" } })
  expect(results[1]).toMatchObject({ status: "fulfilled" })
  await f.files.collectDeleted()
  expect((await f.files.read("successful")).bytes).toEqual(f.bytes)
  expect(f.store.artifacts(f.conversationId).map((artifact) => artifact.id)).toEqual(["successful"])
  expect((await readdir(f.directory)).filter((name) => name === f.hash)).toHaveLength(1)
})

it("keeps a published object when the durable commit succeeds but its acknowledgement fails", async () => {
  const f = await fixture()
  const publish = f.store.publishArtifact.bind(f.store)
  vi.spyOn(f.store, "publishArtifact").mockImplementation((...args) => {
    publish(...args)
    throw new Error("acknowledgement failed")
  })
  await expect(f.files.publish(f.input, f.bytes)).rejects.toThrow("acknowledgement failed")
  await f.files.collectDeleted()
  expect((await f.files.read(f.input.id)).bytes).toEqual(f.bytes)
})

it("retains a failed publication for a later cleanup attempt without replacing its original error", async () => {
  const f = await fixture()
  const unavailable = vi.spyOn(f.store, "artifactContentReferenced").mockImplementation(() => {
    throw new Error("cleanup temporarily unavailable")
  })
  await expect(
    f.files.publish(f.input, f.bytes, undefined, () => {
      throw new Error("original publication failure")
    })
  ).rejects.toThrow("original publication failure")
  unavailable.mockRestore()
  await f.files.collectDeleted()
  await expect(access(join(f.directory, f.hash))).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not register an unrelated destination as garbage when the rename itself fails", async () => {
  const f = await fixture()
  const unrelated = join(f.directory, f.hash)
  await mkdir(unrelated)
  await writeFile(join(unrelated, "keep.txt"), "unmanaged nested file")
  const reference = vi.spyOn(f.store, "artifactContentReferenced")
  const commit = vi.spyOn(f.store, "publishArtifact")
  await expect(f.files.publish(f.input, f.bytes)).rejects.toThrow()
  await f.files.collectDeleted()
  expect(reference).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
  expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("unmanaged nested file")
  expect((await readdir(f.directory)).filter((name) => name.startsWith("pending-"))).toEqual([])
})
