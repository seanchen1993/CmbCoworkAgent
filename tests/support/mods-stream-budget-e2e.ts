import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Real UI -> native provider -> actual utility-process stream hooks; no budget scaling. */
export async function verifyStreamBudget(
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  let requests = 0
  let firstCompleted = false
  let cancelled = false
  const server = createServer(async (request, response) => {
    let receivedBytes = 0
    for await (const chunk of request) receivedBytes += Buffer.byteLength(chunk)
    assert(receivedBytes > 0)
    const index = ++requests
    response.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (text: string, done = false) =>
      response.write(
        `data: ${JSON.stringify({
          id: `stream-budget-${index}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: text },
              finish_reason: done ? "stop" : null
            }
          ]
        })}\n\n`
      )
    frame(index === 1 ? "STREAM_FIRST_VISIBLE" : "STREAM_CANCEL_VISIBLE")
    response.on("close", () => {
      if (index === 2) cancelled = true
    })
    const timer = setTimeout(() => {
      if (response.destroyed) return
      frame(index === 1 ? " STREAM_AFTER_SLOW_WAIT" : " STREAM_MUST_NOT_ARRIVE", true)
      if (index === 1) firstCompleted = true
      response.end("data: [DONE]\n\n")
    }, 11200)
    response.on("close", () => clearTimeout(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const project = join(workspace, "stream-budget")
  mkdirSync(project, { recursive: true })
  const title = "Mods 逐段处理与取消验收"
  try {
    const threadId = await page.evaluate(
      async ({ project, title, baseUrl }) => {
        await window.api.models.setCustomConfig({
          id: "stream-budget",
          name: "stream-budget",
          baseUrl,
          model: "gpt-4",
          apiKey: "fixture-key",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:stream-budget")
        const thread = await window.api.threads.create({
          title,
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, { set: { model: "custom:stream-budget" } })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, title, baseUrl: `http://127.0.0.1:${address.port}/v1` }
    )
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "stream-budget", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on){
      on("turn.step",async function*($,e,next){
        const source=next(e);let count=0;
        for await(const chunk of source){
          $.ui.log("STREAM_BUDGET:"+JSON.stringify({ms:next.budget.ms,left:next.budget.remainingMs,count:++count}));
          yield chunk;
        }
        return await source.result;
      });
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "stream-budget.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((row) => row.name === "stream-budget")!
    assert(mod?.digest)
    await page.evaluate(
      ({ threadId, mod }) => window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!),
      { threadId, mod }
    )
    const applied = await page.evaluate(
      async ({ threadId, mod }) => {
        let view = await window.api.mods.clawView(threadId)
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          workspace: view.workspace,
          revision: view.revision,
          profile: {
            id: "stream-budget-claw",
            name: "逐段处理验收",
            capabilities: [{ pluginId: mod.pluginId, name: mod.name, digest: mod.digest! }],
            models: { default: "custom:stream-budget", roles: {} }
          }
        })
        return window.api.mods.clawChange(threadId, {
          kind: "apply",
          id: "stream-budget-claw",
          workspace: view.workspace,
          revision: view.revision
        })
      },
      { threadId, mod }
    )
    assert.equal(applied.active?.id, "stream-budget-claw")
    pass("Saved and applied Claw selects the actual stream component and configured provider")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("Reply once with the requested stream probe.")
    await composer.press("Enter")
    await until(
      async () => (await page.getByText("STREAM_FIRST_VISIBLE", { exact: false }).count()) > 0,
      "first chunk visible while provider waits"
    )
    assert.equal(firstCompleted, false)
    await page.screenshot({ path: join(artifacts, "stream-first-visible.png") })
    pass("The real first chunk is visible before the provider finishes its 11.2-second wait")
    await until(
      async () =>
        (await page.getByText("STREAM_AFTER_SLOW_WAIT", { exact: false }).count()) > 0 &&
        !(await page.getByRole("button", { name: "停止生成", exact: true }).count()),
      "slow stream completed"
    )
    assert.equal(requests, 1)
    const logs = await page.evaluate((id) => window.api.mods.logs(id), threadId)
    const budgets = logs
      .filter((row) => row.text.startsWith("STREAM_BUDGET:"))
      .map((row) => JSON.parse(row.text.slice("STREAM_BUDGET:".length)))
    assert(budgets.length >= 2, JSON.stringify(logs))
    assert(
      budgets.every((row) => row.ms === 10000 && row.left > 7000),
      JSON.stringify(budgets)
    )
    writeFileSync(join(artifacts, "stream-budgets.json"), JSON.stringify(budgets, null, 2))
    await page.screenshot({ path: join(artifacts, "stream-slow-complete.png") })
    pass(
      "Actual model waits longer than the own budget remain free; all chunks arrive with one provider call"
    )
    await composer.fill("Run the cancellation stream probe.")
    await composer.press("Enter")
    await until(
      async () => (await page.getByText("STREAM_CANCEL_VISIBLE", { exact: false }).count()) > 0,
      "cancellation chunk visible"
    )
    await page.getByRole("button", { name: "停止生成", exact: true }).click()
    await until(
      async () =>
        cancelled && !(await page.getByRole("button", { name: "停止生成", exact: true }).count()),
      "actual native request cancelled"
    )
    assert.equal(requests, 2)
    assert.equal(await page.getByText("STREAM_MUST_NOT_ARRIVE", { exact: false }).count(), 0)
    await page.screenshot({ path: join(artifacts, "stream-cancelled.png") })
    pass("User Stop cancels the actual provider request without replay or late output")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
