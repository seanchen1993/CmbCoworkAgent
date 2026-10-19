import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { BuiltinInstructionsSnapshot } from "../../src/shared/mods/builtin-instructions"

interface FixtureModelRequest {
  model: string
  messages: Array<{ role: string; content?: unknown }>
  tools: Array<{ function: { name: string; description: string } }>
}

/** Actual graph tasks, configured provider endpoints and installed QuickJS modules. */
export async function verifyTaskModelComposition(
  page: Page,
  workspace: string,
  artifacts: string,
  _until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const requests: Array<{ path: string; body: FixtureModelRequest }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FixtureModelRequest
    requests.push({ path: request.url!, body })
    const index = requests.length
    const last = body.messages.at(-1)
    const user = body.messages.findLast((message: { role: string }) => message.role === "user")
    const child = String(user?.content).includes("[288-task-child:")
    const afterTool = last?.role === "tool"
    response.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (delta: unknown, finish: string) =>
      response.write(
        `data: ${JSON.stringify({
          id: `task-288-${index}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`
      )
    if (!child && !afterTool) {
      frame(
        {
          role: "assistant",
          tool_calls: ["A", "B", "override"].map((name, i) => ({
            index: i,
            id: `renderer-task-${name}`,
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                subagent_type: name === "override" ? "fixture-override" : "general-purpose",
                description: `[288-task-child:${name}] Inspect the current directory once, then report.`
              })
            }
          }))
        },
        "tool_calls"
      )
    } else if (child && !afterTool) {
      frame(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `ls-${index}`,
              type: "function",
              function: { name: "ls", arguments: JSON.stringify({ path: project }) }
            }
          ]
        },
        "tool_calls"
      )
    } else {
      frame(
        { role: "assistant", content: child ? "TASK_288_CHILD_DONE" : "TASK_288_MAIN_DONE" },
        "stop"
      )
    }
    response.write(
      `data: ${JSON.stringify({
        id: `task-288-${index}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const project = join(workspace, "task-model-288")
  mkdirSync(join(project, ".cmbcoworkagent", "agents"), { recursive: true })
  writeFileSync(join(project, "AGENTS.md"), "TASK_288_AGENTS_ORIGINAL\nFollow project conventions.")
  writeFileSync(
    join(project, ".cmbcoworkagent", "agents", "fixture-override.md"),
    "---\nname: fixture-override\ndescription: Verify a separate actual provider\n" +
      "model: custom:task-288-override\n---\nTASK_288_REGISTRY_BODY\nInspect once and finish."
  )
  const progress: Array<{ elapsedMs: number; requests: number; hostEvents: number }> = []
  const observedLogs = new Map<string, Awaited<ReturnType<typeof window.api.mods.logs>>[number]>()
  const title = "Mods 子任务与来源段验收"
  try {
    const threadId = await page.evaluate(
      async ({ project, title, baseUrl }) => {
        for (const [id, endpoint] of [
          ["task-288-main", "main"],
          ["task-288-override", "override"],
          ["task-288-switch", "switch"]
        ]) {
          await window.api.models.setCustomConfig({
            id,
            name: id,
            baseUrl: `${baseUrl}/${endpoint}/v1`,
            model: "gpt-4",
            apiKey: "fixture-key",
            maxTokens: 64000,
            maxOutputTokens: 4096
          })
        }
        await window.api.models.setDefault("custom:task-288-main")
        const thread = await window.api.threads.create({
          title,
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:task-288-main", subagentsEnabled: true }
        })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, title, baseUrl }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "task-source-288", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on){
      on("turn.step",async function*($,e,next){
        $.ui.log("TASK_288_MAIN_STEP:"+JSON.stringify(e));
        return yield* next(e.agentId && e.agentId!=="main" && e.index===0
          ? {...e,model:"custom:task-288-switch"} : e)
      });
      on("tool.describe",async($,e)=>({...e,description:e.description+" TASK_288_TOOL_DESCRIPTION"}));
      on("tool.call",async($,e,next)=>{
        $.ui.log("TASK_288_TOOL:"+JSON.stringify({agentId:e.agentId||"main",tool:e.tool}));return next(e)
      });
      on("prompt.section",async($,e,next)=>{
        $.ui.log("TASK_288_SECTION:"+JSON.stringify({name:e.name,empty:e.text===null}));
        if(e.name==="cmb:agents")return {text:null};
        if(e.name==="cmb:extra-context"&&e.text===null)return {text:"\\n\\nTASK_288_FILLED_SLOT"};
        return next(e)
      });
      on("prompt.compose",async($,e)=>{
        const out=await $.prompt.compose();
        $.ui.log("TASK_288_COMPOSE:"+JSON.stringify({facts:e,ids:out.sections.map(s=>s.id)}));
        return {sections:[...out.sections,{id:"task-source-288:policy",scope:"session",text:"\\n\\nTASK_288_COMPOSED"}]}
      })
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "task-source-288.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((row) => row.name === "task-source-288")!
    assert(mod?.digest)
    await page.evaluate(
      ({ threadId, mod }) => window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!),
      { threadId, mod }
    )
    const applied = await page.evaluate(
      async ({ threadId, mod }) => {
        let view = await window.api.mods.clawView(threadId)
        const profile = {
          id: "task-source-288-claw",
          name: "子任务与模型组合验收",
          capabilities: [{ pluginId: mod.pluginId, name: mod.name, digest: mod.digest! }],
          models: {
            default: "custom:task-288-main",
            roles: { review: "custom:task-288-override", switch: "custom:task-288-switch" }
          }
        }
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          profile,
          workspace: view.workspace,
          revision: view.revision
        })
        return window.api.mods.clawChange(threadId, {
          kind: "apply",
          id: profile.id,
          workspace: view.workspace,
          revision: view.revision
        })
      },
      { threadId, mod }
    )
    assert.equal(applied.active?.id, "task-source-288-claw")
    assert.equal(applied.active?.capabilities[0].digest, mod.digest)
    pass(
      "A saved and applied Claw pins the approved module and both configured models before a real chat starts"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    // Production logs are deliberately bounded. Collect snapshots during the run
    // rather than expecting its final ring buffer to retain every section callback.
    const collectLogs = async () => {
      for (const row of await page.evaluate((id) => window.api.mods.logs(id), threadId))
        observedLogs.set(row.id, row)
    }
    let initialInstructions: BuiltinInstructionsSnapshot | undefined
    await composer.fill(
      "[288-task-run] Run two general-purpose tasks and fixture-override in parallel."
    )
    await composer.press("Enter")
    const runStartedAt = Date.now()
    let lastProgressAt = runStartedAt
    let previousProgress = ""
    let waiting = true
    let absoluteDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          while (waiting) {
            await collectLogs()
            if (!initialInstructions) {
              const overview = await page.evaluate(
                ({ threadId, project }) => window.api.mods.builtinOverview(threadId, project),
                { threadId, project }
              )
              initialInstructions = overview.instructions.snapshot
            }
            // Count only actual model requests and original execution events, never UI polling.
            const hostEvents = [...observedLogs.values()].filter((row) =>
              /^TASK_288_(?:MAIN_STEP|TOOL|COMPOSE):/.test(row.text)
            ).length
            const currentProgress = `${requests.length}:${hostEvents}`
            const now = Date.now()
            assert(
              now - lastProgressAt < 30_000,
              "Real shared tasks made no execution progress for 30 seconds"
            )
            if (currentProgress !== previousProgress) {
              previousProgress = currentProgress
              lastProgressAt = now
              progress.push({
                elapsedMs: now - runStartedAt,
                requests: requests.length,
                hostEvents
              })
            }
            assert(
              now - runStartedAt < 120_000,
              "Real shared tasks exceeded the 120-second absolute bound"
            )
            if (
              (await page.getByText("TASK_288_MAIN_DONE", { exact: true }).count()) > 0 &&
              !(await page.getByRole("button", { name: "停止生成", exact: true }).count())
            )
              break
            await page.waitForTimeout(100)
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          absoluteDeadline = setTimeout(
            () => reject(Error("Real shared tasks exceeded the 120-second absolute bound")),
            120_000
          )
        })
      ])
    } finally {
      waiting = false
      if (absoluteDeadline) clearTimeout(absoluteDeadline)
    }
    await collectLogs()
    const logs = [...observedLogs.values()]
    writeFileSync(join(artifacts, "task-288-requests.json"), JSON.stringify(requests, null, 2))
    writeFileSync(join(artifacts, "task-288-logs.json"), JSON.stringify(logs, null, 2))
    const children = requests.filter(
      (row) =>
        JSON.stringify(row.body.messages).includes("[288-task-child:") &&
        String(
          row.body.messages.findLast((message: { role: string }) => message.role === "user")
            ?.content
        ).includes("[288-task-child:")
    )
    assert.equal(children.length, 6)
    assert.equal(requests.length, 8)
    assert.equal(children.filter((row) => row.path.startsWith("/override/")).length, 1)
    assert.equal(children.filter((row) => row.path.startsWith("/main/")).length, 2)
    assert.equal(children.filter((row) => row.path.startsWith("/switch/")).length, 3)
    assert(
      children
        .filter((row) => row.path.startsWith("/switch/"))
        .every((row) => row.body.messages.at(-1)?.role !== "tool")
    )
    assert(
      children
        .filter((row) => !row.path.startsWith("/switch/"))
        .every((row) => row.body.messages.at(-1)?.role === "tool")
    )
    assert(children.every((row) => row.body.model === "gpt-4"))
    pass(
      "Real child first steps select a third configured endpoint and later steps return to their own original endpoint, with the same public model name"
    )
    const modelLogs = logs.filter((row) => row.text.startsWith("TASK_288_COMPOSE:"))
    const toolLogs = logs
      .filter((row) => row.text.startsWith("TASK_288_TOOL:"))
      .map((row) => JSON.parse(row.text.slice("TASK_288_TOOL:".length)))
    const childIds = new Set<string>(
      toolLogs.map((row) => row.agentId).filter((id: string) => !!id && id !== "main")
    )
    assert.equal(childIds.size, 3)
    assert([...childIds].every((id) => /^mod-task:[0-9a-f-]{36}$/.test(id)))
    assert(modelLogs.length >= 8)
    assert.equal(toolLogs.filter((row) => childIds.has(row.agentId) && row.tool === "ls").length, 3)
    assert(
      modelLogs.every(
        (row) => JSON.parse(row.text.slice("TASK_288_COMPOSE:".length)).facts.model === "gpt-4"
      )
    )
    pass(
      "All real shared child prompt composition calls use private owners distinct from renderer tool IDs and actual model facts"
    )
    assert(children.every((row) => JSON.stringify(row.body.messages).includes("TASK_288_COMPOSED")))
    assert(
      children.every((row) =>
        row.body.tools.some(
          (tool) =>
            tool.function.name === "ls" &&
            tool.function.description.includes("TASK_288_TOOL_DESCRIPTION")
        )
      )
    )
    assert.equal(
      children.filter(
        (row) =>
          row.body.messages.at(-1)?.role === "tool" &&
          String(row.body.messages.at(-1)?.content).includes("AGENTS.md")
      ).length,
      3
    )
    pass(
      "Prompt composition and tool description Hooks reach every actual child provider request and native ls still succeeds"
    )
    const main = requests[0].body
    assert(JSON.stringify(main.messages).includes("TASK_288_FILLED_SLOT"))
    assert(!JSON.stringify(main.messages).includes("TASK_288_AGENTS_ORIGINAL"))
    const general = children.filter((row) => row.path.startsWith("/main/"))
    assert(
      general.every(
        (row) => !JSON.stringify(row.body.messages).includes("TASK_288_AGENTS_ORIGINAL")
      )
    )
    const sectionLogs = logs.filter((row) => row.text.startsWith("TASK_288_SECTION:"))
    assert(sectionLogs.some((row) => row.text.includes('"cmb:environment"')))
    assert(
      modelLogs.some((row) => {
        const data = JSON.parse(row.text.slice("TASK_288_COMPOSE:".length))
        return data.ids.includes("cmb:agent") && data.ids.includes("cmb:task-completion")
      })
    )
    pass(
      "Named actual source sections allow selective project-instruction removal and current empty-slot filling without losing the task role"
    )
    const overview = await page.evaluate(
      ({ threadId, project }) => window.api.mods.builtinOverview(threadId, project),
      { threadId, project }
    )
    writeFileSync(
      join(artifacts, "task-288-instructions.json"),
      JSON.stringify({ initialInstructions, finalInstructions: overview.instructions }, null, 2)
    )
    const parent = overview.instructions.snapshot
    assert(initialInstructions && parent, "Production instruction observations must be available")
    assert.equal(parent.threadId, threadId)
    assert.equal(parent.runId, initialInstructions.runId)
    assert.equal(parent.capturedAt, initialInstructions.capturedAt)
    assert.deepEqual(parent.entries, initialInstructions.entries)
    assert.equal(parent.agentId, undefined, "Child observations must not replace the root record")
    assert(
      parent.entries.some(
        (entry) =>
          entry.path.replace(/\\/g, "/").endsWith("/AGENTS.md") && entry.delivery === "injected"
      )
    )
    assert(parent.finalRequests && parent.finalRequests.length === 2)
    assert(
      parent.finalRequests.every((item) => item.result === "modified"),
      "The original prompt.section Hook removed the root instructions"
    )
    assert.equal(parent.children?.length, 3)
    const observedChildren = parent.children!
    assert.deepEqual(new Set(observedChildren.map((child) => child.agentId)), childIds)
    assert.equal(new Set(observedChildren.map((child) => child.runId)).size, 3)
    for (const child of observedChildren) {
      assert.equal(child.childSource, "task-model-boundary")
      assert.equal(child.threadId, threadId)
      assert.notEqual(child.runId, parent.runId)
      assert(child.finalRequests && child.finalRequests.length === 2)
      assert(
        child.finalRequests.every((item) => item.result === "modified"),
        "Each actual child request must report the Hook-removed inherited instruction block"
      )
      assert(child.entries.some((entry) => entry.path.replace(/\\/g, "/").endsWith("/AGENTS.md")))
    }
    pass(
      "Production builtinOverview preserves the parent assembly and records all three real Task owners and six modified child request observations"
    )

    const requestsBeforeObservationUi = requests.length
    await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
    await page.getByRole("tab", { name: "运行过程", exact: true }).click()
    const instructionsUi = page.getByRole("region", { name: "本次规范与运行概况", exact: true })
    await instructionsUi.waitFor({ state: "visible" })
    const childSummary = instructionsUi
      .locator("summary")
      .filter({ hasText: /^子任务规范 · 独立观测$/ })
    await childSummary.waitFor({ state: "visible" })
    const childDetails = childSummary.locator("..")
    assert.equal(await childDetails.getAttribute("open"), null, "Child details start collapsed")
    await childSummary.click()
    assert.notEqual(await childDetails.getAttribute("open"), null)
    for (const childId of childIds)
      assert.equal(
        await childDetails.getByText(`${childId} · Task实际模型请求`, { exact: true }).count(),
        1
      )
    assert.equal(
      await childDetails.getByText("最终请求尚无记录，不能认定已发送。", { exact: true }).count(),
      0
    )
    await instructionsUi
      .locator("summary")
      .filter({ hasText: /^项目规范 · 本次来源$/ })
      .click()
    assert(await instructionsUi.getByText(/内容冲突需人工核对/).isVisible())
    await page.screenshot({ path: join(artifacts, "task-288-instruction-children-expanded.png") })
    await childSummary.click()
    assert.equal(await childDetails.getAttribute("open"), null)
    assert.equal(
      await childDetails.getByText("Task实际模型请求", { exact: false }).first().isVisible(),
      false
    )
    await page.screenshot({ path: join(artifacts, "task-288-instruction-children-collapsed.png") })
    assert.equal(
      requests.length,
      requestsBeforeObservationUi,
      "Reading instruction facts must not invoke a model"
    )
    pass(
      "The original runtime panel exposes distinct child instruction facts, explicit conflict guidance and working collapsed details"
    )
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    await page.screenshot({ path: join(artifacts, "task-288-completed.png") })
  } finally {
    writeFileSync(join(artifacts, "task-288-progress.json"), JSON.stringify(progress, null, 2))
    writeFileSync(
      join(artifacts, "task-288-logs.json"),
      JSON.stringify([...observedLogs.values()], null, 2)
    )
    writeFileSync(join(artifacts, "task-288-requests.json"), JSON.stringify(requests, null, 2))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}
