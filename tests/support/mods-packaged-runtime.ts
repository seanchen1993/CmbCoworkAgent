import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { startModsModelServer } from "./mods-model-server"
import {
  readWindowsProcessIdentities,
  WindowsProcessQueryError
} from "./mods-windows-process-observer"

/** Uses the production package and public IPC. This does not install or test the NSIS installer. */
export async function verifyPackagedRuntime(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  assert.equal(process.platform, "win32")
  const project = join(workspace, "packaged-runtime")
  mkdirSync(project, { recursive: true })
  const evidence: Record<string, unknown> = {
    scope: "Existing win-unpacked runtime closure; not NSIS installation",
    complete: false
  }
  const failures: unknown[] = []
  const startedAt = performance.now()
  let phaseStartedAt = startedAt
  let jobThread: string | undefined
  let jobReaped = false
  let globalState: boolean | undefined
  let defaultModel: string | undefined
  let routingMode: "auto" | "pinned" | undefined
  let modelId: string | undefined
  let server: Awaited<ReturnType<typeof startModsModelServer>> | undefined
  const attempt = async (run: () => unknown | Promise<unknown>) => {
    try {
      await run()
    } catch (reason) {
      failures.push(reason)
    }
  }
  try {
    const packageState = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
      executable: process.execPath
    }))
    assert.equal(packageState.packaged, true)
    assert(packageState.path.endsWith("app.asar"))
    const marker = `PACKAGED_PTY_OUTPUT_${randomUUID().replaceAll("-", "")}`
    const terminal = await page.evaluate(
      async ({ project, marker }) => {
        const errors: unknown[] = []
        let id: string | undefined
        let removeData: (() => void) | undefined
        let removeExit: (() => void) | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let text = ""
        let code: number | null = null
        try {
          id = await window.api.terminal.create({
            workDir: project,
            args: ["--version"],
            syncSkills: false,
            syncMemory: false
          })
          const actualId = id
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(Error("Packaged PTY output/exit timed out")), 30_000)
            removeData = window.api.terminal.onData(actualId, (data, bytes) => {
              try {
                text += data
                window.api.terminal.ack(actualId, bytes)
                if (text.length > 64 * 1024)
                  reject(Error("Packaged PTY output exceeded fixture bound"))
              } catch (reason) {
                reject(reason)
              }
            })
            removeExit = window.api.terminal.onExit(actualId, (exitCode) => {
              code = exitCode
              resolve()
            })
            // Recheck the existing host PATH CLI after subscribing; startup output may precede create.
            // The echo contains neither a numeric version line nor the complete output marker.
            window.api.terminal.write(
              actualId,
              `claude.cmd --version; packaged_cli_status=$?; printf '%s%s\\n' 'PACKAGED_PTY_' '${marker.slice("PACKAGED_PTY_".length)}'; exit "$packaged_cli_status"\n`
            )
          })
        } catch (reason) {
          errors.push(reason)
        } finally {
          clearTimeout(timer)
          try {
            if (id) await window.api.terminal.dispose(id)
          } catch (reason) {
            errors.push(reason)
          }
          try {
            removeData?.()
          } catch (reason) {
            errors.push(reason)
          }
          try {
            removeExit?.()
          } catch (reason) {
            errors.push(reason)
          }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length)
          throw new AggregateError(errors, "Packaged PTY failed", { cause: errors[0] })
        const plain = text
          // eslint-disable-next-line no-control-regex -- Parse complete terminal ESC/BEL sequences.
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
          // eslint-disable-next-line no-control-regex -- Parse terminal CSI control sequences.
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replaceAll("\r", "")
        const lines = plain.split("\n")
        const versions = lines
          .filter((line) => /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(line))
          .map((line) => line.slice(0, -" (Claude Code)".length))
        return {
          code,
          markerLines: lines.filter((line) => line === marker).length,
          versionLines: versions.length,
          hostCliVersions: [...new Set(versions)],
          outputCharacters: text.length
        }
      },
      { project, marker }
    )
    assert.equal(terminal.code, 0)
    assert.equal(terminal.markerLines, 1)
    assert(terminal.versionLines >= 1)
    assert.equal(terminal.hostCliVersions.length, 1)
    evidence.terminal = {
      ...terminal,
      cliScope: "Existing host PATH CLI prerequisite",
      bundledCli: false,
      elapsedMs: performance.now() - phaseStartedAt
    }
    pass("packaged native PTY emits a split marker, starts the existing host CLI and exits zero")

    phaseStartedAt = performance.now()
    const jobTitle = `Packaged Job ${randomUUID()}`
    jobThread = await page.evaluate(
      async ({ project, title }) => {
        const thread = await window.api.threads.create({
          title,
          workspacePath: project,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, project)
        await window.api.mods.configure(thread.thread_id, true, true)
        return thread.thread_id
      },
      { project, title: jobTitle }
    )
    assert(jobThread)
    const childCode = 'console.log("PKG_JOB_CHILD_"+process.pid);setInterval(()=>{},1000)'
    const parentCode = `const {spawn}=require("node:child_process");
      const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{
        env:process.env,stdio:["ignore","pipe","pipe"],windowsHide:true});
      child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      console.log("PKG_JOB_PARENT_"+process.pid);setInterval(()=>{},1000)`
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(
        JSON.stringify({
          name: "packaged-runtime-job",
          version: "1.0.0"
        })
      )
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`export function register(on){
      on("session.start",async($,e,next)=>{await $.command.register({
        name:"packaged-job",description:"Owned package process cancellation",immediate:true
      });return next(e)});
      on("command.run",{command:"packaged-job"},$=>{
        const stream=$.process.spawn({argv:${JSON.stringify([packageState.executable, "-e", parentCode])},
          env:{ELECTRON_RUN_AS_NODE:"1"}});
        (async()=>{for await(const chunk of stream)$.ui.log(chunk.text)})().catch(()=>{});
        return {text:"PACKAGED_JOB_STARTED"}
      })
    }`)
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "packaged-runtime-job.zip",
          "local"
        ),
      [...zip.toBuffer()]
    )
    assert.equal(installed.success, true, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), jobThread)
    ).functionMods!.find((row) => row.name === "packaged-runtime-job")
    assert(mod?.digest)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      {
        id: jobThread,
        pluginId: mod.pluginId,
        digest: mod.digest
      }
    )
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), jobThread)).find(
      (row) => row.command === "packaged-job"
    )
    assert(descriptor)
    const job = await page.evaluate(
      ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
      { id: jobThread, descriptor }
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), jobThread!)).some(
          (row) =>
            row.id === job.id &&
            row.state === "succeeded" &&
            row.result?.text === "PACKAGED_JOB_STARTED"
        ),
      "packaged module creator returned"
    )
    let pids: number[] = []
    await until(async () => {
      const text = (await page.evaluate((id) => window.api.mods.logs(id), jobThread!))
        .map((row) => row.text)
        .join("\n")
      const parents = [...text.matchAll(/PKG_JOB_PARENT_(\d+)/g)].map((match) => Number(match[1]))
      const children = [...text.matchAll(/PKG_JOB_CHILD_(\d+)/g)].map((match) => Number(match[1]))
      if (parents.length !== 1 || children.length !== 1) return false
      pids = [parents[0], children[0]]
      return true
    }, "packaged real parent and grandchild reported their PIDs")
    assert.equal(new Set(pids).size, 2)
    const before = await readWindowsProcessIdentities(pids)
    assert.equal(before.length, 2)
    assert(before.every((row) => pids.includes(row.pid) && Number.isFinite(Date.parse(row.born))))
    assert.equal(before.find((row) => row.pid === pids[1])!.parent, pids[0])
    // This is the product's revocation path. The test never kills these reported PIDs.
    await page.evaluate(
      (id) => window.api.mods.revokeFunction(id, "packaged-runtime-job"),
      jobThread
    )
    await until(async () => {
      const after = await readWindowsProcessIdentities(pids)
      return before.every(
        (original) => !after.some((row) => row.pid === original.pid && row.born === original.born)
      )
    }, "packaged Job close reaps both original process identities")
    jobReaped = true
    evidence.job = {
      before,
      after: await readWindowsProcessIdentities(pids),
      cancellation: "revokeFunction",
      elapsedMs: performance.now() - phaseStartedAt
    }
    pass("packaged Job controller cancellation reaps its real parent and grandchild on revocation")

    phaseStartedAt = performance.now()
    globalState = await page.evaluate(() => window.api.mods.globalEnabled())
    defaultModel = await page.evaluate(() => window.api.models.getDefault())
    routingMode = await page.evaluate(() => window.api.routing.getMode())
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), false)
    server = await startModsModelServer()
    modelId = `packaged-runtime-${randomUUID()}`
    const historyTitle = `Packaged History ${randomUUID()}`
    const prompt = `[mods-spawn-cold] Packaged ordinary history ${randomUUID()}`
    const historyThread = await page.evaluate(
      async ({ project, modelId, baseUrl, title }) => {
        await window.api.models.setCustomConfig({
          id: modelId,
          name: "Packaged protocol fixture",
          baseUrl,
          model: "gpt-4",
          apiKey: "fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault(`custom:${modelId}`)
        await window.api.routing.setMode("pinned")
        const thread = await window.api.threads.create({
          title,
          workspacePath: project,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, project)
        await window.api.threads.patchMetadata(thread.thread_id, {
          set: { model: `custom:${modelId}` }
        })
        return thread.thread_id
      },
      { project, modelId, baseUrl: server.url, title: historyTitle }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(historyTitle, { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    await until(
      async () => (await composer.count()) === 1 && (await composer.isEnabled()),
      "packaged ordinary composer ready"
    )
    await composer.fill(prompt)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(async () => {
      const messages = await page.evaluate(
        (id) => window.api.threads.getMessages(id),
        historyThread
      )
      evidence.history = {
        modelRequests: server!.requests.length,
        messages: messages.map(row => ({ role: row.role, content: row.content.slice(0, 160) }))
      }
      const errorCard = page.getByText("代理出错", { exact: true })
      if (await errorCard.isVisible()) {
        const reason = (await errorCard.locator("..").innerText()).slice(0, 800)
        throw Error(`PACKAGED_ORDINARY_CHAT_FAILED: ${reason}`)
      }
      return (
        messages.length === 2 &&
        messages[1].content === "SPAWN_COLD_DONE" &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0
      )
    }, "packaged ordinary model reply saved and done")
    assert.equal(server.requests.length, 1)
    const history = await page.evaluate(
      async (id) => ({
        page: await window.api.threads.getMessagesPage(id, { limit: 10 }),
        runtime: await window.api.threads.getLatestCheckpointRuntimeState(id),
        checkpoint: await window.api.threads.getLatestCheckpoint(id)
      }),
      historyThread
    )
    assert.equal(history.page.total, 2)
    assert.equal(history.page.hasMore, false)
    assert.deepEqual(
      history.page.messages.map((row) => row.role),
      ["user", "assistant"]
    )
    assert.deepEqual(
      history.page.messages.map((row) => row.content),
      [prompt, "SPAWN_COLD_DONE"]
    )
    assert.equal(new Set(history.page.messages.map((row) => row.id)).size, 2)
    assert(history.page.messages.every((row) => row.id && Number.isSafeInteger(row.ordinal)))
    assert(history.runtime && history.checkpoint)
    const checkpointId = (history.checkpoint as { checkpoint?: { id?: unknown } }).checkpoint?.id
    assert.equal(typeof checkpointId, "string")
    assert.equal(
      (history.runtime as { checkpoint?: { id?: unknown } }).checkpoint?.id,
      checkpointId
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(historyTitle, { exact: true }).first().click()
    const restored = await page.evaluate(
      async (id) => ({
        page: await window.api.threads.getMessagesPage(id, { limit: 10 }),
        runtime: await window.api.threads.getLatestCheckpointRuntimeState(id),
        checkpoint: await window.api.threads.getLatestCheckpoint(id)
      }),
      historyThread
    )
    assert.deepEqual(restored, history)
    assert.equal(server.requests.length, 1)
    await until(
      async () =>
        (await page.getByText(prompt, { exact: true }).count()) === 1 &&
        (await page.getByText("SPAWN_COLD_DONE", { exact: true }).count()) === 1,
      "packaged restored ordinary transcript is visible"
    )
    await page.screenshot({ path: join(artifacts, "packaged-runtime-history.png") })
    evidence.history = {
      modelRequests: server.requests.length,
      count: history.page.total,
      roles: history.page.messages.map((row) => row.role),
      ids: history.page.messages.map((row) => row.id),
      checkpointId,
      mods: "off",
      restoredIdentically: true,
      elapsedMs: performance.now() - phaseStartedAt
    }
    pass("packaged hydration and checkpoint Workers restore the ordinary transcript without replay")
    evidence.complete = true
  } catch (reason) {
    failures.push(reason)
    evidence.failure = reason instanceof Error ? reason.message.slice(0, 1200) : "Unknown failure"
    if (reason instanceof WindowsProcessQueryError)
      evidence.processQueryFailure = reason.diagnostics
  } finally {
    if (jobThread && !jobReaped)
      await attempt(() =>
        page.evaluate(
          (id) => window.api.mods.revokeFunction(id, "packaged-runtime-job"),
          jobThread!
        )
      )
    if (defaultModel !== undefined)
      await attempt(() =>
        page.evaluate((model) => window.api.models.setDefault(model), defaultModel!)
      )
    if (routingMode !== undefined)
      await attempt(() => page.evaluate((mode) => window.api.routing.setMode(mode), routingMode!))
    if (modelId)
      await attempt(() => page.evaluate((id) => window.api.models.deleteCustomConfig(id), modelId!))
    if (globalState !== undefined)
      await attempt(() =>
        page.evaluate((enabled) => window.api.mods.configureGlobal(enabled), globalState!)
      )
    await attempt(() => server?.close())
    evidence.elapsedMs = performance.now() - startedAt
    evidence.failureCount = failures.length
    if (failures.length) evidence.complete = false
    await attempt(() =>
      writeFileSync(
        join(artifacts, "packaged-runtime-evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n"
      )
    )
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length)
    throw new AggregateError(failures, "Packaged runtime verification failed", {
      cause: failures[0]
    })
}
