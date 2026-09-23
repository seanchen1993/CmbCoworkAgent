import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page, ElectronApplication } from "playwright"

export async function verifyClassicOutput(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  requests: Array<{ messages: unknown }>,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const project = join(workspace, "classic-output-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_TOOL_RESULT")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Classic output E2E",
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
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/classic-output"))
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "classic-output.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "classic-output")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Classic output E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const run = async (expected: number) => {
    await composer.fill("[mods-tool-rewrite]")
    await submit.click()
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) >= expected &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "native read completes"
    )
  }
  const lastTool = (start: number): string => {
    const messages = requests.slice(start).flatMap((request) => {
      const list = request.messages as Array<{ role: string; content: unknown }>
      return list.at(-1)?.role === "tool" ? [list.at(-1)] : []
    })
    assert(messages.length > 0)
    return JSON.stringify(messages.at(-1)?.content)
  }
  try {
    const start = requests.length
    await run(1)
    const on = lastTool(start)
    assert(on.includes("CLASSIC_MODEL_REPLACEMENT_1"), on)
    assert(!on.includes("ORIGINAL_TOOL_RESULT"))
    assert.equal(readFileSync(join(project, "claw-notes"), "utf8"), "ORIGINAL_TOOL_RESULT")
    await page.screenshot({ path: join(artifacts, "classic-output-on.png") })
    pass(
      "real classic PostToolUse changes the model result once after native read without changing the file"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    const offStart = requests.length
    await run(2)
    const off = lastTool(offStart)
    assert(off.includes("ORIGINAL_TOOL_RESULT"), off)
    assert(!off.includes("CLASSIC_MODEL_REPLACEMENT"))
    writeFileSync(
      join(artifacts, "classic-output-evidence.json"),
      JSON.stringify({ on, off, actualFileUnchanged: true }, null, 2)
    )
    pass("same native task with Mods off restores original model output")
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await app.evaluate(({ dialog }, entry) => {
      const state = globalThis as unknown as {modsFixture?: unknown; modsConfirmations?: unknown[]}
      if (state.modsFixture) return
      const { createRequire } = process.getBuiltinModule("node:module")
      state.modsFixture = createRequire(entry)(entry)
      state.modsConfirmations = []
      dialog.showMessageBox = (async (_window, options) => {
        state.modsConfirmations!.push(options)
        return {response:1,checkboxChecked:false}
      }) as typeof dialog.showMessageBox
    }, join(root, "out/main/mods-e2e.js"))
    const connector = await app.evaluate(
      (_electron, input) =>
        (
          globalThis as unknown as {
            modsFixture: {
              startFunctionMcpFixture(
                workspace: string,
                node: string,
                server: string
              ): Promise<string>
            }
          }
        ).modsFixture.startFunctionMcpFixture(input.workspace, input.node, input.server),
      {
        workspace: project,
        node: process.execPath,
        server: join(root, "tests/support/mods-mcp-server.mjs")
      }
    )
    try {
      const startedMcp = requests.length
      await composer.fill("[mods-classic-mcp]")
      await submit.click()
      await until(
        async () =>
          (await page.getByText("MODEL_CLASSIC_MCP_OK", { exact: true }).count()) === 1 &&
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
        "actual model-raised MCP completes"
      )
      const output = lastTool(startedMcp)
      assert(output.includes("CLASSIC_MCP_REPLACEMENT"), output)
      assert(!output.includes("WRONG_GENERIC_MCP_OUTPUT"))
      assert.equal(readFileSync(join(project, "mcp-sdk-counter.txt"), "utf8"), "error\n")
      const audit = (await page.evaluate((id) => window.api.mods.audit(id), threadId)).filter(
        (row) => row.toolId.startsWith("mcp:")
      )
      assert.equal(audit.length, 1)
      assert.equal(audit[0].status, "failed")
      writeFileSync(
        join(artifacts, "classic-mcp-output-evidence.json"),
        JSON.stringify(
          {
            output,
            actualExecutions: 1,
            receiptStatus: audit[0].status
          },
          null,
          2
        )
      )
      pass(
        "real model-raised MCP preserves one failed execution receipt despite replacement claiming isError false"
      )
    } finally {
      await app.evaluate(
        (_electron, id) =>
          (
            globalThis as unknown as {
              modsFixture: { stopFunctionMcpFixture(id: string): Promise<void> }
            }
          ).modsFixture.stopFunctionMcpFixture(id),
        connector
      )
    }
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
