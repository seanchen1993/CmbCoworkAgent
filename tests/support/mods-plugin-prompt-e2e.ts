import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Installed modules, real native chat, provider HTTP, durable SQLite and mounted renderer. */
export async function verifyPluginPrompt(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const held = new Map<string, () => void>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    writeFileSync(join(artifacts, "plugin-prompt-provider.json"), JSON.stringify(requests, null, 2))
    const text = JSON.stringify([...body.messages].reverse().find((row) => row.role === "user"))
    const id = `plugin-response-${requests.length}`
    const number = requests.length
    const finish = () => {
      if (response.destroyed) return
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model: "gpt-4",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: `PLUGIN_DONE_${number}` },
              finish_reason: "stop"
            }
          ]
        })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (text.includes("PARENT_BUSY") || text.includes("HOLD_SDK_START")) {
      const key = text.includes("PARENT_BUSY") ? "parent" : "child"
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model: "gpt-4",
          choices: [
            { index: 0, delta: { role: "assistant", content: "RUNNING_" }, finish_reason: null }
          ]
        })}\n\n`
      )
      held.set(key, finish)
    } else finish()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const project = join(workspace, "plugin-prompt-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "secret.txt"), "FILE_MUST_NOT_EXPAND")
  try {
    const id = await page.evaluate(
      async ({ project, url }) => {
        await window.api.models.setCustomConfig({
          id: "plugin-prompt",
          name: "Plugin prompt fixture",
          baseUrl: url,
          model: "gpt-4",
          apiKey: "fixture-key",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:plugin-prompt")
        const thread = await window.api.threads.create({
          title: "组件主动提交验收",
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:plugin-prompt", subagentsEnabled: false }
        })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, url: `http://127.0.0.1:${address.port}/v1` }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "prompt-native", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.tsx"] })))
    zip.addFile(
      "hooks/register.tsx",
      Buffer.from(`export function register(on){
      let replies=[],errors=[],events=[],completed=[];
      on("session.start",async($,e,next)=>{
        await $.command.register({name:"prompt-observe",description:"Submission receipts",immediate:true});return next(e)
      });
      on("command.run",{command:"prompt-observe"},()=>({text:JSON.stringify({replies,errors,events,completed})}));
      on("turn.complete",($,e,next)=>{completed.push({turnId:e.turnId,answer:e.answer});return next(e)});
      on("ui.render",{component:"AbovePrompt"},async($,e,next)=>{
        const {Box,Button}=$.ui.resolve(e);
        const lower=await next(e);
        return Box({children:[...["plain","as-user","omit","rewrite","drop-before","drop-after","local","held","literal","cancel"].map(mode=>
          Button({key:mode,label:"Submit "+mode,onPress:()=>{
            const text=mode==="held"?"HOLD_SDK_START":mode==="literal"?"/goal TASK_LITERAL @secret.txt":"TASK_"+mode;
            $.prompt.submit({text,...(mode==="as-user"?{asUser:true}:{})})
              .then(value=>{replies.push({mode,value})},error=>{errors.push({mode,error:String(error)})});
          }})),lower]})
      });
      on("prompt.submit",async($,e,next)=>{
        events.push({text:e.text,origin:e.origin,wait:e.wait,turnId:e.turnId});
        if(e.text==="TASK_drop-before")return {drop:"handled before core"};
        if(e.text==="TASK_local")return {text:"local handled reply"};
        const input=e.text==="TASK_rewrite"?{...e,text:"ACCEPTED_REWRITE",context:["HIDDEN_PLUGIN_CONTEXT"]}:e;
        const result=await next(input);
        if(e.text==="TASK_rewrite") {await next({...e,text:"MUST_NOT_REPLACE_CORE"});return {text:"public final rewrite"}};
        if(e.text==="TASK_omit")return {text:result.text};
        if(e.text==="TASK_drop-after")return {drop:"public reply after real core"};
        return result
      });
      on("ui.render",{component:"UserMessage"},($,e,next)=>{
        if(e.props.origin.kind!=="plugin")return next(e);
        const {Text}=$.ui.resolve(e);return Text({children:"Component source: "+e.props.origin.name+" | "+e.props.text})
      });
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "prompt-native.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "prompt-native"
    )!
    assert(mod?.digest)
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("组件主动提交验收", { exact: true }).first().click()
    const above = page.locator('[data-function-site="AbovePrompt"]')
    await above.getByRole("button", { name: "Submit plain", exact: true }).waitFor()
    const observe = async () => {
      const job = await page.evaluate(async (id) => {
        const command = (await window.api.mods.commands(id)).find(
          (row) => row.command === "prompt-observe"
        )!
        return window.api.mods.enqueue(id, command, { text: "" })
      }, id)
      await until(
        async () =>
          (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
            (row) => row.id === job.id && row.state === "succeeded"
          ),
        "prompt observer"
      )
      return JSON.parse(
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
          (row) => row.id === job.id
        )!.result!.text!
      ) as {
        replies: Array<{ mode: string; value: unknown }>
        errors: unknown[]
        completed: Array<{ turnId: string; answer: string }>
        events: Array<{ text: string; origin: unknown; wait: boolean; turnId?: string }>
      }
    }
    const history = () => page.evaluate((id) => window.api.threads.getMessages(id), id)
    const done = async (number: number) =>
      until(
        async () =>
          (await history()).some(
            (row) =>
              row.role === "assistant" && String(row.content).includes(`PLUGIN_DONE_${number}`)
          ),
        `native completion ${number}`
      )
    const click = (mode: string) =>
      above.getByRole("button", { name: `Submit ${mode}`, exact: true }).click()
    const submit = async (mode: string) => {
      const count = requests.length
      await click(mode)
      await until(async () => requests.length === count + 1, `actual HTTP ${mode}`)
      await done(count + 1)
      await until(
        async () => (await observe()).replies.some((row) => row.mode === mode),
        `started reply ${mode}`
      )
      await until(
        async () =>
          (await observe()).completed.some((row) =>
            row.answer.includes(`PLUGIN_DONE_${count + 1}`)
          ),
        `actual component turn completion ${mode}`
      )
      return requests[count]
    }
    const framed = JSON.stringify(await submit("plain"))
    assert(
      framed.includes("The prompt-native plugin sent a message:") && framed.includes("TASK_plain")
    )
    pass(
      "installed component button starts a real chat with the selected model and exact plugin framing"
    )
    const lastUser = (request: (typeof requests)[number]) =>
      JSON.stringify([...request.messages].reverse().find((row) => row.role === "user"))
    assert(!lastUser(await submit("as-user")).includes("The prompt-native plugin sent a message:"))
    assert(!lastUser(await submit("omit")).includes("The prompt-native plugin sent a message:"))
    pass(
      "asUser and lawful final origin omission change model framing without changing durable component identity"
    )
    const rewrite = JSON.stringify(await submit("rewrite"))
    assert(
      rewrite.includes("ACCEPTED_REWRITE") &&
        rewrite.includes("HIDDEN_PLUGIN_CONTEXT") &&
        !rewrite.includes("MUST_NOT_REPLACE_CORE") &&
        !rewrite.includes("public final rewrite")
    )
    assert.equal(
      (await history()).filter((row) => row.role === "user" && row.content === "ACCEPTED_REWRITE")
        .length,
      1
    )
    assert(!JSON.stringify(await history()).includes("HIDDEN_PLUGIN_CONTEXT"))
    pass(
      "repeated next launches once, preserves accepted text, sends hidden context only to the provider"
    )
    const beforeLocal = requests.length
    await click("drop-before")
    await click("local")
    await until(
      async () => (await observe()).replies.some((row) => row.mode === "local"),
      "local SDK reply"
    )
    assert.equal(requests.length, beforeLocal)
    assert(
      !(await history()).some(
        (row) => row.content === "TASK_drop-before" || row.content === "TASK_local"
      )
    )
    await submit("drop-after")
    assert((await history()).some((row) => row.content === "TASK_drop-after"))
    pass(
      "no-core handling creates no task or transcript; drop after core preserves the actual accepted task"
    )
    const beforeHold = requests.length
    await click("held")
    await until(
      async () => held.has("child") && requests.length === beforeHold + 1,
      "held actual provider"
    )
    await until(
      async () => (await observe()).replies.some((row) => row.mode === "held"),
      "SDK resolved on actual start"
    )
    assert(
      !(await history()).some(
        (row) =>
          row.role === "assistant" && String(row.content).includes(`PLUGIN_DONE_${beforeHold + 1}`)
      )
    )
    pass(
      "SDK public promise resolves at actual native start while its provider answer is still held"
    )
    held.get("child")!()
    held.delete("child")
    await done(beforeHold + 1)
    const literal = JSON.stringify(await submit("literal"))
    assert(literal.includes("TASK_LITERAL") && !literal.includes("FILE_MUST_NOT_EXPAND"))
    const metadata = await page.evaluate((id) => window.api.threads.get(id), id)
    assert.equal(metadata?.metadata?.agentMode, "normal")
    pass(
      "plugin /goal and @file text remains literal and does not change the conversation mode or expand private files"
    )
    const rows = (await history()).filter((row) => row.role === "user")
    assert(
      rows.every(
        (row) => row.prompt_origin?.kind === "plugin" && row.prompt_origin.name === "prompt-native"
      )
    )
    await page.locator('[data-plugin-prompt-source="prompt-native"]').first().waitFor()
    await page
      .getByText("Component source: prompt-native | /goal TASK_LITERAL @secret.txt", {
        exact: true
      })
      .first()
      .waitFor()
    await page.screenshot({
      path: join(artifacts, "plugin-prompt-chat-source.png"),
      fullPage: true
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("组件主动提交验收", { exact: true }).first().click()
    await page.locator('[data-plugin-prompt-source="prompt-native"]').first().waitFor()
    assert(
      (await history())
        .filter((row) => row.role === "user")
        .every((row) => row.prompt_origin?.name === "prompt-native")
    )
    pass(
      "durable source reaches real UserMessage hooks and remains visible after reopening the chat"
    )
    assert((await observe()).completed.length >= 7)
    pass(
      "real native turn-complete callbacks still run after every component task, without inheriting an expired model-hook entry"
    )
    // An ordinary desktop turn keeps its actual physical owner while the component waits.
    const composer = page.locator("textarea.composer-textarea")
    const parentCount = requests.length
    await composer.fill("PARENT_BUSY ordinary desktop turn")
    await composer.press("Enter")
    await until(async () => held.has("parent"), "ordinary busy parent")
    await click("plain")
    await until(
      async () => (await observe()).events.some((row) => row.text === "TASK_plain"),
      "child core during busy parent"
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(requests.length, parentCount + 1)
    held.get("parent")!()
    held.delete("parent")
    await until(
      async () => requests.length === parentCount + 2,
      "queued child after parent settles"
    )
    await done(parentCount + 2)
    pass(
      "component queues during a real desktop turn, sends no second HTTP while busy and runs once after it settles"
    )
    const final = await observe()
    assert.equal(final.errors.length, 0)
    assert(final.events.every((event) => event.wait === false && event.turnId === undefined))
    const ordinary = (await history()).find(
      (row) => row.role === "user" && String(row.content).includes("PARENT_BUSY")
    )
    assert(ordinary && ordinary.prompt_origin === undefined)
    pass("ordinary composer and durable human messages remain usable alongside plugin submissions")
    const beforeRevoke = requests.length
    await page.evaluate((id) => {
      const evidence = window as unknown as { pluginRevokeParent?: string }
      evidence.pluginRevokeParent = undefined
      window.api.agent.invoke(
        id,
        "PARENT_BUSY holds a queued component before revoke",
        (event) => {
          if (event.type === "done" || event.type === "error")
            evidence.pluginRevokeParent = event.type
        },
        "custom:plugin-prompt",
        "normal"
      )
    }, id)
    await until(async () => held.has("parent"), "busy parent before revoke")
    await click("cancel")
    await until(
      async () => (await observe()).events.some((row) => row.text === "TASK_cancel"),
      "actual child dispatch before revoke"
    )
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "prompt-native"), id)
    held.get("parent")!()
    held.delete("parent")
    // Revocation retires the old runtime, so its parent may terminate with SESSION_CLOSED.
    // That security boundary is distinct from submitting while busy (verified above).
    await until(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { pluginRevokeParent?: string }).pluginRevokeParent !== undefined
        ),
      "actual parent terminal after revoke"
    )
    assert.equal(requests.length, beforeRevoke + 1)
    assert(!(await history()).some((row) => row.content === "TASK_cancel"))
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod }
    )
    await above.getByRole("button", { name: "Submit plain", exact: true }).waitFor()
    await submit("plain")
    assert.equal(requests.length, beforeRevoke + 2)
    assert(!(await history()).some((row) => row.content === "TASK_cancel"))
    pass(
      "revoking a real waiting component cancels its task; approving it again never replays the cancelled task"
    )
    const afterRevokeParent = requests.length
    await composer.fill("ORDINARY_AFTER_REVOKE")
    await composer.press("Enter")
    await until(async () => requests.length === afterRevokeParent + 1, "ordinary chat after revoke")
    await done(afterRevokeParent + 1)
    assert(
      (await history()).some(
        (row) => row.content === "ORDINARY_AFTER_REVOKE" && row.prompt_origin === undefined
      )
    )
    pass("ordinary desktop chat still completes after component revocation and reapproval")
    // Install the actual user-facing resource pack, then use its actual rendered button.
    // A busy unrelated parent must not consume the example's own completion binding.
    const example = new AdmZip()
    example.addLocalFolder(resolve("resources/mods/queued-review"))
    writeFileSync(join(artifacts, "queued-review.zip"), example.toBuffer())
    const exampleInstall = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "queued-review.zip", "local"),
      [...example.toBuffer()]
    )
    assert(exampleInstall.success, exampleInstall.error)
    const exampleMod = (
      await page.evaluate((id) => window.api.mods.status(id), id)
    ).functionMods!.find((row) => row.name === "queued-review")!
    assert(exampleMod?.digest)
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod: exampleMod }
    )
    const exampleButton = above.getByRole("button", { name: "完成需求并接着检视", exact: true })
    await exampleButton.waitFor()
    const beforeExample = requests.length
    await composer.fill("PARENT_BUSY before the actual review example")
    await composer.press("Enter")
    await until(async () => held.has("parent"), "busy parent before example")
    await exampleButton.click()
    await until(
      async () =>
        (await observe()).events.some((row) => row.text.startsWith("根据本对话已经确认的需求")),
      "actual example core while parent is busy"
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(requests.length, beforeExample + 1)
    held.get("parent")!()
    held.delete("parent")
    await until(
      async () => requests.length === beforeExample + 3,
      "example development then review"
    )
    await done(beforeExample + 3)
    assert(lastUser(requests[beforeExample + 1]).includes("根据本对话已经确认的需求"))
    assert(lastUser(requests[beforeExample + 2]).includes("只检视刚才任务的代码修改"))
    await until(
      async () =>
        (await observe()).completed.some((row) =>
          row.answer.includes(`PLUGIN_DONE_${beforeExample + 3}`)
        ),
      "actual review completion"
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(requests.length, beforeExample + 3)
    const exampleRows = (await history()).filter(
      (row) => row.prompt_origin?.name === "queued-review"
    )
    assert.equal(exampleRows.length, 2)
    await page.locator('[data-plugin-prompt-source="queued-review"]').first().waitFor()
    await page.screenshot({ path: join(artifacts, "queued-review-example.png"), fullPage: true })
    pass(
      "actual shipped example waits for its own development turn, submits one review from real completion, and never loops"
    )
    writeFileSync(
      join(artifacts, "plugin-prompt-evidence.json"),
      JSON.stringify({ final, requests: requests.length, rows: await history() }, null, 2)
    )
  } finally {
    for (const finish of held.values()) finish()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
