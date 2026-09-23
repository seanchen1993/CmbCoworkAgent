import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyUiAsk(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const project = join(workspace, "ui-ask-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI ask E2E",
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
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "ui-ask", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"ui-ask",description:"Native question"});return next(e)});
    on("command.run",{command:"ui-ask"},async($,e)=>{
      try {return {text:"UI_ASK_ANSWER:"+await $.ui.ask(e.args==="blocked"?"UI_ASK_BLOCKED?":"UI_ASK_QUESTION?",{header:"Approach",options:["Careful","Fast"]})}}
      catch(e){return {text:"UI_ASK_ERROR:"+e.message}}
    });
    on("classic.PreToolUse",($,e,next)=>e.tool==="request_user_input" &&
      e.questions?.[0]?.question==="UI_ASK_BLOCKED?"
      ? {deny:"CLASSIC_ASK_BLOCKED"}:next(e));
    on("tool.call",{tool:"request_user_input"},($,e,next)=>next({...e,questions:e.questions.map(q=>({...q,question:q.question==="UI_ASK_BLOCKED?"?q.question:"UI_ASK_FILTERED?"}))}));
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-ask.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "ui-ask")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI ask E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const run = async (args = "now") => {
    await composer.fill(`/ui-ask ${args}`)
    await composer.press("Enter")
  }
  const dialog = page.getByRole("dialog", { name: "需要用户输入" })
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const modelBefore = requests.length
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      askApprovalOriginal: typeof dialog.showMessageBox
      askApprovals: unknown[]
    }
    state.askApprovalOriginal = dialog.showMessageBox
    state.askApprovals = []
    dialog.showMessageBox = (async (_window, options) => {
      state.askApprovals.push(options)
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  const approvals = () =>
    app.evaluate(() => (globalThis as unknown as { askApprovals: unknown[] }).askApprovals)
  try {
    await run()
    await until(
      async () => (await dialog.count()) === 1,
      "native question opens from cold command through the actual tool chain"
    )
    assert((await dialog.innerText()).includes("UI_ASK_FILTERED?"))
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await page.screenshot({ path: join(artifacts, "ui-ask-native.png") })
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "UI_ASK_ANSWER:Careful"),
      "native option returns to real guest"
    )
    assert.equal(requests.length, modelBefore)
    const firstApprovals = await approvals()
    assert.equal(firstApprovals.length, 1)
    assert(JSON.stringify(firstApprovals).includes("UI_ASK_FILTERED?"))
    pass(
      "real ui.ask goes through tool.call rewrite, original native dialog and queued command without a model call"
    )
    await run()
    await until(async () => (await dialog.count()) === 1, "second native question")
    await dialog.getByRole("textbox", { name: "自定义回答" }).fill("Custom answer")
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "UI_ASK_ANSWER:Custom answer"),
      "native free text returns exactly"
    )
    await run()
    await until(async () => (await dialog.count()) === 1, "dismissible native question")
    await dialog.getByRole("button", { name: "跳过全部问题", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text?.includes("MODS_UI_ASK_DISMISSED")),
      "dismissal rejects without inventing an answer"
    )
    pass("ui.ask preserves native free-text entry and rejects ignored questions")
    const approvalsBeforeDenial = (await approvals()).length
    await run("blocked")
    await until(
      async () => (await jobs()).some((j) => j.result?.text?.includes("CLASSIC_ASK_BLOCKED")),
      "classic PreToolUse blocks the SDK question before opening its native dialog"
    )
    assert.equal(await dialog.count(), 0)
    assert.equal((await approvals()).length, approvalsBeforeDenial)
    pass("classic PreToolUse denial prevents final approval and the native SDK dialog")

    await run()
    await until(async () => (await dialog.count()) === 1, "pending question before global off")
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () => (await dialog.count()) === 0,
      "off cancels the original pending question"
    )
    assert.equal(requests.length, modelBefore)
    pass("Mods off aborts its pending native question and leaves the composer usable")
    await composer.fill("Original task after Mods off")
    await composer.press("Enter")
    await until(
      async () =>
        requests.length > modelBefore &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original model task still completes after off"
    )
    assert.equal(await dialog.count(), 0)
    pass("off control runs the original model task without plugin questions")
    const nativeStart = requests.length
    await composer.fill("[mods-native-question]")
    await composer.press("Enter")
    await until(
      async () => (await dialog.count()) === 1,
      "original model-raised native question with Mods off"
    )
    assert((await dialog.innerText()).includes("ORIGINAL_NATIVE_QUESTION?"))
    assert(!(await dialog.innerText()).includes("UI_ASK_FILTERED"))
    await dialog.getByRole("radio", { name: /Keep original/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () =>
        (await page.getByText("NATIVE_QUESTION_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original model question returns through the existing agent loop"
    )
    const nativeAnswers = requests
      .slice(nativeStart)
      .flatMap(
        (request) =>
          (request as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
      )
      .filter((message) => message.role === "tool")
    assert(
      nativeAnswers.some((message) => {
        const content = JSON.stringify(message.content)
        return (
          content.includes("native_choice") &&
          content.includes("Keep original") &&
          content.includes("submitted")
        )
      })
    )
    pass(
      "original model-raised request_user_input retains native wording and returns the answer through the existing agent loop when Mods are off"
    )

    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await page.evaluate((id) => window.api.mods.commands(id), threadId)
    await run()
    await until(
      async () => (await dialog.count()) === 1,
      "pending question after runtime replacement"
    )
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "ui-ask"), threadId)
    await until(async () => (await dialog.count()) === 0, "revocation cancels the native request")
    pass("fresh runtime can ask again and revocation cancels the pending native dialog")
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as {
        askApprovalOriginal?: typeof dialog.showMessageBox
        askApprovals?: unknown[]
      }
      if (state.askApprovalOriginal) dialog.showMessageBox = state.askApprovalOriginal
      delete state.askApprovalOriginal
      delete state.askApprovals
    })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
