import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Actual composer → native runtime → utility guest chain → HTTP provider and SQLite history. */
export async function verifyPromptContext(page: Page, workspace: string, artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    writeFileSync(join(artifacts, "prompt-context-provider.json"), JSON.stringify(requests, null, 2))
    const tool = body.messages.at(-1)?.role === "user" &&
      JSON.stringify(body.messages.at(-1)).includes("[tool]")
    const id = `context-response-${requests.length}`
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
      choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [{ index: 0,
        id: "context-ls", type: "function", function: { name: "ls", arguments: '{"path":"."}' }
      }] } : { content: "CONTEXT_DONE" }) }, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-4",
      choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const project = join(workspace, "context-project")
  const nested = join(project, "nested")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(nested)
  writeFileSync(join(project, "AGENTS.md"), "PROJECT_NATIVE")
  writeFileSync(join(nested, "AGENTS.override.md"), "LOCAL_NATIVE")
  try {
    const id = await page.evaluate(async ({ nested, url }) => {
      await window.api.models.setCustomConfig({ id: "context", name: "Context fixture",
        model: "gpt-4", apiKey: "fixture-key", baseUrl: url, maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:context")
      const row = await window.api.threads.create({ title: "规范与提醒验收",
        workspacePath: nested, agentMode: "normal" })
      const id = (row as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, nested)
      await window.api.threads.patchMetadata(id, { set: { model: "custom:context", outputStyle: "concise" } })
      await window.api.mods.configure(id, true, true)
      return id
    }, { nested, url: `http://127.0.0.1:${address.port}/v1` })
    for (const [name, code] of [
      ["context-a", `
        let contextCount=0,attachmentCount=0;
        on("session.start",async($,e,next)=>{await $.command.register({name:"context-mode",description:"Mode"});return next(e)});
        on("command.run",{command:"context-mode"},async($,e)=>{await $.store.set("mode",e.args);return {text:"MODE:"+e.args}});
        on("prompt.context",async($,e,next)=>{
          const number=++contextCount;
          const mode=await $.store.get("mode")||"files";
          if(mode==="drop")return next({...e,blocks:[]});
          if(mode==="text")return next({...e,blocks:[{name:"claudeMd",text:"TEXT_REWRITTEN"}]});
          if(!e.instructionFiles)return next(e);
          const calculated=await $.prompt.context({blocks:[{name:"sdk",text:"SDK_CALCULATION_ONLY"}]});
          if(mode==="refresh")$.ui.invalidate("prompt.context");
          const out=await next({...e,instructionFiles:e.instructionFiles.filter(f=>f.kind!=="user").reverse()
            .map(f=>({...f,content:f.kind==="project"?"PROJECT_REWRITTEN":f.content}))});
          return {...out,blocks:[...out.blocks,{name:"counter",text:"CONTEXT_COUNT:"+number},
            {name:"calculated",text:"SDK_RESULT:"+JSON.stringify(calculated)}]}
        });
        on("prompt.attachment",async($,e,next)=>{
          if(e.type!=="output_style"||e.origin.kind!=="engine"||e.text.includes("<system-reminder>"))
            return {text:"INVALID_PRODUCER"};
          const calculated=await $.prompt.attachment({type:"sdk",text:"ATTACHMENT_SDK_OWNER",origin:{kind:"engine"}});
          if(calculated.text!=="ATTACHMENT_SDK_OWNER")throw Error("MISSING_ATTACHMENT_OWNER");
          return await $.store.get("mode")==="drop"?{text:null}:next({...e,text:"MOD_OUTPUT_REMINDER "+(++attachmentCount)+" ATTACHMENT_SDK_OWNER"})
        });`],
      ["context-b", `on("prompt.context",async($,e,next)=>{
        const out=await next(e);
        const proof="instructionFiles" in out?(out.instructionFiles.length?"KNOWN_FILES":"KNOWN_EMPTY"):"UNKNOWN_FILES";
        return {...out,blocks:[{name:"proof",text:proof},...out.blocks]}
      });`]
    ]) {
      const zip = new AdmZip()
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
      zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
      zip.addFile("hooks/register.ts", Buffer.from(`export function register(on){${code}}`))
      const installed = await page.evaluate(bytes => window.api.plugins.install(
        new Uint8Array(bytes).buffer, "context.zip", "local"), [...zip.toBuffer()])
      assert(installed.success, installed.error)
      const mod = (await page.evaluate(id => window.api.mods.status(id), id)).functionMods!
        .find(mod => mod.name === name)!
      await page.evaluate(({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
        { id, mod })
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("规范与提醒验收", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    const idle = async () => await page.getByRole("button", { name: "停止生成", exact: true }).count() === 0
    const send = async (text: string, expected: number) => {
      const before = requests.length
      await composer.fill(text)
      await composer.press("Enter")
      await until(async () => requests.length >= before + expected && await idle(), text)
      assert.equal(requests.length, before + expected)
      return requests.slice(before)
    }
    const first = await send("[tool] inspect project", 2)
    const prompt = String(first[0].messages.find(message => message.role === "system")?.content)
    assert(prompt.includes("PROJECT_REWRITTEN") && !prompt.includes("PROJECT_NATIVE"))
    assert(prompt.indexOf("KNOWN_FILES") < prompt.indexOf("LOCAL_NATIVE"))
    assert(prompt.indexOf("LOCAL_NATIVE") < prompt.indexOf("PROJECT_REWRITTEN"))
    const countOf = (body: typeof first[number]) => String(body.messages
      .find(message => message.role === "system")?.content).match(/CONTEXT_COUNT:(\d+)/)?.[1]
    assert(countOf(first[0]) && countOf(first[0]) === countOf(first[1]))
    assert(prompt.includes("SDK_RESULT:") && prompt.includes("SDK_CALCULATION_ONLY"))
    assert(JSON.stringify(first[0]).includes("<system-reminder>\\nMOD_OUTPUT_REMINDER"))
    const tool = first[1].messages.find(message => message.role === "tool")
    assert(tool && (tool as unknown as { tool_call_id: string }).tool_call_id === "context-ls")
    assert(JSON.stringify(tool).includes("MOD_OUTPUT_REMINDER"))
    const reminders = first.map(body => JSON.stringify(body).match(/MOD_OUTPUT_REMINDER (\d+)/)?.[1])
    assert(reminders[0] && reminders[1] && reminders[0] !== reminders[1])
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "PROJECT_NATIVE")
    pass("Two real plugins reorder/rewrite instruction files and context blocks before the actual provider")
    pass("Reminder rewrite preserves the actual tool result association and never rewrites source files")
    pass("Production manager preserves occurrence identity: one context calculation across two actual model requests")
    pass("SDK calculation skips exactly its current hook, retains the neighboring plugin, and sends no extra request")
    pass("Distinct native user/tool reminder occurrences calculate independently in the same physical run")
    const mode = async (value: string) => {
      const descriptor = (await page.evaluate(id => window.api.mods.commands(id), id))
        .find(command => command.command === "context-mode")!
      const job = await page.evaluate(({ id, descriptor, value }) =>
        window.api.mods.enqueue(id, descriptor, { text: value }), { id, descriptor, value })
      await until(async () => (await page.evaluate(id => window.api.mods.jobs(id), id))
        .some(row => row.id === job.id && row.state === "succeeded"), `mode ${value}`)
    }
    await mode("refresh")
    const refreshed = await send("[tool] refresh actual context", 2)
    assert(countOf(refreshed[0]) && countOf(refreshed[1]) &&
      Number(countOf(refreshed[1])) === Number(countOf(refreshed[0])) + 1)
    pass("Void SDK invalidation inside the actual context chain prevents stale cache fill and recalculates the next request")
    await mode("drop")
    const dropped = JSON.stringify((await send("drop rules and reminder", 1))[0])
    assert(dropped.includes("KNOWN_EMPTY") && !dropped.includes("PROJECT_NATIVE") &&
      !dropped.includes("LOCAL_NATIVE") && !dropped.includes("MOD_OUTPUT_REMINDER"), JSON.stringify({
        knownEmpty: dropped.includes("KNOWN_EMPTY"), nativeProject: dropped.includes("PROJECT_NATIVE"),
        nativeLocal: dropped.includes("LOCAL_NATIVE"), reminder: dropped.includes("MOD_OUTPUT_REMINDER")
      }))
    pass("Removing the instruction block and reminder really removes them from the request")
    await mode("text")
    const edited = JSON.stringify((await send("edit opaque rules", 1))[0])
    assert(edited.includes("UNKNOWN_FILES") && edited.includes("TEXT_REWRITTEN"))
    pass("A second plugin observes unknown files after a text rewrite regardless of package load order")
    const history = await page.evaluate(id => window.api.threads.getMessages(id), id)
    assert(!JSON.stringify(history).includes("MOD_OUTPUT_REMINDER"))
    assert(!JSON.stringify(history).includes("TEXT_REWRITTEN"))
    pass("Model-only transformations leave durable user and tool history unchanged")
    await page.evaluate(id => window.api.mods.configure(id, false, false), id)
    const disabled = JSON.stringify((await send("native rules when off", 1))[0])
    assert(disabled.includes("PROJECT_NATIVE") && disabled.includes("LOCAL_NATIVE"))
    assert(!disabled.includes("TEXT_REWRITTEN") && !disabled.includes("MOD_OUTPUT_REMINDER"))
    pass("Turning Mods off restores the original native instruction and reminder path")
    writeFileSync(join(artifacts, "prompt-context-provider.json"), JSON.stringify(requests, null, 2))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
