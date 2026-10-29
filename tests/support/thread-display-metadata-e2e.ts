import assert from "node:assert/strict"
import { join } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { isChatRowPresented } from "../../src/renderer/src/components/chat/chat-row-presentation"
import {
  installThreadDisplayMetadataRace,
  type MetadataRaceGlobal,
  type MetadataRaceKind
} from "./thread-display-metadata-race"

/** Small native preflight, also reusable before the separate long-history gesture observation. */
export async function runThreadDisplayMetadataCases(
  app: ElectronApplication,
  page: Page,
  fixture: { isolated: string; workspace: string },
  record: (event: unknown) => void
): Promise<void> {
  await app.evaluate("globalThis.__name = value => value\nvoid 0")
  await page.addInitScript("globalThis.__name = value => value")
  await page.evaluate("globalThis.__name = value => value")
  await app.evaluate(installThreadDisplayMetadataRace, {
    privateRoot: fixture.isolated,
    workspace: fixture.workspace
  })
  const kinds: MetadataRaceKind[] = [
    "llmModifiedFiles",
    "llmFileHistory",
    "llmRecentlyRevertedFiles",
    "repeat",
    "workspace",
    "unknown",
    "incarnation",
    "deleted"
  ]
  try {
    const cases = await page.evaluate(
      async ({ workspace, kinds }) => {
        await window.api.mods.configureGlobal(true)
        const cases: Array<{
          threadId: string
          title: string
          marker: string
          kind: MetadataRaceKind
        }> = []
        for (const kind of kinds) {
          const title = `METADATA_RACE_FIXTURE_${kind}`
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const threadId = thread.thread_id
          await window.api.workspace.set(threadId, workspace)
          const config = await window.api.mods.status(threadId)
          await window.api.mods.configure(threadId, true, true, config.workspace)
          const marker = `SYNTHETIC_METADATA_RACE_${kind}`
          const stored = await window.api.threads.appendMessages(threadId, [
            {
              id: `${threadId}-prompt`,
              role: "user",
              content: `${marker}_PROMPT`,
              created_at: new Date(1700000000000)
            },
            {
              id: `${threadId}-answer`,
              role: "assistant",
              content: `${marker}_ANSWER`,
              created_at: new Date(1700000000001)
            }
          ])
          if (stored.count !== 2) throw Error("Metadata fixture persistence incomplete")
          cases.push({ threadId, title, marker, kind })
        }
        return cases
      },
      { workspace: fixture.workspace, kinds }
    )
    record({
      kind: "metadata-race-fixture-provenance",
      source:
        "Eight new synthetic conversations, two ordinary messages each, persisted through real preload IPC into private native SQLite",
      realUserHistoryRead: false,
      modelInvoked: false,
      installedGuestOrBusinessPermissions: false,
      nativeOutputProtectionEnabled: true,
      witnessScope:
        "Real display worker and original source/witness verifier; witness counts are recorded, not fabricated. Ordinary fixture rows do not establish protected canonical transcript coverage.",
      scheduling:
        "Only the named worker instance and original IPC invocation are observed; response payloads and witnesses are unchanged",
      separatedFromHistoryTiming: true,
      threads: cases.map(({ threadId, kind }) => ({ threadId, kind }))
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => !!window.api?.threads)
    await page.getByRole("button", { name: /展开显示/ }).click()
    const presentationCheck = `globalThis.metadataRaceRowPresented = ${isChatRowPresented.toString()}`
    await page.evaluate(presentationCheck)
    for (const item of cases) {
      const before = await app.evaluate(
        () =>
          (globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace.snapshot()
            .invocations.length
      )
      await app.evaluate((_electron, { threadId, kind }) => {
        ;(globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace.arm(threadId, kind)
      }, item)
      const positive = ["llmModifiedFiles", "llmFileHistory", "llmRecentlyRevertedFiles"].includes(
        item.kind
      )
      if (positive) {
        await page.getByText(item.title, { exact: true }).first().click()
        await page.waitForFunction(
          ({ threadId, marker }) => {
            const scope = document.querySelector(`[data-chat-thread-id="${threadId}"]`)
            const row = scope?.querySelector(`[data-chat-message-id="${threadId}-answer"]`)
            const viewport = row?.closest("[data-radix-scroll-area-viewport]")
            if (
              !row ||
              !viewport ||
              !row.textContent?.includes(`${marker}_ANSWER`) ||
              row.querySelector("[data-function-site-pending]")
            )
              return false
            const box = row.getBoundingClientRect(),
              area = viewport.getBoundingClientRect()
            return (
              box.height > 0 &&
              box.bottom > area.top &&
              box.top < area.bottom &&
              (
                window as unknown as { metadataRaceRowPresented(row: Element): boolean }
              ).metadataRaceRowPresented(row)
            )
          },
          item,
          { timeout: 30_000, polling: "raf" }
        )
        await page.screenshot({ path: join(fixture.isolated, `metadata-${item.kind}.png`) })
      } else {
        // Exercise the actual bridge without selecting a revoked/deleted fixture in the UI.
        // This isolates one invocation from the renderer's separate automatic hydration budget.
        const response = await page.evaluate(async (threadId) => {
          try {
            const page = await window.api.threads.getMessagesPage(threadId, { limit: 20 })
            return { resolved: true, ids: page.messages.map((message) => message.id), error: "" }
          } catch (error) {
            return { resolved: false, ids: [], error: String(error) }
          }
        }, item.threadId)
        assert.equal(response.resolved, false, `${item.kind}: stale invocation must reject`)
        assert.deepEqual(response.ids, [], `${item.kind}: no stale page crossed the bridge`)
        assert.match(response.error, /MODS_CONVERSATION_THREAD_CHANGED/)
        assert.equal(
          await page.locator(`[data-chat-message-id="${item.threadId}-answer"]`).count(),
          0
        )
      }
      const snapshot = await app.evaluate(() =>
        (globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace.snapshot()
      )
      assert.deepEqual(snapshot.failures, [], "Race observation/injection must be exact")
      const calls = snapshot.invocations.slice(before)
      assert.equal(calls.length, 1, `${item.kind}: one original IPC, not a later renderer retry`)
      const invocation = calls[0]
      assert.equal(invocation.outcome, positive ? "resolved" : "rejected")
      assert.equal(invocation.reads.length, positive || item.kind === "repeat" ? 2 : 1)
      assert.equal(
        new Set(invocation.reads.map((read) => read.requestId)).size,
        invocation.reads.length
      )
      for (const read of invocation.reads) {
        assert.equal(
          read.responseOk,
          true,
          "Native worker read SQLite successfully before the guard"
        )
        assert(
          read.responseIds?.includes(`${item.threadId}-answer`),
          "The competing old row was actually read"
        )
      }
      assert.equal(invocation.reads[0].mutation, item.kind)
      if (positive) {
        assert.equal(invocation.foreground, true)
        assert.equal(invocation.reads[1].mutation, undefined)
        assert(invocation.returnedIds?.includes(`${item.threadId}-answer`))
      } else {
        assert.equal(invocation.returnedIds, undefined)
        if (item.kind === "repeat") assert.equal(invocation.reads[1].mutation, "repeat")
      }
      record({
        kind: "metadata-race-case",
        scenario: item.kind,
        nativeUiRendered: positive,
        invocation
      })
    }
  } finally {
    const snapshot = await app.evaluate(() =>
      (globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace.close()
    )
    record({ kind: "metadata-race-observer-closed", snapshot })
    assert.equal(
      snapshot.detached,
      true,
      "Remove test observation before measuring history gestures"
    )
    assert.deepEqual(snapshot.failures, [])
    assert(snapshot.workerCount >= 1, "A real named native display worker must have been observed")
  }
}
