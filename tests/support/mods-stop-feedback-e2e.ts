import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyStopFeedback(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "stop-feedback-project")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Stop feedback E2E",
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
    Buffer.from(JSON.stringify({ name: "stop-feedback", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"stop-mode",description:"Stop feedback mode"});return next(e)});
    on("command.run",{command:"stop-mode"},async($,e)=>{await $.store.set("mode",e.args);return {text:"STOP_MODE:"+e.args}});
    on("classic.Stop",async($,e,next)=>{
      $.ui.log("STOP_STATE:"+JSON.stringify({active:e.stop_hook_active,answer:e.last_assistant_message}));
      const lower=await next(e),mode=await $.store.get("mode")||"feedback";
      if(mode==="stall"){
        await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] Stop observer",maxTokens:64});
        $.ui.log("STOP_LATE_FINISH");return lower
      }
      if(mode!=="loop" && e.stop_hook_active) return lower;
      return {...lower,additionalContext:["STOP_FEEDBACK_RECHECK: check the current task again"]}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "stop-feedback.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (m) => m.name === "stop-feedback"
  )!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Stop feedback E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const stopped = async () =>
    (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), id)
  const states = async () =>
    (await logs())
      .filter((row) => row.text.startsWith("STOP_STATE:"))
      .map((row) => JSON.parse(row.text.slice(11)))
  const prompt = "[stop-feedback-task] inspect the task"
  let start = requests.length
  await send(prompt)
  await until(
    async () => requests.length === start + 2 && (await stopped()) && (await states()).length === 2,
    "Stop feedback continues exactly once"
  )
  const first = await states()
  assert.deepEqual(
    first.map((row) => row.active),
    [false, true]
  )
  assert(
    first.every((row) => typeof row.answer === "string" && row.answer.includes("SDK_MODEL_OK"))
  )
  assert(JSON.stringify(requests[start + 1]).includes("STOP_FEEDBACK_RECHECK"))
  assert(JSON.stringify(requests[start + 1]).includes("This is not a tool or model error"))
  await page.screenshot({ path: join(artifacts, "stop-feedback-on.png") })
  pass(
    "real Stop additionalContext continues the original main loop once with false/true state and non-error feedback"
  )
  start = requests.length
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Stop feedback E2E", { exact: true }).first().click()
  await send(prompt)
  await until(
    async () => requests.length === start + 2 && (await stopped()) && (await states()).length === 4,
    "fresh turn has fresh Stop state"
  )
  assert.deepEqual(
    (await states()).map((row) => row.active),
    [false, true, false, true]
  )
  pass(
    "new task turn after renderer reload starts with stop_hook_active false and retains the original budget"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  start = requests.length
  await send(prompt)
  await until(
    async () => requests.length === start + 1 && (await stopped()),
    "same task with Mods off completes once"
  )
  assert.deepEqual(await logs(), [])
  pass("same task with Mods off performs one model request and no Stop continuation")
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await send("/stop-mode loop")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
        (job) => job.result?.text === "STOP_MODE:loop"
      ),
    "set repeated feedback mode"
  )
  start = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length === start + 3 &&
      (await stopped()) &&
      (await page
        .getByText("Stop hook feedback exceeded 2 continuation attempts", { exact: false })
        .count()) > 0,
    "Stop feedback exhausts original budget"
  )
  assert.deepEqual(
    (await states()).map((row) => row.active),
    [false, true, true]
  )
  writeFileSync(
    join(artifacts, "stop-feedback-evidence.json"),
    JSON.stringify(
      { first, exhausted: await states(), modelRequestsAtBudget: requests.length - start },
      null,
      2
    )
  )
  pass(
    "repeated non-error Stop feedback consumes the original two-repair budget and cannot approve completion"
  )
  await send("/stop-mode stall")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
        (job) => job.result?.text === "STOP_MODE:stall"
      ),
    "set waiting feedback mode"
  )
  for (const action of ["cancel", "revoke"] as const) {
    start = requests.length
    const closed = closedStalls()
    await send(prompt)
    await until(async () => requests.length === start + 2, "Stop reaches actual upstream review")
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else await page.evaluate((id) => window.api.mods.revokeFunction(id, "stop-feedback"), id)
    await until(
      async () => closedStalls() > closed && (await stopped()),
      "Stop review transport cancelled"
    )
    assert.equal(requests.length, start + 2)
    assert(!(await logs()).some((row) => row.text === "STOP_LATE_FINISH"))
    pass(action + " cancels an actual Stop review without a late repair request")
  }
}
