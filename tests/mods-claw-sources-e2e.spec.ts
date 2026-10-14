/** Real Electron, installed Skill/QuickJS guests and local MCP transports; isolated user data. */
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { formatSkillUseBlock } from "../src/shared/skill-use-block"
import type { ClawProfile } from "../src/shared/mods/claw"
import { DEFAULT_COMPLETION_POLICY } from "../src/shared/mods/v2/completion-policy-values"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

const root = resolve(__dirname, "..")
const artifacts = process.env.CMB_MODS_CORE_E2E_ARTIFACTS
  ? resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS)
  : join(root, "output/mods-claw-sources-e2e")
const { isolated, workspace, env } = compositionEnvironment(root)
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, "report.json"), { force: true })
if (existsSync(join(artifacts, "failure.json")))
  renameSync(join(artifacts, "failure.json"), join(artifacts, "previous-failure.json"))
const journal = join(isolated, "mcp.jsonl")
const requests: Record<string, unknown>[] = []
const checks: string[] = []
const errors: string[] = []
const timings: number[] = []
let nativeSkillPath = ""
let vetoSkill = false
const skillHooks: string[] = []
let app: ElectronApplication | undefined
let page: Page
const pass = (name: string) => {
  checks.push(name)
  console.log("PASS " + name)
}
const audit = () =>
  existsSync(journal)
    ? readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const currentSystemPrompt = () =>
  JSON.stringify(
    (requests.at(-1)?.messages as { role: string }[] | undefined)?.filter(
      (message) => message.role === "system"
    )
  )

