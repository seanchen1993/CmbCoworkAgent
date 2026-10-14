import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ConsoleMessage, Locator, Page } from "playwright"
import { openModsResults } from "./mods-sidebar-navigation"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiNode
} from "../../src/shared/mods/v2/ui"

function codeNodes(tree: FunctionUiElement | string): FunctionUiNode[] {
  if (typeof tree === "string" || tree.type === "engine") return []
  if (tree.type === "Code") return [tree]
  return (tree.children ?? []).flatMap(codeNodes)
}

/** Separate from the existing Code pane/highlighter regression; no model turn is introduced. */
export async function verifyCodeLong(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const failures: unknown[] = []
  let observationFailed = false
  let originalConsoleEnabled: boolean | undefined
  const fallbackLogs: string[] = []
  const onConsole = (message: ConsoleMessage): void => {
    try {
      if (message.type() === "warning" && message.text() === "MODS_UI_CODE_DIFF_FALLBACK")
        fallbackLogs.push("MODS_UI_CODE_DIFF_FALLBACK")
    } catch {
      observationFailed = true
    }
  }
  const evidence = {
    complete: false,
    realGuest: true,
    actualCommandSettlement: true,
    sourceInputLength: 120000 + ":sk-code-long-fixture-token-123456789:CODE_LONG_SOURCE_END".length,
    sourceSnapshotLength: 0,
    sourceDisplayLength: 0,
    aggregateSnapshotLengths: [] as number[],
    aggregateDisplayLengths: [] as number[],
    diffSnapshotLength: 0,
    diffDisplayLength: 0,
    fallbackLogEnums: [] as string[],
    protectedBeforeDisplay: false,
    transcriptUnchanged: false,
    requestsUnchanged: false,
    closed: false,
    off: false,
    noStaleRestoration: false,
    revoked: false,
    screenshots: [
      "code-long-source.png",
      "code-long-aggregate.png",
      "code-long-diff.png",
      "code-long-off.png",
      "code-long-revoked.png"
    ]
  }
  try {
    const project = join(workspace, "code-long-project")
    mkdirSync(project, { recursive: true })
    const threadId = await page.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Code long E2E",
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    }, project)
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "code-long", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on) {
      on("session.start", async ($, e, next) => {
        for (const name of ["code-long-source", "code-long-aggregate", "code-long-diff"])
          await $.command.register({name, description:"Long Code drawing", immediate:true});
        return next(e);
      });
      on("command.run", {command:"code-long-source"}, async ($) => {
        await $.ui.open({id:"code-long-source", title:"Long Code Source", rows:12, closeOnEscape:true});
        return {text:"CODE_LONG_SOURCE_OPEN"};
      });
      on("command.run", {command:"code-long-aggregate"}, async ($) => {
        await $.ui.open({id:"code-long-aggregate", title:"Long Code Aggregate", rows:12, closeOnEscape:true});
        return {text:"CODE_LONG_AGGREGATE_OPEN"};
      });
      on("command.run", {command:"code-long-diff"}, async ($) => {
        await $.ui.open({id:"code-long-diff", title:"Long Code Diff", rows:12, closeOnEscape:true});
        return {text:"CODE_LONG_DIFF_OPEN"};
      });
      on("ui.render", {component:"Pane", requestId:"code-long-source"}, ($, e) => {
        const {Box, Code} = $.ui.resolve(e);
        const tail=":sk-code-long-fixture-token-123456789:CODE_LONG_SOURCE_END";
        const source="x".repeat(120000)+tail;
        if(source.length!==120000+tail.length || !source.endsWith(tail))
          throw Error("CODE_LONG_FULL_SOURCE_REQUIRED");
        return Box({flexDirection:"column", children:[Code({source, language:"typescript",
          path:"never-read/code-long-source.ts"})]});
      });
      on("ui.render", {component:"Pane", requestId:"code-long-aggregate"}, ($, e) => {
        const {Box, Code} = $.ui.resolve(e);
        return Box({flexDirection:"column", children:[Code({source:"a".repeat(70000)}),
          Box({flexDirection:"column", children:[Code({source:"b".repeat(70000)})]})]});
      });
      on("ui.render", {component:"Pane", requestId:"code-long-diff"}, ($, e) => {
        const {Box, Code} = $.ui.resolve(e);
        const prefix="<script>CODE_LONG_NOT_EXECUTABLE</script>", tail=":CODE_LONG_DIFF_END";
        const source=prefix+"d".repeat(30000-prefix.length-tail.length)+tail;
        if(source.length!==30000 || !source.endsWith(tail)) throw Error("CODE_LONG_FULL_DIFF_REQUIRED");
        return Box({children:[Code({source, format:"diff", startLine:17,
          path:"never-read/code-long-diff.txt"})]});
      });
    }`)
    )
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "code-long.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods?.find((row) => row.name === "code-long")
    assert(mod?.digest)
    assert.equal(mod.name, "code-long")
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Code long E2E", { exact: true }).first().click()
    await openModsResults(page)

    const messagesBefore = JSON.stringify(
      await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    )
    const requestsBefore = JSON.stringify(requests)
    originalConsoleEnabled = await page.evaluate(() => {
      const gate = window as Window & { logState?: () => boolean; logOn?: () => boolean }
      if (typeof gate.logState !== "function" || typeof gate.logOn !== "function")
        throw Error("The original renderer console gate is required")
      const original = gate.logState()
      if (typeof original !== "boolean") throw Error("The original console state is invalid")
      return original
    })
    await page.evaluate(() => {
      const gate = window as Window & { logState?: () => boolean; logOn?: () => boolean }
      if (
        typeof gate.logState !== "function" ||
        typeof gate.logOn !== "function" ||
        gate.logOn() !== true ||
        gate.logState() !== true
      )
        throw Error("The original renderer console gate did not enable")
    })
    page.on("console", onConsole)
    const panes = () => page.evaluate((id) => window.api.mods.panes(id), threadId)
    const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
    const run = async (command: string, expected: string): Promise<void> => {
      const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), threadId)).find(
        (row) => row.command === command
      )
      assert(descriptor, "The approved real command descriptor is required")
      const job = await page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
        { id: threadId, descriptor }
      )
      await until(
        async () => (await jobs()).some((row) => row.id === job.id && row.state === "succeeded"),
        "the actual Code command succeeds"
      )
      const settled = (await jobs()).find((row) => row.id === job.id)
      assert(settled && settled.state === "succeeded", "The original command must actually settle")
      assert.equal(settled.result?.text, expected)
    }
    const snapshot = async (id: string): Promise<FunctionPaneSnapshot> => {
      const value = (await panes()).find((row) => row.id === id && row.plugin === mod.name)
      assert(value, "The actual approved plugin pane snapshot is required")
      return value
    }
    const pane = (id: string) => page.locator(`[data-function-pane="${id}"]`)
    const text = async (element: Locator): Promise<string> =>
      (await element.locator("code").allTextContents()).join("\n")
    const unchanged = async (): Promise<void> => {
      assert.equal(
        JSON.stringify(await page.evaluate((id) => window.api.threads.getMessages(id), threadId)),
        messagesBefore
      )
      assert.equal(JSON.stringify(requests), requestsBefore)
    }
    await run("code-long-source", "CODE_LONG_SOURCE_OPEN")
    const source = await snapshot("code-long-source"),
      sourceNodes = codeNodes(source.tree)
    assert.equal(sourceNodes.length, 1)
    const protectedSource = "x".repeat(120000) + ":[REDACTED]:CODE_LONG_SOURCE_END"
    assert.equal(sourceNodes[0].props.source, protectedSource)
    const sourcePane = pane(source.id)
    await until(
      async () => (await text(sourcePane)) === "x".repeat(100000),
      "the protected source uses its exact bounded desktop copy"
    )
    assert(!(await sourcePane.innerText()).includes("never-read/code-long-source.ts"))
    assert.equal(await sourcePane.locator("script").count(), 0)
    evidence.sourceSnapshotLength = protectedSource.length
    evidence.sourceDisplayLength = (await text(sourcePane)).length
    evidence.protectedBeforeDisplay = true
    await unchanged()
    await page.screenshot({ path: join(artifacts, "code-long-source.png") })
    pass("real Guest Code keeps the complete protected source snapshot and displays only 100k")

    await run("code-long-aggregate", "CODE_LONG_AGGREGATE_OPEN")
    const aggregate = await snapshot("code-long-aggregate"),
      aggregateNodes = codeNodes(aggregate.tree)
    assert.equal(aggregateNodes.length, 2)
    assert.equal(aggregateNodes[0].props.source, "a".repeat(70000))
    assert.equal(aggregateNodes[1].props.source, "b".repeat(70000))
    const aggregatePane = pane(aggregate.id)
    await until(
      async () =>
        JSON.stringify(await aggregatePane.locator("code").allTextContents()) ===
        JSON.stringify(["a".repeat(70000), "b".repeat(30000)]),
      "the actual nested Code elements share one 100k drawing budget"
    )
    evidence.aggregateSnapshotLengths = aggregateNodes.map(
      (node) => String(node.props.source).length
    )
    evidence.aggregateDisplayLengths = (await aggregatePane.locator("code").allTextContents()).map(
      (value) => value.length
    )
    assert.equal(
      evidence.aggregateDisplayLengths.reduce((total, length) => total + length, 0),
      100000
    )
    await unchanged()
    await page.screenshot({ path: join(artifacts, "code-long-aggregate.png") })
    pass("two actual Code nodes retain 140k in their snapshot and share 70k plus 30k on screen")

    await run("code-long-diff", "CODE_LONG_DIFF_OPEN")
    const diff = await snapshot("code-long-diff"),
      diffNodes = codeNodes(diff.tree)
    const prefix = "<script>CODE_LONG_NOT_EXECUTABLE</script>",
      tail = ":CODE_LONG_DIFF_END"
    const plainDiff = prefix + "d".repeat(30000 - prefix.length - tail.length) + tail
    assert.equal(diffNodes.length, 1)
    assert.equal(diffNodes[0].props.source, plainDiff)
    assert.equal(diffNodes[0].props.format, "diff")
    assert.equal(diffNodes[0].props.startLine, 17)
    const diffPane = pane(diff.id)
    await until(
      async () => (await text(diffPane)) === plainDiff,
      "the actual malformed diff falls back to complete escaped plain code"
    )
    await until(
      async () => fallbackLogs.length > 0,
      "the original Code fallback warning is observed"
    )
    assert.equal(await diffPane.locator("script").count(), 0)
    assert.equal(await diffPane.locator('[aria-hidden="true"]').count(), 0)
    assert.equal(
      await diffPane
        .locator('[data-code-kind="add"], [data-code-kind="remove"], [data-code-kind="header"]')
        .count(),
      0
    )
    assert.equal(await diffPane.locator('[data-code-kind="source"]').count(), 1)
    assert(!(await diffPane.innerText()).includes("never-read/code-long-diff.txt"))
    assert.deepEqual([...new Set(fallbackLogs)], ["MODS_UI_CODE_DIFF_FALLBACK"])
    assert.equal(observationFailed, false)
    evidence.diffSnapshotLength = plainDiff.length
    evidence.diffDisplayLength = (await text(diffPane)).length
    evidence.fallbackLogEnums = [...new Set(fallbackLogs)]
    await unchanged()
    await page.screenshot({ path: join(artifacts, "code-long-diff.png") })
    pass(
      "invalid diff retains its full source while actual DOM escapes it without gutters or paths"
    )

    await sourcePane.getByRole("button", { name: "关闭 Long Code Source", exact: true }).click()
    await until(
      async () =>
        !(await panes()).some((row) => row.id === source.id) && (await sourcePane.count()) === 0,
      "the actual native close button retires the source pane"
    )
    evidence.closed = true
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        (await panes()).length === 0 && (await page.locator("[data-function-pane]").count()) === 0,
      "global off removes every Code pane"
    )
    evidence.off = true
    await unchanged()
    await page.screenshot({ path: join(artifacts, "code-long-off.png") })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await page.evaluate((id) => window.api.mods.commands(id), threadId)
    assert.deepEqual(await panes(), [])
    evidence.noStaleRestoration = true
    await run("code-long-aggregate", "CODE_LONG_AGGREGATE_OPEN")
    const fresh = await snapshot("code-long-aggregate")
    assert.notEqual(fresh.generation, aggregate.generation)
    await until(
      async () => (await pane(fresh.id).count()) === 1,
      "the new real Session draws a fresh pane"
    )
    await page.evaluate(({ id, pluginId }) => window.api.mods.revokeFunction(id, pluginId), {
      id: threadId,
      pluginId: mod.pluginId
    })
    await until(
      async () =>
        (await panes()).length === 0 && (await page.locator("[data-function-pane]").count()) === 0,
      "revocation removes the fresh Code pane"
    )
    evidence.revoked = true
    await unchanged()
    evidence.transcriptUnchanged = true
    evidence.requestsUnchanged = true
    assert.equal(observationFailed, false)
    await page.screenshot({ path: join(artifacts, "code-long-revoked.png") })
    pass(
      "close, global off and revocation remove Code presentation with no transcript or model change"
    )
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      if (originalConsoleEnabled !== undefined)
        await page.evaluate((enabled) => {
          const gate = window as Window & {
            logState?: () => boolean
            logOn?: () => boolean
            logOff?: () => boolean
          }
          if (
            typeof gate.logState !== "function" ||
            typeof gate.logOn !== "function" ||
            typeof gate.logOff !== "function"
          )
            throw Error("The original console gate is unavailable")
          if (enabled) gate.logOn()
          else gate.logOff()
          if (gate.logState() !== enabled) throw Error("The original console state did not restore")
        }, originalConsoleEnabled)
    } catch (error) {
      failures.push(error)
    }
    try {
      await page.evaluate(() => window.api.mods.configureGlobal(false))
    } catch (error) {
      failures.push(error)
    }
    try {
      page.off("console", onConsole)
    } catch (error) {
      failures.push(error)
    }
    try {
      await page.evaluate(() => window.api.mods.configureGlobal(true))
    } catch (error) {
      failures.push(error)
    }
  }
  evidence.complete = failures.length === 0 && !observationFailed
  try {
    writeFileSync(join(artifacts, "code-long-evidence.json"), JSON.stringify(evidence, null, 2))
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Code long E2E cleanup failed")
  assert.equal(evidence.complete, true)
}
