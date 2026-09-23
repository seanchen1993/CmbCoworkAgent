import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyQuestionSite(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const project = join(workspace, "question-site-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Question site E2E",
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
    Buffer.from(JSON.stringify({ name: "question-site", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"question-site",description:"Question presentation"});return next(e)});
    on("command.run",{command:"question-site"},async($,e)=>{
      await $.store.set("mode",e.args);$.ui.invalidate("ui.render");
      if(e.args==="model") return {text:"QUESTION_SITE_MODEL_READY"};
      return {text:"QUESTION_SITE_ANSWER:"+await $.ui.ask("Original site question?",["Careful","Fast"])}
    });
    on("ui.render",{component:"AskUserQuestion"},async($,e,next)=>{
      const mode=await $.store.get("mode");
      if(mode==="custom") return {type:"Text",props:{},children:["QUESTION_CONTEXT "+"Explanation ".repeat(350)]};
      return next({...e,props:{...e.props,questions:e.props.questions.map(q=>mode==="invalid"
        ? {...q,options:q.options.slice().reverse()}
        : {...q,header:"Reviewed",question:"Reviewed question?",options:q.options.map(o=>({...o,description:"Visual explanation"}))})}})
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "question-site.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "question-site")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Question site E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const dialog = page.getByRole("dialog", { name: "需要用户输入" })
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const run = async (mode: string) => {
    await composer.fill(`/question-site ${mode}`)
    await composer.press("Enter")
  }
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { questionSiteApproval: typeof dialog.showMessageBox }
    state.questionSiteApproval = dialog.showMessageBox
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  const before = requests.length
  try {
    await run("rewrite")
    await until(
      async () =>
        (await dialog.count()) === 1 && (await dialog.innerText()).includes("Reviewed question?"),
      "native question display rewritten"
    )
    assert((await dialog.innerText()).includes("Visual explanation"))
    assert.equal(await dialog.getByRole("radio").count(), 2)
    await page.screenshot({ path: join(artifacts, "question-site-native.png") })
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "QUESTION_SITE_ANSWER:Careful"),
      "original native answer identity"
    )
    assert.equal(requests.length, before)
    pass(
      "AskUserQuestion rewrites native wording through real guest while original options and submission stay intact"
    )
    await run("invalid")
    await until(
      async () =>
        (await dialog.count()) === 1 &&
        (await dialog.innerText()).includes("Original site question?"),
      "invalid option rewrite falls back"
    )
    assert.equal(await dialog.getByRole("radio", { checked: true }).count(), 0)
    assert((await dialog.getByRole("radio").first().innerText()).includes("Careful"))
    await dialog.getByRole("radio", { name: /Fast/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "QUESTION_SITE_ANSWER:Fast"),
      "fallback answer delivered"
    )
    pass(
      "invalid question option reorder falls back to original dialog and preserves native answer mapping"
    )
    await run("custom")
    await until(
      async () =>
        (await dialog.count()) === 1 && (await dialog.innerText()).includes("QUESTION_CONTEXT"),
      "custom question context drawn"
    )
    assert((await dialog.innerText()).includes("Original site question?"))
    const rail = dialog.locator('[data-function-site="AskUserQuestion"]')
    assert((await rail.boundingBox())!.height <= 112)
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await dialog.count()) === 0,
      "native submit removes custom presentation"
    )
    pass("custom question context stays bounded and cannot replace native answer controls")
    await run("model")
    await until(
      async () => (await jobs()).some((j) => j.result?.text === "QUESTION_SITE_MODEL_READY"),
      "native model presentation mode"
    )
    await composer.fill("[mods-native-question]")
    await composer.press("Enter")
    await until(
      async () =>
        (await dialog.count()) === 1 && (await dialog.innerText()).includes("Reviewed question?"),
      "actual model question presentation"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        (await dialog.count()) === 1 &&
        (await dialog.innerText()).includes("ORIGINAL_NATIVE_QUESTION?"),
      "off preserves pending native model question and restores wording"
    )
    await dialog.getByRole("radio", { name: /Keep original/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () =>
        (await page.getByText("MODS_THREAD_CONTEXT_EXPIRED", { exact: true }).count()) > 0,
      "old runtime rejects the late answer after off"
    )
    assert.equal(await page.getByText("NATIVE_QUESTION_OK", { exact: true }).count(), 0)
    await composer.fill("[mods-native-question] fresh after off")
    await composer.press("Enter")
    await until(
      async () =>
        (await dialog.count()) === 1 &&
        (await dialog.innerText()).includes("ORIGINAL_NATIVE_QUESTION?"),
      "fresh off task keeps native question wording"
    )
    await dialog.getByRole("radio", { name: /Keep original/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () => (await page.getByText("NATIVE_QUESTION_OK", { exact: true }).count()) > 0,
      "fresh native model question completes with Mods off"
    )
    const toolResults = requests
      .slice(before)
      .flatMap(
        (r) => (r as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
      )
      .filter((m) => m.role === "tool")
    assert(toolResults.some((m) => JSON.stringify(m.content).includes("Keep original")))
    assert(toolResults.every((m) => !JSON.stringify(m.content).includes("Visual explanation")))
    pass(
      "off restores native wording, expires the old runtime, and a fresh original question completes without plugin presentation"
    )
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { questionSiteApproval?: typeof dialog.showMessageBox }
      if (state.questionSiteApproval) dialog.showMessageBox = state.questionSiteApproval
      delete state.questionSiteApproval
    })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
