import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyBackgroundTimeout(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "background-timeout-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "deadline-job.cjs"), 'setTimeout(() => console.log("DONE"), 5000)')
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_BACKGROUND_READ")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Background timeout E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id?: string; id: string }).thread_id ??
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
    Buffer.from(JSON.stringify({ name: "background-timeout", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"background-timeout",description:"Real background timeout"});return next(e)});
    on("command.run",{command:"background-timeout"},async($)=>{
      const start=await $.tool.call({tool:"execute",command:"node deadline-job.cjs",run_in_background:true});
      const id=JSON.stringify(start).match(/id:\\s*([a-f0-9]+)/i)?.[1];
      if(!id) throw Error("BACKGROUND_ID_MISSING:"+JSON.stringify(start));
      $.ui.log("BACKGROUND_READY");await $.clock.sleep(500);
      const result=await $.tool.call({tool:"task_output",task_id:id,block:true,timeout:200});
      $.ui.log("BACKGROUND_RESULT:"+JSON.stringify(result));
      return {text:"BACKGROUND_TIMEOUT_DONE"}
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "background-timeout.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "background-timeout")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Background timeout E2E", { exact: true }).first().click()
  const modelBefore = requests.length
  // Answer only this fixture's original native approval prompt; all other prompts are denied.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      backgroundOriginalDialog: typeof dialog.showMessageBox
      backgroundApprovals: unknown[]
      backgroundClockRestore?: () => void
    }
    state.backgroundOriginalDialog = dialog.showMessageBox
    state.backgroundApprovals = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      state.backgroundApprovals.push(args.slice(1))
      return {
        response: JSON.stringify(args.slice(1)).includes("deadline-job.cjs") ? 1 : 0,
        checkboxChecked: false
      }
    }) as typeof dialog.showMessageBox
  })
  try {
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("[mods-tool-rewrite]")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original model tool turn establishes a live native runtime"
    )
    await composer.fill("/background-timeout now")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
    await until(
      async () => (await logs()).some((row) => row.text === "BACKGROUND_READY"),
      "actual native background task started"
    )
    await app.evaluate(() => {
      const original = Date.now
      const frozen = original()
      const clock = {
        now() {
          return frozen
        },
        restore() {
          clearTimeout(timer)
          Date.now = original
        }
      }
      Date.now = clock.now
      Object.assign(globalThis, { backgroundClockRestore: clock.restore })
      const timer = setTimeout(clock.restore, 1200)
    })
    const started = performance.now()
    await until(
      async () => (await logs()).some((row) => row.text.startsWith("BACKGROUND_RESULT:")),
      "actual SDK timeout under frozen Electron main wall clock"
    )
    const elapsed = performance.now() - started
    const result = JSON.parse(
      (await logs())
        .find((row) => row.text.startsWith("BACKGROUND_RESULT:"))!
        .text.slice("BACKGROUND_RESULT:".length)
    )
    assert.equal(result.result.completed, false)
    assert.equal(result.result.retrieval_status, "timeout")
    assert(elapsed < 1000, `timeout exceeded monotonic bound: ${elapsed}ms`)
    const approvals = await app.evaluate(
      () => (globalThis as unknown as { backgroundApprovals: unknown[] }).backgroundApprovals
    )
    assert(approvals.length > 0)
    assert(JSON.stringify(approvals).includes("deadline-job.cjs"))
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (job) => job.result?.text === "BACKGROUND_TIMEOUT_DONE"
        ),
      "original command settles"
    )
    assert(requests.length > modelBefore)
    assert(JSON.stringify(requests.slice(modelBefore)).includes("ORIGINAL_BACKGROUND_READ"))
    await page.screenshot({ path: join(artifacts, "background-timeout.png") })
    writeFileSync(
      join(artifacts, "background-timeout.json"),
      JSON.stringify(
        {
          elapsed,
          result,
          nativeApprovals: approvals.length,
          modelRequests: requests.length - modelBefore
        },
        null,
        2
      )
    )
    pass(
      "real native background task_output returns timeout under a frozen Electron wall clock through the original grant and approval"
    )
    await app.evaluate(() =>
      (globalThis as unknown as { backgroundClockRestore: () => void }).backgroundClockRestore()
    )
    const receipts = await page.evaluate((id) => window.api.mods.audit(id), threadId)
    const beforeOff = requests.length
    const answers = await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await composer.fill("[mods-tool-rewrite] after Mods off")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > answers &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original native model read completes with Mods disabled"
    )
    assert(JSON.stringify(requests.slice(beforeOff)).includes("ORIGINAL_BACKGROUND_READ"))
    assert.deepEqual(await page.evaluate((id) => window.api.mods.audit(id), threadId), receipts)
    await page.screenshot({ path: join(artifacts, "background-timeout-off.png") })
    pass("Mods off preserves the original model and native read without new plugin tool receipts")
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as {
        backgroundOriginalDialog: typeof dialog.showMessageBox
        backgroundClockRestore?: () => void
      }
      state.backgroundClockRestore?.()
      dialog.showMessageBox = state.backgroundOriginalDialog
    })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