async function main() {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (request.url?.startsWith("/skill-hook")) {
      skillHooks.push(request.url)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify(
          vetoSkill && request.url.endsWith("pre")
            ? { decision: "block", reason: "NATIVE-SKILL-VETO" }
            : {}
        )
      )
      return
    }
    requests.push(body)
    const flow = JSON.stringify(body.messages).includes("[SOURCES-FLOW]")
    const native = JSON.stringify(body.messages).includes("[NATIVE-FLOW]")
    const readSkill =
      native && !(body.messages as { role: string }[]).some((message) => message.role === "tool")
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({
        id: `sources-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta:
              flow || native
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `source-flow-${requests.length}`,
                        type: "function",
                        function: {
                          name: readSkill ? "read_file" : "structured_output",
                          arguments: JSON.stringify(
                            readSkill
                              ? { file_path: nativeSkillPath }
                              : {
                                  passed: true,
                                  summary: "Selected sources observed"
                                }
                          )
                        }
                      }
                    ]
                  }
                : { role: "assistant", content: "CLAW-SOURCES-READY" },
            finish_reason: flow || native ? "tool_calls" : "stop"
          }
        ]
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 300_000)
  try {
    app = await launchApp(60_000)
    const runtimeLog = join(artifacts, "runtime.log")
    writeFileSync(runtimeLog, "")
    app.process().stdout?.on("data", (chunk) => appendFileSync(runtimeLog, chunk))
    app.process().stderr?.on("data", (chunk) => appendFileSync(runtimeLog, chunk))
    page = await app.firstWindow()
    page.on("pageerror", (error) => errors.push(error.message))
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawSources))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page.evaluate(async (url) => {
      await window.api.mods.configureGlobal(true)
      await window.api.models.setCustomConfig({
        id: "sources",
        name: "Sources fixture",
        baseUrl: url,
        model: "sources",
        apiKey: "fixture",
        maxTokens: 32000,
        maxOutputTokens: 4096
      })
      await window.api.models.setDefault("custom:sources")
    }, url)
    const create = (title: string) =>
      page.evaluate(
        async ({ workspace, title }) => {
          const row = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = (row as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(id, workspace)
          await window.api.mods.configure(id, true, true)
          return id
        },
        { workspace, title }
      )
    const thread = await create("Skill MCP selected")
    const other = await create("Skill MCP inherited")
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(
        JSON.stringify({
          name: "source-fixture",
          version: "1.0.0",
          claw: {
            actions: [
              {
                id: "receive",
                name: "Receive tool output",
                command: "source-receive",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" }
              }
            ]
          }
        })
      )
    )
    zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on) {
      on("session.start", async ($,e,next) => {
        await $.command.register({name:"source-call",description:"Local MCP probe"})
        await $.command.register({name:"source-receive",description:"Receive MCP output",immediate:true})
        return next(e)
      })
      on("command.run", {command:"source-call"}, async ($,e) => {
        try { return {text:JSON.stringify(await $.mcp.call(e.args,"echo",{text:"actual-call"}))} }
        catch(error) { return {text:"DENIED:"+String(error)} }
      })
      on("command.run", {command:"source-receive"}, async ($,e) => {
        const input=JSON.parse(e.args).input
        return {text:"RECEIVED:"+input.text,output:input}
      })
    }`)
    )
    for (const name of ["source-allowed", "source-excluded"])
      zip.addFile(
        `skills/${name}/SKILL.md`,
        Buffer.from(
          `---\nname: ${name}\ndescription: ${name}-unique-description\n---\n# ${name}\nReply concisely.\n`
        )
      )
    zip.addFile(
      ".mcp.json",
      Buffer.from(
        JSON.stringify({
          mcpServers: Object.fromEntries(
            ["source-a", "source-b"].map((name) => [
              name,
              {
                command: process.execPath,
                args: [join(root, "tests/support/legacy-plugin-mcp-server.mjs"), journal, name]
              }
            ])
          )
        })
      )
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "sources.zip",
          "local",
          undefined,
          true
        ),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const status = (
      await page.evaluate((id) => window.api.mods.status(id), thread)
    ).functionMods!.find((entry) => entry.name === "source-fixture")!
    await page.evaluate(
      async ({ id, pluginId, digest, name, policy }) => {
        await window.api.mods.approveFunction(id, pluginId, digest)
        await window.api.mods.setCompletionPolicy(id, name, policy)
      },
      {
        id: thread,
        pluginId: status.pluginId,
        digest: status.digest!,
        name: status.name,
        policy: { ...DEFAULT_COMPLETION_POLICY, timeoutMs: 30000 }
      }
    )
    const catalog = await page.evaluate((id) => window.api.mods.clawSources(id), thread)
    assert(!JSON.stringify(catalog).includes(process.execPath))
    assert(!existsSync(journal), "Catalog must not start MCP processes")
    const skill = catalog.skills.find((entry) => entry.name === "source-allowed")!
    const mcp = catalog.mcp.find((entry) => entry.name === "source-a")!
    assert(skill && mcp)
    for (let index = 0; index < 5; index++) {
      const start = performance.now()
      await page.evaluate((id) => window.api.mods.clawSources(id), thread)
      timings.push(performance.now() - start)
    }
    pass("Host catalog is redacted and never launches configured MCP servers")
    const profile: ClawProfile = {
      id: "sources",
      name: "我的代码审查 Claw",
      capabilities: [{ pluginId: status.pluginId, name: status.name, digest: status.digest! }],
      skills: { mode: "selected", items: [skill] },
      mcp: { mode: "selected", items: [mcp] }
    }
    const bind = async (id: string, profile: ClawProfile) =>
      page.evaluate(
        async ({ id, profileJson }) => {
          const profile: ClawProfile = JSON.parse(profileJson)
          const view = await window.api.mods.clawView(id)
          const saved = await window.api.mods.clawChange(id, {
            kind: "save",
            profile,
            revision: view.revision,
            workspace: view.workspace
          })
          return window.api.mods.clawChange(id, {
            kind: "apply",
            id: profile.id,
            revision: saved.revision,
            workspace: saved.workspace
          })
        },
        { id, profileJson: JSON.stringify(profile) }
      )
    await bind(thread, profile)
    const command = async (id: string, serverName: string) => {
      const job = await page.evaluate(
        async ({ id, serverName }) => {
          const descriptor = (await window.api.mods.commands(id)).find(
            (item) => item.command === "source-call"
          )!
          return window.api.mods.enqueue(id, descriptor, { text: serverName })
        },
        { id, serverName }
      )
      for (let count = 0; count < 200; count++) {
        const current = await page.evaluate(
          async ({ id, jobId }) =>
            (await window.api.mods.jobs(id)).find((item) => item.id === jobId),
          { id, jobId: job.id }
        )
        assert(current?.state !== "failed", current?.error)
        if (current?.state === "succeeded") return current.result?.text ?? ""
        await new Promise((done) => setTimeout(done, 100))
      }
      throw Error("Command did not settle")
    }
    assert.match(await command(thread, "source-a"), /source-a:actual-call/)
    assert.match(await command(thread, "source-b"), /DENIED/)
    assert.equal(
      audit().filter((event) => event.event === "call" && event.revision === "source-b").length,
      0
    )
    assert.match(await command(other, "source-b"), /source-b:actual-call/)
    pass(
      "Real QuickJS SDK invokes selected MCP only; another unbound conversation retains both services"
    )
    const invoke = (id: string, message: string) =>
      page.evaluate(
        ({ id, message }) =>
          new Promise<unknown[]>((resolve, reject) => {
            const events: unknown[] = []
            const timer = setTimeout(() => {
              cleanup()
              reject(Error("Agent timeout"))
            }, 60_000)
            const cleanup = window.api.agent.invoke(
              id,
              message,
              (event) => {
                events.push(event)
                if (event.type === "done" || event.type === "error") {
                  clearTimeout(timer)
                  cleanup()
                  setTimeout(() => resolve(events), 100)
                }
              },
              "custom:sources",
              "normal"
            )
          }),
        { id, message }
      )
    const before = requests.length
    const events = await invoke(thread, "Report available capabilities briefly")
    assert(requests.length > before, JSON.stringify(events))
    const prompt = currentSystemPrompt()
    assert(prompt.includes("source-allowed-unique-description"), prompt.slice(0, 3000))
    assert(!prompt.includes("source-excluded-unique-description"))
    const skills = await page.evaluate(() => window.api.skills.listPlugins())
    const excluded = skills.find((entry) => entry.name === "source-excluded")!
    const accepted = skills.find((entry) => entry.name === "source-allowed")!
    const prior = requests.length
    const blocked = await invoke(thread, "Use this skill\n" + formatSkillUseBlock(excluded))
    assert.equal(
      requests.length,
      prior,
      "Excluded explicit skill must be blocked before model request"
    )
    assert.match(JSON.stringify(blocked), /CLAW_SKILL_NOT_SELECTED/)
    await invoke(thread, "Use this skill\n" + formatSkillUseBlock(accepted))
    assert(requests.length > prior)
    pass(
      "Real model prompt contains only selected Skill; excluded explicit activation is blocked before model"
    )
    await bind(thread, {
      ...profile,
      skills: { mode: "selected", items: [] },
      mcp: { mode: "selected", items: [] }
    })
    const callsBefore = audit().filter((event) => event.event === "call").length
    assert.match(await command(thread, "source-a"), /DENIED/)
    assert.equal(audit().filter((event) => event.event === "call").length, callsBefore)
    await invoke(thread, "No skills are selected")
    assert(!currentSystemPrompt().includes("source-allowed-unique-description"))
    pass("Explicit empty selections remove actual Skill/MCP capabilities without restoring all")
    const secondSkill = catalog.skills.find((entry) => entry.name === "source-excluded")!
    await bind(thread, { ...profile, skills: { mode: "selected", items: [secondSkill] } })
    await invoke(thread, "Use the newly applied skills only")
    assert(currentSystemPrompt().includes("source-excluded-unique-description"))
    assert(!currentSystemPrompt().includes("source-allowed-unique-description"))
    pass(
      "Switching a used conversation to another Skill refreshes real prompt metadata despite checkpoint cache"
    )
    const savedFlow = await page.evaluate(
      (id) =>
        window.api.mods.flowSave(
          id,
          {
            schemaVersion: 1,
            id: "source-inheritance",
            name: "Source inheritance",
            plugin: "source-fixture",
            goal: "Check inherited source selection",
            timeoutMs: 30000,
            maxExecutions: 4,
            steps: [
              {
                id: "inspect",
                name: "Inspect sources",
                kind: "agent",
                enabled: true,
                modelId: "custom:sources",
                prompt: "[SOURCES-FLOW] Return a structured result."
              }
            ]
          },
          0
        ),
      thread
    )
    const flowBinding = await bind(thread, { ...profile, flow: savedFlow })
    const flowRun = await page.evaluate(
      ({ id, revision }) => window.api.mods.clawStart(id, revision, "Check source inheritance"),
      { id: thread, revision: flowBinding.bindingRevision }
    )
    let completed = false
    for (let count = 0; count < 200; count++) {
      const run = await page.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
        id: thread,
        runId: flowRun.id
      })
      assert(
        !run || !["failed", "cancelled", "interrupted"].includes(run.status),
        JSON.stringify(run)
      )
      if (run?.status === "complete") {
        completed = true
        break
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    assert(completed, "Flow child did not complete")
    assert(currentSystemPrompt().includes("source-allowed-unique-description"))
    assert(!currentSystemPrompt().includes("source-excluded-unique-description"))
    pass(
      "A real host-created Flow child inherits the bound Skill catalog and completes its agent step"
    )
    nativeSkillPath = accepted.path
    const nativeCatalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), thread)
    const toolCatalog = await page.evaluate((id) => window.api.mods.flowMcpTools(id), thread)
    const echo = toolCatalog.find(
      (entry) => entry.provider.id === mcp.id && entry.toolName === "echo"
    )!
    assert(echo && !echo.unavailableReason, JSON.stringify(toolCatalog))
    assert(toolCatalog.every((entry) => entry.provider.id === mcp.id))
    const receiver = nativeCatalog.actions!.find((entry) => entry.actionId === "receive")!
    const nativeFlow = await page.evaluate(
      ({ id, skill, echo, receiver }) =>
        window.api.mods.flowSave(
          id,
          {
            schemaVersion: 1,
            id: "native-chain",
            name: "Skill 与 MCP 组合示例",
            plugin: "source-fixture",
            goal: "[NATIVE-FLOW] Read the selected Skill then invoke echo and pass output to action.",
            timeoutMs: 60000,
            maxExecutions: 5,
            steps: [
              {
                id: "skill",
                name: "使用选定 Skill",
                kind: "skill",
                enabled: true,
                skill,
                prompt: "[NATIVE-FLOW] Read the selected Skill and return a structured result.",
                modelId: "custom:sources"
              },
              {
                id: "echo",
                name: "调用指定 MCP",
                kind: "mcp-tool",
                enabled: true,
                provider: echo.provider,
                toolName: echo.toolName,
                schemaDigest: echo.schemaDigest,
                input: { text: "native-chain" }
              },
              {
                id: "receive",
                name: "插件接收结果",
                kind: "plugin-action",
                enabled: true,
                pluginId: receiver.pluginId,
                plugin: receiver.plugin,
                digest: receiver.digest,
                actionId: receiver.actionId,
                input: {},
                inputFrom: { stepId: "echo", path: "/structuredContent" }
              }
            ]
          },
          0
        ),
      {
        id: thread,
        skill,
        echo: {
          provider: echo.provider,
          toolName: echo.toolName,
          schemaDigest: echo.schemaDigest
        },
        receiver: {
          pluginId: receiver.pluginId,
          plugin: receiver.plugin,
          digest: receiver.digest,
          actionId: receiver.actionId
        }
      }
    )
    const hooks = await page.evaluate(
      async (base) =>
        Promise.all(
          (["PreSkillUse", "PostSkillUse"] as const).map((event) =>
            window.api.hooks.create({
              event,
              matcher: "source-allowed",
              type: "http",
              enabled: true,
              timeout: 10000,
              url: `${base}/skill-hook/${event === "PreSkillUse" ? "pre" : "post"}`
            })
          )
        ),
      url.replace(/\/v1$/, "")
    )
    const nativeBinding = await bind(thread, { ...profile, flow: nativeFlow })
    const runNative = async () => {
      const started = await page.evaluate(
        ({ id, revision }) =>
          window.api.mods.clawStart(id, revision, "[NATIVE-FLOW] Verify native steps"),
        { id: thread, revision: nativeBinding.bindingRevision }
      )
      for (let count = 0; count < 600; count++) {
        const result = await page.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
          id: thread,
          runId: started.id
        })
        if (result && ["complete", "failed", "cancelled", "interrupted"].includes(result.status))
          return result
        await new Promise((done) => setTimeout(done, 100))
      }
      throw Error("Native flow timeout")
    }
    const callsAtStart = audit().filter((event) => event.event === "call").length
    const nativeResult = await runNative()
    assert.equal(nativeResult.status, "complete", JSON.stringify(nativeResult))
    assert.equal(audit().filter((event) => event.event === "call").length, callsAtStart + 1)
    assert(skillHooks.some((event) => event.endsWith("pre")))
    assert(skillHooks.some((event) => event.endsWith("post")))
    assert(
      requests.some((request) =>
        (request.messages as { role: string; content: unknown }[]).some(
          (message) =>
            message.role === "tool" && JSON.stringify(message.content).includes("# source-allowed")
        )
      ),
      "Model must actually receive selected Skill document through read_file"
    )
    assert.equal(
      nativeResult.attempts.find((attempt) => attempt.stepId === "receive")?.result?.output?.text,
      "native-chain"
    )
    assert.equal(
      nativeResult.attempts.find((attempt) => attempt.stepId === "skill")?.result?.source,
      "skill"
    )
    pass(
      "Native Skill reads real instructions with Pre/Post hooks, MCP executes once, QuickJS action consumes structured output"
    )
    vetoSkill = true
    const requestsBeforeVeto = requests.length
    const callsBeforeVeto = audit().filter((event) => event.event === "call").length
    const vetoed = await runNative()
    assert.equal(vetoed.status, "failed", JSON.stringify(vetoed))
    assert.equal(requests.length, requestsBeforeVeto)
    assert.equal(audit().filter((event) => event.event === "call").length, callsBeforeVeto)
    assert.match(JSON.stringify(vetoed), /NATIVE-SKILL-VETO/)
    vetoSkill = false
    for (const hook of hooks) await page.evaluate((id) => window.api.hooks.delete(id), hook.id)
    pass("A real PreSkillUse veto blocks native Flow before any model or MCP request")
    await assert.rejects(
      page.evaluate(
        ({ id, flowJson }) => {
          const flow: typeof nativeFlow.definition = JSON.parse(flowJson)
          return window.api.mods.flowSave(
            id,
            {
              ...flow,
              id: "invalid-replay",
              steps: [
                ...flow.steps,
                {
                  id: "retry",
                  name: "Unsafe retry",
                  kind: "check",
                  enabled: true,
                  check: "unit-test",
                  onFailure: { stepId: "echo", maxRetries: 1 }
                }
              ]
            },
            0
          )
        },
        { id: thread, flowJson: JSON.stringify(nativeFlow.definition) }
      ),
      /MCP/
    )
    pass(
      "Saved native definitions preserve source identities and reject backtracking across an external call"
    )
    await bind(thread, profile)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Skill MCP selected", { exact: true }).first().click()
    await page.getByRole("button", { name: "当前助手", exact: true }).click()
    await page.getByRole("tab", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "管理助手组合", exact: true }).click()
    await page.locator("[data-claw-settings]").waitFor()
    await page.getByText("高级编辑与已保存组合", { exact: true }).click()
    await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
    await page
      .locator("[data-claw-settings]")
      .getByRole("heading", { name: "技能", exact: true })
      .waitFor()
    await page.screenshot({ path: join(artifacts, "source-selection-editor.png"), fullPage: true })
    await page.getByRole("region", { name: "技能", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, "skill-selection.png") })
    await page
      .getByRole("region", { name: "连接工具", exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, "mcp-selection.png") })
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(640, 600)
      window.setContentSize(800, 900)
    })
    await page.getByRole("region", { name: "技能", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, "skill-selection-800.png") })
    assert.equal(
      (await page.evaluate((id) => window.api.mods.clawView(id), thread)).active?.skills?.items[0]
        .id,
      skill.id
    )
    pass(
      "Selection persists through renderer reload and the production editor renders its source groups"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          errors,
          timings,
          audit: audit(),
          requestCount: requests.length,
          isolated,
          limits: [
            "Controlled model provider",
            "MCP service selection does not isolate shared connections",
            "Global slash menu remains visible; host enforces selection"
          ]
        },
        null,
        2
      )
    )
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          stack: (error as Error).stack,
          checks,
          errors,
          isolated,
          audit: audit()
        },
        null,
        2
      )
    )
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
