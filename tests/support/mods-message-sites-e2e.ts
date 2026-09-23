import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyMessageSites(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  requests: Array<{ messages: unknown }>,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "message-sites-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Message sites E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/message-sites"))
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "message-sites.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "message-sites")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Message sites E2E", { exact: true }).first().click()
  const users = page.locator('[data-function-site="UserMessage"]')
  const assistants = page.locator('[data-function-site="AssistantMessage"]')
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const send = async (text: string, count: number): Promise<void> => {
    await composer.fill(text)
    await submit.click()
    await until(
      async () =>
        (await users.count()) >= count &&
        (await assistants.count()) >= count &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "real message turn completes and renders both message sites"
    )
  }
  const started = requests.length
  try {
    await send("MESSAGE_ORIGINAL_ONE", 1)
    assert((await users.allInnerTexts()).join("\n").includes("MESSAGE_ORIGINAL_ONE"))
    assert(!(await assistants.allInnerTexts()).join("\n").includes("DISPLAY_ONLY_"))
    const job = await page.evaluate(async (id) => {
      const descriptor = (await window.api.mods.commands(id)).find(
        (command) => command.command === "message-style"
      )
      if (!descriptor) throw Error("Missing style command")
      return window.api.mods.enqueue(id, descriptor, { text: "custom" })
    }, threadId)
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (item) => item.id === job.id && item.state === "succeeded"
        ),
      "real style command finishes"
    )
    await until(
      async () =>
        (await users.allInnerTexts()).every((text) => text.includes("DISPLAY_ONLY_UserMessage")) &&
        (await assistants.allInnerTexts()).every((text) =>
          text.includes("DISPLAY_ONLY_AssistantMessage")
        ),
      "existing visible message owners redraw"
    )
    await send("MESSAGE_ORIGINAL_TWO", 2)
    await until(
      async () =>
        (await users.allInnerTexts()).filter((text) => text.includes("DISPLAY_ONLY_UserMessage"))
          .length >= 2,
      "two user owners coexist"
    )
    await page.screenshot({ path: join(artifacts, "message-sites-custom.png") })
    const persisted = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    const wire = JSON.stringify(requests.slice(started))
    assert(wire.includes("MESSAGE_ORIGINAL_ONE") && wire.includes("MESSAGE_ORIGINAL_TWO"))
    assert(
      !wire.includes("DISPLAY_ONLY_"),
      "presentation rewrites must never enter the model transcript"
    )
    assert(
      !JSON.stringify(persisted).includes("DISPLAY_ONLY_"),
      "presentation rewrites must never persist as messages"
    )
    pass(
      "UserMessage and AssistantMessage hooks redraw multiple rows without changing model input or persisted history"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Message sites E2E", { exact: true }).first().click()
    await until(
      async () =>
        (await users.allInnerTexts()).filter((text) => text.includes("DISPLAY_ONLY_UserMessage"))
          .length >= 2,
      "message display preference survives renderer reload"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        !(await users.allInnerTexts()).join("\n").includes("DISPLAY_ONLY_") &&
        !(await assistants.allInnerTexts()).join("\n").includes("DISPLAY_ONLY_"),
      "off restores original rich message content"
    )
    assert((await users.allInnerTexts()).join("\n").includes("MESSAGE_ORIGINAL_TWO"))
    await page.screenshot({ path: join(artifacts, "message-sites-off.png") })
    writeFileSync(
      join(artifacts, "message-sites-evidence.json"),
      JSON.stringify(
        {
          threadId,
          modelRequests: requests.length - started,
          persistedMessages: persisted.length,
          originalWire: true,
          originalHistory: true,
          off: true
        },
        null,
        2
      )
    )
    pass("message render sites survive reload and disabling restores original transcript rendering")
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
