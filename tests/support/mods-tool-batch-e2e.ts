import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyToolBatch(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "tool-batch-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "batch-present.txt"), "ACTUAL_BATCH_FILE")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Tool batch E2E",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "tool-batch", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"tool-batch",description:"Batch mode"});return next(e)});
      on("command.run",{command:"tool-batch"},async($,e)=>{await $.store.set("mode",e.args);return {text:"BATCH_MODE:"+e.args}});
      on("classic.PostToolBatch",async($,e,next)=>{
        const n=(await $.store.get("count")||0)+1;await $.store.set("count",n);
        $.ui.log("BATCH_CALLS:"+JSON.stringify(e.tool_calls));$.ui.log("BATCH_COUNT:"+n);
        const lower=await next(e);
        if(await $.store.get("mode")==="stall") {
          await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] batch review",maxTokens:64});
          $.ui.log("LATE_BATCH_FINISH")
        }
        return await $.store.get("mode")==="block"?{block:"BATCH_BLOCKED_NEXT_MODEL"}:{...lower,additionalContext:[...(lower.additionalContext||[]),"ACTUAL_BATCH_CONTEXT"]}
      })
    }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "tool-batch.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "tool-batch")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Tool batch E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const send = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const prompt = "[mods-tool-batch] inspect both files"
  const first = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= first + 2 &&
      (await page.getByText("TOOL_BATCH_OK", { exact: true }).count()) >= 1 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "complete batch returns to model"
  )
  const entries = await logs()
  assert.equal(entries.filter((row) => row.text === "BATCH_COUNT:1").length, 1)
  const batch = JSON.parse(
    entries.find((row) => row.text.startsWith("BATCH_CALLS:"))!.text.slice(12)
  )
  assert.equal(batch.length, 2)
  assert.deepEqual(
    batch.map((row: { tool_use_id: string }) => row.tool_use_id),
    ["batch-tool-0", "batch-tool-1"]
  )
  assert(JSON.stringify(batch[0].tool_response).includes("ACTUAL_BATCH_FILE"))
  assert(batch[1].tool_response)
  const on = requests.slice(first)
  assert.equal(on.length, 2)
  assert(JSON.stringify(on[1]).includes("ACTUAL_BATCH_CONTEXT"))
  await page.screenshot({ path: join(artifacts, "tool-batch-on.png") })
  pass(
    "real parallel native reads emit one complete ordered PostToolBatch before the next model, including a failed read"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  const offStart = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= offStart + 2 &&
      (await page.getByText("TOOL_BATCH_OK", { exact: true }).count()) >= 2 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "off original batch"
  )
  const off = requests.slice(offStart)
  assert.equal(off.length, 2)
  assert(!JSON.stringify(off).includes("ACTUAL_BATCH_CONTEXT"))
  assert.deepEqual(await logs(), [])
  pass(
    "same native batch with Mods off preserves tool execution without batch checks or added model context"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await send("/tool-batch block")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "BATCH_MODE:block"
      ),
    "set block mode"
  )
  const blockedStart = requests.length
  await send(prompt)
  await until(
    async () => (await page.getByText("BATCH_BLOCKED_NEXT_MODEL", { exact: false }).count()) > 0,
    "batch block prevents next model"
  )
  assert.equal(requests.length - blockedStart, 1)
  assert.equal((await logs()).filter((row) => row.text === "BATCH_COUNT:2").length, 1)
  pass(
    "classic batch block stops the next model request after actual tool settlement without duplicating the check"
  )
  await send("/tool-batch stall")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "BATCH_MODE:stall"
      ),
    "set stalled batch mode"
  )
  for (const action of ["cancel", "revoke"] as const) {
    const start = requests.length
    const closed = closedStalls()
    await send(prompt)
    await until(async () => requests.length >= start + 2, "batch hook reaches real model review")
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else await page.evaluate((id) => window.api.mods.revokeFunction(id, "tool-batch"), threadId)
    await until(
      async () =>
        closedStalls() > closed &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "batch review cancels upstream transport"
    )
    assert.equal(requests.length - start, 2)
    assert(!(await logs()).some((row) => row.text === "LATE_BATCH_FINISH"))
    pass(
      `${action} during an actual batch review closes the model transport and prevents late context or another main model call`
    )
  }
}
