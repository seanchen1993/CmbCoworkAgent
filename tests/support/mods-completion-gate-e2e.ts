import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { isModObject } from "../../src/shared/mods/v2/contracts"
import { openModsResults } from "./mods-sidebar-navigation"

/** Real completion hook, model repair and host evidence; no business acceptance is inferred. */
export async function verifyCompletionGate(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: Array<{ messages: unknown }>,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  existingThreadId?: string
): Promise<void> {
  let threadId = existingThreadId
  if (!threadId) {
    const project = join(workspace, "completion-gate-project")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "requirements.md"), "Request one revision, then check again.")
    threadId = await page.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Completion gate E2E",
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, project)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Completion gate E2E", { exact: true }).first().click()
  }
  const id = threadId
  await until(
    async () => (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "completion scenario begins with the current native model turn idle"
  )
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: "completion-gate-e2e",
        version: "1.0.0"
      })
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./gate.ts"] })))
  zip.addFile(
    "hooks/gate.ts",
    Buffer.from(`export function register(on) {
    let checks = 0
    on("completion.check", ($, e) => {
      checks++
      return e.revisionAttempts === 0
        ? { decision: "revise", reason: "COMPLETION_GATE_E2E_REPAIR: recheck the answer" }
        : { decision: "pass" }
    })
    on("turn.complete", async ($, e, next) => {
      const result = await next(e)
      return { ...result, text: "COMPLETION_GATE_E2E:" + checks }
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "completion-gate-e2e.zip", "local"),
    [...zip.toBuffer()]
  )
  assert.equal(installed.success, true, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods?.find(
    (mod) => mod.name === "completion-gate-e2e"
  )
  assert.ok(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  const recordsBefore = new Set(
    (await page.evaluate((id) => window.api.mods.completionEvidence(id), id)).map(
      (record) => record.id
    )
  )
  const before = requests.length
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("请再次确认当前结果。[completion-gate-e2e]")
  await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.turnNotices(id), id)).some(
        (notice) => notice.text === "COMPLETION_GATE_E2E:2"
      ) && (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "mandatory gate revises and checks again before the native turn completes"
  )
  const gateRequests = requests.slice(before)
  assert.equal(gateRequests.length, 2, "one original model request and one real repair request")
  assert.ok(
    gateRequests.some((request) =>
      JSON.stringify(request.messages).includes("COMPLETION_GATE_E2E_REPAIR")
    )
  )
  const records = (await page.evaluate((id) => window.api.mods.completionEvidence(id), id)).filter(
    (record) => !recordsBefore.has(record.id)
  )
  const outcomes = records.filter((record) => record.phase === "check.result")
  assert.equal(outcomes.length, 2)
  const revise = outcomes.find((record) => record.status === "revise")
  const approved = outcomes.find((record) => record.status === "pass")
  assert.ok(revise && approved, "durable completion IPC records a revise and a subsequent pass")
  assert.ok(revise.at <= approved.at)
  assert.equal(revise.turnId, approved.turnId)
  assert.equal(revise.runId, approved.runId)
  assert.ok(
    isModObject(revise.detail) &&
      String(revise.detail.reason).includes("COMPLETION_GATE_E2E_REPAIR")
  )
  assert.ok(
    records.some(
      (record) =>
        record.phase === "repair.attempt" &&
        record.status === "revise" &&
        isModObject(record.detail) &&
        record.detail.revisionAttempts === 1
    )
  )
  for (const outcome of outcomes) {
    assert.ok(
      isModObject(outcome.detail) &&
        outcome.detail.source === "guest-opinion" &&
        outcome.detail.businessAccepted === false
    )
  }
  assert.ok(records.length >= 3)
  await openModsResults(page)
  const rail = page.locator("[data-completion-evidence]")
  await until(
    async () => (await rail.count()) === 1,
    "host completion evidence reaches the real task UI"
  )
  if (!(await rail.evaluate((element) => (element as HTMLDetailsElement).open)))
    await rail.locator(":scope > summary").click()
  await until(
    async () =>
      (await rail.locator(`[data-completion-record="${revise.id}"]`).count()) === 1 &&
      (await rail.locator(`[data-completion-record="${approved.id}"]`).count()) === 1,
    "the exact revise and pass IPC evidence rows reach the current task UI"
  )
  const text = await rail.innerText()
  assert.ok(text.includes("插件评审意见不代表测试通过或业务验收"))
  assert.ok(text.includes("插件评审意见"))
  assert.ok(text.includes("任务完成检查"))
  assert.ok((await rail.locator("[data-completion-record]").count()) >= 3)
  for (const outcome of outcomes) {
    const row = rail.locator(`[data-completion-record="${outcome.id}"]`)
    assert.ok(await row.isVisible(), "both durable results must be rendered in current evidence")
    assert.ok((await row.innerText()).includes("任务完成检查"))
  }
  await page.screenshot({ path: join(artifacts, "completion-gate-repair.png") })
  writeFileSync(
    join(artifacts, "completion-gate.json"),
    JSON.stringify(
      {
        threadId: id,
        modelRequests: gateRequests.length,
        records,
        turnNotices: await page.evaluate((id) => window.api.mods.turnNotices(id), id),
        guestOpinionIsBusinessAcceptance: false
      },
      null,
      2
    )
  )
  pass("installed Function Mod requests a real agent revision and rechecks before completion")
  pass(
    "real host evidence explains completion checks without presenting guest opinion as business acceptance"
  )
}
