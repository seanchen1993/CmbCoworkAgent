import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { canonicalizeState, writeArtifacts } from "./mods-autobiz-contract-fixture"

/** Real agent completion, pinned upstream validator and native checkpoint receipt.
 * The model producer and artifacts are contract fixtures, not business acceptance.
 */
export async function verifyAutobizStage(
  page: Page,
  app: ElectronApplication,
  project: string,
  threadId: string,
  plugin: string,
  artifacts: string,
  run: (text: string) => Promise<void>,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  await writeArtifacts(project, { report: "verdict: PASS\nElectron contract fixture only" })
  const statePath = join(project, ".autobizdevops", "state.json")
  await writeFile(
    statePath,
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: {
        "order-export": {
          feature: "order-export",
          checkpoint: "requirements_eval_in_progress",
          workflowProfile: "standard",
          workflowTemplate: "standard",
          workflowDecisions: {}
        }
      }
    })
  )
  await canonicalizeState(project)
  const before = await readFile(statePath, "utf8")
  const records = () => page.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
  const audit = async () =>
    (await page.evaluate((id) => window.api.mods.audit(id), threadId)).filter(
      (row) => row.toolId === "host:autobiz_checkpoint"
    )
  const configure = (mode: "off" | "check") =>
    page.evaluate(
      ({ threadId, plugin, mode }) =>
        window.api.mods.setCompletionPolicy(threadId, plugin, {
          mode,
          scope: "feature",
          feature: "order-export",
          checks: ["autobiz-validator"],
          maxRepairs: 0,
          timeoutMs: 30000,
          modelTokenBudget: 4096,
          autobizStartCheckpoint: "requirements_eval_in_progress"
        }),
      { threadId, plugin, mode }
    )
  const settle = () =>
    until(
      async () => (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "checkpoint completion settles"
    )
  await configure("off")
  const idsOff = new Set((await records()).map((row) => row.id))
  const noticeIds = new Set(
    (await page.evaluate((id) => window.api.mods.turnNotices(id), threadId)).map(
      (notice) => notice.id
    )
  )
  await run("请确认任务状态。[autobiz-stage-off]")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.turnNotices(id), threadId)).some(
        (notice) => !noticeIds.has(notice.id) && notice.text === "FRESHNESS_CHECKED"
      ),
    "off original turn completes"
  )
  await settle()
  assert.equal(await readFile(statePath, "utf8"), before)
  assert.equal(
    (await records()).filter((row) => !idsOff.has(row.id) && row.phase !== "invalidated").length,
    0
  )
  assert.equal((await audit()).length, 0)
  pass(
    "disabled application stage leaves the same contract task without a gate or checkpoint write"
  )

  await configure("check")
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  const idsDenied = new Set((await records()).map((row) => row.id))
  await run("请确认任务状态。[autobiz-stage-denied]")
  await until(
    async () =>
      (await records()).some(
        (row) =>
          !idsDenied.has(row.id) &&
          row.phase === "check.result" &&
          row.status === "error" &&
          JSON.stringify(row.detail).includes("MODS_USER_REJECTED")
      ),
    "checkpoint native approval rejects"
  )
  await settle()
  assert.equal(await readFile(statePath, "utf8"), before)
  assert(
    !(await records()).some((row) => row.phase === "state.transition" && row.status === "pass")
  )
  pass(
    "real native approval rejection prevents the automatic checkpoint write after upstream validation"
  )

  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  await run("请复检任务状态。[autobiz-stage-approved]")
  await until(
    async () =>
      (await records()).some((row) => row.phase === "state.transition" && row.status === "pass"),
    "upstream stage transition commits"
  )
  await settle()
  const after = await readFile(statePath, "utf8")
  assert.equal(JSON.parse(after).features["order-export"].checkpoint, "requirements_eval_done")
  assert.equal((await audit()).filter((row) => row.status === "succeeded").length, 1)
  const prior = new Set((await records()).map((row) => row.id))
  await run("请再次复检任务状态。[autobiz-stage-repeat]")
  await until(
    async () =>
      (await records()).some(
        (row) => !prior.has(row.id) && row.phase === "check.result" && row.status === "pass"
      ),
    "completed stage revalidates"
  )
  await settle()
  assert.equal(await readFile(statePath, "utf8"), after)
  assert.equal((await audit()).filter((row) => row.status === "succeeded").length, 1)
  await writeFile(
    join(artifacts, "autobiz-stage.json"),
    JSON.stringify(
      {
        scope: "contract fixture, not business acceptance",
        records: await records(),
        audit: await audit()
      },
      null,
      2
    )
  )
  await page.screenshot({ path: join(artifacts, "autobiz-stage.png") })
  pass(
    "pinned validator plus native receipt commits once; repeated completion rechecks without advancing another stage"
  )
}
