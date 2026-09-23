import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Physical file edit -> existing watcher -> host evidence ledger -> real React UI. */
export async function verifyCompletionFreshness(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "completion-freshness-project")
  mkdirSync(project, { recursive: true })
  const target = join(project, "requirements.md")
  writeFileSync(target, "version one")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Evidence freshness E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "evidence-freshness", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("completion.check", () => ({ decision: "pass" }))
    on("turn.complete", async ($, e, next) => ({ ...await next(e), text: "FRESHNESS_CHECKED" }))
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "freshness.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "evidence-freshness")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
  const rail = page.locator("[data-completion-evidence]")
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const records = () => page.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
  const run = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  try {
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    const before = requests.length
    await run("请确认任务状态。[freshness-off]")
    await until(
      async () =>
        requests.length > before &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "native off turn settles"
    )
    assert.deepEqual(await records(), [])
    assert.equal(await rail.count(), 0)
    pass("off completes the original model turn without a completion gate or evidence UI")
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await run("请确认任务状态。[freshness-on]")
    await until(
      async () =>
        (await records()).some((row) => row.phase === "check.result" && row.status === "pass"),
      "real completion PASS recorded"
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.turnNotices(id), threadId)).some(
          (n) => n.text === "FRESHNESS_CHECKED"
        ),
      "guest completion settles"
    )
    const initial = await records()
    assert(!initial.some((row) => row.phase === "invalidated"))
    const modelCalls = requests.length
    // Same-content writes still generate an OS notification. They must not stale a proof.
    writeFileSync(target, "version one")
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert(!(await records()).some((row) => row.phase === "invalidated"))
    const started = Date.now()
    writeFileSync(target, "version two: requirement changed")
    await until(
      async () =>
        (await records()).some((row) => row.phase === "invalidated" && row.status === "stale"),
      "physical workspace watcher invalidates the old PASS"
    )
    await until(
      async () => (await rail.locator(":scope > summary").innerText()).includes("证据已失效"),
      "stale state reaches UI without a reload"
    )
    const latencyMs = Date.now() - started
    assert.equal(requests.length, modelCalls, "freshness must not invoke the model")
    assert.equal(
      (await records()).filter((row) => row.phase === "check.result").length,
      1,
      "freshness must not re-run checks"
    )
    await rail.locator(":scope > summary").click()
    assert((await rail.innerText()).includes("input-changed"))
    assert((await rail.innerText()).includes("请对当前版本重新检查"))
    await page.screenshot({ path: join(artifacts, "completion-freshness-stale.png") })
    writeFileSync(
      join(artifacts, "completion-freshness.json"),
      JSON.stringify({ latencyMs, records: await records(), modelCallsUnchanged: true }, null, 2)
    )
    pass(
      "physical file modification invalidates host proof and UI without model/check replay; unchanged content stays valid"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
    await until(
      async () => (await rail.locator(":scope > summary").innerText()).includes("证据已失效"),
      "stale evidence survives renderer restart"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(async () => (await rail.count()) === 0, "off removes evidence UI")
    assert.deepEqual(await records(), [])
    pass("durable stale evidence survives renderer restart and disabling Mods removes the gate UI")
    writeFileSync(join(project, "too-large.txt"), Buffer.alloc(3 * 1024 * 1024, 65))
    await page.evaluate(
      async ({ id, plugin }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.mods.setCompletionPolicy(id, plugin, {
          mode: "report",
          scope: "project",
          checks: ["code-review"],
          maxRepairs: 0,
          timeoutMs: 30000,
          modelTokenBudget: 4096
        })
      },
      { id: threadId, plugin: mod.name }
    )
    await run("请确认任务状态。[freshness-capture-error]")
    await until(
      async () => (await records()).some((row) => row.phase === "capture.failed"),
      "initial capture error reaches durable host evidence"
    )
    await until(
      async () => (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "report-only capture error does not block original completion"
    )
    await until(
      async () => (await rail.locator(":scope > summary").innerText()).includes("检查错误"),
      "capture error reaches the actual evidence UI"
    )
    await rail.locator(":scope > summary").click()
    assert((await rail.innerText()).includes("未取得文件证据"))
    const failed = (await records()).find((row) => row.phase === "capture.failed")!
    assert.equal(failed.binding, null)
    assert.equal(failed.status, "error")
    await page.screenshot({ path: join(artifacts, "completion-capture-error.png") })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
    assert((await records()).some((row) => row.id === failed.id && row.binding === null))
    pass(
      "report-only capture failure persists as unavailable evidence, explains the next action and survives renderer restart"
    )
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
