import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

/** Installed guest, production IPC, original React factories and actual native answer service. */
export async function verifyNativeEngine(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "native-engine-project")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Native engine E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
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
    Buffer.from(JSON.stringify({ name: "native-engine", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"engine-output",description:"Original command output",immediate:true});
      await $.command.register({name:"engine-question",description:"Actual native question"});
      return next(e)
    });
    on("command.run",{command:"engine-output"},()=>({text:"DURABLE_ENGINE_OUTPUT"}));
    on("command.run",{command:"engine-question"},async($)=>({
      text:"ENGINE_ANSWER:"+await $.ui.ask("Original engine question?",{header:"Plan",options:["Careful","Fast"]})
    }));
    on("ui.render",async($,e,next)=>{
      const {Box,Text}=$.ui.resolve(e);
      if(e.component==="PromptHint") return next({...e,props:{...e.props,hint:"NATIVE_ENGINE_HINT"}});
      if(e.component==="SessionMode") return Box({children:[Text({children:"DIY · "}),await next(e)]});
      if(e.component==="UserMessage") return Box({children:[Text({children:"ENGINE_USER_CONTEXT"}),
        await next({...e,props:{...e.props,text:"ENGINE_NATIVE_USER "+e.props.text}}),{type:"engine",ref:999}]});
      if(e.component==="AssistantMessage") return Box({children:[Text({children:"ENGINE_ASSISTANT_CONTEXT"}),
        await next({...e,props:{...e.props,text:"**ENGINE_NATIVE_ASSISTANT** "+e.props.text}})]});
      if(e.component==="CommandOutput") return Box({children:[Text({children:"ENGINE_OUTPUT_CONTEXT"}),
        await next({...e,props:{...e.props,text:"ENGINE_NATIVE_OUTPUT "+e.props.text}})]});
      if(e.component==="AskUserQuestion") return Box({flexDirection:"column",children:[Text({children:"ENGINE_QUESTION_CONTEXT"}),
        await next({...e,props:{...e.props,questions:e.props.questions.map(q=>({...q,
          header:"Reviewed",question:"Reviewed engine question?"}))}})]});
      return next(e)
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "native-engine.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "native-engine"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Native engine E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  await until(
    async () => (await composer.getAttribute("placeholder")) === "NATIVE_ENGINE_HINT",
    "native protected hint reaches original composer"
  )
  const trigger = page.getByRole("button", { name: /^执行模式：Solo。/ })
  await until(async () => (await trigger.innerText()).includes("DIY ·"), "inline mode label")
  assert.equal(await trigger.count(), 1)
  assert.equal(await trigger.locator("button").count(), 0)
  await trigger.focus()
  await page.keyboard.press("Enter")
  await until(
    async () => (await page.getByRole("slider", { name: "执行模式", exact: true }).count()) === 1,
    "original mode popover opens from keyboard"
  )
  await page.keyboard.press("Escape")
  pass("real next engine keeps one original mode trigger and original keyboard popover")

  const before = requests.length
  await composer.fill("ENGINE_STORED_ORIGINAL")
  await composer.press("Enter")
  const users = page.locator('[data-function-site="UserMessage"]')
  const assistants = page.locator('[data-function-site="AssistantMessage"]')
  await until(
    async () =>
      (await users.allInnerTexts()).join("\n").includes("ENGINE_NATIVE_USER") &&
      (await assistants.allInnerTexts()).join("\n").includes("ENGINE_NATIVE_ASSISTANT") &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "actual message turn with wrapped native Markdown"
  )
  assert(
    await users.locator("[data-chat-search-text]").filter({ hasText: "ENGINE_NATIVE_USER" }).count()
  )
  assert(await assistants.locator("strong").filter({ hasText: "ENGINE_NATIVE_ASSISTANT" }).count())
  assert((await users.innerText()).includes("ENGINE_USER_CONTEXT"))
  assert.equal((await users.innerText()).split("ENGINE_STORED_ORIGINAL").length - 1, 2)
  const stored = await page.evaluate((id) => window.api.threads.getMessages(id), id)
  const persisted = JSON.stringify(stored)
  const wire = JSON.stringify(requests.slice(before))
  assert(persisted.includes("ENGINE_STORED_ORIGINAL") && wire.includes("ENGINE_STORED_ORIGINAL"))
  assert(!persisted.includes("ENGINE_NATIVE_") && !wire.includes("ENGINE_NATIVE_"))
  pass(
    "actual core ref keeps user search spans and assistant Markdown; unknown ref uses zero and history/model stay original"
  )

  const enqueue = async (command: string) =>
    page.evaluate(
      async ({ id, command }) => {
        const descriptor = (await window.api.mods.commands(id)).find(
          (row) => row.command === command
        )!
        return window.api.mods.enqueue(id, descriptor, { text: "" })
      },
      { id, command }
    )
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
  const outputJob = await enqueue("engine-output")
  await until(
    async () => (await jobs()).some((row) => row.id === outputJob.id && row.state === "succeeded"),
    "actual command finishes"
  )
  const { openModsResults } = await import("./mods-sidebar-navigation")
  await openModsResults(page)
  const outputs = page.locator('[data-function-site="CommandOutput"]')
  await until(
    async () => (await outputs.allInnerTexts()).join("\n").includes("ENGINE_NATIVE_OUTPUT"),
    "native command output inside wrapper"
  )
  assert(await outputs.locator("pre").filter({ hasText: "ENGINE_NATIVE_OUTPUT" }).count())
  assert.equal(
    (await jobs()).find((row) => row.id === outputJob.id)?.result?.text,
    "DURABLE_ENGINE_OUTPUT"
  )
  pass(
    "engine delegates command output to original pre renderer without changing durable command result"
  )

  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { nativeEngineApproval: typeof dialog.showMessageBox }
    state.nativeEngineApproval = dialog.showMessageBox
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox
  })
  try {
    const questionJob = await enqueue("engine-question")
    const dialog = page.getByRole("dialog", { name: "需要用户输入" })
    await until(
      async () =>
        (await dialog.count()) === 1 &&
        (await dialog.innerText()).includes("Reviewed engine question?"),
      "wrapped actual question"
    )
    const question = dialog.locator('[data-function-site="AskUserQuestion"]')
    assert((await question.innerText()).includes("ENGINE_QUESTION_CONTEXT"))
    const pending = await page.evaluate((id) => window.api.userInput.getPending(id), id)
    assert(pending)
    assert.equal(await question.getAttribute("data-function-request-id"), pending.requestId)
    assert.equal(await dialog.getByRole("radio").count(), 2)
    assert.equal(await dialog.getByRole("button", { name: "提交", exact: true }).count(), 1)
    const radioBounds = await dialog.getByRole("radio").last().boundingBox()
    const submitBounds = await dialog
      .getByRole("button", { name: "提交", exact: true })
      .boundingBox()
    assert(
      radioBounds && submitBounds && submitBounds.y >= radioBounds.y + radioBounds.height,
      "the original footer stays below the complete native question body"
    )
    await dialog.getByRole("radio", { name: /Careful/ }).click()
    await page.screenshot({ path: join(artifacts, "native-engine-question.png") })
    await dialog.getByRole("button", { name: "提交", exact: true }).click()
    await until(
      async () =>
        (await jobs()).some(
          (row) => row.id === questionJob.id && row.result?.text === "ENGINE_ANSWER:Careful"
        ),
      "original service receives one native answer"
    )
    assert.equal(await dialog.count(), 0)
    pass(
      "actual native question is in engine tail once; original radio and answer service still deliver Careful"
    )
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (
        globalThis as unknown as {
          nativeEngineApproval: typeof dialog.showMessageBox
        }
      ).nativeEngineApproval
    })
  }
  await page.screenshot({ path: join(artifacts, "native-engine-chat.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(
    async () => !(await users.allInnerTexts()).join("\n").includes("ENGINE_NATIVE_USER"),
    "off restores original factory"
  )
  assert((await users.innerText()).includes("ENGINE_STORED_ORIGINAL"))
  assert(!(await trigger.innerText()).includes("DIY ·"))
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  writeFileSync(
    join(artifacts, "native-engine-evidence.json"),
    JSON.stringify(
      {
        threadId: id,
        providerRequests: requests.length - before,
        persistedOriginal: true,
        nativeMarkdown: true,
        unknownRefZero: true,
        originalAnswer: "Careful",
        offRestoresOriginal: true
      },
      null,
      2
    )
  )
  pass(
    "disabling Mods restores original chat and mode UI after actual model turn and command interactions"
  )
}
