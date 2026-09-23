import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyStopFailure(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "stop-failure-project")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Stop failure E2E",
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
    Buffer.from(JSON.stringify({ name: "stop-failure", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"failure-mode",description:"Stop failure mode"});return next(e)});
    on("command.run",{command:"failure-mode"},async($,e)=>{await $.store.set("mode",e.args);return {text:"STOP_MODE:"+e.args}});
    on("classic.Stop",($,e,next)=>{$.ui.log("UNEXPECTED_SUCCESS_STOP");return next(e)});
    on("classic.StopFailure",async($,e,next)=>{
      $.ui.log("FAILURE_FACTS:"+JSON.stringify(e));
      const lower=await next(e),mode=await $.store.get("mode")||"review";
      await $.model.complete({model:"custom:mods-model-fixture",prompt:mode==="stall"?"[stall] failure observer":"Review the observed model failure",maxTokens:64});
      $.ui.log("FAILURE_OBSERVER_FINISHED");
      return {...lower,additionalContext:["DO_NOT_RESTART_FAILED_MODEL"]}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "stop-failure.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (m) => m.name === "stop-failure"
  )!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Stop failure E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const stopped = async () =>
    (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), id)
  const prompt = "[mods-stop-failure-task] inspect this task"
  let start = requests.length
  await send(prompt)
  await until(
    async () =>
      (await logs()).some((row) => row.text === "FAILURE_OBSERVER_FINISHED") && (await stopped()),
    "StopFailure observer completes before original run ends"
  )
  assert.equal(requests.length, start + 2)
  const facts = (await logs()).filter((row) => row.text.startsWith("FAILURE_FACTS:"))
  assert.equal(facts.length, 1)
  const detail = JSON.parse(facts[0].text.slice(14))
  assert.equal(detail.error, "invalid_request")
  assert.equal(typeof detail.error_details, "string")
  assert(detail.error_details.includes("actual protocol request rejected"))
  assert(!(await logs()).some((row) => row.text === "UNEXPECTED_SUCCESS_STOP"))
  assert((await page.getByText("actual protocol request rejected", { exact: false }).count()) > 0)
  writeFileSync(join(artifacts, "stop-failure-evidence.json"), JSON.stringify(detail, null, 2))
  await page.screenshot({ path: join(artifacts, "stop-failure-on.png") })
  pass(
    "actual model error supplies immutable StopFailure facts and allows its real SDK observation before original failure completes"
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  start = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length === start + 2 &&
      (await stopped()) &&
      (await logs()).filter((row) => row.text === "FAILURE_OBSERVER_FINISHED").length === 2,
    "fresh failure after renderer reload"
  )
  pass(
    "a new failed model task after renderer reload delivers one fresh failure observation and never restarts the task"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  start = requests.length
  await send(prompt)
  await until(
    async () => requests.length === start + 1 && (await stopped()),
    "off retains native failure"
  )
  assert.deepEqual(await logs(), [])
  pass(
    "same failing task with Mods off reports the original error without a review or success Stop"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await send("/failure-mode stall")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
        (job) => job.result?.text === "STOP_MODE:stall"
      ),
    "set stalled observer"
  )
  for (const action of ["cancel", "revoke"] as const) {
    start = requests.length
    const closed = closedStalls()
    await send(prompt)
    await until(async () => requests.length === start + 2, "failure observer reaches real HTTP")
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else await page.evaluate((id) => window.api.mods.revokeFunction(id, "stop-failure"), id)
    await until(
      async () => closedStalls() > closed && (await stopped()),
      "failure observation cancelled"
    )
    assert.equal(requests.length, start + 2)
    assert(!(await logs()).some((row) => row.text === "FAILURE_OBSERVER_FINISHED"))
    pass(action + " closes a real failure observation without late success or model restart")
  }
}
