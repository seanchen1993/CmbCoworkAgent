import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"

/** Real main graph afterAgent, native usage reader, utility guest and actual sidebar. */
export async function verifySessionMeasure(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
) {
  let calls = 0
  const secret = "sk-fixture-secret-123456789"
  writeFileSync(join(workspace, "AGENTS.md"), `Fixture protected system text: ${secret}\n`)
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    calls++
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      `data: ${JSON.stringify({
        id: `measure-${calls}`,
        object: "chat.completion.chunk",
        model: "gpt-4",
        choices: [
          {
            index: 0,
            delta:
              calls === 4
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "policy-native-task",
                        type: "function",
                        function: {
                          name: "task",
                          arguments: JSON.stringify({
                            subagent_type: "general-purpose",
                            description:
                              "MEASURE_NATIVE_TASK: return a brief answer without using tools."
                          })
                        }
                      }
                    ]
                  }
                : {
                    role: "assistant",
                    content: `MEASURE_DONE_${calls}${calls === 5 || calls === 6 ? " " + secret : ""}`
                  },
            finish_reason: calls === 4 ? "tool_calls" : "stop"
          }
        ],
        usage: {
          prompt_tokens: calls === 1 ? 100 : 150,
          completion_tokens: 5,
          total_tokens: calls === 1 ? 105 : 155
        }
      })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    const id = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.models.setCustomConfig({
          id: "measure-fixture",
          name: "Measurement fixture",
          model: "gpt-4",
          baseUrl: url,
          apiKey: "fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:measure-fixture")
        const thread = await window.api.threads.create({
          title: "真实任务用量通知",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.threads.patchMetadata(id, { set: { model: "custom:measure-fixture" } })
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "measurement-board", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.tsx"]}'))
    zip.addFile(
      "hooks/register.tsx",
      Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"measure-read",description:"Actual measurement",immediate:true});return next(e)});
      on("session.measure",async($,e,next)=>{const start=await $.clock.now();
        await $.store.set("measurement",e);await $.store.set("count",(await $.store.get("count")??0)+1);
        await $.ui.open({id:"usage",title:"真实任务用量"});await $.ui.invalidate("ui.render");
        await $.store.set("hookMs",(await $.clock.now())-start);return next(e)});
      on("command.run",{command:"measure-read"},async($)=>({text:JSON.stringify({measurement:await $.store.get("measurement"),count:await $.store.get("count"),hookMs:await $.store.get("hookMs")})}));
      on("ui.render",{component:"Pane",requestId:"usage"},async($,e)=>{
        const value=await $.store.get("measurement");const {Box,Text}=$.ui.resolve(e);
        return <Box><Text>{value?"实际输入量 "+value.context.tokens+" / "+value.context.window:"尚未返回用量"}</Text></Box>
      })
    }`)
    )
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "measure.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "measurement-board"
    )!
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("真实任务用量通知", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    const idle = async () =>
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
    const read = async () => {
      const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
        (row) => row.command === "measure-read"
      )!
      const job = await page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
        { id, descriptor }
      )
      await until(
        async () =>
          (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
            (row) => row.id === job.id && row.state === "succeeded"
          ),
        "native measurement command"
      )
      const result = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
        (row) => row.id === job.id
      )!
      return JSON.parse(String(result.result?.text))
    }
    await composer.fill("measure first actual response")
    await composer.press("Enter")
    await until(async () => calls === 1 && (await idle()), "first real graph completed")
    const first = await read()
    assert.equal(first.count, 1)
    assert.equal(first.measurement.context.tokens, 100)
    assert.deepEqual(first.measurement.changed, ["context"])
    assert.deepEqual(first.measurement.rateLimits, [])
    assert.equal(first.measurement.cost, undefined)
    pass(
      "Real afterAgent publishes actual provider usage once before the original runtime releases"
    )
    await openModsResults(page)
    await until(
      async () =>
        (await page.locator("[data-claw-results]").textContent())?.includes("实际输入量 100") ??
        false,
      "actual measurement pane"
    )
    await page.screenshot({ path: join(artifacts, "session-measure.png"), fullPage: true })
    pass(
      "A real independently installed component displays native measurement in the right sidebar"
    )
    await composer.fill("measure changed actual response")
    await composer.press("Enter")
    await until(async () => calls === 2 && (await idle()), "second graph completed")
    const second = await read()
    assert.equal(second.count, 2)
    assert.equal(second.measurement.context.tokens, 150)
    pass(
      "The following physical run publishes its new actual fill without reusing the previous lease"
    )
    await composer.fill("same reported fill")
    await composer.press("Enter")
    await until(async () => calls === 3 && (await idle()), "third graph completed")
    assert.equal((await read()).count, 2)
    pass("An unchanged actual reading does not generate another notification")
    await page.evaluate((id) => window.api.mods.configure(id, false, true), id)
    await composer.fill("ordinary chat with Mods off")
    await composer.press("Enter")
    await until(
      async () => calls === 6 && (await idle()),
      "policy-only native task and graph completed"
    )
    const body = await page.locator("body").textContent()
    assert(body?.includes("MEASURE_DONE_6"))
    assert(!body?.includes(secret), "policy-only actual renderer must not receive the raw secret")
    for (const request of requests.slice(3, 6)) {
      const system = request.messages.filter((message) => message.role === "system")
      assert(
        !JSON.stringify(system).includes(secret),
        "policy-only real HTTP system must be protected"
      )
    }
    pass(
      "Mods-off, policy-on ordinary chat and an actual native task protect HTTP system and rendered model output"
    )
    await page.evaluate((id) => window.api.mods.configure(id, false, false), id)
    await composer.fill("ordinary chat with both options off")
    await composer.press("Enter")
    await until(async () => calls === 7 && (await idle()), "both-off native graph completed")
    assert((await page.locator("body").textContent())?.includes("MEASURE_DONE_7"))
    pass("Both options off retains the original ordinary chat path")
    await page.evaluate((id) => window.api.mods.configure(id, true, false), id)
    await composer.fill("ordinary chat with only Mods on")
    await composer.press("Enter")
    await until(async () => calls === 8 && (await idle()), "Mods-only graph completed")
    assert((await page.locator("body").textContent())?.includes("MEASURE_DONE_8"))
    pass("All four Mods/content-protection combinations retain ordinary chat")
    const removed = await page.evaluate((plugin) => window.api.plugins.delete(plugin), mod.pluginId)
    assert(removed.success, removed.error)
    await page.evaluate((id) => window.api.mods.configure(id, true, true), id)
    await composer.fill("protected ordinary chat without any installed component")
    await composer.press("Enter")
    await until(async () => calls === 9 && (await idle()), "source-free protected graph completed")
    assert((await page.locator("body").textContent())?.includes("MEASURE_DONE_9"))
    assert(
      !JSON.stringify(requests[8].messages.filter((message) => message.role === "system")).includes(
        secret
      )
    )
    pass("No installed components still protects the actual HTTP system prompt and completes chat")
    writeFileSync(
      join(artifacts, "session-measure-performance.json"),
      JSON.stringify(
        {
          scope:
            "Two actual QuickJS observer bodies including native store and UI operations; excludes reader and model latency",
          hookMs: [first.hookMs, second.hookMs],
          figuresInvented: false
        },
        null,
        2
      )
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
