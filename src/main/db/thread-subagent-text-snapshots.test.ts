import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
const paths = vi.hoisted(() => ({ db: "", content: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.db,
  getSubagentTranscriptContentDir: () => paths.content,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "./index"
import {
  compactSubagentTranscriptManifests,
  hydrateSubagentTranscriptManifests
} from "../services/subagent-transcript-content-store"
async function compact(input: Record<string, unknown>) {
  const result = await compactSubagentTranscriptManifests(input)
  expect(Array.isArray(result.manifests.worker)).toBe(true)
  return { ...result, manifests: result.manifests as { worker: Record<string, unknown>[] } }
}

async function hydrate(input: Record<string, unknown>) {
  const result = await hydrateSubagentTranscriptManifests(input)
  expect(Array.isArray(result.worker)).toBe(true)
  return result as { worker: Record<string, unknown>[] }
}

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "snapshot-db-"))
  paths.db = join(directory, "db.sqlite")
  paths.content = join(directory, "content")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
for (const replacement of ["", "short"]) {
  for (const field of ["content", "reasoning"] as const) {
    it(`replaces ${field} with ${JSON.stringify(replacement)} and preserves the other journal`, async () => {
      const id = `snapshot-${field}-${replacement}`
      db.createThread(id)
      const base = (
        await compact({
          worker: [
            {
              id: "a",
              role: "assistant",
              content: "body",
              reasoning: "thought",
              subagent_live_text_bootstrap: true
            }
          ]
        })
      ).manifests.worker[0] as Record<string, unknown>
      db.upsertThreadSubagentManifestMessages(id, "worker", [base])
      const deltas = Object.fromEntries(
        (["content", "reasoning"] as const).map((key) => [
          key,
          {
            v: 1,
            baseRefSha256: (base[`${key}_ref`] as { sha256: string }).sha256,
            baseLength: base[`${key}_full_length`],
            targetLength: Number(base[`${key}_full_length`]) + 1,
            delta: "!"
          }
        ])
      )
      expect(
        db.appendThreadSubagentManifestTextDeltas(id, "worker", {
          ...base,
          subagent_text_deltas: deltas
        })
      ).toBeDefined()
      const incoming = (
        await compact({
          worker: [
            {
              id: "a",
              role: "assistant",
              [field]: replacement,
              subagent_text_snapshots: [field],
              subagent_preserve_text_journal: true
            }
          ]
        })
      ).manifests.worker[0]
      expect(
        db.patchThreadSubagentManifestPreservingTextJournal(id, "worker", incoming)
      ).toBeDefined()
      const page = db.getThreadSubagentManifestPage(id, "worker", undefined, 10)
      const full = (await hydrate({ worker: page.messages })).worker[0] as Record<string, unknown>
      expect(full[field]).toBe(replacement)
      const other = field === "content" ? "reasoning" : "content"
      expect(full[other]).toBe(other === "content" ? "body!" : "thought!")
      expect((page.messages[0] as Record<string, unknown>)[`${field}_ref`]).toBeUndefined()
      expect(
        db.appendThreadSubagentManifestTextDeltas(id, "worker", {
          ...base,
          subagent_text_deltas: { [field]: deltas[field] }
        })
      ).toBeUndefined()
    })
  }
}
import { serializeSubagentTranscripts } from "../../renderer/src/lib/subagent-transcripts"
import type { Message } from "../../renderer/src/types"
it("persists UI content rewrite with reasoning delta atomically, then clears both snapshots", async () => {
  const id = "snapshot-mixed"
  db.createThread(id)
  const base = (
    await compact({
      worker: [
        {
          id: "a",
          role: "assistant",
          content: "body",
          reasoning: "thought",
          subagent_live_text_bootstrap: true
        }
      ]
    })
  ).manifests.worker[0] as Record<string, unknown>
  db.upsertThreadSubagentManifestMessages(id, "worker", [base])
  const delta = {
    v: 1,
    baseRefSha256: (base.reasoning_ref as { sha256: string }).sha256,
    baseLength: 7,
    targetLength: 8,
    delta: "!"
  }
  expect(
    db.appendThreadSubagentManifestTextDeltas(id, "worker", {
      ...base,
      subagent_text_deltas: { reasoning: delta }
    })
  ).toBeDefined()
  const ui = {
    ...base,
    created_at: new Date(),
    content: "new",
    content_pending_delta: "new",
    content_stream_snapshot: true,
    reasoning: "thought!?",
    reasoning_pending_delta: "?",
    reasoning_persisted_length: 8
  } as unknown as Message
  const wire = (
    serializeSubagentTranscripts({ worker: [ui] }).worker as Record<string, unknown>[]
  )[0]
  expect(wire.subagent_text_snapshots).toEqual(["content"])
  const incoming = (await compact({ worker: [{ ...wire, subagent_preserve_text_journal: true }] }))
    .manifests.worker[0] as Record<string, unknown>
  // A rejected companion delta must not commit the snapshot.
  expect(
    db.appendThreadSubagentManifestTextDeltas(id, "worker", {
      ...incoming,
      subagent_text_deltas: { reasoning: { ...delta, baseRefSha256: "f".repeat(64) } }
    })
  ).toBeUndefined()
  let page = db.getThreadSubagentManifestPage(id, "worker", undefined, 10)
  expect(
    ((await hydrate({ worker: page.messages })).worker[0] as Record<string, unknown>).content
  ).toBe("body")
  expect(db.appendThreadSubagentManifestTextDeltas(id, "worker", incoming)).toBeDefined()
  page = db.getThreadSubagentManifestPage(id, "worker", undefined, 10)
  expect((await hydrate({ worker: page.messages })).worker[0]).toMatchObject({
    content: "new",
    reasoning: "thought!?"
  })
  const clears = (
    serializeSubagentTranscripts({
      worker: [
        {
          ...ui,
          content: "",
          reasoning: "",
          content_pending_delta: "",
          reasoning_pending_delta: "",
          content_stream_snapshot: true,
          reasoning_stream_snapshot: true
        }
      ]
    }).worker as Record<string, unknown>[]
  )[0]
  const clear = (await compact({ worker: [{ ...clears, subagent_preserve_text_journal: true }] }))
    .manifests.worker[0]
  expect(db.patchThreadSubagentManifestPreservingTextJournal(id, "worker", clear)).toBeDefined()
  page = db.getThreadSubagentManifestPage(id, "worker", undefined, 10)
  expect((await hydrate({ worker: page.messages })).worker[0]).toMatchObject({
    content: "",
    reasoning: ""
  })
  expect(page.messages[0]).not.toHaveProperty("content_ref")
  expect(page.messages[0]).not.toHaveProperty("reasoning_ref")
  expect(page.messages[0]).not.toHaveProperty("subagent_text_snapshots")
})
it("replaces a sidecar snapshot while preserving an omitted field without journals", async () => {
  const id = "snapshot-no-journal"
  db.createThread(id)
  const base = (
    await compact({
      worker: [
        {
          id: "a",
          role: "assistant",
          content: "body",
          reasoning: "thought",
          subagent_live_text_bootstrap: true
        }
      ]
    })
  ).manifests.worker[0]
  db.upsertThreadSubagentManifestMessages(id, "worker", [base])
  const incoming = (
    await compact({
      worker: [{ id: "a", role: "assistant", content: "", subagent_text_snapshots: ["content"] }]
    })
  ).manifests.worker[0]
  db.upsertThreadSubagentManifestMessages(id, "worker", [incoming])
  const page = db.getThreadSubagentManifestPage(id, "worker", undefined, 10)
  expect((await hydrate({ worker: page.messages })).worker[0]).toMatchObject({
    content: "",
    reasoning: "thought"
  })
  expect(page.messages[0]).not.toHaveProperty("content_ref")
})
