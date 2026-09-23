import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { ModCommandJob } from "../../src/shared/mods/types"
import { COMPACTION_SUMMARY_SENTINEL, isCompactionSummaryRequest } from "./mods-compaction-fixture"

interface ProbeEvent {
  kind: "pre" | "post" | "returned" | "failed"
  trigger?: "manual" | "auto"
  instructions?: string | null
  summary?: string
  summaryVisible?: boolean
  message?: string
}
interface ProbeStatus {
  events: ProbeEvent[]
}
interface ProbeResult {
  ok: boolean
  error?: string
  result?: { messages: unknown[]; tokensBefore: number; tokensAfter: number }
}

/** Public preload only. The root suite supplies its existing local HTTP model server. */
export async function verifyCompactionHooks(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  modelServer: { requests: Array<{ messages: unknown }> },
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<string> {
  const priorEnabled = await page.evaluate(() => window.api.mods.globalEnabled())
  assert.equal(priorEnabled, true, "Root suite must explicitly enable Mods before this probe")
  // Earlier scenarios intentionally approve many independent fixtures. Keep the
  // compaction probe within the real eight-plugin chain bound in its own project.
  const executionWorkspace = join(workspace, "compaction-project")
  mkdirSync(executionWorkspace, { recursive: true })
  const title = "Compaction lifecycle E2E"
  const threadId = await page.evaluate(
    async ({ workspace, title }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      await window.api.threads.patchMetadata(id, { set: { model: "custom:mods-model-fixture" } })
      await window.api.mods.configure(id, true, true)
      return id
    },
    { workspace: executionWorkspace, title }
  )
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/compaction-probe"))
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "compaction-probe.zip", "local"),
    [...zip.toBuffer()]
  )
  assert.equal(installed.success, true, installed.error)
  const plugin = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((entry) => entry.name === "compaction-probe")
  assert(plugin?.digest, "Compaction plugin must have a real captured digest")
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(title, { exact: true }).first().click()

  async function command<T>(name: string, text = ""): Promise<T> {
    const queued = await page.evaluate(
      async ({ id, name, text }) => {
        const descriptor = (await window.api.mods.commands(id)).find(
          (entry) => entry.command === name
        )
        if (!descriptor || descriptor.apiVersion !== "cmb.mods/v2")
          throw Error(`Missing command ${name}`)
        if (descriptor.immediate !== true)
          throw Error("Compaction must run outside a model/tool lease")
        return window.api.mods.enqueue(id, descriptor, { text })
      },
      { id: threadId, name, text }
    )
    let done: ModCommandJob | undefined
    await until(async () => {
      done = (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
        (job) => job.id === queued.id
      )
      return !!done && !["queued", "running"].includes(done.state)
    }, `${name} completes through the real immediate command queue`)
    assert.equal(done?.state, "succeeded", done?.error)
    assert.equal(typeof done.result?.text, "string")
    return JSON.parse(done.result!.text) as T
  }
  async function invoke(message: string): Promise<void> {
    const result = await page.evaluate(
      async ({ id, message }) =>
        new Promise<{ done: boolean; error?: string }>((resolve) => {
          let cleanup = () => {}
          let error: string | undefined
          const timer = window.setTimeout(() => {
            cleanup()
            void window.api.agent.cancel(id)
            resolve({ done: false, error: "Compaction fixture model turn timeout" })
          }, 45000)
          cleanup = window.api.agent.invoke(
            id,
            message,
            (event) => {
              if (event.type === "error") {
                error = String(event.error)
                window.clearTimeout(timer)
                cleanup()
                resolve({ done: false, error })
              }
              if (event.type === "done") {
                window.clearTimeout(timer)
                cleanup()
                resolve({ done: true, ...(error ? { error } : {}) })
              }
            },
            "custom:mods-model-fixture",
            "normal"
          )
        }),
      { id: threadId, message }
    )
    assert.equal(result.done, true, result.error)
    assert.equal(result.error, undefined)
  }
  const summaries = () => modelServer.requests.filter(isCompactionSummaryRequest).length
  const seed =
    "Source src/compaction.ts; requirement preserve paths and committed evidence. ".repeat(230)
  const evidence: Record<string, unknown> = {
    threadId,
    scope: "Public preload / real main runtime / local HTTP model / SQLite checkpoint"
  }
  try {
    await invoke(`COMPACTION_PROBE seed-one\n${seed}`)
    await invoke(`COMPACTION_PROBE seed-two\n${seed}`)
    await command("compact-probe-mode", "block")
    const beforeBlock = summaries()
    const blocked = await command<ProbeResult>("compact-probe-run")
    assert.equal(blocked.ok, false)
    assert.match(blocked.error ?? "", /COMPACTION_PROBE_BLOCK|CONTEXT_COMPACTION_BLOCKED/)
    assert.equal(
      summaries(),
      beforeBlock,
      "PreCompact block must prevent all summary provider calls"
    )
    const blockedStatus = await command<ProbeStatus>("compact-probe-status")
    assert.deepEqual(
      blockedStatus.events.map((event) => event.kind),
      ["pre", "failed"]
    )
    assert.equal(blockedStatus.events[0].trigger, "manual")
    evidence.blocked = { result: blocked, events: blockedStatus.events, summaryRequests: 0 }
    pass(
      "real immediate session.compact is blocked by PreCompact before any summary provider request"
    )

    await command("compact-probe-mode", "allow")
    const beforeSuccess = summaries()
    const success = await command<ProbeResult>("compact-probe-run")
    assert.equal(success.ok, true, success.error)
    assert(success.result)
    assert.equal(summaries(), beforeSuccess + 1, "Valid summary should not need quality retries")
    assert(
      success.result.tokensAfter < success.result.tokensBefore,
      "Real history must become smaller"
    )
    assert(JSON.stringify(success.result.messages).includes(COMPACTION_SUMMARY_SENTINEL))
    const committed = await command<ProbeStatus>("compact-probe-status")
    assert.deepEqual(
      committed.events.map((event) => event.kind),
      ["pre", "post", "returned"]
    )
    assert.equal(committed.events[1].trigger, "manual")
    assert.equal(
      committed.events[1].summaryVisible,
      true,
      "Post sees the already updated real session"
    )
    assert(committed.events[1].summary?.includes(COMPACTION_SUMMARY_SENTINEL))
    // Transcript rows retain the visible conversation. Compaction updates the
    // graph checkpoint; validate that durable source through its public reader.
    const persisted = await page.evaluate((id) => window.api.threads.getLatestCheckpoint(id), threadId)
    assert(
      JSON.stringify(persisted).includes(COMPACTION_SUMMARY_SENTINEL),
      "Public checkpoint reader must read the persisted compaction"
    )
    evidence.committed = {
      result: success,
      events: committed.events,
      persistedCheckpoint: persisted
    }
    await page.screenshot({ path: join(artifacts, "function-compaction-committed.png") })
    pass(
      "real session.compact commits a smaller checkpoint and PostCompact sees that summary before the SDK returns"
    )

    await page.evaluate(() => window.api.mods.configureGlobal(false))
    const offBefore = summaries()
    await invoke(`COMPACTION_PROBE off-seed-one\n${seed}`)
    await invoke(`COMPACTION_PROBE off-seed-two\n${seed}`)
    await invoke(
      "COMPACTION_PROBE [mods-compaction-force-overflow] continue after actual automatic compaction"
    )
    assert(
      summaries() > offBefore,
      "Off comparison must perform a real automatic summary, not merely skip hooks"
    )
    const offCommands = await page.evaluate((id) => window.api.mods.commands(id), threadId)
    assert(!offCommands.some((entry) => entry.command.startsWith("compact-probe-")))
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    const afterOff = await command<ProbeStatus>("compact-probe-status")
    assert.deepEqual(
      afterOff.events,
      committed.events,
      "Global-off actual compaction must not execute either classic hook"
    )
    evidence.off = { summaryRequests: summaries() - offBefore, eventsUnchanged: true }
    pass(
      "Mods global-off still performs actual automatic compaction but removes commands and emits no Pre/PostCompact"
    )
    evidence.status = "passed"
    return threadId
  } catch (error) {
    evidence.status = "failed"
    evidence.error = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    if ((await page.evaluate(() => window.api.mods.globalEnabled())) !== priorEnabled)
      await page.evaluate((enabled) => window.api.mods.configureGlobal(enabled), priorEnabled)
    writeFileSync(
      join(artifacts, "function-compaction-evidence.json"),
      JSON.stringify(evidence, null, 2)
    )
  }
}
