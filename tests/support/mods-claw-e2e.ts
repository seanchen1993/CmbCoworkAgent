import assert from "node:assert/strict"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsAdvancedSettings, openModsClawEditor } from "./mods-sidebar-navigation"

/** Upload real modules, choose them in production React, and observe real normal-turn hooks. */
export async function verifyClawJourney(page: Page, threadId: string, artifacts: string) {
  await page.evaluate(
    (id) =>
      window.api.mods.setCompletionPolicy(id, "flow-e2e", {
        mode: "off",
        scope: "diff",
        checks: [],
        maxRepairs: 0,
        timeoutMs: 120000,
        modelTokenBudget: 4096
      }),
    threadId
  )
  for (const name of ["claw-a", "claw-b"]) {
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({name:${JSON.stringify(name)},description:"读取真实触发记录",immediate:true})
        return next(e)
      })
      on("turn.start", async ($, e, next) => {
        const count = (await $.store.get("turn-count") ?? 0) + 1
        await $.store.set("turn-count", count)
        return next(e)
      })
      on("command.run", {command:${JSON.stringify(name)}}, async ($) => ({text:JSON.stringify({name:${JSON.stringify(name)},count:await $.store.get("turn-count")??0})}))
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "claw.zip",
          "local",
          undefined,
          true
        ),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    await page.evaluate(
      async ({ threadId, name }) => {
        const plugin = (await window.api.mods.status(threadId)).functionMods!.find(
          (item) => item.name === name
        )!
        await window.api.mods.approveFunction(threadId, plugin.pluginId, plugin.digest!)
      },
      { threadId, name }
    )
  }
  await openModsAdvancedSettings(page, "搭配管理")
  await openModsClawEditor(page)
  await page.getByLabel("助手组合名称").fill("仅 A 参与聊天")
  await page.getByLabel("选择能力 claw-a").check()
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  await page
    .getByRole("button", { name: "仅 A 参与聊天", exact: true })
    .locator("..")
    .getByRole("button", { name: "应用到所选聊天", exact: true })
    .click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await page.getByText("当前组合：仅 A 参与聊天", { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, "claw-profile.png") })
  const readCount = async (command: string) => {
    const job = await page.evaluate(
      async ({ threadId, command }) => {
        const descriptor = (await window.api.mods.commands(threadId)).find(
          (item) => item.command === command
        )!
        if (!descriptor) throw Error("Missing command")
        return window.api.mods.enqueue(threadId, descriptor, { text: "" })
      },
      { threadId, command }
    )
    let result
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await page.evaluate(
        async ({ threadId, jobId }) =>
          (await window.api.mods.jobs(threadId)).find((item) => item.id === jobId),
        { threadId, jobId: job.id }
      )
      if (result && ["succeeded", "failed"].includes(result.state)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(result?.state, "succeeded", result?.error)
    return JSON.parse(result!.result!.text).count as number
  }
  const send = async (text: string) => {
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    const label = text.includes("说明 A 模式") ? "CLAW-A-READY" : "CLAW-B-READY"
    await page.locator("textarea.composer-textarea").fill(text)
    await page.locator("textarea.composer-textarea").press("Enter")
    await page
      .getByText("普通聊天答复：已读取本次问题与运行摘要。 " + label, { exact: true })
      .first()
      .waitFor({ timeout: 60000 })
  }
  const commandsA = await page.evaluate((id) => window.api.mods.commands(id), threadId)
  assert.deepEqual(
    commandsA.map((item) => item.command),
    ["claw-a"]
  )
  assert.equal(await readCount("claw-a"), 0)
  await send("说明 A 模式下这个项目的测试目标")
  assert.equal(await readCount("claw-a"), 1)
  const previousJobs = await page.evaluate(
    async (id) => (await window.api.mods.jobs(id)).map((job) => job.id),
    threadId
  )
  await page.locator("textarea.composer-textarea").fill("/claw-a 查询触发记录")
  await page.locator("textarea.composer-textarea").press("Enter")
  let slashResult
  for (let attempt = 0; attempt < 300; attempt++) {
    slashResult = await page.evaluate(
      async ({ id, previous }) =>
        (await window.api.mods.jobs(id)).find(
          (job) =>
            job.command === "claw-a" && !previous.includes(job.id) && job.state === "succeeded"
        ),
      { id: threadId, previous: previousJobs }
    )
    if (slashResult) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(slashResult, "The production composer must route /claw-a to the selected Mod")
  assert.equal(JSON.parse(slashResult.result!.text).count, 1)

  await openModsAdvancedSettings(page, "搭配管理")
  await openModsClawEditor(page)
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await page.getByLabel("助手组合名称").fill("仅 B 参与聊天")
  await page.getByLabel("选择能力 claw-b").check()
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  await page
    .getByRole("button", { name: "仅 B 参与聊天", exact: true })
    .locator("..")
    .getByRole("button", { name: "应用到所选聊天", exact: true })
    .click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await page.getByText("当前组合：仅 B 参与聊天", { exact: true }).waitFor()
  assert.deepEqual(
    (await page.evaluate((id) => window.api.mods.commands(id), threadId)).map(
      (item) => item.command
    ),
    ["claw-b"]
  )
  assert.equal(await readCount("claw-b"), 0)
  await send("说明 B 模式下这个项目的测试目标")
  let observedB = await readCount("claw-b")
  for (let attempt = 0; observedB === 0 && attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    observedB = await readCount("claw-b")
  }
  assert.equal(
    observedB,
    1,
    JSON.stringify(
      await page.evaluate(
        async (id) => ({
          logs: await window.api.mods.logs(id),
          feedback: await window.api.mods.feedback(id),
          status: await window.api.mods.clawView(id)
        }),
        threadId
      )
    )
  )
  // Restore the original project selection after demonstrating both real hook chains.
  const view = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
  await page.evaluate(
    ({ id, revision, workspace }) =>
      window.api.mods.clawChange(id, { kind: "apply", id: null, revision, workspace }),
    { id: threadId, revision: view.revision, workspace: view.workspace }
  )
  assert.equal(await readCount("claw-a"), 1, "Unselected A must not observe the B turn")
}
