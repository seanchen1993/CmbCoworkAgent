import { createHash } from "node:crypto"
import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it as test, vi } from "vitest"
import { AutobizStateJournal } from "./autobiz-state-journal"
import { inspectAutobizRecovery } from "./autobiz-recovery"
import * as stableFiles from "../../services/stable-file-handle"

const host = vi.hoisted(() => ({ root: "" }))
const it = test.runIf(process.platform === "win32")
vi.mock("../../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => host.root }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-recovery-"))
  roots.push(root)
  host.root = join(root, "host")
  const workspace = join(root, "project")
  await mkdir(join(workspace, ".autobizdevops"), { recursive: true })
  const files = ["state.json", "STATE.md"].map((name) => join(workspace, ".autobizdevops", name))
  const before: [string, string] = ['{"checkpoint":"before"}', "# before"]
  const after: [string, string] = ['{"checkpoint":"after"}', "# after"]
  await Promise.all(files.map((file, index) => writeFile(file, before[index])))
  const journal = new AutobizStateJournal(workspace, "identity", "key")
  const operationId = journal.operationId
  journal.begin({
    before: before.map(hash) as [string, string],
    after: after.map(hash) as [string, string],
    identities: ["one", "two"],
    beforeContent: before.map((text) => Buffer.from(text).toString("base64")) as [string, string],
    afterContent: after.map((text) => Buffer.from(text).toString("base64")) as [string, string]
  })
  journal.unknown()
  journal.close()
  return { workspace, files, before, after, operationId }
}

it.each(["before", "after", "mixed", "changed"] as const)(
  "inspects %s bytes after reopening the host journal without accepting or replaying a commit",
  async (state) => {
    const f = await fixture()
    const contents =
      state === "before"
        ? f.before
        : state === "after"
          ? f.after
          : state === "mixed"
            ? [f.after[0], f.before[1]]
            : ["external", f.before[1]]
    await Promise.all(f.files.map((file, index) => writeFile(file, contents[index])))
    const result = await inspectAutobizRecovery(f.workspace, f.operationId, () => {})
    expect(result).toMatchObject({ operationId: f.operationId, journalStatus: "unknown", state })
    expect(JSON.stringify(result)).not.toContain("checkpoint")
    expect(await Promise.all(f.files.map((file) => readFile(file, "utf8")))).toEqual(contents)
    const journal = new AutobizStateJournal(f.workspace, "identity", "key")
    try {
      expect(() => journal.receipt()).toThrow("AUTOBIZ_COMMIT_UNKNOWN")
    } finally {
      journal.close()
    }
  }
)

it("rejects foreign operation IDs and workspaces without exposing journal contents", async () => {
  const f = await fixture()
  await expect(inspectAutobizRecovery(f.workspace, "../journal", () => {})).rejects.toThrow(
    "AUTOBIZ_RECOVERY_ID"
  )
  await expect(inspectAutobizRecovery(f.workspace, "a".repeat(64), () => {})).rejects.toThrow(
    "AUTOBIZ_RECOVERY_MISSING"
  )
  const other = join(f.workspace, "other")
  await mkdir(other)
  await expect(inspectAutobizRecovery(other, f.operationId, () => {})).rejects.toThrow(
    "AUTOBIZ_RECOVERY_MISSING"
  )
})

it("does not create a new journal or data directory when inspecting missing host evidence", async () => {
  const f = await fixture()
  host.root = join(host.root, "not-created")
  await expect(inspectAutobizRecovery(f.workspace, f.operationId, () => {})).rejects.toThrow(
    "AUTOBIZ_RECOVERY_MISSING"
  )
  await expect(access(host.root)).rejects.toThrow()
})

it("reports missing, linked and oversized state files as unavailable", async () => {
  const f = await fixture()
  await rm(f.files[0])
  expect((await inspectAutobizRecovery(f.workspace, f.operationId, () => {})).state).toBe(
    "unavailable"
  )
  const external = join(host.root, "outside.txt")
  await writeFile(external, f.before[0])
  await link(external, f.files[0])
  expect((await inspectAutobizRecovery(f.workspace, f.operationId, () => {})).state).toBe(
    "unavailable"
  )
  await rm(f.files[0])
  await writeFile(f.files[0], "x".repeat(262145))
  expect((await inspectAutobizRecovery(f.workspace, f.operationId, () => {})).state).toBe(
    "unavailable"
  )
})

it("rejects a cancelled or invalidated inspection instead of returning its snapshot", async () => {
  const f = await fixture()
  let checks = 0
  await expect(
    inspectAutobizRecovery(f.workspace, f.operationId, () => {
      if (++checks > 1) throw Error("MODS_SCOPE_CHANGED")
    })
  ).rejects.toThrow("MODS_SCOPE_CHANGED")
})

it("does not report a mixed-time snapshot if a file changes while reading the pair", async () => {
  const f = await fixture()
  const original = stableFiles.readStableFileHandleBounded
  let reads = 0
  vi.spyOn(stableFiles, "readStableFileHandleBounded").mockImplementation(async (...args) => {
    const result = await original(...args)
    if (++reads === 2) await writeFile(f.files[0], "concurrent modification")
    return result
  })
  const result = await inspectAutobizRecovery(f.workspace, f.operationId, () => {})
  expect(result.state).toBe("unavailable")
  expect(result.files.every((file) => file.current === undefined)).toBe(true)
})
