import { openModUserConfig, openModsSettings } from "./mods-sidebar-navigation"
import type { ModCommandDescriptor } from "../../src/shared/mods/types"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Actual ZIP, approvals, root protection, utility guest, configured HTTP model and React reload. */
export async function verifyStartupModel(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  modelWaitMs = 0
) {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    if (modelWaitMs) await new Promise((done) => setTimeout(done, modelWaitMs))
    response.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (choices: unknown[], usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({
          id: "startup-model",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices,
          ...(usage ? { usage } : {})
        })}\n\n`
      )
    frame([
      { index: 0, delta: { role: "assistant", content: "STARTUP_MODEL_OK" }, finish_reason: "stop" }
    ])
    frame([], { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 })
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    const id = await page.evaluate(
      async ({ workspace, baseUrl }) => {
        await window.api.models.setCustomConfig({
          id: "startup-model",
          name: "Startup fixture",
          baseUrl,
          model: "gpt-4",
          apiKey: "local-fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 512
        })
        await window.api.models.setDefault("custom:startup-model")
        const thread = await window.api.threads.create({
          title: "启动分析与组合验证",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, baseUrl: `http://127.0.0.1:${address.port}/v1` }
    )
    const install = async (name: string, source: string, primary: boolean) => {
      const zip = new AdmZip()
      zip.addFile(
        "plugin.json",
        Buffer.from(
          JSON.stringify({
            name,
            ...(primary
              ? {
                  userConfig: {
                    tone: {
                      type: "string",
                      title: "分析风格",
                      description: "明确重载后用新风格做一次独立分析",
                      default: "warm"
                    }
                  }
                }
              : {})
          })
        )
      )
      zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
      zip.addFile("hooks/register.ts", Buffer.from(source))
      const installed = await page.evaluate(
        (bytes) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, "startup-fixture.zip", "local"),
        [...zip.toBuffer()]
      )
      assert(installed.success, installed.error)
      const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
        (row) => row.name === name
      )!
      assert(mod?.digest)
      await page.evaluate(
        ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
        { id, mod }
      )
      return mod
    }
    await install(
      "startup-model-rules",
      `export function register(on){
      on("prompt.compose",async($,e,next)=>{const out=await next(e);return {sections:[...out.sections,
        {id:"second-rule",scope:"session",text:"SECOND_COMPONENT_RULE"}]}})
    }`,
      false
    )
    const mod = await install(
      "startup-model-demo",
      `export function register(on,options){
      on("prompt.compose",async($,e,next)=>{
        const own=await $.prompt.compose();
        if(!JSON.stringify(own).includes("NATIVE_STARTUP_RULE"))throw Error("wrong model snapshot");
        const out=await next(e);return {sections:[...out.sections,{id:"primary-rule",scope:"session",text:"STYLE_"+options.tone}]}
      });
      on("session.start",async($,e,next)=>{
        const before=next.budget;
        const reply=await $.model.complete({model:"default",system:"NATIVE_STARTUP_RULE",prompt:"STARTUP_INPUT",maxTokens:32});
        if(!reply.isAnswered)throw Error("startup model did not answer");
        const text=reply.text;
        ${
          modelWaitMs
            ? `const after=next.budget;
          if(after.ms!==10000||before.remainingMs-after.remainingMs>2000)
            throw Error("model wait consumed the own hook budget");`
            : ""
        }
        await $.command.register({name:"startup-result",description:options.tone+":"+text,immediate:true});return next(e)
      });on("command.run",{command:"startup-result"},async($)=>({text:"RESULT:"+options.tone}))
    }`,
      true
    )
    const commands = async () => {
      let rows: ModCommandDescriptor[] | undefined
      await until(async () => {
        try {
          rows = await page.evaluate((id) => window.api.mods.commands(id), id)
          return true
        } catch (error) {
          if (String(error).includes("MODS_RUNTIME_SESSION_BUSY")) return false
          throw error
        }
      }, "startup registration is ready for a read-only command listing")
      assert(rows)
      return rows
    }
    const startupCommands = await commands()
    writeFileSync(
      join(artifacts, "startup-registration.json"),
      JSON.stringify(
        {
          commands: startupCommands,
          logs: await page.evaluate((id) => window.api.mods.logs(id), id),
          requests
        },
        null,
        2
      )
    )
    assert(
      startupCommands.some(
        (row) => row.command === "startup-result" && row.name === "warm:STARTUP_MODEL_OK"
      )
    )
    assert.equal(requests.length, 1)
    assert(JSON.stringify(requests[0]).includes("STYLE_warm"))
    assert(JSON.stringify(requests[0]).includes("SECOND_COMPONENT_RULE"))
    pass(
      "Real first startup analyzes once with both installed components and its actual prompt snapshot"
    )
    if (modelWaitMs)
      pass(
        "Actual utility guest and configured HTTP model exceed ten seconds without consuming the hook's ten-second own budget"
      )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("启动分析与组合验证", { exact: true }).first().click()
    await openModsSettings(page)
    const form = await openModUserConfig(page, mod.pluginId)
    await form.getByLabel("分析风格").fill("formal")
    await form.getByRole("button", { name: "保存", exact: true }).click()
    await until(async () => {
      const view = await page.evaluate(
        ({ id, mod }) => window.api.mods.userConfig(id, mod.pluginId),
        { id, mod }
      )
      return view.state === "failed" && view.savedRevision === 1 && view.effectiveRevision === 0
    }, "automatic adoption cannot spend model tokens")
    assert.equal(requests.length, 1)
    assert(
      (await commands()).some(
        (row) => row.command === "startup-result" && row.name === "warm:STARTUP_MODEL_OK"
      )
    )
    pass(
      "A normal parameter save keeps the running composition and makes zero extra model requests"
    )
    await form.getByRole("button", { name: "重新加载当前组合", exact: true }).click()
    await until(
      async () =>
        (await commands()).some(
          (row) => row.command === "startup-result" && row.name === "formal:STARTUP_MODEL_OK"
        ),
      "explicit reload publishes the new model-backed registration"
    )
    await openModUserConfig(page, mod.pluginId)
    await form
      .getByRole("status")
      .filter({ hasText: "当前对话已应用" })
      .waitFor({
        timeout: modelWaitMs ? 60000 : 15000
      })
    assert(
      (await commands()).some(
        (row) => row.command === "startup-result" && row.name === "formal:STARTUP_MODEL_OK"
      )
    )
    assert.equal(requests.length, 2)
    assert(JSON.stringify(requests[1]).includes("STYLE_formal"))
    assert(JSON.stringify(requests[1]).includes("SECOND_COMPONENT_RULE"))
    assert(!JSON.stringify(requests[1]).includes("STYLE_warm"))
    pass(
      "The native explicit reload analyzes once using the new complete composition, with no old rules"
    )
    await page.screenshot({ path: join(artifacts, "startup-model-reloaded.png"), fullPage: true })
    const composer = page.locator("textarea.composer-textarea")
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await composer.fill("/startup-result")
    // Follow the real slash picker: first Enter selects the command, then submit it.
    await composer.press("Enter")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
          (job) => job.result?.text === "RESULT:formal"
        ),
      "the reloaded plugin is usable from the actual chat composer"
    )
    assert.equal(requests.length, 2)
    pass(
      "The saved and reloaded component remains usable by a slash command in the actual conversation"
    )
  } finally {
    writeFileSync(
      join(artifacts, "startup-model-evidence.json"),
      JSON.stringify({ requests, modelWaitMs }, null, 2)
    )
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
