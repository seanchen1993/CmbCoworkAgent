/* Original Electron/tools/permissions; deterministic loopback model, no user data or paid API. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import {
  assertCreatorCreationMetrics,
  assertCreatorPatchMetrics,
  observeCreatorClicks,
  CREATOR_S1_GATES
} from "./support/creator-s1-acceptance"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const document = join(fixture.workspace, "review.md")
writeFileSync(document, "# Release plan\nOwner: missing\nDeadline: Friday\n")
const reviewBody = `
  const input=await $.fs.read("review.md")
  const result=await $.model.complete({model:"default",prompt:"DOC_REVIEW_INPUT\\n"+input})
  if(!result.isAnswered)throw Error("review did not complete")
  await $.store.set("review",result.text)
  await $.store.set("reviews",Number(await $.store.get("reviews")||0)+1)
`
const source = `import type {Register} from "claude-code"
export const register:Register=(on)=>{
  on("session.start",async($,event,next)=>{
    await $.command.register({name:"review-doc",description:"重新审查绑定文档"})
    return next(event)
  })
  on("command.run",{command:"review-doc"},async($)=>{
    ${reviewBody}
    $.ui.invalidate("ui.render");return{text:result.text}
  })
  on("ui.render",{component:"AbovePrompt"},async($,event)=>{
    let value=await $.store.get("review")
    if(!value){${reviewBody};value=result.text}
    const {Text}=$.ui.resolve(event)
    return Text({children:"审查："+String(value)+" · 次数："+Number(await $.store.get("reviews")||0)})
  })
}`
function files(text = source) {
  return [
    {
      path: "plugin.json",
      text: JSON.stringify({
        name: "creator-doc-review",
        version: "1.0.0",
        mods: "mods/manifest.json"
      })
    },
    {
      path: "mods/manifest.json",
      text: JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "creator-doc-review",
        entry: "main.ts",
        modelProtocol: "result-v1"
      })
    },
    { path: "mods/main.ts", text }
  ]
}
const errors: string[] = [],
  requests: unknown[] = [],
  reviews: string[] = []
const metrics: Record<string, unknown> = {}
let app: ElectronApplication | undefined,
  page: Page | undefined,
  passed = false
let mutation = 0
const server = createServer(async (request, response) => {
  let requestBody = ""
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 3_000_000)
    }
    const body = JSON.parse(raw)
    requestBody = raw
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const last = messages.findLastIndex((row) => row.role === "user")
    const prompt = JSON.stringify(messages[last])
    const results = messages.slice(last + 1).filter((row) => row.role === "tool")
    let tool: string | undefined,
      args: Record<string, unknown> | undefined,
      text = ""
    if (prompt.includes("Create a compact continuation handoff")) {
      text = `## Goal\nMaintain the document review Mod and follow the latest request.\n## Constraints\nUse original tools and permissions. Preserve review results.\n## Completed\nCreated, patched and undid the card; kept unsupported drafts.\n## Current State\nDraft doc-review current revision ${mutation}. Runtime status is authoritative.\n## Blockers\nNone observed.\n## Key Decisions\nReuse stored results for display changes.\n## Next Step\nFollow the latest user request.\n## Critical Evidence\nUse mod_authoring list for exact current status.`
    } else if (
      typeof messages[last]?.content === "string" &&
      messages[last].content.startsWith("DOC_REVIEW_INPUT\n")
    ) {
      assert(prompt.includes("# Release plan"), "The model must receive the real file contents")
      reviews.push(prompt)
      text = prompt.includes("Owner: missing") ? "缺少负责人" : "审查通过"
    } else if (/CREATE_DOC|PATCH_DOC|UNSUPPORTED_DOC|RESTORE_DOC/.test(prompt)) {
      if (!results.length) {
        const revision = mutation++
        tool = "mod_authoring"
        args = {
          action: "submit",
          id: "doc-review",
          name: "文档审查",
          revision,
          files: files(
            prompt.includes("PATCH_DOC")
              ? source.replace('"审查："', '"审查结果："')
              : prompt.includes("UNSUPPORTED_DOC")
                ? source + "\nconst unsupported = globalThis.host.rewrite()"
                : source
          )
        }
      } else {
        const result = JSON.parse(String(results[0].content))
        if (prompt.includes("UNSUPPORTED_DOC")) assert.equal(result.result.check.valid, false)
        else assert.equal(result.result.check.valid, true, JSON.stringify(result))
        text = prompt.includes("UNSUPPORTED_DOC")
          ? "当前不支持改写宿主内核，失败草稿已保留，原文档审查继续可用。"
          : "DOC_CANDIDATE_READY"
      }
    } else if (prompt.includes("UNDO_DOC")) {
      if (!results.length) {
        tool = "mod_authoring"
        args = { action: "undo_trial" }
        mutation++
      } else text = "DOC_UNDO_READY"
    } else if (prompt.includes("SAVE_DOC_COMBO")) {
      tool = "mod_composition"
      const replies = results.map((row) => JSON.parse(String(row.content)))
      const latest = replies.at(-1)
      const changed = replies.filter((reply) => reply.error === "COMPOSITION_SOURCE_CHANGED").length
      assert(changed <= 1, "A repeatedly changing catalog must stop, not loop")
      if (!latest || latest.error === "COMPOSITION_SOURCE_CHANGED")
        args = { action: "list", refresh: true }
      else if (latest.result?.catalogToken) {
        const catalog = latest.result
        assert.equal(
          catalog.saved.some((saved: { name: string }) => saved.name === "日常文档审查"),
          false,
          "The pending save must not already exist as a partial or empty named combination"
        )
        args = { action: "save", savedName: "日常文档审查", catalogToken: catalog.catalogToken }
      } else {
        assert.equal(latest.ok, true, JSON.stringify(latest))
        assert.equal(
          latest.result?.saved,
          false,
          "An uninstalled active trial cannot already be a saved combination"
        )
        assert.equal(latest.result?.phase, "needs-approval")
        assert.deepEqual(
          latest.result?.dependencies.map((dependency: { draftId: string }) => dependency.draftId),
          ["doc-review"]
        )
        assert.equal(
          latest.result?.revision,
          0,
          "Pending intent retains expected prior saved revision until native confirmation"
        )
        tool = undefined
        text = "DOC_COMBO_NEEDS_APPROVAL"
      }
    } else if (prompt.includes("APPLY_DOC_COMBO")) {
      if (!results.length) {
        tool = "mod_composition"
        args = { action: "apply_saved", savedName: "日常文档审查", savedRevision: 1 }
      } else {
        assert.equal(JSON.parse(String(results[0].content)).ok, true, JSON.stringify(results))
        text = "DOC_COMBO_APPLIED"
      }
    } else throw Error("Unexpected fixture prompt: " + prompt.slice(0, 240))
    if (tool)
      assert(
        body.tools.some((entry: { function: { name: string } }) => entry.function.name === tool)
      )
    requests.push({ prompt, tool, args, results })
    assert(requests.length < 45)
    if (!body.stream) {
      assert(!tool)
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "doc-review",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
        })
      )
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `doc-${requests.length}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) }
            }
          ]
        }
      : { role: "assistant", content: text }
    for (const value of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: tool ? "tool_calls" : "stop" }
    ])
      response.write(
        `data: ${JSON.stringify({ id: "doc", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...value }] })}\n\n`
      )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    appendFileSync(join(fixture.isolated, "fixture-errors.log"), String(error) + "\n")
    writeFileSync(join(fixture.isolated, "rejected-request.json"), requestBody)
    response.writeHead(500).end("fixture rejected")
  }
})
async function until<T>(
  read: () => Promise<T>,
  test: (value: T) => boolean,
  label: string
): Promise<T> {
  for (let n = 0; n < 240; n++) {
    const value = await read()
    assert.equal(errors.length, 0, errors.join("\n"))
    if (
      value &&
      typeof value === "object" &&
      "composition" in value &&
      (value.composition as { phase?: string })?.phase === "failed"
    )
      throw Error("Composition failed: " + JSON.stringify(value.composition))
    if (n % 40 === 0)
      writeFileSync(
        join(fixture.isolated, "latest-poll.json"),
        JSON.stringify({ label, value }, null, 2)
      )
    if (test(value)) return value
    await new Promise((done) => setTimeout(done, 250))
  }
  throw Error("Timed out: " + label)
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 300_000)
  try {
    const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })
    app = await launch()
    app
      .process()
      .stdout?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stdout.log"), bytes)
      )
    app
      .process()
      .stderr?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stderr.log"), bytes)
      )
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const scope = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "doc-loopback",
          name: "隔离审查模型",
          baseUrl: url,
          model: "doc-loopback",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:doc-loopback")
        const thread = await window.api.threads.create({
          title: "Document creator acceptance",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const current = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
        const scope = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
        await window.api.mods.development.setEnabled({ ...scope, enabled: true })
        return scope
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.getByText("Document creator acceptance", { exact: true }).first().click()
    const status = () =>
      page!.evaluate((input) => window.api.mods.development.status(input), {
        threadId: scope.threadId
      })
    const send = async (text: string) => {
      const workspace = page!.getByRole("dialog", { name: "插件创作工作区", exact: true })
      if (await workspace.isVisible())
        await workspace.getByRole("button", { name: "Close", exact: true }).click()
      await page!.locator("textarea.composer-textarea").fill(text)
      await page!.getByRole("button", { name: "发送消息", exact: true }).click()
    }
    const clicks = await observeCreatorClicks(page)
    const started = Date.now()
    await send(
      "CREATE_DOC 制作文档审查灵件，读取项目的 review.md，用当前模型审查并在聊天框上方展示结果，保留现有功能。"
    )
    await until(status, (value) => value.trials[0]?.phase === "needs-approval", "initial review")
    const approvalReady = Date.now()
    const approve = page.getByRole("button", { name: "确认并应用到这段聊天", exact: true })
    await approve.click()
    const approvalAt = Date.now()
    await until(status, (value) => value.trials[0]?.phase === "active", "active document trial")
    await page.getByText("审查：缺少负责人 · 次数：1", { exact: true }).waitFor({ timeout: 60_000 })
    metrics.creation = {
      elapsedMs: Date.now() - started,
      candidateReadyMs: approvalReady - started,
      confirmationMs: approvalAt - approvalReady,
      submitClicks: 1,
      trialConfirmations: 1,
      technicalPageVisits: 0,
      reviews: reviews.length
    }
    Object.assign(metrics.creation as object, { clicks: await clicks.read() })
    assert.equal(reviews.length, 1)
    if (process.env.CREATOR_E2E_SHORT !== "1") {
      const patchStarted = Date.now()
      await clicks.reset()
      await page.keyboard.press("Escape")
      await send("PATCH_DOC 把卡片标题改成审查结果，保留审查和已有结果，不重新审查文档。")
      await until(status, (value) => value.trials[0]?.activeRevision === 2, "display-only update")
      await page.getByText("审查结果：缺少负责人 · 次数：1", { exact: true }).waitFor()
      metrics.localPatch = {
        elapsedMs: Date.now() - patchStarted,
        submitClicks: 1,
        confirmations: 0,
        additionalReviews: reviews.length - 1
      }
      Object.assign(metrics.localPatch as object, { clicks: await clicks.read() })
      assert.equal(reviews.length, 1, "Display-only patch must reuse the actual stored result")
      await send("UNDO_DOC 撤销刚才的标题修改，保留审查结果。")
      await until(status, (value) => value.trials[0]?.activeRevision === 3, "source undo")
      await page.getByText("审查：缺少负责人 · 次数：1", { exact: true }).waitFor()
      await send("UNSUPPORTED_DOC 尝试改写宿主内核，无法支持时保留目前的审查功能和草稿，解释限制。")
      const unsupported = await until(
        status,
        (value) => value.drafts[0]?.revision === 4,
        "unsupported draft retained"
      )
      assert.equal(unsupported.trials[0].activeRevision, 3)
      await page
        .getByText("当前不支持改写宿主内核，失败草稿已保留，原文档审查继续可用。", { exact: true })
        .waitFor()
      await page.getByText("审查：缺少负责人 · 次数：1", { exact: true }).waitFor()
      assert.equal(reviews.length, 1)
      await send("RESTORE_DOC 继续使用原来支持的文档审查实现，保留结果。")
      await until(
        status,
        (value) => value.trials[0]?.activeRevision === 5,
        "supported source restored"
      )
    }
    const trialBeforeSave = await status()
    assert.equal(trialBeforeSave.trials[0]?.phase, "active")
    assert.equal(
      trialBeforeSave.reuse,
      undefined,
      "The fixture must not formalize the trial before requesting save"
    )
    assert.equal(trialBeforeSave.save, undefined)
    await page.keyboard.press("Escape")
    await send(
      "SAVE_DOC_COMBO 直接把当前文档审查组合保存为日常文档审查，保留已有功能并用于其它聊天。"
    )
    await page.getByText("DOC_COMBO_NEEDS_APPROVAL", { exact: true }).waitFor({ timeout: 60_000 })
    const pendingSave = await until(
      status,
      (value) => value.save?.phase === "needs-approval",
      "pending combination save through original reuse"
    )
    assert.equal(pendingSave.save?.saved, false)
    assert.equal(pendingSave.reuse?.phase, "needs-approval")
    assert.deepEqual(
      pendingSave.save?.dependencies.map((item) => item.draftId),
      ["doc-review"]
    )
    writeFileSync(
      join(fixture.isolated, "pending-save-receipt.json"),
      JSON.stringify(pendingSave, null, 2)
    )
    await page.getByRole("button", { name: "确认保存并复用", exact: true }).click()
    const formal = await until(
      status,
      (value) => value.reuse?.phase === "active" && value.save?.saved === true,
      "native reuse completes exact pending combination save"
    )
    assert(formal.reuse?.installationId)
    assert.equal(formal.save?.phase, "saved")
    assert.equal(formal.save?.name, "日常文档审查")
    assert.equal(formal.save?.revision, 1)
    await until(
      async () => reviews.length,
      (count) => count === 2,
      "formal source's own review store"
    )
    await page.getByText("审查：缺少负责人 · 次数：1", { exact: true }).waitFor()
    const composed = formal
    assert.equal(
      requests.some((row) => JSON.stringify(row).includes('"action":"request_reuse"')),
      false,
      "Only save may organize native reuse; the fixture must not issue a preceding model request_reuse"
    )
    const next = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Document reuse target",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      const current = await window.api.mods.status(thread.thread_id)
      await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
      const target = { threadId: thread.thread_id, expectedWorkspace: current.workspace }
      await window.api.mods.development.setEnabled({ ...target, enabled: true })
      return target
    }, fixture.workspace)
    await page.reload()
    await page.getByText("Document reuse target", { exact: true }).first().click()
    await send("APPLY_DOC_COMBO 套用已保存的日常文档审查，核对这段聊天的真实权限和来源。")
    const applied = await until(
      () =>
        page!.evaluate((input) => window.api.mods.development.status(input), {
          threadId: next.threadId
        }),
      (value) => value.composition?.phase === "active",
      "saved combination applied in another chat"
    )
    assert(applied.composition?.pluginNames.includes("creator-doc-review"))
    await page
      .locator('[data-function-site="AbovePrompt"] > div:not([data-function-site-cached])')
      .getByText("审查：缺少负责人 · 次数：1", { exact: true })
      .waitFor({ timeout: 60_000 })
    const reviewsBefore = reviews.length
    writeFileSync(document, "# Release plan\nOwner: Alice\nDeadline: Friday\n")
    // A trailing space closes the slash picker; this is a complete command with no arguments.
    await send("/review-doc ")
    await page
      .locator('[data-function-site="AbovePrompt"] > div:not([data-function-site-cached])')
      .getByText(/审查：审查通过 · 次数：/)
      .waitFor({ timeout: 60_000 })
    assert.equal(reviews.length, reviewsBefore + 1)
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true
        })
      )
        .toPNG()
        .toString("base64")
    )
    writeFileSync(join(fixture.isolated, "document-result.png"), Buffer.from(png, "base64"))
    writeFileSync(
      join(fixture.isolated, "composition-receipt.json"),
      JSON.stringify(composed, null, 2)
    )
    // The same isolated user directory is restarted; the test does not restore a run or approval.
    await app.close()
    app = await launch()
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.mods))
    const recovered = await page.evaluate((input) => window.api.mods.development.status(input), {
      threadId: scope.threadId
    })
    assert(!recovered.trials.some((trial) => trial.phase === "active"))
    assert.equal(recovered.drafts[0].revision, mutation)
    assert(recovered.request)
    assert.equal(reviews.length, reviewsBefore + 1, "Restart cannot replay a completed review")
    writeFileSync(
      join(fixture.isolated, "restart-observations.json"),
      JSON.stringify(recovered, null, 2)
    )
    assert.equal(errors.length, 0, errors.join("\n"))
    if (process.env.CREATOR_E2E_ACCEPTANCE === "1") {
      assertCreatorCreationMetrics("document", metrics.creation)
      assertCreatorPatchMetrics(metrics.localPatch)
    }
    passed = true
    console.log("PASS document creator closure: " + fixture.isolated)
  } catch (error) {
    errors.push(String(error))
    if (page)
      writeFileSync(
        join(fixture.isolated, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "document-evidence.json"),
      JSON.stringify(
        {
          passed,
          candidate,
          metrics,
          gates: process.env.CREATOR_E2E_ACCEPTANCE === "1" ? CREATOR_S1_GATES : "baseline-only",
          reviews,
          requests,
          errors,
          scope:
            "Original Electron IPC, compiler, native permissions and original model provider; deterministic loopback review fixture"
        },
        null,
        2
      )
    )
    assert.deepEqual(projectCompositionCandidate(root), candidate)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
