import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
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
  app: ElectronApplication,
  withdrawal: "global-off" | "uninstall" = "global-off"
): Promise<void> {
  const pluginName = withdrawal === "uninstall" ? "question-site-uninstall" : "question-site"
  const title = withdrawal === "uninstall" ? "Question site uninstall E2E" : "Question site E2E"
  const receipt = withdrawal === "uninstall" ? "question-site-uninstall" : "question-site-off"
  const project = join(workspace, `${pluginName}-project`)
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(
    async ({ project, title }) => {
      const thread = await window.api.threads.create({
        title,
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
    },
    { project, title }
  )
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: pluginName, version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:${JSON.stringify(pluginName)},description:"Question presentation"});return next(e)});
    on("command.run",{command:${JSON.stringify(pluginName)}},async($,e)=>{
      if(e.args==="probe") return {text:"QUESTION_SITE_PROBE:"+(await $.store.get("probe-count")||0)};
      await $.store.set("mode",e.args);$.ui.invalidate("ui.render");
      if(e.args==="model") return {text:"QUESTION_SITE_MODEL_READY"};
      return {text:"QUESTION_SITE_ANSWER:"+await $.ui.ask("Original site question?",["Careful","Fast"])}
    });
    on("ui.render",{component:"InfoNotice"},($,e,next)=>{
      if(e.props.text!=="scope probe")return next(e);
      const {Button}=$.ui.resolve(e);
      return Button({key:"scope-probe",label:"Question scope probe",onPress:async()=>{
        await $.store.set("probe-count",1+(await $.store.get("probe-count")||0))
      }})
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
    ({ bytes, fileName }) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, fileName, "local"),
    { bytes: [...zip.toBuffer()], fileName: `${pluginName}.zip` }
  )
  assert(installed.success, installed.error)
  const installedPluginId = installed.pluginId
  assert(installedPluginId)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === pluginName)!
  assert.equal(mod.pluginId, installedPluginId)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(title, { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const dialog = page.getByRole("dialog", { name: "需要用户输入" })
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const run = async (mode: string) => {
    await composer.fill(`/${pluginName} ${mode}`)
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
  let uninstalled = false
  let completed = false
  let cleanupFailure: { error: unknown } | undefined
  try {
    await run("rewrite")
    await until(
      async () =>
        (await dialog.count()) === 1 && (await dialog.innerText()).includes("Reviewed question?"),
      "native question display rewritten"
    )
    assert((await dialog.innerText()).includes("Visual explanation"))
    assert.equal(await dialog.getByRole("radio").count(), 2)
    await page.screenshot({ path: join(artifacts, `${pluginName}-native.png`) })
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
    await page.screenshot({ path: join(artifacts, `${pluginName}-custom.png`) })
    // The site uses display:contents around the native engine, so measure its actual dialog.
    const dialogBounds = await dialog.boundingBox()
    assert(dialogBounds && dialogBounds.height > 0 && dialogBounds.height <= 520)
    const content = dialog.getByRole("region", { name: "问题内容与补充说明", exact: true })
    const contentBounds = await content.boundingBox()
    assert(
      contentBounds &&
        contentBounds.height > 0 &&
        contentBounds.y >= dialogBounds.y &&
        contentBounds.y + contentBounds.height <= dialogBounds.y + dialogBounds.height
    )
    assert(await content.evaluate((node) => node.scrollHeight > node.clientHeight))
    const contextBounds = await rail.getByText(/^QUESTION_CONTEXT /).boundingBox()
    assert(
      contextBounds &&
        contextBounds.width > 0 &&
        contextBounds.height > 0 &&
        contextBounds.y < dialogBounds.y + dialogBounds.height &&
        contextBounds.y + contextBounds.height > dialogBounds.y,
      "custom context must occupy visible space in the bounded question dialog"
    )
    assert.equal(await dialog.getByRole("radio").count(), 2)
    assert.equal(await dialog.getByRole("button", { name: "提交", exact: true }).count(), 1)
    const lastRadio = dialog.getByRole("radio").last()
    await lastRadio.scrollIntoViewIfNeeded()
    const radioBounds = await lastRadio.boundingBox()
    assert(
      radioBounds &&
        radioBounds.height > 0 &&
        radioBounds.y >= contentBounds.y &&
        radioBounds.y + radioBounds.height <= contentBounds.y + contentBounds.height,
      "long custom context must leave native options reachable by scrolling the question content"
    )
    const submit = dialog.getByRole("button", { name: "提交", exact: true })
    await submit.scrollIntoViewIfNeeded()
    const submitBounds = await submit.boundingBox()
    assert(
      submitBounds &&
        submitBounds.height > 0 &&
        submitBounds.y >= contentBounds.y &&
        submitBounds.y + submitBounds.height <= contentBounds.y + contentBounds.height,
      "the original submit must be reachable inside the bounded question content"
    )
    assert(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight
      ),
      "question content must not overflow the page"
    )
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () =>
        (await jobs()).filter((j) => j.result?.text === "QUESTION_SITE_ANSWER:Careful").length ===
        2,
      "custom context preserves the original native answer"
    )
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
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), threadId)).find(
      (command) => command.command === pluginName
    )!
    assert(descriptor)
    const oldProbe = await page.evaluate(async (id) => {
      const mounted = await window.api.mods.siteMountOutcome(id, "InfoNotice")
      if (mounted.state !== "mounted") throw new Error("Question probe site did not mount")
      const frame = await window.api.mods.siteRender(id, mounted.owner, {
        text: "scope probe",
        command: null
      })
      if (!frame || frame.tree.type !== "Button" || !frame.tree.press)
        throw new Error("Question probe button did not publish")
      return {
        owner: mounted.owner,
        action: {
          pane: frame.key,
          generation: frame.generation,
          plugin: frame.tree.press.plugin,
          handle: frame.tree.press.handle,
          kind: "press" as const,
          intentId: crypto.randomUUID()
        }
      }
    }, threadId)
    await page.evaluate(({ id, probe }) => window.api.mods.siteAct(id, probe.owner, probe.action), {
      id: threadId,
      probe: oldProbe
    })
    await run("probe")
    await until(
      async () => (await jobs()).some((job) => job.result?.text === "QUESTION_SITE_PROBE:1"),
      "the original probe really executes its guest SDK store call"
    )
    const modelStart = requests.length
    await composer.fill("[mods-native-question]")
    await composer.press("Enter")
    await until(
      async () =>
        (await dialog.count()) === 1 && (await dialog.innerText()).includes("Reviewed question?"),
      "actual model question presentation"
    )
    const jobsBefore = (await jobs()).map((job) => job.id)
    if (withdrawal === "uninstall") {
      const result = await page.evaluate((id) => window.api.plugins.delete(id), installedPluginId)
      assert(result.success, result.error)
      uninstalled = true
      assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
      assert(
        !(await page.evaluate(() => window.api.plugins.list())).some(
          (plugin) => plugin.id === installedPluginId
        )
      )
    } else {
      await page.evaluate(() => window.api.mods.configureGlobal(false))
    }
    await until(
      async () =>
        (await dialog.count()) === 1 &&
        (await dialog.innerText()).includes("ORIGINAL_NATIVE_QUESTION?"),
      `${withdrawal} preserves pending native model question and restores wording`
    )
    assert(!(await dialog.innerText()).includes("Visual explanation"))
    await assert.rejects(
      page.evaluate(
        ({ id, probe }) =>
          window.api.mods.siteAct(id, probe.owner, {
            ...probe.action,
            intentId: crypto.randomUUID()
          }),
        { id: threadId, probe: oldProbe }
      ),
      /MODS_UI_SITE_CLOSED/
    )
    await assert.rejects(
      page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "probe" }),
        { id: threadId, descriptor }
      ),
      withdrawal === "uninstall" ? /MODS_COMMAND_STALE/ : /MODS_DISABLED/
    )
    assert.deepEqual(
      (await jobs()).map((job) => job.id),
      jobsBefore
    )
    assert.equal(
      requests.length,
      modelStart + 1,
      `${withdrawal} and rejected guest calls do not invoke the model`
    )
    writeFileSync(
      join(artifacts, `${receipt}-guards.json`),
      JSON.stringify(
        {
          withdrawal,
          installedPluginId,
          oldOwner: oldProbe.owner,
          oldAction: oldProbe.action,
          sdkStoreCountBeforeOff: 1,
          oldOwnerRejected: true,
          oldCommandRejected: true,
          jobsBefore,
          modelRequests: requests.length - modelStart
        },
        null,
        2
      )
    )
    pass(
      `${withdrawal} rejects a previously working guest SDK button and command without new jobs or model calls`
    )
    await dialog.getByRole("radio", { name: /Keep original/ }).click()
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () =>
        (await page.getByText("NATIVE_QUESTION_OK", { exact: true }).count()) === 1 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      `the same pending native question completes after ${withdrawal} without a new user task`
    )
    assert.equal(await dialog.count(), 0)
    assert.equal(
      requests.length,
      modelStart + 2,
      "one original question and one answer continuation only"
    )
    assert.equal(
      await page.getByText(/MODS_(?:THREAD_CONTEXT_EXPIRED|CALL_SCOPE_CHANGED)/).count(),
      0
    )
    assert.equal(await page.getByText("Reviewed question?", { exact: true }).count(), 0)
    const toolResults = requests
      .slice(modelStart)
      .flatMap(
        (r) => (r as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
      )
      .filter((m) => m.role === "tool")
    assert.equal(toolResults.length, 1, "the native answer is submitted exactly once")
    assert(JSON.stringify(toolResults[0].content).includes("native_choice"))
    assert(JSON.stringify(toolResults[0].content).includes("submitted"))
    assert(JSON.stringify(toolResults[0].content).includes("Keep original"))
    assert(toolResults.every((m) => !JSON.stringify(m.content).includes("Visual explanation")))
    writeFileSync(
      join(artifacts, `${receipt}.json`),
      JSON.stringify(
        {
          withdrawal,
          installedPluginId,
          modelRequests: requests.length - modelStart,
          toolResults,
          oldOwner: oldProbe.owner,
          oldOwnerRejected: true,
          oldCommandRejected: true,
          jobsUnchanged: true
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(artifacts, `${receipt}.png`) })
    pass(
      `${withdrawal} restores native wording, rejects old guest SDK entry points, and completes the same original question exactly once`
    )
    completed = true
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { questionSiteApproval?: typeof dialog.showMessageBox }
      if (state.questionSiteApproval) dialog.showMessageBox = state.questionSiteApproval
      delete state.questionSiteApproval
    })
    try {
      // Remove this fixture's source so a second mode cannot inherit its hooks or persistent store.
      if (!uninstalled) {
        const removed = await page.evaluate(
          (id) => window.api.plugins.delete(id),
          installedPluginId
        )
        assert(removed.success, removed.error)
      }
    } catch (error) {
      cleanupFailure = { error }
      if (!completed) console.error("Question fixture cleanup failed", error)
    } finally {
      await page.evaluate(() => window.api.mods.configureGlobal(true))
    }
  }
  if (cleanupFailure) throw cleanupFailure.error
}
