/** Real beta App/preload/IPC/Store/Thread/Runtime/ChatContainer with an isolated profile and localhost-only model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { _electron } from "playwright"

async function main() {
  const root = resolve("."),
    dir = await mkdtemp(join(tmpdir(), "m05-mock-channel-app-")),
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const calls: Array<{ tools: string[]; lastUser: string }> = [],
    errors: string[] = []
  let hooks=0
  const advertised:string[][]=[]
  const server = createServer(async (req, res) => {
    try {
      if(req.url==="/hook"){hooks++;for await(const _ of req){};res.writeHead(200,{"content-type":"application/json"});res.end("{}");return}
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw),
        messages = body.messages ?? []
      const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
      let lastUser = -1
      messages.forEach((m: any, i: number) => {
        if (m.role === "user") lastUser = i
      })
      const user = text(messages[lastUser]?.content ?? ""),
        turn = messages.slice(lastUser + 1)
      const all = JSON.stringify(messages)
      const used = turn.flatMap((m: any) => (m.tool_calls ?? []).map((t: any) => t.function?.name))
      const visible=(body.tools??[]).map((v:any)=>v.function?.name).sort()
      advertised.push(visible)
      const external=user.includes("模拟渠道")
      if(external){
        assert.deepEqual(visible,["bot_work_complete","bot_work_continue","bot_work_create","bot_work_list","bot_work_send"])
        assert.ok(!all.includes("M05_OWNER_PRIVATE_MEMORY"),"external runtime cannot load owner's private memory")
      }
      calls.push({tools:used,lastUser:user.slice(0,200)})
      let reply="模拟渠道普通问答已回复。",call:{name:string;args:Record<string,unknown>}|undefined
      if(user.includes("MOCK_CREATE")){
        if(!used.includes("bot_work_create"))call={name:"bot_work_create",args:{requestKey:"mock-work",title:"渠道周末安排",goal:"MOCK_WORK_GOAL：拟一份周末安排，只需文字。",contextMessageIds:[]}}
        else reply="渠道工作已交办，可继续修改。"
      }else if(user.includes("MOCK_WORK_GOAL"))reply="渠道工作第一版：周六讨论。"
      else if(user.includes("MOCK_EDIT")){
        assert.ok(all.includes("渠道工作第一版"),"desktop edit keeps previous assistant in the external work")
        assert.ok(!all.includes("OWNER_PING"),"work does not import owner's main thread")
        reply="渠道工作第二版：周日讨论。"
      }else if(user.includes("MOCK_UNSAFE")){
        if(!used.includes("read_file"))call={name:"read_file",args:{file_path:"/private-owner-fixture"}}
        else reply="此渠道无法读取本机文件。"
      }else if(user.includes("OWNER_PING"))reply="本机主对话保持可用。"
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${calls.length}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) }
              }
            ]
          }
        : { content: reply }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const send = (delta: unknown, finish_reason: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: `m05-${calls.length}`, object: "chat.completion.chunk", model: "local-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        send(delta, null)
        send({}, call ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: `m05-${calls.length}`,
            object: "chat.completion",
            model: "local-fixture",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: call ? null : reply,
                  ...(call
                    ? {
                        tool_calls: [
                          {
                            id: `call-${calls.length}`,
                            type: "function",
                            function: { name: call.name, arguments: JSON.stringify(call.args) }
                          }
                        ]
                      }
                    : {})
                },
                finish_reason: call ? "tool_calls" : "stop"
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("fixture-error")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number },
    env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP"
  ]) {
    env[key] = join(dir, key)
    await mkdir(env[key], { recursive: true })
  }
  if (process.env.HOME) env.HOME = process.env.HOME
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(dir, "agent-profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  try {
    console.log("stage: launching isolated App", dir)
    app = await _electron.launch({
      executablePath: binary,
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(dir, "electron-profile")}`],
      cwd: root,
      env,
      timeout: 60000
    })
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false)
    })
    app
      .process()
      .stdout?.on(
        "data",
        (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" })
      )
    app
      .process()
      .stderr?.on(
        "data",
        (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" })
      )
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("renderer", error.message)
    })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    const bot = await page.evaluate(async (baseUrl) => {
      const api = (window as any).api
      await api.models.setCustomConfig({
        id: "m05-local",
        name: "Local fixture",
        baseUrl,
        model: "local-fixture",
        apiKey: "synthetic-only",
        maxTokens: 64000,
        maxOutputTokens: 2048
      })
      await api.models.setDefault("custom:m05-local")
      return api.bots.create({
        name: "本机协作专家",
        instructions: "帮助讨论和交办普通工作，按要求生成实际文件。",
        color: "#168bea",
        modelRef: "custom:m05-local"
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    await page.evaluate(async ({botId,url})=>{
      const api=(window as any).api
      await api.bots.writeMemory(botId,{name:"Private",content:"M05_OWNER_PRIVATE_MEMORY"})
      for(const event of ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionEnd"])
        await api.hooks.create({event,type:"http",url,enabled:true,timeout:5000})
    },{botId:bot.id,url:`http://127.0.0.1:${address.port}/hook`})
    console.log("stage: profile-model-bot-created")
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText("本机协作专家", { exact: true }).first().click()
    await page.waitForFunction(async()=>!(await (window as any).api.bots.snapshot()).tasks.some((t:any)=>["queued","running","waiting_user"].includes(t.state)),undefined,{timeout:90000})
    const hookBaseline=hooks
    if(await page.getByRole("button",{name:"打开 Bot 详情",exact:true}).isVisible())await page.getByRole("button",{name:"打开 Bot 详情",exact:true}).click()
    await page.getByRole("button",{name:"更多 Bot 操作",exact:true}).click()
    await page.getByRole("button",{name:"模拟 IM 接入",exact:true}).click()
    const modal=page.locator("[data-bot-mock-dialog]")
    await modal.waitFor()
    await modal.getByRole("button",{name:"新建绑定",exact:true}).click()
    await modal.getByLabel("渠道标识",{exact:true}).fill("dm-alice")
    await modal.getByLabel("显示名称",{exact:true}).fill("Alice 个人模拟")
    await modal.getByLabel("允许的模拟用户 ID",{exact:true}).fill("alice")
    await modal.getByRole("button",{name:"创建模拟绑定",exact:true}).click()
    await modal.getByText("模拟设备在线",{exact:false}).waitFor()
    const binding=await page.evaluate(async id=>(await (window as any).api.bots.mock.bindings(id)).items[0],bot.id)
    const sendMock=async(text:string)=>{await modal.getByLabel("模拟消息",{exact:true}).fill(text);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await modal.getByRole("button",{name:"发送模拟消息",exact:true}).click();await page.waitForFunction(()=>!document.querySelector("[data-bot-mock-dialog] textarea")?.getAttribute("disabled"))}
    const waitResult=async(text:string)=>{await page.waitForFunction(async({botId,bindingId,text})=>(await (window as any).api.bots.mock.history(botId,bindingId)).items.some((v:any)=>v.kind==="bot"&&v.state==="sent"&&v.text.includes(text)),{botId:bot.id,bindingId:binding.id,text},{timeout:90000})}
    await sendMock("MOCK_QA：只是咨询，不建工作。")
    await waitResult("普通问答")
    assert.equal((await page.evaluate(async id=>(await (window as any).api.bots.works.list(id)).items,bot.id)).length,0)
    assert.equal(hooks,hookBaseline,"external first SessionStart/UserPrompt/Stop cannot run hooks")
    await sendMock("MOCK_CREATE：请独立交办周末安排。")
    await waitResult("渠道工作第一版")
    const work=await page.evaluate(async id=>(await (window as any).api.bots.works.list(id)).items[0],bot.id)
    assert.equal(work.source.bindingId,binding.id)
    assert.equal(hooks,hookBaseline,"external tools cannot run Pre/Post hooks")
    await modal.getByRole("button",{name:"打开独立工作",exact:true}).last().click()
    await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
    await page.getByText("模拟渠道工作 ·",{exact:false}).waitFor()
    const composer=page.locator(".bots-conversation [data-bot-composer] textarea").first()
    assert.equal(await page.getByRole("button",{name:"添加文件",exact:true}).isEnabled(),false)
    await composer.fill("MOCK_EDIT：改成周日。")
    await composer.press("Enter")
    await waitResult("渠道工作第二版")
    assert.equal(hooks,hookBaseline,"desktop view must preserve external source policy")
    await page.getByText("渠道工作第二版：周日讨论。",{exact:true}).last().waitFor()
    await page.getByRole("button",{name:"完成工作",exact:true}).click()
    await page.getByRole("button",{name:"继续处理",exact:true}).waitFor()
    await page.getByRole("button",{name:"继续处理",exact:true}).click()
    await page.getByRole("button",{name:"完成工作",exact:true}).waitFor()
    await page.screenshot({path:"/tmp/m05-mock-channel-work.png"})
    const openModal=async()=>{await page.getByRole("button",{name:"更多 Bot 操作",exact:true}).click();await page.getByRole("button",{name:"模拟 IM 接入",exact:true}).click();await modal.waitFor()}
    await openModal()
    await modal.getByRole("button",{name:"模拟离线",exact:true}).click()
    await sendMock("MOCK_OFFLINE：离线排队。")
    await modal.getByText("等待执行",{exact:false}).last().waitFor()
    const before=calls.length
    await page.waitForTimeout(200)
    assert.equal(calls.length,before)
    await modal.getByRole("button",{name:"恢复在线",exact:true}).click()
    await page.waitForFunction(async({botId,bindingId})=>(await (window as any).api.bots.mock.history(botId,bindingId)).items.filter((v:any)=>v.kind==="bot"&&v.state==="sent").length>=5,{botId:bot.id,bindingId:binding.id},{timeout:90000})
    await sendMock("MOCK_UNSAFE：试图读取本机文件。")
    await waitResult("无法读取")
    assert.equal(hooks,hookBaseline)
    await modal.getByRole("button",{name:"新建绑定",exact:true}).click()
    await modal.getByLabel("受众类型",{exact:true}).selectOption("group")
    await modal.getByLabel("渠道标识",{exact:true}).fill("group-team")
    await modal.getByLabel("显示名称",{exact:true}).fill("小组模拟")
    await modal.getByLabel("允许的模拟用户 ID",{exact:true}).fill("alice,bob")
    await modal.getByRole("button",{name:"创建模拟绑定",exact:true}).click()
    await modal.getByLabel("模拟发送者",{exact:true}).selectOption("bob")
    await sendMock("MOCK_GROUP_IGNORED：文字 @Bot 不应触发。")
    await modal.getByText("群消息未触发 Bot",{exact:false}).waitFor()
    const groupBinding=await page.evaluate(async id=>(await (window as any).api.bots.mock.bindings(id)).items.find((b:any)=>b.kind==="group"),bot.id)
    await modal.getByLabel("结构化 @ 此 Bot",{exact:false}).check()
    await sendMock("MOCK_GROUP_QA：结构化提及后回复。")
    await page.waitForFunction(async({botId,id})=>(await (window as any).api.bots.mock.history(botId,id)).items.some((v:any)=>v.kind==="bot"&&v.state==="sent"),{botId:bot.id,id:groupBinding.id},{timeout:90000})
    assert.equal(hooks,hookBaseline)
    await page.screenshot({path:"/tmp/m05-mock-channel-dialog.png"})
    await page.getByRole("button",{name:"Close",exact:true}).click()
    await page.locator(".bots-conversation").getByRole("button",{name:/主对话$/}).click()
    await composer.fill("OWNER_PING：本机主对话仍可用。")
    await composer.press("Enter")
    await page.getByText("本机主对话保持可用。",{exact:true}).last().waitFor({timeout:90000})
    assert.ok(hooks>hookBaseline,"ordinary beta still executes configured hooks")
    assert.ok(advertised.some(v=>v.includes("write_file")),"owner runtime retains beta tools")
    assert.deepEqual(errors,[])
    console.log("complete: real App modal/channel/runtime/work/edit/complete/continue/offline/group/allowlist/hooks",{calls:calls.length,hooks})
  } catch (error) {
    console.error(
      "artifact-directory",
      dir,
      "last model phases",
      JSON.stringify(calls)
    )
    if (app) {
      const page = await app.firstWindow().catch(() => null)
      if (page)
        await page.screenshot({ path: "/tmp/m05-mock-channel-app-failure.png" }).catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Keep only diagnostic logs; the isolated profiles and their fixture-only credentials are removed.
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "TEMP",
      "TMP",
      "agent-profile",
      "electron-profile"
    ])
      await rm(join(dir, key), { recursive: true, force: true })
    console.log(
      "cleanup: owned Electron and localhost fixture stopped; isolated profiles removed",
      dir
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
