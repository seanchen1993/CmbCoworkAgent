import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Production composer, SQLite admission, guest rules, provider requests and busy steer. */
export async function verifyContinuity(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  let held: ServerResponse | undefined
  let responseIndex = 0
  let goalJudgeVerdict: "blocked" | "complete" = "blocked"
  const answer = (response: ServerResponse, text: string, tool = false) => {
    const responseId = `continuity-response-${++responseIndex}`
    response.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (delta: unknown, finish: string | null) =>
      response.write(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`
      )
    frame(
      {
        role: "assistant",
        ...(tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "continuity-ls",
                  type: "function",
                  function: { name: "ls", arguments: '{"path":"."}' }
                }
              ]
            }
          : { content: text })
      },
      tool ? "tool_calls" : "stop"
    )
    response.write(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        model: "gpt-4",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      })}\n\ndata: [DONE]\n\n`
    )
    response.end()
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push({ path: request.url!, body })
    if (request.url?.startsWith("/goal-judge/")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: `continuity-goal-judge-${++responseIndex}`,
        object: "chat.completion",
        created: 1,
        model: "gpt-4",
        choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant",
          content: JSON.stringify({
            verdict: goalJudgeVerdict,
            reason: goalJudgeVerdict === "complete"
              ? "Controlled goal completion" : "Controlled missing user input",
            blocker_type: "needs_user_input"
          })
        } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      }))
      return
    }
    const last = body.messages.at(-1)
    if (last?.role === "user" && String(last.content).includes("[hold]")) {
      held = response
      return
    }
    answer(
      response,
      JSON.stringify(body.messages).includes("Choose exactly one label") ? "yes" : "CONTINUITY_DONE"
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const base = `http://127.0.0.1:${address.port}`
  const project = join(workspace, "continuity")
  mkdirSync(project)
  writeFileSync(join(project, "AGENTS.md"), "MAIN_PROJECT_ONLY\nKeep project conventions.")
  writeFileSync(join(project, "config.json"), '"CONTINUITY_CONFIG"')
  try {
    const id = await page.evaluate(
      async ({ project, base }) => {
        for (const [id, endpoint] of [
          ["continuity-wrong", "wrong"],
          ["continuity-main", "actual"]
        ])
          await window.api.models.setCustomConfig({
            id,
            name: id,
            model: "gpt-4",
            apiKey: "fixture-key",
            baseUrl: `${base}/${endpoint}/v1`,
            maxTokens: 64000,
            maxOutputTokens: 4096
          })
        await window.api.models.setDefault("custom:continuity-main")
        const thread = await window.api.threads.create({
          title: "连续定制验收",
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, { set: { model: "custom:continuity-main" } })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, base }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "continuity", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on){
      let starts=0;
      on("session.start",async($,e,next)=>{
        if(++starts!==1)throw Error("initialization repeated");
        if(!(await $.fs.read("config.json")).includes("CONTINUITY_CONFIG"))throw Error("config unavailable");
        await $.command.register({name:"continuity-analyze",description:"Analyze"});return next(e)
      });
      on("prompt.submit",async($,e,next)=>{
        if(starts!==1)return {drop:"initialization count invalid"};
        if(e.origin.kind!=="composer")throw Error("wrong origin");
        if(e.text==="[drop]")return {drop:"请补充任务"};
        if(e.text==="[no-next]")return {text:"local answer"};
        if(e.text==="[rewrite]"){
          await next({...e,text:"[accepted]",context:["CONTEXT_ONLY"]});
          await next({...e,text:"must-not-enter"});return {drop:"post-next must not undo"}
        }
        if(e.text.startsWith("[collision]"))return next({...e,text:"[collision]",context:["COLLISION_CONTEXT"]});
        if(e.text==="[steer]")return next({...e,text:"[steer-accepted]",context:["STEER_CONTEXT_ONLY"]});
        if(e.text==="[blank-steer]")return next({...e,text:"",context:["MUST_NOT_ENTER"]});
        if(e.text.startsWith("[goal-rewrite]"))return next({...e,
          text:e.text.replace("[goal-rewrite]","[goal-accepted]"),context:["GOAL_CONTEXT_ONLY"]});
        if(e.text==="[goal-held]"){
          $.ui.log("GOAL_SUBMIT_RULE_WAITING");
          await $.clock.sleep(1500);
          return next({...e,text:"[goal-held-accepted]"})
        }
        return next(e)
      });
      on("prompt.compose",async($,e,next)=>{
        const out=await next(e);
        if(!e.traits.includes("analysis"))return out;
        try {await $.model.complete({model:"default",prompt:"MUST_NOT_RECURSE"});throw Error("recursion admitted")}
        catch(error){if(!String(error).includes("MODS_MODEL_COMPOSE_REENTRANT"))throw error}
        $.ui.log("OWN_ANALYSIS:"+e.model);
        return {sections:[...out.sections,{id:"continuity:own",text:"OWN_ANALYSIS_POLICY",scope:"session"}]}
      });
      on("command.run",{command:"continuity-analyze"},async($)=>{
        const a=await $.model.complete({model:"default",prompt:"[analysis]",system:"OWN_SYSTEM"});
        const b=await $.model.classify("classification",["yes","no"],{model:"default"});
        const c=await $.model.fork({prompt:"[fork]"});
        return {text:"ANALYSIS_RESULT:"+JSON.stringify({a,b,c,starts})}
      })
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "continuity.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === "continuity"
    )!
    await page.evaluate(
      ({ id, mod }) => window.api.mods.approveFunction(id, mod.pluginId, mod.digest!),
      { id, mod }
    )
    const emptyId = await page.evaluate(async (project) => {
      const row = await window.api.threads.create({
        title: "首次拒绝验收", workspacePath: project, agentMode: "normal"
      })
      return (row as unknown as { thread_id: string }).thread_id
    }, project)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("首次拒绝验收", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    const send = async (text: string) => {
      await composer.fill(text)
      await composer.press("Enter")
    }
    const idle = () =>
      page
        .getByRole("button", { name: "停止生成", exact: true })
        .count()
        .then((n) => n === 0)
    const messages = () => page.evaluate((id) => window.api.threads.getMessages(id), id)
    const unlockedMode = page.getByRole("button", { name: /^执行模式：.*选择执行模式/ })
    await until(async () => (await unlockedMode.count()) === 1, "new history confirmed empty")
    await send("[drop]")
    await until(async () => (await idle()) && (await unlockedMode.count()) === 1 &&
      (await page.getByText("[drop]", { exact: true }).count()) === 0, "first refusal unlocks mode")
    assert.equal(requests.length, 0)
    assert.equal((await page.evaluate((id) => window.api.threads.getMessages(id), emptyId)).length, 0)
    pass("A first refused message leaves the empty conversation and execution mode unchanged")
    await page.getByText("连续定制验收", { exact: true }).first().click()
    await until(async () => (await unlockedMode.count()) === 1, "main test history ready")
    await send("[rewrite]")
    await until(async () => requests.length === 1 && (await idle()), "rewritten task completes")
    const stored = await messages()
    assert.deepEqual(
      stored.filter((m) => m.role === "user").map((m) => m.content),
      ["[accepted]"]
    )
    assert(JSON.stringify(requests[0].body.messages).includes("CONTEXT_ONLY"))
    assert(!JSON.stringify(stored).includes("CONTEXT_ONLY"))
    assert.equal(await page.getByText("[accepted]", { exact: true }).count(), 1)
    pass(
      "Plain composer rules rewrite the same visible/durable message once and keep context model-only"
    )
    for (const text of ["[drop]", "[no-next]"]) {
      await send(text)
      await until(
        async () => (await idle()) && (await composer.inputValue()) === "",
        "refused submit settles"
      )
      assert.equal(requests.length, 1)
      assert(!(await messages()).some((m) => m.role === "user" && m.content === text))
    }
    pass(
      "Official drop and answers without next cause zero provider calls and no durable user message"
    )
    await send("[collision]\n\nCOLLISION_CONTEXT")
    await until(async () => requests.length === 2 && (await idle()), "collision context finishes")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("连续定制验收", { exact: true }).first().click()
    await until(
      async () => (await page.getByText("[collision]", { exact: true }).count()) === 1,
      "recovered visible history hydrates"
    )
    assert(
      !(await messages()).some(
        (m) => m.role === "user" && String(m.content).includes("COLLISION_CONTEXT")
      )
    )
    assert.equal(await page.getByText("[collision]", { exact: true }).count(), 1)
    assert(!(await page.locator("body").innerText()).includes("COLLISION_CONTEXT"))
    pass(
      "Hidden context remains hidden after checkpoint recovery even when model text equals the original submission"
    )
    await composer.fill("/continuity-analyze")
    await composer.press("Enter")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(
      async () => (await page.evaluate((id) => window.api.mods.jobs(id), id))
        .some((job) => job.command === "continuity-analyze" &&
          !["queued", "running"].includes(job.state)) && (await idle()),
      "standalone analyses"
    )
    const job = (await page.evaluate((id) => window.api.mods.jobs(id), id))
      .find((job) => job.command === "continuity-analyze")!
    assert.equal(job.state, "succeeded", job.error ?? job.result?.text)
    assert(job.result?.text.startsWith("ANALYSIS_RESULT:"), job.result?.text)
    const analysis = JSON.parse(job.result!.text.slice("ANALYSIS_RESULT:".length))
    assert.equal(analysis.starts, 1)
    assert.equal(analysis.b, "yes")
    assert.equal(requests.length, 5)
    assert(requests.every((r) => r.path.startsWith("/actual/")))
    const analyses = requests.slice(2)
    assert(analyses.every((r) => JSON.stringify(r.body.messages).includes("OWN_ANALYSIS_POLICY")))
    assert(!JSON.stringify(analyses[0].body.messages).includes("MAIN_PROJECT_ONLY"))
    assert(JSON.stringify(analyses[2].body.messages).includes("[accepted]"))
    assert(analyses.every((r) => !r.body.tools))
    pass(
      "Complete/classify/fork compose their own rules, reject recursion and fork uses the captured configured endpoint"
    )
    await send("[hold]")
    await until(async () => !!held, "running provider awaits steer")
    const blank = await page.evaluate((id) => window.api.agent.queueCurrentRunMessage(id, {
      id: "continuity-blank", content: "[blank-steer]", displayContent: "[blank-steer]",
      composerSubmission: { kind: "plain-text", text: "[blank-steer]" }
    }), id)
    assert.equal(blank.queued, false)
    assert(!(await messages()).some((m) => m.id === "continuity-blank"))
    const steer = await page.evaluate(
      (id) =>
        window.api.agent.queueCurrentRunMessage(id, {
          id: "continuity-steer",
          content: "[steer]",
          displayContent: "[steer]",
          composerSubmission: { kind: "plain-text", text: "[steer]" }
        }),
      id
    )
    assert.equal(steer.queued, true, steer.message)
    assert.equal(steer.visibleText, "[steer-accepted]")
    answer(held!, "HELD_FIRST_DONE")
    held = undefined
    await until(async () => requests.length >= 7 && (await idle()), "running steer consumed")
    const queued = (await messages()).find((m) => m.id === "continuity-steer")
    assert.equal(queued?.content, "[steer-accepted]")
    assert(requests.some((r) => JSON.stringify(r.body.messages).includes("STEER_CONTEXT_ONLY")))
    pass(
      "Busy steer commits rewritten queued text to the exact live run and preserves hidden context"
    )
    const hot = new AdmZip()
    hot.addFile("plugin.json", Buffer.from(JSON.stringify({
      name: "continuity-hot", version: "1.0.0"
    })))
    hot.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
    hot.addFile("hooks/register.ts", Buffer.from(`export function register(on){
      let starts=0;
      on("session.start",async($,e,next)=>{
        if(++starts!==1)throw Error("hot initialization repeated");
        if(!(await $.fs.read("config.json")).includes("CONTINUITY_CONFIG"))throw Error("hot config unavailable");
        return next(e)
      });
      on("prompt.submit",($,e,next)=>e.text==="[hot-submit]"
        ?next({...e,text:"[hot-accepted]",context:["HOT_CONTEXT_ONLY"]}):next(e));
    }`))
    assert.equal((await page.evaluate(bytes => window.api.plugins.install(
      new Uint8Array(bytes).buffer, "continuity-hot.zip", "local"
    ), [...hot.toBuffer()])).success, true)
    const hotMod = (await page.evaluate(id => window.api.mods.status(id), id))
      .functionMods!.find(row => row.name === "continuity-hot")!
    await page.evaluate(({id,mod}) => window.api.mods.approveFunction(id,mod.pluginId,mod.digest!),
      {id,mod:hotMod})
    // A real UI read can initialize the session concurrently with the next plain submission.
    const initializing = page.evaluate(id => window.api.mods.commands(id), id)
    await send("[hot-submit]")
    await initializing
    await until(async () => requests.length === 8 && (await idle()) &&
      (await messages()).some(message => message.role === "user" && message.content === "[hot-accepted]"),
      "hot grant and concurrent UI initialization preserve ordinary submission")
    assert(JSON.stringify(requests.at(-1)!.body.messages).includes("HOT_CONTEXT_ONLY"))
    assert(!(await page.locator("body").innerText()).includes("HOT_CONTEXT_ONLY"))
    pass("Newly approved rules and concurrent UI initialization do not expire the resident main or lose the next message")
    const originalGoalSettings = await page.evaluate(() => window.api.models.getGoalSettings())
    try {
      await page.evaluate(async base => {
        await window.api.models.setCustomConfig({ id: "continuity-goal-judge",
          name: "Continuity goal judge", model: "gpt-4", apiKey: "fixture-key",
          baseUrl: `${base}/goal-judge/v1`, maxTokens: 64000, maxOutputTokens: 4096 })
        await window.api.models.setGoalSettings({ evaluatorModelId: "custom:continuity-goal-judge" })
      }, base)
      for (const status of ["paused", "complete"] as const) {
        goalJudgeVerdict = status === "complete" ? "complete" : "blocked"
        const objective = status === "complete"
          ? "GOAL_COMPOSER_COMPLETE_SAMPLE" : "GOAL_COMPOSER_PAUSED_SAMPLE"
        await send(`/goal ${objective}`)
        await until(async () => (await idle()) &&
          (await page.evaluate(id => window.api.threads.getGoalState(id), id)).goal?.status === status,
        `real Goal worker and configured evaluator produce ${status}`)
        const before = requests.length
        const previousMessages = await messages()
        await send(`[goal-rewrite] ${status}`)
        await until(async () => requests.length === before + 1 && (await idle()),
          `ordinary composer after ${status} Goal completes`)
        const after = await messages()
        const added = after.filter(message => !previousMessages.some(old => old.id === message.id))
        const userMessages = added.filter(message => message.role === "user")
        assert.equal(userMessages.length, 1)
        assert.equal(userMessages[0].content, `[goal-accepted] ${status}`)
        assert(JSON.stringify(requests.at(-1)!.body.messages).includes("GOAL_CONTEXT_ONLY"))
        assert(!JSON.stringify(after).includes("GOAL_CONTEXT_ONLY"))
        assert(!(await page.locator("body").innerText()).includes("GOAL_CONTEXT_ONLY"))
        assert.equal((await page.evaluate(id => window.api.threads.getGoalState(id), id)).goal?.status,
          status)
        await send("[drop]")
        await until(async () => (await idle()) && (await composer.inputValue()) === "",
          `refused ordinary input after ${status} Goal settles`)
        assert.equal(requests.length, before + 1)
        assert(!(await messages()).some(message => message.role === "user" && message.content === "[drop]"))
        pass(`A real ${status} Goal keeps ordinary rewrite, hidden context, one saved message and refusal with zero model calls`)
      }
      // Set a genuinely paused Goal again, then mutate it through the original control IPC.
      goalJudgeVerdict = "blocked"
      await send("/goal GOAL_COMPOSER_PAUSED_MUTATION_SAMPLE")
      await until(async () => (await idle()) &&
        (await page.evaluate(id => window.api.threads.getGoalState(id), id)).goal?.status === "paused",
      "real paused Goal for delayed-rule invalidation")
      const beforeMutation = requests.length
      await send("[goal-held]")
      await until(async () => (await page.evaluate(id => window.api.mods.logs(id), id))
        .some(row => row.text === "GOAL_SUBMIT_RULE_WAITING"), "actual guest rule waits")
      const cleared = await page.evaluate(id => window.api.agent.goalControl(id, "/goal clear"), id)
      assert.equal(cleared.handled, true)
      assert.equal(cleared.terminatedCurrentRun, false,
        "clearing a paused Goal must not cancel the unrelated ordinary run")
      await new Promise(resolve => setTimeout(resolve, 1750))
      await until(idle, "Goal mutation retires the delayed ordinary submission")
      assert.equal((await page.evaluate(id => window.api.threads.getGoalState(id), id)).goal, null)
      assert.equal(requests.length, beforeMutation)
      assert(!(await messages()).some(message =>
        message.role === "user" && String(message.content).includes("[goal-held")))
      pass("Real Goal clear while an actual rule waits prevents old model and user-message acceptance")
    } finally {
      await page.evaluate(settings => window.api.models.setGoalSettings({
        evaluatorModelId: settings.evaluatorModelId ?? ""
      }), originalGoalSettings)
    }
    await page.screenshot({ path: join(artifacts, "continuity-chat.png") })
  } finally {
    writeFileSync(join(artifacts, "continuity-requests.json"), JSON.stringify(requests, null, 2))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}
