import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyInstructionsLoaded(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  closedStalls: () => number
): Promise<void> {
  const project = join(workspace, "instructions-loaded-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "batch-present.txt"), "ACTUAL_BATCH_FILE")
  writeFileSync(join(project, "AGENTS.md"), "INSTRUCTION_SOURCE_ACTUAL: respect project boundaries")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Instructions loaded E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "instructions-loaded", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"instructions-loaded",description:"Instruction mode"});return next(e)});
      on("command.run",{command:"instructions-loaded"},async($,e)=>{await $.store.set("mode",e.args);return {text:"INSTRUCTION_MODE:"+e.args}});
      on("classic.InstructionsLoaded",async($,e,next)=>{
        $.ui.log("INSTRUCTION_SOURCE:"+JSON.stringify(e));
        const lower=await next(e);
        if(await $.store.get("mode")==="stall") {
          await $.model.complete({model:"custom:mods-model-fixture",prompt:"[stall] instructions review",maxTokens:64});
          $.ui.log("LATE_INSTRUCTIONS_FINISH")
        }
        return await $.store.get("mode")==="block"?{block:"INSTRUCTIONS_BLOCKED_BEFORE_MODEL"}:lower
      })
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "instructions-loaded.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "instructions-loaded")!
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest! }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Instructions loaded E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const logs = () => page.evaluate((id) => window.api.mods.logs(id), threadId)
  const prompt = "[mods-tool-batch] inspect both files"
  const first = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= first + 2 &&
      (await page.getByText("TOOL_BATCH_OK", { exact: true }).count()) > 0 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "loaded instructions reach actual model"
  )
  const entries = (await logs()).filter((row) => row.text.startsWith("INSTRUCTION_SOURCE:"))
  assert.equal(entries.length, 1)
  const source = JSON.parse(entries[0].text.slice("INSTRUCTION_SOURCE:".length))
  assert.equal(source.file_path, join(project, "AGENTS.md"))
  assert.equal(source.memory_type, "Project")
  assert.equal(source.load_reason, "session_start")
  assert(JSON.stringify(requests[first]).includes("INSTRUCTION_SOURCE_ACTUAL"))
  await page.screenshot({ path: join(artifacts, "instructions-loaded-on.png") })
  pass(
    "actual project instructions emit one provenance event before a multi-step main task and remain in the real model prompt"
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  const off = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= off + 2 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "off original instructions task"
  )
  assert.deepEqual(await logs(), [])
  assert(JSON.stringify(requests[off]).includes("INSTRUCTION_SOURCE_ACTUAL"))
  pass("same task with Mods off retains original instruction injection without instruction hooks")
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await send("/instructions-loaded block")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "INSTRUCTION_MODE:block"
      ),
    "block instruction mode"
  )
  const blocked = requests.length
  await send(prompt)
  await until(
    async () =>
      requests.length >= blocked + 2 &&
      (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
    "observer cannot block main model"
  )
  assert.equal(requests.length, blocked + 2)
  assert.equal(
    await page.getByText("INSTRUCTIONS_BLOCKED_BEFORE_MODEL", { exact: false }).count(),
    0
  )
  pass(
    "InstructionsLoaded discards block output and preserves the original model flow as an observation event"
  )
  await send("/instructions-loaded stall")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
        (job) => job.result?.text === "INSTRUCTION_MODE:stall"
      ),
    "stall instruction mode"
  )
  for (const action of ["cancel", "revoke"] as const) {
    const start = requests.length,
      closed = closedStalls()
    const beforeAudit = new Set(
      (await page.evaluate((id) => window.api.mods.audit(id), threadId)).map(row => row.callId)
    )
    await send("[stall] original main task")
    await until(
      async () => requests.length >= start + 2,
      "instruction check reaches real review transport"
    )
    type ProtocolRequest = {
      messages: Array<{ role: string; content: unknown }>
      tools?: unknown[]
      max_tokens?: number
    }
    const phase = requests.slice(start) as ProtocolRequest[]
    assert.equal(phase.length, 2, "one original main model and one instruction observer")
    const native = phase.filter(request => Array.isArray(request.tools))
    const observer = phase.filter(request => !Array.isArray(request.tools))
    assert.equal(native.length, 1)
    assert.equal(observer.length, 1)
    assert.equal(native[0].messages.at(-1)?.role, "user")
    assert.equal(native[0].messages.at(-1)?.content, "[stall] original main task")
    assert(JSON.stringify(native[0].messages).includes("INSTRUCTION_SOURCE_ACTUAL"))
    assert.equal(observer[0].messages.at(-1)?.role, "user")
    assert.equal(observer[0].messages.at(-1)?.content, "[stall] instructions review")
    assert.equal(observer[0].max_tokens, 64)
    if (action === "cancel")
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
    else
      await page.evaluate(
        (id) => window.api.mods.revokeFunction(id, "instructions-loaded"),
        threadId
      )
    await until(
      async () =>
        closedStalls() === closed + (action === "cancel" ? 2 : 1) &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) ===
          (action === "cancel" ? 0 : 1),
      action === "cancel"
        ? "main cancellation closes both original and observer transports"
        : "revocation closes the instruction observer while original native chat remains running"
    )
    assert.equal(requests.length, start + 2)
    await until(async () => (await page.evaluate((id) => window.api.mods.audit(id), threadId))
      .some(row => !beforeAudit.has(row.callId) && row.toolId === "model.complete" &&
        row.status !== "running" && row.status !== "not_started"),
    "the closed instruction observer publishes its actual execution settlement")
    const receipts = (await page.evaluate((id) => window.api.mods.audit(id), threadId))
      .filter(row => !beforeAudit.has(row.callId) && row.toolId === "model.complete")
    assert.equal(receipts.length, 1, "the observer makes one real model call without retries")
    assert.equal(receipts[0].status, "unknown", "an interrupted observer cannot report model success")
    assert.deepEqual(receipts[0].modelUsage, {
      modelRef: "custom:mods-model-fixture", outputTokenLimit: 64
    }, "the stalled observer retains its real limit without inventing final token usage")
    const closedAtAction = closedStalls() - closed
    assert.equal(closedAtAction, action === "cancel" ? 2 : 1)
    assert(!(await logs()).some((row) => row.text === "LATE_INSTRUCTIONS_FINISH"))
    if (action === "revoke") {
      assert.equal((await page.evaluate((id) => window.api.mods.status(id), threadId))
        .functionMods?.find(row => row.name === "instructions-loaded")?.state, "needs-approval")
      assert(!(await page.evaluate((id) => window.api.mods.commands(id), threadId))
        .some(row => row.command === "instructions-loaded"))
      // Revoking an observer never cancels its native parent. Stop that deliberately stalled
      // native transport explicitly, after proving the observer was already closed on its own.
      await page.getByRole("button", { name: "停止生成", exact: true }).click()
      await until(async () => closedStalls() === closed + 2 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "explicit native stop closes only the remaining main transport after observer revocation")
      assert.equal(requests.length, start + 2)
    }
    writeFileSync(join(artifacts, `instructions-loaded-${action}-evidence.json`), JSON.stringify({
      requestPhases: ["native-stall", "instruction-observer-stall"],
      observerStatus: receipts[0].status,
      modelUsage: receipts[0].modelUsage,
      closedAtAction,
      explicitNativeStopAfterRevoke: action === "revoke",
      closedAfterCleanup: closedStalls() - closed
    }, null, 2))
    pass(
      action === "cancel"
        ? "cancel during actual instruction review closes both observation and main transports without a late observation"
        : "revoke closes the instruction observer without cancelling native chat; explicit native stop cleans up its transport"
    )
  }
}
